
/* ------------------------------------------------------------------ *
 * REST API
 * ------------------------------------------------------------------ */
const ALL = ROLES;
const CONTROL = ['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'];
const ADMIN = ['SYSTEM_ADMIN'];

/* Per-operator UI preferences (theme, mode, surface, sound) — stored on the
 * user row so they follow a login to any terminal, not per-browser
 * localStorage. Lazily defaulted: an existing user row with no ui_prefs at
 * all reads as DEFAULT_UI_PREFS rather than needing a migration. */
const THEMES = ['cosmic', 'midnight', 'harbour', 'rosewood', 'terminal', 'graphite'];
const UI_MODES = ['system', 'dark', 'light'];
const BLOOMS = ['violet', 'blue', 'teal', 'rose', 'none'];
const PANEL_STYLES = ['translucent', 'solid'];
const CORNER_STYLES = ['sharp', 'soft', 'round'];
const PRIORITY_RAMPS = ['standard', 'cbf'];
const DEFAULT_UI_PREFS = {
  theme: 'harbour', mode: 'system', bloom: 'teal', panels: 'translucent', corners: 'soft',
  glow: false, priority_ramp: 'standard', sound: true, reduce_motion: false,
};
function normalizeUiPrefs(p) {
  p = p || {};
  return {
    theme: THEMES.includes(p.theme) ? p.theme : DEFAULT_UI_PREFS.theme,
    mode: UI_MODES.includes(p.mode) ? p.mode : DEFAULT_UI_PREFS.mode,
    bloom: BLOOMS.includes(p.bloom) ? p.bloom : DEFAULT_UI_PREFS.bloom,
    panels: PANEL_STYLES.includes(p.panels) ? p.panels : DEFAULT_UI_PREFS.panels,
    corners: CORNER_STYLES.includes(p.corners) ? p.corners : DEFAULT_UI_PREFS.corners,
    glow: Boolean(p.glow),
    priority_ramp: PRIORITY_RAMPS.includes(p.priority_ramp) ? p.priority_ramp : DEFAULT_UI_PREFS.priority_ramp,
    sound: p.sound !== false,
    reduce_motion: Boolean(p.reduce_motion),
  };
}
const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, display_name: u.display_name, personnel_id: u.personnel_id, mdt_id: u.mdt_id, email: u.email || null, ui_prefs: normalizeUiPrefs(u.ui_prefs) });

route('POST', '/api/auth/login', null, ({ body }) => {
  const user = db.users.find((u) => u.username === String(body.username || '').toLowerCase());
  if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) {
    logEvent('auth.failed', `Failed login for ${body.username}`);
    throw httpError(401, 'invalid credentials');
  }
  const ttl = user.role === 'MDT_USER' ? MDT_TOKEN_TTL_MS : TOKEN_TTL_MS;
  const token = sign({ sub: user.id, role: user.role, exp: Date.now() + ttl });
  logEvent('auth.login', `${user.username} signed in (${user.role})`, { user_id: user.id });
  return { token, user: publicUser(user) };
});
route('PATCH', '/api/me/preferences', ALL, ({ body, user }) => {
  const u = db.users.find((x) => x.id === user.id); if (!u) throw httpError(404, 'account not found');
  const next = normalizeUiPrefs(u.ui_prefs);
  if ('theme' in body) { if (!THEMES.includes(body.theme)) throw httpError(400, 'invalid theme'); next.theme = body.theme; }
  if ('mode' in body) { if (!UI_MODES.includes(body.mode)) throw httpError(400, 'invalid mode'); next.mode = body.mode; }
  if ('bloom' in body) { if (!BLOOMS.includes(body.bloom)) throw httpError(400, 'invalid bloom'); next.bloom = body.bloom; }
  if ('panels' in body) { if (!PANEL_STYLES.includes(body.panels)) throw httpError(400, 'invalid panels'); next.panels = body.panels; }
  if ('corners' in body) { if (!CORNER_STYLES.includes(body.corners)) throw httpError(400, 'invalid corners'); next.corners = body.corners; }
  if ('priority_ramp' in body) { if (!PRIORITY_RAMPS.includes(body.priority_ramp)) throw httpError(400, 'invalid priority_ramp'); next.priority_ramp = body.priority_ramp; }
  if ('glow' in body) next.glow = Boolean(body.glow);
  if ('sound' in body) next.sound = Boolean(body.sound);
  if ('reduce_motion' in body) next.reduce_motion = Boolean(body.reduce_motion);
  u.ui_prefs = next;
  return publicUser(u);
});

/* ---- Microsoft Entra ID (Azure AD) single sign-on --------------------
 * Alongside local username/password, never replacing it. A Microsoft sign-in
 * only succeeds if its email/UPN matches an existing CCCS account's `email`
 * field — SSO never creates an account, it only unlocks one an admin already
 * set up, so role and personnel/MDT bindings stay under admin control. */
const ssoState = new Map();   // csrf nonce -> created-at, cleared on use
const ssoExchange = new Map(); // one-time code -> { token, user, created }
const SSO_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SSO_TTL_MS;
  for (const [k, at] of ssoState) if (at < cutoff) ssoState.delete(k);
  for (const [k, v] of ssoExchange) if (v.created < cutoff) ssoExchange.delete(k);
}, 60 * 1000).unref?.();

route('GET', '/api/auth/microsoft/status', null, () => ({ enabled: MS_ENABLED }));

route('GET', '/api/auth/microsoft/login', null, () => {
  if (!MS_ENABLED) throw httpError(404, 'Microsoft sign-in is not configured');
  const state = crypto.randomBytes(16).toString('hex');
  ssoState.set(state, Date.now());
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: MS_REDIRECT_URI,
    response_mode: 'query',
    scope: 'openid profile email',
    state,
  });
  return { __status: 302, __headers: { location: `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/authorize?${params}` }, __body: '' };
});

route('GET', '/api/auth/microsoft/callback', null, async ({ query }) => {
  if (!MS_ENABLED) throw httpError(404, 'Microsoft sign-in is not configured');
  const oauthError = query.get('error');
  if (oauthError) throw httpError(400, query.get('error_description') || oauthError);

  const state = query.get('state');
  if (!state || !ssoState.delete(state)) throw httpError(400, 'that sign-in attempt expired — try again');

  const code = query.get('code');
  if (!code) throw httpError(400, 'missing authorization code');

  const tokenRes = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET,
      code, redirect_uri: MS_REDIRECT_URI, grant_type: 'authorization_code',
    }),
  });
  const tokenBody = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error('[cccs] microsoft token exchange failed', tokenBody);
    throw httpError(502, 'Microsoft sign-in failed — see server logs');
  }

  let claims;
  try {
    claims = await verifyMicrosoftIdToken(tokenBody.id_token, { tenantId: MS_TENANT_ID, clientId: MS_CLIENT_ID });
  } catch (e) {
    console.error('[cccs] microsoft id_token rejected:', e.message);
    throw httpError(401, 'Microsoft sign-in could not be verified');
  }

  const email = String(claims.email || claims.preferred_username || '').toLowerCase();
  const localUser = email ? db.users.find((u) => u.email && u.email.toLowerCase() === email) : null;
  if (!localUser) {
    logEvent('auth.sso_denied', `Microsoft sign-in for ${email || '(no email claim)'} has no matching CCCS account`);
    const msg = encodeURIComponent('No CCCS account is linked to that Microsoft account. Ask an admin to set its email address.');
    return { __status: 302, __headers: { location: `/index.html?sso_error=${msg}` }, __body: '' };
  }

  const token = sign({ sub: localUser.id, role: localUser.role, exp: Date.now() + TOKEN_TTL_MS });
  const oneTime = crypto.randomBytes(16).toString('hex');
  ssoExchange.set(oneTime, { token, user: publicUser(localUser), created: Date.now() });
  logEvent('auth.login', `${localUser.username} signed in via Microsoft (${localUser.role})`, { user_id: localUser.id });
  return { __status: 302, __headers: { location: `/index.html?sso=${oneTime}` }, __body: '' };
});

route('GET', '/api/auth/microsoft/session', null, ({ query }) => {
  const code = query.get('code');
  const entry = code && ssoExchange.get(code);
  if (!entry) throw httpError(400, 'that sign-in code is invalid or already used');
  ssoExchange.delete(code);
  return { token: entry.token, user: entry.user };
});
route('GET', '/api/me', ALL, ({ user }) => publicUser(user));

// Web Push — lets a phone with the console added to its home screen get
// emergency, call and job alerts while it isn't open. See webpush.js.
route('GET', '/api/push/vapid-public-key', ALL, () => ({ key: webpush.getPublicKeyBase64Url() }));
route('POST', '/api/push/subscribe', ALL, ({ body, user }) => {
  const sub = body.subscription || body;
  const { endpoint, keys } = sub;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) throw httpError(400, 'invalid push subscription');
  const existing = db.push_subscriptions.find((s) => s.endpoint === endpoint);
  if (existing) { existing.user_id = user.id; existing.p256dh = keys.p256dh; existing.auth = keys.auth; }
  else db.push_subscriptions.push({ id: nextId('push_subscriptions'), user_id: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, created_at: new Date().toISOString() });
  return { ok: true };
});
route('DELETE', '/api/push/subscribe', ALL, ({ body, user }) => {
  db.push_subscriptions = db.push_subscriptions.filter((s) => !(s.endpoint === body.endpoint && s.user_id === user.id));
  return { ok: true };
});


// MDTs, vehicles, personnel
route('GET', '/api/mdts', ALL, () => db.mdts.map(publicMdt));

/* Crew sign-in/out is separate from terminal auth: the vehicle terminal stays
 * signed in for the shift (or longer), while personnel come and go from it.
 * This is what tells control who was actually in the car for a given call. */
const MDT_CREW = [...CONTROL, 'MDT_USER'];
route('POST', '/api/mdts/:id/crew', MDT_CREW, ({ params, body, user }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'MDT not found');
  if (user.role === 'MDT_USER' && user.mdt_id !== m.id) throw httpError(403, 'not your terminal');
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'crew member name required');
  m.crew = m.crew || [];
  if (m.crew.length >= 3) throw httpError(409, 'this terminal already has 3 crew signed in');
  if (m.crew.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw httpError(409, `${name} is already signed in`);
  const member = { id: nextId('mdt_crew'), name, signed_in_at: new Date().toISOString() };
  m.crew.push(member);
  broadcast('mdt.crew_changed', publicMdt(m));
  logEvent('mdt.crew_signed_in', `${name} SIGNED IN TO ${m.mdt_code}`, { mdt_id: m.id });
  return { __status: 201, __body: publicMdt(m) };
});
route('DELETE', '/api/mdts/:id/crew/:crewId', MDT_CREW, ({ params, user }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'MDT not found');
  if (user.role === 'MDT_USER' && user.mdt_id !== m.id) throw httpError(403, 'not your terminal');
  const idx = (m.crew || []).findIndex((c) => c.id === Number(params.crewId));
  if (idx < 0) throw httpError(404, 'crew member not found');
  const [removed] = m.crew.splice(idx, 1);
  broadcast('mdt.crew_changed', publicMdt(m));
  logEvent('mdt.crew_signed_out', `${removed.name} SIGNED OUT OF ${m.mdt_code}`, { mdt_id: m.id });
  return publicMdt(m);
});

/* Manual duty status, independent of job assignment — a vehicle can declare
 * itself busy or out of service even with nothing dispatched to it. Job
 * status (EN_ROUTE etc.) is separate and takes over once a job exists. */
const MDT_DUTY_STATUSES = ['AVAILABLE', 'BUSY', 'MEAL_BREAK', 'OUT_OF_SERVICE'];
route('POST', '/api/mdts/:id/duty-status', MDT_CREW, ({ params, body, user }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'MDT not found');
  if (user.role === 'MDT_USER' && user.mdt_id !== m.id) throw httpError(403, 'not your terminal');
  const status = String(body.status || '').toUpperCase();
  if (!MDT_DUTY_STATUSES.includes(status)) throw httpError(400, `invalid status ${status}`);
  m.duty_status = status;
  broadcast('mdt.status_changed', publicMdt(m));
  logEvent('mdt.duty_status', `${m.mdt_code} → ${status}`, { mdt_id: m.id });
  return publicMdt(m);
});

route('POST', '/api/mdts/:id/location', MDT_CREW, ({ params, body, user }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'MDT not found');
  if (user.role === 'MDT_USER' && user.mdt_id !== m.id) throw httpError(403, 'not your terminal');
  m.lat = Number(body.lat); m.lon = Number(body.lon);
  // This never wrote to db.locations at all before -- confirmed live during
  // the radio removal, only the (now-deleted) radio location route did.
  // Adding the write here rather than leaving GPS history/retention-sweep
  // silently empty for every terminal going forward.
  db.locations.push({ id: nextId('locations'), mdt_id: m.id, personnel_id: null, lat: m.lat, lon: m.lon, speed: null, heading: null, at: new Date().toISOString() });
  checkAutoJobProgress(m, m.lat, m.lon);
  broadcast('mdt.status_changed', publicMdt(m));
  return publicMdt(m);
});

route('POST', '/api/mdts', ADMIN, ({ body }) => {
  const mdt_code = String(body.mdt_code || '').trim().toUpperCase();
  if (!mdt_code) throw httpError(400, 'mdt_code is required');
  if (db.mdts.some((m) => m.mdt_code === mdt_code)) throw httpError(409, 'MDT code already exists');
  const cs = body.callsign ? findCallsign(body.callsign) : null;
  const m = {
    id: nextId('mdts'), mdt_code, serial: body.serial || mdt_code, callsign_id: cs ? cs.id : null,
    vehicle_id: null, status: 'OFFLINE', duty_status: 'AVAILABLE', job_id: null, battery: 100,
    network: 'LTE', operator: null, lat: null, lon: null, connected: false, crew: [], emergency: false,
  };
  db.mdts.push(m);
  broadcast('mdt.created', publicMdt(m));
  logEvent('mdt.created', `MDT ${mdt_code} CREATED`, { mdt_id: m.id });
  return { __status: 201, __body: publicMdt(m) };
});
route('PATCH', '/api/mdts/:id', ADMIN, ({ params, body }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id));
  if (!m) throw httpError(404, 'MDT not found');
  if ('mdt_code' in body) {
    const mdt_code = String(body.mdt_code || '').trim().toUpperCase();
    if (!mdt_code) throw httpError(400, 'mdt_code is required');
    if (db.mdts.some((x) => x.id !== m.id && x.mdt_code === mdt_code)) throw httpError(409, 'MDT code already exists');
    m.mdt_code = mdt_code;
  }
  if ('serial' in body) m.serial = String(body.serial || '').trim() || m.mdt_code;
  if ('callsign' in body) {
    const cs = body.callsign ? findCallsign(body.callsign) : null;
    m.callsign_id = cs ? cs.id : null;
  }
  broadcast('mdt.status_changed', publicMdt(m));
  logEvent('mdt.updated', `MDT ${m.mdt_code} UPDATED`, { mdt_id: m.id });
  return publicMdt(m);
});
route('DELETE', '/api/mdts/:id', ADMIN, ({ params }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id));
  if (!m) throw httpError(404, 'MDT not found');
  if (m.job_id) throw httpError(409, 'MDT is assigned to an open job — stand it down first');
  if (db.users.some((u) => u.mdt_id === m.id)) throw httpError(409, 'an account is still linked to this MDT — unlink it from the account first');
  db.mdts = db.mdts.filter((x) => x.id !== m.id);
  broadcast('mdt.deleted', { id: m.id, mdt_code: m.mdt_code });
  logEvent('mdt.deleted', `MDT ${m.mdt_code} DELETED`, { mdt_id: m.id });
  return { ok: true };
});
const VEHICLE_STATUSES = ['ACTIVE', 'IN_SERVICE', 'OFF_ROAD'];
route('GET', '/api/vehicles', ALL, () => db.vehicles.map(publicVehicle));
route('POST', '/api/vehicles', ADMIN, ({ body }) => {
  const registration = String(body.registration || '').trim().toUpperCase();
  if (!registration) throw httpError(400, 'registration required');
  if (db.vehicles.some((x) => x.registration === registration)) throw httpError(409, 'a vehicle with that registration already exists');
  const p = body.assigned_personnel_id ? db.personnel.find((x) => x.id === Number(body.assigned_personnel_id)) : null;
  const v = {
    id: nextId('vehicles'), registration, type: body.type || 'Vehicle', make: body.make || '', model: body.model || '',
    service_due_at: body.service_due_at || null, insurance_due_at: body.insurance_due_at || null,
    mileage: body.mileage != null && body.mileage !== '' ? Number(body.mileage) : null, condition: body.condition || '',
    assigned_personnel_id: p ? p.id : null,
    status: VEHICLE_STATUSES.includes(body.status) ? body.status : 'ACTIVE', notes: body.notes || '',
  };
  db.vehicles.push(v);
  logEvent('vehicle.created', `VEHICLE ${registration} ADDED`, { vehicle_id: v.id });
  return { __status: 201, __body: publicVehicle(v) };
});
route('PATCH', '/api/vehicles/:id', ADMIN, ({ params, body }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  if ('registration' in body) {
    const registration = String(body.registration || '').trim().toUpperCase();
    if (!registration) throw httpError(400, 'registration required');
    if (db.vehicles.some((x) => x.id !== v.id && x.registration === registration)) throw httpError(409, 'a vehicle with that registration already exists');
    v.registration = registration;
  }
  if ('type' in body) v.type = body.type || 'Vehicle';
  if ('make' in body) v.make = body.make || '';
  if ('model' in body) v.model = body.model || '';
  if ('service_due_at' in body) v.service_due_at = body.service_due_at || null;
  if ('insurance_due_at' in body) v.insurance_due_at = body.insurance_due_at || null;
  if ('mileage' in body) v.mileage = body.mileage != null && body.mileage !== '' ? Number(body.mileage) : null;
  if ('condition' in body) v.condition = body.condition || '';
  if ('assigned_personnel_id' in body) { const p = body.assigned_personnel_id ? db.personnel.find((x) => x.id === Number(body.assigned_personnel_id)) : null; v.assigned_personnel_id = p ? p.id : null; }
  if ('status' in body) { if (!VEHICLE_STATUSES.includes(body.status)) throw httpError(400, 'invalid status'); v.status = body.status; }
  if ('notes' in body) v.notes = body.notes || '';
  logEvent('vehicle.updated', `VEHICLE ${v.registration} UPDATED`, { vehicle_id: v.id });
  return publicVehicle(v);
});
route('DELETE', '/api/vehicles/:id', ADMIN, ({ params }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  if (db.mdts.some((m) => m.vehicle_id === v.id)) throw httpError(409, 'an MDT is still linked to this vehicle — unlink it first');
  if (db.personnel.some((p) => p.vehicle_id === v.id)) throw httpError(409, 'a person is still linked to this vehicle — unlink them first');
  db.vehicles = db.vehicles.filter((x) => x.id !== v.id);
  logEvent('vehicle.deleted', `VEHICLE ${v.registration} DELETED`, { vehicle_id: v.id });
  return { ok: true };
});

/* Fuel-up records against a vehicle — odometer, litres, cost, an optional
 * receipt photo, and who filled up. Anyone can log one (whoever's driving is
 * the one at the pump); only admin can delete, for correcting a mistake. */
const fuelReceiptDir = (fuelLogId) => path.join(UPLOADS_DIR, 'fuel', String(fuelLogId));
route('GET', '/api/vehicles/:id/fuel-logs', ALL, ({ params }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  return db.fuel_logs.filter((f) => f.vehicle_id === v.id)
    .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))
    .map(publicFuelLog);
});
route('POST', '/api/vehicles/:id/fuel-logs', ALL, ({ params, body, user }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  const litres = Number(body.litres);
  if (!litres || litres <= 0) throw httpError(400, 'litres required');
  const odometer = body.odometer != null && body.odometer !== '' ? Number(body.odometer) : null;
  const cost = body.cost != null && body.cost !== '' ? Number(body.cost) : null;
  const driver = user.role === 'FIELD_USER' && user.personnel_id
    ? db.personnel.find((p) => p.id === user.personnel_id)
    : (body.personnel_id ? db.personnel.find((p) => p.id === Number(body.personnel_id)) : null);
  const log = {
    id: nextId('fuel_logs'), vehicle_id: v.id, personnel_id: driver ? driver.id : null,
    odometer, litres, cost: cost != null && !isNaN(cost) ? cost : null,
    fuel_type: body.fuel_type || '', notes: body.notes || '', receipt: null,
    recorded_at: new Date().toISOString(), created_by: user.id, created_at: new Date().toISOString(),
  };
  db.fuel_logs.push(log);
  if (odometer != null && !isNaN(odometer)) v.mileage = odometer;
  logEvent('fuel_log.created', `FUEL LOG ADDED FOR ${v.registration} — ${litres}L`, { vehicle_id: v.id, fuel_log_id: log.id });
  return { __status: 201, __body: publicFuelLog(log) };
});
route('POST', '/api/fuel-logs/:id/receipt', ALL, ({ params, body }) => {
  const f = db.fuel_logs.find((x) => x.id === Number(params.id)); if (!f) throw httpError(404, 'fuel log not found');
  const ext = MEDIA_MIME_EXT[body.mimetype];
  if (!ext) throw httpError(400, 'mimetype must be image/jpeg, image/png or image/webp');
  if (!body.data) throw httpError(400, 'data (base64) required');
  const bytes = Buffer.from(body.data, 'base64');
  if (bytes.length > 8e6) throw httpError(413, 'photo too large');
  const dir = fuelReceiptDir(f.id);
  fs.mkdirSync(dir, { recursive: true });
  const mediaId = crypto.randomUUID();
  const filename = `${mediaId}${ext}`;
  fs.writeFileSync(path.join(dir, filename), bytes);
  f.receipt = { id: mediaId, url: `/api/fuel-logs/${f.id}/receipt/${mediaId}`, filename };
  logEvent('fuel_log.receipt_added', `RECEIPT ADDED TO FUEL LOG ${f.id}`, { fuel_log_id: f.id, vehicle_id: f.vehicle_id });
  return { __status: 201, __body: publicFuelLog(f) };
});
route('GET', '/api/fuel-logs/:id/receipt/:mediaId', ALL, ({ params }) => {
  const f = db.fuel_logs.find((x) => x.id === Number(params.id)); if (!f) throw httpError(404, 'fuel log not found');
  if (!f.receipt || f.receipt.id !== params.mediaId) throw httpError(404, 'receipt not found');
  const file = path.join(fuelReceiptDir(f.id), f.receipt.filename);
  if (!fs.existsSync(file)) throw httpError(404, 'receipt file missing');
  return { __body: fs.readFileSync(file), __headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'private, max-age=86400' } };
});
route('DELETE', '/api/fuel-logs/:id', ADMIN, ({ params }) => {
  const f = db.fuel_logs.find((x) => x.id === Number(params.id)); if (!f) throw httpError(404, 'fuel log not found');
  db.fuel_logs = db.fuel_logs.filter((x) => x.id !== f.id);
  logEvent('fuel_log.deleted', 'FUEL LOG DELETED', { fuel_log_id: f.id, vehicle_id: f.vehicle_id });
  return { ok: true };
});

/* Vehicle maintenance history — a record of what was done, and when it's due
 * again. Logging one with next_due_at also updates the vehicle's own
 * service_due_at, the same "the record updates the summary field" pattern
 * fuel logs use for mileage. Control-only to log (coordinating a garage
 * visit isn't something an officer does), same read access as everything
 * else vehicle-related. */
route('GET', '/api/vehicles/:id/maintenance-logs', ALL, ({ params }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  return db.maintenance_logs.filter((m) => m.vehicle_id === v.id)
    .sort((a, b) => Date.parse(b.performed_at) - Date.parse(a.performed_at))
    .map(publicMaintenanceLog);
});
route('POST', '/api/vehicles/:id/maintenance-logs', CONTROL, ({ params, body, user }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  const description = String(body.description || '').trim();
  if (!description) throw httpError(400, 'description required');
  const cost = body.cost != null && body.cost !== '' ? Number(body.cost) : null;
  const odometer = body.odometer != null && body.odometer !== '' ? Number(body.odometer) : null;
  const performedAt = body.performed_at ? new Date(body.performed_at) : new Date();
  if (isNaN(performedAt)) throw httpError(400, 'invalid performed_at');
  const nextDueAt = body.next_due_at ? new Date(body.next_due_at) : null;
  if (body.next_due_at && isNaN(nextDueAt)) throw httpError(400, 'invalid next_due_at');
  const log = {
    id: nextId('maintenance_logs'), vehicle_id: v.id, description,
    cost: cost != null && !isNaN(cost) ? cost : null, odometer: odometer != null && !isNaN(odometer) ? odometer : null,
    performed_at: performedAt.toISOString(), next_due_at: nextDueAt ? nextDueAt.toISOString() : null,
    notes: body.notes || '', created_by: user.id, created_at: new Date().toISOString(),
  };
  db.maintenance_logs.push(log);
  if (odometer != null && !isNaN(odometer)) v.mileage = odometer;
  if (nextDueAt) v.service_due_at = nextDueAt.toISOString();
  logEvent('maintenance_log.created', `MAINTENANCE LOGGED FOR ${v.registration}: ${description}`, { vehicle_id: v.id, maintenance_log_id: log.id });
  return { __status: 201, __body: publicMaintenanceLog(log) };
});
route('DELETE', '/api/maintenance-logs/:id', ADMIN, ({ params }) => {
  const m = db.maintenance_logs.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'maintenance log not found');
  db.maintenance_logs = db.maintenance_logs.filter((x) => x.id !== m.id);
  logEvent('maintenance_log.deleted', 'MAINTENANCE LOG DELETED', { maintenance_log_id: m.id, vehicle_id: m.vehicle_id });
  return { ok: true };
});

const ASSET_CATEGORIES = ['EQUIPMENT', 'UNIFORM', 'KEY', 'DEVICE', 'OTHER'];
const ASSET_STATUSES = ['IN_USE', 'IN_STORE', 'LOST', 'RETIRED'];
route('GET', '/api/assets', ALL, ({ query }) => {
  let rows = db.assets.map(publicAsset);
  if (query.get('assigned_to')) rows = rows.filter((a) => a.assigned_to === Number(query.get('assigned_to')));
  if (query.get('category')) rows = rows.filter((a) => a.category === query.get('category').toUpperCase());
  return rows;
});
route('POST', '/api/assets', ADMIN, ({ body }) => {
  const description = String(body.description || '').trim();
  if (!description) throw httpError(400, 'description required');
  if (!ASSET_CATEGORIES.includes(body.category)) throw httpError(400, 'invalid category');
  const tag = body.tag ? String(body.tag).trim() : null;
  if (tag && db.assets.some((x) => x.tag === tag)) throw httpError(409, 'an asset with that tag already exists');
  const p = body.assigned_to ? db.personnel.find((x) => x.id === Number(body.assigned_to)) : null;
  const site = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null;
  const a = {
    id: nextId('assets'), tag, category: body.category, description, serial_no: body.serial_no || '',
    assigned_to: p ? p.id : null, site_id: site ? site.id : null,
    status: ASSET_STATUSES.includes(body.status) ? body.status : 'IN_STORE',
    purchase_date: body.purchase_date || null, last_checked_at: null, notes: body.notes || '',
  };
  db.assets.push(a);
  logEvent('asset.created', `ASSET ${tag || description} ADDED`, { asset_id: a.id });
  return { __status: 201, __body: publicAsset(a) };
});
route('PATCH', '/api/assets/:id', ADMIN, ({ params, body }) => {
  const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
  if ('tag' in body) {
    const tag = body.tag ? String(body.tag).trim() : null;
    if (tag && db.assets.some((x) => x.id !== a.id && x.tag === tag)) throw httpError(409, 'an asset with that tag already exists');
    a.tag = tag;
  }
  if ('category' in body) { if (!ASSET_CATEGORIES.includes(body.category)) throw httpError(400, 'invalid category'); a.category = body.category; }
  if ('description' in body) { const description = String(body.description || '').trim(); if (!description) throw httpError(400, 'description required'); a.description = description; }
  if ('serial_no' in body) a.serial_no = body.serial_no || '';
  if ('assigned_to' in body) { const p = body.assigned_to ? db.personnel.find((x) => x.id === Number(body.assigned_to)) : null; a.assigned_to = p ? p.id : null; }
  if ('site_id' in body) { const site = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null; a.site_id = site ? site.id : null; }
  if ('status' in body) { if (!ASSET_STATUSES.includes(body.status)) throw httpError(400, 'invalid status'); a.status = body.status; }
  if ('purchase_date' in body) a.purchase_date = body.purchase_date || null;
  if ('notes' in body) a.notes = body.notes || '';
  if (body.check_now) a.last_checked_at = new Date().toISOString();
  logEvent('asset.updated', `ASSET ${a.tag || a.description} UPDATED`, { asset_id: a.id });
  return publicAsset(a);
});
route('DELETE', '/api/assets/:id', ADMIN, ({ params }) => {
  const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
  db.assets = db.assets.filter((x) => x.id !== a.id);
  logEvent('asset.deleted', `ASSET ${a.tag || a.description} DELETED`, { asset_id: a.id });
  return { ok: true };
});

/* Checkout/return as a dedicated, audit-trailed path alongside the blunter
 * PATCH assigned_to/status (kept for admin corrections). A FIELD_USER can
 * only check an asset out to themselves and only return their own
 * checkout — control/admin can act on anyone's. */
route('GET', '/api/assets/:id/checkouts', ALL, ({ params }) => {
  const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
  return db.asset_checkouts.filter((c) => c.asset_id === a.id)
    .sort((x, y) => Date.parse(y.checked_out_at) - Date.parse(x.checked_out_at))
    .map(publicAssetCheckout);
});
route('POST', '/api/assets/:id/checkout', ALL, ({ params, body, user }) => {
  const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
  if (db.asset_checkouts.some((c) => c.asset_id === a.id && !c.returned_at)) throw httpError(409, 'asset is already checked out — return it first');
  let personnelId;
  if (user.role === 'FIELD_USER') {
    if (!user.personnel_id) throw httpError(400, 'no personnel record linked to your account');
    personnelId = user.personnel_id;
  } else {
    const p = body.personnel_id ? db.personnel.find((x) => x.id === Number(body.personnel_id)) : null;
    if (!p) throw httpError(400, 'personnel_id required');
    personnelId = p.id;
  }
  const co = {
    id: nextId('asset_checkouts'), asset_id: a.id, personnel_id: personnelId,
    checked_out_at: new Date().toISOString(), checked_out_by: user.id,
    returned_at: null, returned_by: null, notes: body.notes || '',
  };
  db.asset_checkouts.push(co);
  a.assigned_to = personnelId; a.status = 'IN_USE';
  const p = db.personnel.find((x) => x.id === personnelId);
  logEvent('asset.checked_out', `ASSET ${a.tag || a.description} CHECKED OUT TO ${p ? p.name : personnelId}`, { asset_id: a.id, checkout_id: co.id });
  return { __status: 201, __body: publicAsset(a) };
});
route('POST', '/api/assets/:id/return', ALL, ({ params, user }) => {
  const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
  const co = db.asset_checkouts.find((c) => c.asset_id === a.id && !c.returned_at);
  if (!co) throw httpError(409, 'asset is not currently checked out');
  if (user.role === 'FIELD_USER' && user.personnel_id !== co.personnel_id) throw httpError(403, 'not your checkout');
  co.returned_at = new Date().toISOString(); co.returned_by = user.id;
  a.assigned_to = null; a.status = 'IN_STORE'; a.last_checked_at = new Date().toISOString();
  logEvent('asset.returned', `ASSET ${a.tag || a.description} RETURNED`, { asset_id: a.id, checkout_id: co.id });
  return publicAsset(a);
});
route('GET', '/api/personnel', ALL, () => db.personnel.map(publicPersonnel));
route('POST', '/api/personnel', ADMIN, ({ body }) => {
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'name required');
  const employeeNo = body.employee_no ? String(body.employee_no).trim() : null;
  if (employeeNo && db.personnel.some((p) => p.employee_no === employeeNo)) throw httpError(409, 'employee number already in use');
  const cs = body.callsign_id ? findCallsign(body.callsign_id) : null;
  const veh = body.vehicle_id ? db.vehicles.find((v) => v.id === Number(body.vehicle_id)) : null;
  const p = {
    id: nextId('personnel'), employee_no: employeeNo, name, rank: body.rank || '',
    contact_phone: body.contact_phone || '', contact_email: body.contact_email || '',
    employment_status: ['ACTIVE', 'LEAVE', 'TERMINATED'].includes(body.employment_status) ? body.employment_status : 'ACTIVE',
    callsign_id: cs ? cs.id : null, user_id: null, vehicle_id: veh ? veh.id : null,
    welfare_interval_s: null, welfare_due_at: null, welfare_warned: false, welfare_note: null,
    notes: body.notes || '',
  };
  db.personnel.push(p);
  logEvent('personnel.created', `PERSONNEL ${name} ADDED`, { personnel_id: p.id });
  return { __status: 201, __body: publicPersonnel(p) };
});
route('PATCH', '/api/personnel/:id', ADMIN, ({ params, body }) => {
  const p = db.personnel.find((x) => x.id === Number(params.id)); if (!p) throw httpError(404, 'personnel not found');
  if ('name' in body) { const name = String(body.name || '').trim(); if (!name) throw httpError(400, 'name required'); p.name = name; }
  if ('employee_no' in body) {
    const employeeNo = body.employee_no ? String(body.employee_no).trim() : null;
    if (employeeNo && db.personnel.some((x) => x.id !== p.id && x.employee_no === employeeNo)) throw httpError(409, 'employee number already in use');
    p.employee_no = employeeNo;
  }
  if ('rank' in body) p.rank = body.rank || '';
  if ('contact_phone' in body) p.contact_phone = body.contact_phone || '';
  if ('contact_email' in body) p.contact_email = body.contact_email || '';
  if ('employment_status' in body) {
    if (!['ACTIVE', 'LEAVE', 'TERMINATED'].includes(body.employment_status)) throw httpError(400, 'invalid employment_status');
    p.employment_status = body.employment_status;
  }
  if ('callsign_id' in body) { const cs = body.callsign_id ? findCallsign(body.callsign_id) : null; p.callsign_id = cs ? cs.id : null; }
  if ('vehicle_id' in body) { const veh = body.vehicle_id ? db.vehicles.find((v) => v.id === Number(body.vehicle_id)) : null; p.vehicle_id = veh ? veh.id : null; }
  if ('notes' in body) p.notes = body.notes || '';
  logEvent('personnel.updated', `PERSONNEL ${p.name} UPDATED`, { personnel_id: p.id });
  return publicPersonnel(p);
});
route('DELETE', '/api/personnel/:id', ADMIN, ({ params }) => {
  const p = db.personnel.find((x) => x.id === Number(params.id)); if (!p) throw httpError(404, 'personnel not found');
  if (p.user_id) throw httpError(409, 'an account is still linked to this person — unlink it from the account first');
  if (db.job_assignments.some((a) => a.personnel_id === p.id && db.jobs.some((j) => j.id === a.job_id && !['COMPLETED', 'CANCELLED'].includes(j.status)))) {
    throw httpError(409, 'this person is assigned to an open job — stand them down first');
  }
  if (db.site_visits.some((v) => (v.personnel_id === p.id || (v.additional_personnel || []).includes(p.id)) && !['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status))) {
    throw httpError(409, 'this person is assigned to an open site visit — stand them down first');
  }
  if (db.shifts.some((s) => s.personnel_id === p.id && ['SCHEDULED', 'CONFIRMED', 'CLOCKED_IN'].includes(s.status))) {
    throw httpError(409, 'this person has an upcoming or active shift — cancel it first');
  }
  db.personnel = db.personnel.filter((x) => x.id !== p.id);
  logEvent('personnel.deleted', `PERSONNEL ${p.name} DELETED`, { personnel_id: p.id });
  return { ok: true };
});

// Call signs
route('GET', '/api/callsigns', ALL, () => db.callsigns.map((c) => ({
  ...c,
  mdts: db.mdts.filter((m) => m.callsign_id === c.id).map((m) => ({ id: m.id, mdt_code: m.mdt_code, status: m.status })),
  personnel: db.personnel.filter((p) => p.callsign_id === c.id).map((p) => ({ id: p.id, name: p.name })),
  vehicles: [...new Set(db.mdts.filter((m) => m.callsign_id === c.id && m.vehicle_id).map((m) => (db.vehicles.find((v) => v.id === m.vehicle_id) || {}).registration))],
})));
route('POST', '/api/callsigns', CONTROL, ({ body }) => {
  const name = String(body.name || '').toUpperCase().trim();
  if (!name) throw httpError(400, 'name required');
  if (db.callsigns.some((c) => c.name === name)) throw httpError(409, 'call sign already exists');
  const c = { id: nextId('callsigns'), name, description: body.description || '', active: true };
  db.callsigns.push(c);
  broadcast('callsign.created', c);
  logEvent('callsign.created', `CALL SIGN ${name} CREATED`);
  return { __status: 201, __body: c };
});
route('POST', '/api/callsigns/:id/assign', CONTROL, ({ params, body }) => {
  const cs = findCallsign(params.id); if (!cs) throw httpError(404, 'call sign not found');
  if (body.mdt) {
    const m = findMdt(body.mdt); if (!m) throw httpError(404, 'MDT not found');
    m.callsign_id = cs.id;
    broadcast('mdt.assigned', publicMdt(m));
    logEvent('assignment.mdt', `${m.mdt_code} → ${cs.name}`, { mdt_id: m.id, callsign_id: cs.id });
  }
  return { ok: true };
});
route('DELETE', '/api/callsigns/:id/assign', CONTROL, ({ params, body }) => {
  const cs = findCallsign(params.id); if (!cs) throw httpError(404, 'call sign not found');
  if (body.mdt) {
    const m = findMdt(body.mdt); if (!m) throw httpError(404, 'MDT not found');
    m.callsign_id = null;
    broadcast('mdt.assigned', publicMdt(m));
    logEvent('assignment.mdt_removed', `${m.mdt_code} REMOVED FROM ${cs.name}`);
  }
  return { ok: true };
});


// Jobs
route('GET', '/api/jobs', ALL, ({ query }) => {
  let jobs = db.jobs.map(publicJob);
  if (query.get('status')) jobs = jobs.filter((j) => j.status === query.get('status').toUpperCase());
  return jobs;
});
/* On-scene checklist — every job gets one, instantiated from the site's own
 * template if it has one configured, else this fixed default. A site with
 * no template yet (most GuardM8 sites, until someone sets one up in admin)
 * still gets a sane checklist rather than none at all. Each instantiated
 * item carries its own completion state; the site's template itself never
 * does — that's what makes it reusable across jobs. */
const DEFAULT_CHECKLIST_TEMPLATE = [
  { title: 'Call control room on arrival', instructions: 'Contact the site’s control room to confirm your arrival on site.' },
  { title: 'Entrance check', instructions: 'Check the site entry point for signs of unauthorised entry.' },
  { title: 'Perimeter check', instructions: 'Complete a perimeter check of the site for any signs of damage or forced entry.' },
  { title: 'Risks on site', instructions: 'Note any risks or hazards observed on site.' },
  { title: 'Report', instructions: 'Provide a detailed report of the site attendance.' },
  { title: 'Before departing', instructions: 'Contact the site’s control room to obtain permission to depart.' },
  { title: 'Departure', instructions: 'Ensure the site is secure on departure.' },
];
function instantiateChecklist(site) {
  const template = site && site.checklist && site.checklist.length ? site.checklist : DEFAULT_CHECKLIST_TEMPLATE;
  return template.map((item) => ({
    id: crypto.randomUUID(), title: item.title, instructions: item.instructions || '',
    status: 'PENDING', notes: '', completed_by: null, completed_at: null,
  }));
}

route('POST', '/api/jobs', CONTROL, ({ body, user }) => {
  const priority = String(body.priority || 'GREEN').toUpperCase();
  if (!PRIORITIES.includes(priority)) throw httpError(400, 'invalid priority');
  const site = body.site ? db.sites.find((x) => x.id === Number(body.site) || x.name === String(body.site)) : null;
  if (!body.location && !site) throw httpError(400, 'location or site required');
  const j = {
    id: nextId('jobs'), reference: `INC-${new Date().getFullYear()}-${String(nextId('jobref') + 124).padStart(5, '0')}`,
    incident_type: body.incident_type || 'UNSPECIFIED', priority,
    location: body.location || `${site.name}, ${site.address}`,
    site_id: site ? site.id : null, keyholder: site ? site.keyholder : (body.keyholder || ''),
    lat: Number(body.lat || (site && site.lat) || 53.6152 + (Math.random() - 0.5) * 0.05),
    lon: Number(body.lon || (site && site.lon) || -0.2210 + (Math.random() - 0.5) * 0.05),
    description: body.description || '', caller: body.caller || '', required_resources: Number(body.required_resources || 1),
    what3words: String(body.what3words || '').replace(/^\/+/, '').trim(),
    notes: body.notes || '', status: 'CREATED', created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    checklist: instantiateChecklist(site), media: [],
  };
  db.jobs.push(j);
  broadcast('job.created', publicJob(j));
  logEvent('job.created', `JOB ${j.reference} CREATED (${priority})`, { job_id: j.id });
  return { __status: 201, __body: publicJob(j) };
});

/* ---- GuardM8 integration ----------------------------------------------
 * GuardM8 (Echelon's separate guarding/alarm-receiving product) pushes an
 * alarm straight in as a dispatchable job, the same shape a call taker
 * would create by hand. Authenticated with a shared secret rather than a
 * user session — GuardM8 is a system, not a CCCS operator — same pattern
 * as the PBX inbound route below. external_ref lets GuardM8 retry a send
 * (e.g. after a network blip) without creating a duplicate job: resending
 * the same external_ref returns the job already created for it instead of
 * making a second one. */
const GUARDM8_PRIORITY_MAP = {
  RED: 'RED', CRITICAL: 'RED', P1: 'RED',
  AMBER: 'AMBER', HIGH: 'AMBER', P2: 'AMBER',
  GREEN: 'GREEN', MEDIUM: 'GREEN', P3: 'GREEN',
  ROUTINE: 'ROUTINE', LOW: 'ROUTINE', P4: 'ROUTINE',
};
route('POST', '/api/integrations/guardm8/jobs', null, ({ body, req }) => {
  const secret = process.env.GUARDM8_SECRET;
  if (!secret || req.headers['x-guardm8-secret'] !== secret) throw httpError(401, 'bad GuardM8 secret');

  const externalRef = body.external_ref !== undefined && body.external_ref !== null ? String(body.external_ref) : null;
  if (externalRef) {
    const existing = db.jobs.find((x) => x.external_ref === externalRef);
    if (existing) return { __status: 200, __body: publicJob(existing) };
  }

  const priority = GUARDM8_PRIORITY_MAP[String(body.priority || 'GREEN').toUpperCase()] || 'GREEN';
  const site = body.site ? db.sites.find((x) => x.id === Number(body.site) || x.name === String(body.site)) : null;
  if (!body.location && !site) throw httpError(400, 'location or site required');

  const j = {
    id: nextId('jobs'), reference: `INC-${new Date().getFullYear()}-${String(nextId('jobref') + 124).padStart(5, '0')}`,
    incident_type: body.incident_type || 'ALARM', priority,
    location: body.location || `${site.name}, ${site.address}`,
    site_id: site ? site.id : null, keyholder: site ? site.keyholder : (body.keyholder || ''),
    lat: body.lat != null ? Number(body.lat) : (site && site.lat != null ? site.lat : null),
    lon: body.lon != null ? Number(body.lon) : (site && site.lon != null ? site.lon : null),
    description: body.description || '', caller: body.caller || 'GuardM8', required_resources: Number(body.required_resources || 1),
    what3words: String(body.what3words || '').replace(/^\/+/, '').trim(),
    notes: body.notes || '', status: 'CREATED', created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    external_source: 'guardm8', external_ref: externalRef,
    checklist: instantiateChecklist(site), media: [],
  };
  db.jobs.push(j);
  broadcast('job.created', publicJob(j));
  pushToRoles(CONTROL, { title: 'New job — GuardM8', body: `${j.reference} · ${j.incident_type} · ${j.location}`, url: '/control.html', tag: 'cccs-job' });
  logEvent('job.created', `JOB ${j.reference} CREATED (${priority}) — via GuardM8`, { job_id: j.id, external_ref: externalRef });
  return { __status: 201, __body: publicJob(j) };
});

route('POST', '/api/jobs/:id/assign', CONTROL, ({ params, body }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  const targets = body.resources || body.to || [];
  if (!targets.length) throw httpError(400, 'resources required');
  const personnelIds = [], mdtIds = [];
  for (const t of targets) {
    // Call sign only by exact name here, not by numeric id — a bare id is
    // ambiguous between "callsign id" and "personnel id" (independent
    // sequences that both start at 1), and every real caller (control.html's
    // pick-a-callsign buttons, GuardM8) already sends the name, never the id.
    const cs = db.callsigns.find((c) => c.name === String(t).toUpperCase());
    const people = cs ? db.personnel.filter((p) => p.callsign_id === cs.id) : [findPersonnel(t)].filter(Boolean);
    const mdts = cs ? db.mdts.filter((m) => m.callsign_id === cs.id) : [findMdt(t)].filter(Boolean);
    if (!people.length && !mdts.length) throw httpError(404, `unknown resource ${t}`);
    for (const p of people) {
      if (db.job_assignments.some((a) => a.job_id === j.id && a.personnel_id === p.id)) continue;
      db.job_assignments.push({ id: nextId('job_assignments'), job_id: j.id, personnel_id: p.id, mdt_id: null, callsign_id: p.callsign_id, acknowledged: false, acknowledged_at: null, at: new Date().toISOString() });
      personnelIds.push(p.id);
    }
    for (const m of mdts) {
      if (db.job_assignments.some((a) => a.job_id === j.id && a.mdt_id === m.id)) continue;
      db.job_assignments.push({ id: nextId('job_assignments'), job_id: j.id, personnel_id: null, mdt_id: m.id, callsign_id: m.callsign_id, acknowledged: false, acknowledged_at: null, at: new Date().toISOString() });
      m.job_id = j.id; mdtIds.push(m.id);
    }
  }
  j.status = 'DISPATCHED'; j.updated_at = new Date().toISOString();
  stampJobStatus(j, 'DISPATCHED');
  const payload = publicJob(j);
  broadcast('job.dispatched', payload);
  broadcast('job.assigned_to_you', payload, { personnelIds, mdtIds });
  pushToUsers(db.users.filter((u) => (u.personnel_id && personnelIds.includes(u.personnel_id)) || (u.mdt_id && mdtIds.includes(u.mdt_id))).map((u) => u.id),
    { title: `Job ${j.reference}`, body: `${j.priority} — ${j.location}`, url: '/officer.html', tag: 'cccs-job' });
  logEvent('job.dispatched', `JOB ${j.reference} DISPATCHED → ${payload.resources.map((r) => r.callsign || r.personnel || r.mdt).join(', ')}`, { job_id: j.id });
  return payload;
});
route('POST', '/api/jobs/:id/ack', ALL, ({ params, user, body }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  let assignment;
  if (user.role === 'FIELD_USER') assignment = db.job_assignments.find((a) => a.job_id === j.id && a.personnel_id === user.personnel_id);
  else if (user.role === 'MDT_USER') assignment = db.job_assignments.find((a) => a.job_id === j.id && a.mdt_id === user.mdt_id);
  else {
    const p = body.personnel ? findPersonnel(body.personnel) : null; const m = body.mdt ? findMdt(body.mdt) : null;
    assignment = db.job_assignments.find((a) => a.job_id === j.id && ((p && a.personnel_id === p.id) || (m && a.mdt_id === m.id)));
  }
  if (!assignment) throw httpError(404, 'no assignment for this resource');
  assignment.acknowledged = true; assignment.acknowledged_at = new Date().toISOString();
  if (j.status === 'DISPATCHED') { j.status = 'ACKNOWLEDGED'; j.updated_at = assignment.acknowledged_at; }
  stampJobStatus(j, 'ACKNOWLEDGED');
  const ackMdt = assignment.mdt_id ? db.mdts.find((m) => m.id === assignment.mdt_id) : null;
  // Baseline for checkAutoJobProgress's "distance is decreasing" check —
  // without this the first location report after ack has nothing to
  // compare against and can never detect movement toward the job.
  if (j.lat != null && ackMdt && ackMdt.lat != null) assignment.last_distance_m = haversineMeters(ackMdt.lat, ackMdt.lon, j.lat, j.lon);
  const who = assignment.personnel_id ? (db.personnel.find((p) => p.id === assignment.personnel_id) || {}).name : (db.mdts.find((m) => m.id === assignment.mdt_id) || {}).mdt_code;
  broadcast('job.acknowledged', { job: publicJob(j), by: who });
  logEvent('job.acknowledged', `${who} ACKNOWLEDGED JOB ${j.reference}`, { job_id: j.id });
  return publicJob(j);
});
/* ---- Resolution report ---------------------------------------------- *
 * Built the moment a job completes and kept on the job itself (so it shows
 * up in job history in the control room and the incidents log without
 * needing email to have worked), then emailed out to the site's own
 * contact and RESOLUTION_REPORT_CC via Microsoft Graph, app-only — inert
 * until MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET/MS_GRAPH_SENDER are all
 * set, same gating pattern as the AURA integration above. */
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* Email clients don't send an Authorization header for embedded images, and
 * most either block external image loading by default or strip data: URIs
 * outright — so the report's images are referenced as cid: and attached
 * inline, the one embedding method that actually renders reliably across
 * real mail clients. buildResolutionReportHtml() always returns the cid:
 * form; it's the email body verbatim, not something a browser can render
 * standalone, which is fine since job history in the app renders its own
 * view straight from job.checklist/job.media (with authenticated URLs)
 * rather than reusing this HTML. */
/** Generic across jobs and site visits — both are "a reference, a place, a
 * timeline of stages, a checklist, some photos", just with different stage
 * vocabularies (a visit has no TRANSPORTING) and detail fields (a job has a
 * priority; a visit doesn't). Callers build their own timeline/extraRows,
 * this only knows how to lay them out. */
function buildResolutionReportHtml({ reference, kindLabel, locationLabel, siteId, description, notes, timeline, checklist, media, extraRows = [] }) {
  const site = siteId ? db.sites.find((s) => s.id === siteId) : null;
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London' }) : '—');
  const checklistRows = (checklist || []).map((item) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e5ea;vertical-align:top">
        <strong>${escHtml(item.title)}</strong><br><span style="color:#6b7280;font-size:13px">${escHtml(item.instructions)}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e5ea;vertical-align:top;white-space:nowrap">
        ${item.status === 'COMPLETE' ? '✅ Complete' : '⬜ Not completed'}<br>
        <span style="color:#6b7280;font-size:12px">${item.completed_at ? fmt(item.completed_at) : ''}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e5ea;vertical-align:top">${escHtml(item.notes || '—')}</td>
    </tr>`).join('');
  const photos = (media || []).map((m) => `
    <div style="display:inline-block;margin:6px;text-align:center">
      <img src="cid:media-${m.id}" style="width:180px;height:135px;object-fit:cover;border-radius:6px;border:1px solid #e2e5ea">
      <div style="font-size:11px;color:#6b7280;margin-top:4px">${fmt(m.taken_at)}</div>
    </div>`).join('');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
    <div style="max-width:640px;margin:0 auto;padding:24px 20px">
      <img src="cid:echelon-wordmark" style="height:34px;margin-bottom:20px">
      <h1 style="font-size:20px;margin:0 0 4px">Resolution report — ${escHtml(reference)}</h1>
      <p style="color:#6b7280;margin:0 0 20px">${escHtml(kindLabel)} · ${escHtml(locationLabel)}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px">
        ${extraRows.map(([label, value]) => `<tr><td style="padding:4px 0;color:#6b7280;width:140px">${escHtml(label)}</td><td>${escHtml(value)}</td></tr>`).join('')}
        <tr><td style="padding:4px 0;color:#6b7280">Site</td><td>${escHtml(site ? site.name : '—')}</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280">Description</td><td>${escHtml(description || '—')}</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280">Notes</td><td>${escHtml(notes || '—')}</td></tr>
      </table>
      <h2 style="font-size:15px;margin:0 0 8px">Timeline</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px">
        ${timeline.map(([label, t]) => `<tr><td style="padding:3px 0;color:#6b7280;width:140px">${label}</td><td>${fmt(t)}</td></tr>`).join('')}
      </table>
      <h2 style="font-size:15px;margin:0 0 8px">Checklist</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        ${checklistRows || '<tr><td style="padding:8px 12px;color:#6b7280">No checklist on this.</td></tr>'}
      </table>
      ${photos ? `<h2 style="font-size:15px;margin:0 0 8px">Photos</h2><div>${photos}</div>` : ''}
      <p style="color:#9ca3af;font-size:11px;margin-top:32px">Sent automatically by CCCS — comms.echeloncic.com</p>
    </div>
  </body></html>`;
}
const MS_GRAPH_SENDER = process.env.MS_GRAPH_SENDER || '';
const RESOLUTION_REPORT_CC = process.env.RESOLUTION_REPORT_CC || '';
const GRAPH_MAIL_ENABLED = Boolean(MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET && MS_GRAPH_SENDER);
let graphTokenCache = { token: null, exp: 0 };
async function getGraphAppToken() {
  if (graphTokenCache.token && Date.now() < graphTokenCache.exp - 30000) return graphTokenCache.token;
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'graph token request failed');
  graphTokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}
async function sendResolutionReportEmail({ reference, siteId, media, mediaDir: mDir, logType, logIdKey, logId }, html) {
  if (!GRAPH_MAIL_ENABLED) { console.warn(`[cccs] resolution report for ${reference} not emailed — Graph mail not configured`); return; }
  const site = siteId ? db.sites.find((s) => s.id === siteId) : null;
  const recipients = [site && site.contact_email, RESOLUTION_REPORT_CC].filter(Boolean);
  if (!recipients.length) { console.warn(`[cccs] resolution report for ${reference} not emailed — no recipient configured`); return; }
  try {
    const attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment', name: 'echelon-wordmark.png', contentId: 'echelon-wordmark', isInline: true,
      contentType: 'image/png', contentBytes: fs.readFileSync(path.join(__dirname, 'public', 'assets', 'echelon-wordmark.png')).toString('base64'),
    }];
    for (const m of media || []) {
      const file = path.join(mDir, path.basename(m.url));
      if (!fs.existsSync(file)) continue;
      attachments.push({
        '@odata.type': '#microsoft.graph.fileAttachment', name: path.basename(file), contentId: `media-${m.id}`, isInline: true,
        contentType: MIME[path.extname(file)] || 'application/octet-stream', contentBytes: fs.readFileSync(file).toString('base64'),
      });
    }
    const token = await getGraphAppToken();
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MS_GRAPH_SENDER)}/sendMail`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { subject: `Resolution report — ${reference}`, body: { contentType: 'HTML', content: html }, toRecipients: recipients.map((address) => ({ emailAddress: { address } })), attachments } }),
    });
    if (!res.ok) console.warn(`[cccs] resolution report email failed for ${reference}:`, res.status, await res.text());
    else logEvent(logType, `RESOLUTION REPORT EMAILED FOR ${reference}`, { [logIdKey]: logId, to: recipients });
  } catch (e) { console.warn(`[cccs] resolution report email failed for ${reference}:`, e.message); }
}

route('PATCH', '/api/jobs/:id', ALL, ({ params, body, user }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  if (body.status) {
    const s = String(body.status).toUpperCase();
    if (!JOB_STATES.includes(s)) throw httpError(400, 'invalid job status');
    assertJobAccess(j, user);
    j.status = s;
    stampJobStatus(j, s);
    if (['COMPLETED', 'CANCELLED'].includes(s)) {
      for (const a of db.job_assignments.filter((x) => x.job_id === j.id)) {
        if (a.mdt_id) { const m = db.mdts.find((x) => x.id === a.mdt_id); if (m) m.job_id = null; }
      }
    }
    if (s === 'COMPLETED') {
      j.resolution_report_html = buildResolutionReportHtml({
        reference: j.reference, kindLabel: j.incident_type, locationLabel: j.location, siteId: j.site_id,
        description: j.description, notes: j.notes, extraRows: [['Priority', j.priority]],
        timeline: [
          ['Job created', j.created_at], ['Dispatched', j.dispatched_at], ['Acknowledged', j.acknowledged_at],
          ['En route', j.en_route_at], ['On scene', j.on_scene_at], ['Completed', j.completed_at],
        ].filter(([, t]) => t),
        checklist: j.checklist, media: j.media,
      });
      sendResolutionReportEmail({
        reference: j.reference, siteId: j.site_id, media: j.media, mediaDir: mediaDir(j.id),
        logType: 'job.report_emailed', logIdKey: 'job_id', logId: j.id,
      }, j.resolution_report_html);
      logEvent('job.report_generated', `RESOLUTION REPORT GENERATED FOR ${j.reference}`, { job_id: j.id });
    }
  }
  if (body.notes !== undefined) j.notes = body.notes;
  // Incident details — mainly for a job auto-created from an emergency,
  // which starts with placeholders (raw coordinates, no description) and
  // gets filled in as the officer actually reports what's going on.
  const DETAIL_FIELDS = { incident_type: 120, location: 200, description: 2000, caller: 200 };
  if (Object.keys(DETAIL_FIELDS).some((f) => body[f] !== undefined)) {
    if (!isControlRole(user.role)) throw httpError(403, 'only control can edit incident details');
    for (const [f, max] of Object.entries(DETAIL_FIELDS)) if (body[f] !== undefined) j[f] = String(body[f]).slice(0, max);
    if (body.what3words !== undefined) j.what3words = String(body.what3words).replace(/^\/+/, '').trim();
  }
  j.updated_at = new Date().toISOString();
  broadcast('job.status_changed', publicJob(j));
  logEvent('job.status_changed', `JOB ${j.reference} → ${j.status}`, { job_id: j.id });
  return publicJob(j);
});
/** Only the assigned personnel/MDT (or control) may touch a job's checklist —
 * same "is this mine" check used by the general job PATCH above, pulled out
 * since both the checklist and media routes need it. */
function assertJobAccess(j, user) {
  if (isControlRole(user.role)) return;
  const mine = db.job_assignments.some((a) => a.job_id === j.id && (
    (user.role === 'FIELD_USER' && user.personnel_id && a.personnel_id === user.personnel_id) ||
    (user.role === 'MDT_USER' && user.mdt_id && a.mdt_id === user.mdt_id)));
  if (!mine) throw httpError(403, 'job not assigned to you');
}
route('PATCH', '/api/jobs/:id/checklist/:itemId', ALL, ({ params, body, user }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  assertJobAccess(j, user);
  const item = (j.checklist || []).find((x) => x.id === params.itemId); if (!item) throw httpError(404, 'checklist item not found');
  if (body.status) {
    const s = String(body.status).toUpperCase();
    if (!['PENDING', 'COMPLETE'].includes(s)) throw httpError(400, 'invalid checklist status');
    item.status = s;
    if (s === 'COMPLETE') { item.completed_at = new Date().toISOString(); item.completed_by = user.display_name; }
    else { item.completed_at = null; item.completed_by = null; }
  }
  if (body.notes !== undefined) item.notes = String(body.notes).slice(0, 2000);
  j.updated_at = new Date().toISOString();
  broadcast('job.status_changed', publicJob(j));
  logEvent('job.checklist_updated', `${item.status === 'COMPLETE' ? 'COMPLETED' : 'UPDATED'} "${item.title}" on JOB ${j.reference}`, { job_id: j.id });
  return publicJob(j);
});

// Same writable directory the SQLite store uses (see store.js) — the
// service's systemd unit runs with ProtectSystem=strict, which makes
// everything else, /opt/cccs/public included, read-only at runtime.
const UPLOADS_DIR = path.join(path.dirname(process.env.DATA_FILE || path.join(__dirname, 'data', 'cccs.db')), 'uploads');
const mediaDir = (jobId) => path.join(UPLOADS_DIR, String(jobId));
// Site visits get their own id space (nextId('site_visits') is independent of
// nextId('jobs')), so a job and a visit can share a numeric id — keep them in
// separate subtrees rather than risk one's photos landing in the other's folder.
const visitMediaDir = (visitId) => path.join(UPLOADS_DIR, 'visits', String(visitId));
const MEDIA_MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
route('POST', '/api/jobs/:id/media', ALL, ({ params, body, user }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  assertJobAccess(j, user);
  const ext = MEDIA_MIME_EXT[body.mimetype];
  if (!ext) throw httpError(400, 'mimetype must be image/jpeg, image/png or image/webp');
  if (!body.data) throw httpError(400, 'data (base64) required');
  if (body.checklist_item_id && !(j.checklist || []).some((x) => x.id === body.checklist_item_id)) throw httpError(404, 'checklist item not found');
  const bytes = Buffer.from(body.data, 'base64');
  if (bytes.length > 8e6) throw httpError(413, 'photo too large');
  const dir = mediaDir(j.id);
  fs.mkdirSync(dir, { recursive: true });
  const mediaId = crypto.randomUUID();
  const filename = `${mediaId}${ext}`;
  fs.writeFileSync(path.join(dir, filename), bytes);
  const media = {
    id: mediaId, url: `/api/jobs/${j.id}/media/${mediaId}`, filename, caption: String(body.caption || '').slice(0, 200),
    checklist_item_id: body.checklist_item_id || null, taken_by: user.display_name, taken_at: new Date().toISOString(),
  };
  j.media = j.media || [];
  j.media.push(media);
  j.updated_at = new Date().toISOString();
  broadcast('job.status_changed', publicJob(j));
  logEvent('job.media_added', `PHOTO ADDED TO JOB ${j.reference}`, { job_id: j.id });
  return { __status: 201, __body: media };
});
route('GET', '/api/jobs/:id/media/:mediaId', ALL, ({ params, user }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  assertJobAccess(j, user);
  const m = (j.media || []).find((x) => x.id === params.mediaId); if (!m) throw httpError(404, 'photo not found');
  const file = path.join(mediaDir(j.id), m.filename);
  if (!fs.existsSync(file)) throw httpError(404, 'photo file missing');
  return { __body: fs.readFileSync(file), __headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'private, max-age=86400' } };
});

route('POST', '/api/jobs/:id/stand-down', CONTROL, ({ params, body }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  const p = body.personnel ? findPersonnel(body.personnel) : null;
  const m = body.mdt ? findMdt(body.mdt) : null;
  if (!p && !m) throw httpError(400, 'personnel or mdt required');
  const a = db.job_assignments.find((x) => x.job_id === j.id && ((p && x.personnel_id === p.id) || (m && x.mdt_id === m.id)));
  if (!a) throw httpError(404, 'that resource is not assigned to this job');
  db.job_assignments = db.job_assignments.filter((x) => x.id !== a.id);
  const who = p ? p.name : m.mdt_code;
  if (m) { m.job_id = null; broadcast('mdt.status_changed', publicMdt(m)); }
  j.updated_at = new Date().toISOString();
  const payload = publicJob(j);
  broadcast('job.status_changed', payload);
  broadcast('job.stood_down', payload, { personnelIds: p ? [p.id] : [], mdtIds: m ? [m.id] : [] });
  logEvent('job.stood_down', `${who} STOOD DOWN FROM JOB ${j.reference}`, { job_id: j.id });
  return payload;
});

// Emergency
/** An emergency needs backup dispatched to it, which means it needs a job —
 * otherwise a supervisor's only way to send other units is to freehand a new
 * job and hope the location matches. Created with no resources assigned:
 * the officer/crew already in trouble aren't who you'd "dispatch" to their
 * own emergency, so this is deliberately backup-only. Location starts as raw
 * coordinates and incident_type/description/caller start as placeholders —
 * there's no reverse geocoding here — and get filled in via the job's own
 * edit fields as details actually come in over the air. */
function createEmergencyJob(ev) {
  const j = {
    id: nextId('jobs'), reference: `INC-${new Date().getFullYear()}-${String(nextId('jobref') + 124).padStart(5, '0')}`,
    incident_type: ev.kind === 'WELFARE' ? 'WELFARE ALARM' : 'OFFICER EMERGENCY', priority: 'RED',
    location: ev.lat != null ? `${ev.lat.toFixed(5)}, ${ev.lon.toFixed(5)} (add details as received)` : 'Location unknown — add details as received',
    site_id: null, keyholder: '', lat: ev.lat, lon: ev.lon,
    description: '', caller: ev.callsign, required_resources: 2, what3words: '',
    notes: '', status: 'CREATED', created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    emergency_id: ev.id, checklist: [], media: [],
  };
  db.jobs.push(j);
  ev.job_id = j.id;
  broadcast('job.created', publicJob(j));
  logEvent('job.created', `JOB ${j.reference} CREATED (RED) — ${j.incident_type} ${ev.callsign}`, { job_id: j.id, emergency_id: ev.id });
  return j;
}

/* ---- Minimal MQTT 3.1.1 publisher ---------------------------------------
 * Publish-only (QoS 0, clean session) — CCCS never subscribes to anything,
 * so there's no need for the parts of MQTT that make a full client
 * complicated (PUBACK/PUBREC/PUBREL/PUBCOMP flows, subscription state,
 * reconnect logic). One TCP connection per publish: CONNECT, wait for
 * CONNACK, PUBLISH, DISCONNECT, close — same hand-rolled-over-node:net
 * approach already used for the WebSocket signalling server elsewhere in
 * this file, rather than pulling in an MQTT client package for a handful
 * of packet types. */
function mqttEncodeString(str) {
  const buf = Buffer.from(str, 'utf8');
  const len = Buffer.alloc(2); len.writeUInt16BE(buf.length);
  return Buffer.concat([len, buf]);
}
function mqttEncodeRemainingLength(n) {
  const bytes = [];
  do {
    let b = n % 128; n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}
function mqttConnectPacket({ clientId, username, password, keepAlive = 30 }) {
  let flags = 0x02; // clean session
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;
  const keepAliveBuf = Buffer.alloc(2); keepAliveBuf.writeUInt16BE(keepAlive);
  const parts = [mqttEncodeString('MQTT'), Buffer.from([4]), Buffer.from([flags]), keepAliveBuf, mqttEncodeString(clientId)];
  if (username) parts.push(mqttEncodeString(username));
  if (password) parts.push(mqttEncodeString(password));
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x10]), mqttEncodeRemainingLength(body.length), body]);
}
function mqttPublishPacket({ topic, payload }) {
  const body = Buffer.concat([mqttEncodeString(topic), Buffer.from(payload, 'utf8')]); // QoS 0: no packet identifier
  return Buffer.concat([Buffer.from([0x30]), mqttEncodeRemainingLength(body.length), body]);
}
const MQTT_DISCONNECT_PACKET = Buffer.from([0xe0, 0x00]);

const MQTT_PING_PACKET = Buffer.from([0xc0, 0x00]);

/* A persistent connection, not one-shot per event — AURA's source config
 * has a "warn if silent for 300s (big alarm + siren)" watchdog on by
 * default, so a client that only ever appears for a few hundred ms per
 * rare emergency reads to it as a dead/flapping source, not a healthy
 * idle one. This holds one connection open for the process lifetime,
 * reconnecting on drop, and a periodic heartbeat message on the same
 * topic keeps AURA's watchdog satisfied between real events. */
const mqttState = { socket: null, connected: false, buf: Buffer.alloc(0) };
function mqttStart({ host, port, username, password, clientId, keepAlive = 60 }) {
  if (mqttState.socket) return;
  const socket = net.connect({ host, port });
  mqttState.socket = socket;
  mqttState.buf = Buffer.alloc(0);
  let pingTimer = null;
  socket.on('connect', () => socket.write(mqttConnectPacket({ clientId, username, password, keepAlive })));
  socket.on('data', (chunk) => {
    mqttState.buf = Buffer.concat([mqttState.buf, chunk]);
    // Only CONNACK (once) and PINGRESP are ever expected back — never
    // SUBSCRIBEd to anything, so no PUBLISH can arrive from the broker.
    while (mqttState.buf.length >= 2) {
      const packetType = mqttState.buf[0] & 0xf0;
      if (packetType === 0x20 && !mqttState.connected) {
        const returnCode = mqttState.buf[3];
        mqttState.buf = mqttState.buf.subarray(4);
        if (returnCode !== 0) { console.warn(`[cccs] MQTT broker rejected connection (return code ${returnCode})`); socket.destroy(); return; }
        mqttState.connected = true;
        pingTimer = setInterval(() => { if (mqttState.socket) mqttState.socket.write(MQTT_PING_PACKET); }, keepAlive * 1000 * 0.8).unref?.();
      } else if (packetType === 0xd0) {
        mqttState.buf = mqttState.buf.subarray(2); // PINGRESP, nothing to do
      } else {
        mqttState.buf = Buffer.alloc(0); // unexpected — drop rather than get stuck re-parsing garbage
      }
    }
  });
  const reconnect = () => {
    if (pingTimer) clearInterval(pingTimer);
    mqttState.socket = null; mqttState.connected = false;
    setTimeout(() => mqttStart({ host, port, username, password, clientId, keepAlive }), 10000).unref?.();
  };
  socket.on('error', (e) => { console.warn('[cccs] MQTT connection error:', e.message); reconnect(); });
  socket.on('close', reconnect);
}
function mqttPublishNow(topic, payload) {
  if (!mqttState.connected || !mqttState.socket) return false;
  mqttState.socket.write(mqttPublishPacket({ topic, payload }));
  return true;
}

/* ---- SIA-format encoding -------------------------------------------------
 * Confirmed with the AURA side: the arc/rx/cccs provider parses raw SIA-
 * format signals, not JSON — every JSON attempt landed as an unparsed
 * signal with no account attached. An initial attempt at the full SIA
 * DC-09-2007 wire packet (CRC/length/"SIA-DCS" framing) still didn't
 * parse; what actually works was confirmed by example — a genuine
 * "Automatic (periodic) test" event relayed through the same MQTT bridge
 * from another receiver came through as exactly:
 *   S016[#7000|Nri0/RP0000]
 * i.e. this relay's own lighter framing (S + 3-digit sequence) around the
 * SIA data block, not the full DC-09 packet. Matched here exactly rather
 * than guessed. */
let siaSeq = 0;
function buildSia({ acct, data }) {
  siaSeq = (siaSeq % 999) + 1;
  return `S${String(siaSeq).padStart(3, '0')}[#${acct}|${data}]`;
}

/* ---- AURA alarm forwarding ---------------------------------------------
 * AURA is Echelon's alarm receiving centre platform — an emergency button
 * press is exactly what an ARC exists to see, so it's forwarded the moment
 * one is raised, over MQTT rather than AURA's REST alarm intake (its
 * endpoint wasn't reachable when that was tried — see git history).
 * Fire-and-forget: a slow or failed publish must never block or fail the
 * emergency flow itself, since that's the one thing here that must never
 * silently not work. */
const MQTT_HOST = process.env.MQTT_HOST || '';
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'arc/rx/cccs';
const AURA_ACCT = process.env.AURA_ACCT || '8581'; // Echelon Control Centre
const MQTT_HEARTBEAT_S = Number(process.env.MQTT_HEARTBEAT_S || 60); // cadence of the SIA "automatic test" event below — an operator-visible signal, not the connection keep-alive (see MQTT_ACK_* just below)
// Separate from the SIA periodic test above: GuardM8 also wants a plain
// connection keep-alive on its own topic, independent of anything
// operator-visible. Content doesn't matter to GuardM8 for this one (their
// own words) -- a timestamp, just so it's not literally empty.
const MQTT_ACK_TOPIC = process.env.MQTT_ACK_TOPIC || 'guardm8/ack/cccs';
const MQTT_ACK_INTERVAL_S = Number(process.env.MQTT_ACK_INTERVAL_S || 180);
// JSON over this topic was confirmed not to parse at all (see above) — hold
// publishing behind this flag until a real SIA DC-09 send has been checked
// against AURA at least once, same reasoning as before: a wrong guess here
// creates a stale alarm card in a live queue, not a silent failure.
const MQTT_AURA_PUBLISH_ENABLED = process.env.MQTT_AURA_PUBLISH_ENABLED === '1';
if (MQTT_HOST) {
  mqttStart({ host: MQTT_HOST, port: MQTT_PORT, username: MQTT_USERNAME || undefined, password: MQTT_PASSWORD || undefined, clientId: 'cccs' });
  if (MQTT_AURA_PUBLISH_ENABLED) {
    setInterval(() => {
      mqttPublishNow(MQTT_TOPIC, buildSia({ acct: AURA_ACCT, data: 'Nri0/RP0000' })); // RP = SIA "automatic test report" — the standard periodic test/heartbeat code, not a real alarm. Matches the confirmed-working example exactly.
    }, MQTT_HEARTBEAT_S * 1000).unref?.();
    setInterval(() => {
      mqttPublishNow(MQTT_ACK_TOPIC, new Date().toISOString());
    }, MQTT_ACK_INTERVAL_S * 1000).unref?.();
  }
}
// SIA's zone field is numeric-only (4 digits in every confirmed example) —
// a callsign like "P101" doesn't fit as-is, so use its digits: "P101" -> 0101.
// Falls back to 0000 for a callsign with no digits at all.
function zoneFromCallsign(callsign) {
  const digits = String(callsign || '').replace(/\D/g, '');
  return (digits || '0').slice(-4).padStart(4, '0');
}
function forwardEmergencyToAura(ev) {
  if (!MQTT_HOST || !MQTT_AURA_PUBLISH_ENABLED) return;
  const zone = zoneFromCallsign(ev.callsign);
  const packet = buildSia({ acct: AURA_ACCT, data: `Nri0/PA${zone}` }); // PA = SIA panic alarm
  if (!mqttPublishNow(MQTT_TOPIC, packet)) console.warn(`[cccs] AURA MQTT publish skipped for emergency ${ev.id} — not connected to broker`);
}

route('POST', '/api/emergency', ALL, ({ body, user }) => {
  const person = user.role === 'FIELD_USER' ? db.personnel.find((p) => p.id === user.personnel_id) : (body.personnel ? findPersonnel(body.personnel) : null);
  const mdt = user.role === 'MDT_USER' ? db.mdts.find((m) => m.id === user.mdt_id) : (body.mdt ? findMdt(body.mdt) : null);
  if (!person && !mdt) throw httpError(404, 'personnel or mdt not found');
  const open = db.emergency_events.find((e) => ((person && e.personnel_id === person.id) || (mdt && e.mdt_id === mdt.id)) && e.state !== 'RESOLVED');
  if (open) return open;
  // The device takes a fresh GPS fix the instant the button is pressed and
  // sends it here — trust that over whatever lat/lon happens to be on file,
  // since an idle terminal's stored position can be stale (or, before it's
  // ever reported one, still whatever it was seeded with).
  const who = person || mdt;
  if (body.lat != null && body.lon != null) { who.lat = Number(body.lat); who.lon = Number(body.lon); }
  if (mdt) { mdt.emergency = true; broadcast('mdt.status_changed', publicMdt(mdt)); }
  const callsign = person ? callsignOf(person) : callsignOf(mdt);
  const ev = {
    id: nextId('emergency_events'), kind: 'EMERGENCY', personnel_id: person ? person.id : null, mdt_id: mdt ? mdt.id : null,
    mdt_code: mdt ? mdt.mdt_code : null, callsign,
    lat: who.lat, lon: who.lon, state: 'ACTIVE', activated_at: new Date().toISOString(),
    acknowledged_at: null, acknowledged_by: null, resolved_at: null, job_id: null,
  };
  db.emergency_events.push(ev);
  createEmergencyJob(ev);
  broadcast('emergency.activated', ev);
  pushToRoles(CONTROL, { title: 'EMERGENCY', body: `${ev.callsign}`, url: '/control.html', tag: 'cccs-emergency' });
  forwardEmergencyToAura(ev);
  store.flushNow();
  logEvent('emergency.activated', `!!! EMERGENCY — ${ev.callsign}`, { emergency_id: ev.id, personnel_id: ev.personnel_id, mdt_id: ev.mdt_id });
  return { __status: 201, __body: ev };
});
route('GET', '/api/emergency', ALL, () => db.emergency_events.slice(-100));
route('POST', '/api/emergency/:id/ack', CONTROL, ({ params, user }) => {
  const ev = db.emergency_events.find((e) => e.id === Number(params.id)); if (!ev) throw httpError(404, 'emergency not found');
  ev.state = 'ACKNOWLEDGED'; ev.acknowledged_at = new Date().toISOString(); ev.acknowledged_by = user.display_name;
  broadcast('emergency.acknowledged', ev);
  logEvent('emergency.acknowledged', `EMERGENCY ${ev.callsign} ACKNOWLEDGED BY ${user.display_name}`, { emergency_id: ev.id });
  return ev;
});
route('POST', '/api/emergency/:id/resolve', CONTROL, ({ params, user }) => {
  const ev = db.emergency_events.find((e) => e.id === Number(params.id)); if (!ev) throw httpError(404, 'emergency not found');
  ev.state = 'RESOLVED'; ev.resolved_at = new Date().toISOString();
  const mdt = db.mdts.find((m) => m.id === ev.mdt_id);
  if (mdt) { mdt.emergency = false; broadcast('mdt.status_changed', publicMdt(mdt)); }
  broadcast('emergency.resolved', ev);
  logEvent('emergency.resolved', `EMERGENCY ${ev.callsign} RESOLVED BY ${user.display_name}`, { emergency_id: ev.id });
  return ev;
});

// Messaging
route('GET', '/api/messages', ALL, ({ user, query }) => {
  const mine = db.messages.filter((m) => {
    if (isControlRole(user.role)) return true;
    if (user.role === 'FIELD_USER') return m.to_personnel_id === user.personnel_id || m.from_personnel_id === user.personnel_id;
    if (user.role === 'MDT_USER') return m.to_mdt_id === user.mdt_id || m.from_mdt_id === user.mdt_id;
    return false;
  });
  const lim = Number(query.get('limit') || 100);
  return mine.slice(-lim);
});
route('POST', '/api/messages', ALL, ({ body, user }) => {
  const toPerson = body.to_personnel ? findPersonnel(body.to_personnel) : null;
  const toMdt = body.to_mdt ? findMdt(body.to_mdt) : null;
  if (!toPerson && !toMdt && !body.to_control) throw httpError(400, 'recipient required');
  const fromPerson = user.role === 'FIELD_USER' ? db.personnel.find((p) => p.id === user.personnel_id) : null;
  const fromMdt = user.role === 'MDT_USER' ? db.mdts.find((m) => m.id === user.mdt_id) : null;
  const msg = {
    id: nextId('messages'), body: String(body.body || '').slice(0, 1000),
    from_label: fromPerson ? callsignOf(fromPerson) : fromMdt ? fromMdt.mdt_code : 'CONTROL',
    from_personnel_id: fromPerson ? fromPerson.id : null, from_mdt_id: fromMdt ? fromMdt.id : null,
    to_personnel_id: toPerson ? toPerson.id : null, to_mdt_id: toMdt ? toMdt.id : null,
    to_label: toPerson ? callsignOf(toPerson) : toMdt ? toMdt.mdt_code : 'CONTROL',
    state: 'DELIVERED', sent_at: new Date().toISOString(), read_at: null,
  };
  if (!msg.body) throw httpError(400, 'message body required');
  db.messages.push(msg);
  broadcast('message.received', msg, { personnelIds: toPerson ? [toPerson.id] : undefined, mdtIds: toMdt ? [toMdt.id] : undefined });
  logEvent('message.sent', `${msg.from_label} ✉ ${msg.to_label}: ${msg.body.slice(0, 60)}`, { message_id: msg.id });
  return { __status: 201, __body: msg };
});
route('POST', '/api/messages/:id/read', ALL, ({ params }) => {
  const m = db.messages.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'message not found');
  m.state = 'READ'; m.read_at = new Date().toISOString();
  broadcast('message.read', m);
  return m;
});

// Events / audit
route('GET', '/api/events', ALL, ({ query }) => {
  let ev = db.audit_logs.slice();
  const type = query.get('type'); const q = query.get('q'); const since = query.get('since');
  if (type) ev = ev.filter((e) => e.type.startsWith(type));
  if (q) ev = ev.filter((e) => e.summary.toLowerCase().includes(q.toLowerCase()));
  if (since) ev = ev.filter((e) => e.at >= since);
  return ev.slice(-Number(query.get('limit') || 200));
});
route('GET', '/api/state', ALL, () => ({
  mdts: db.mdts.map(publicMdt), jobs: db.jobs.map(publicJob),
  personnel: db.personnel.map(publicPersonnel), sites: db.sites,
  site_visits: db.site_visits.map(publicSiteVisit),
  emergencies: db.emergency_events.filter((e) => e.state !== 'RESOLVED'),
  events: db.audit_logs.slice(-80), server_time: new Date().toISOString(),
}));
/* ------------------------------------------------------------------ *
 * Data retention
 *
 * This system tracks employees' locations continuously and records their
 * welfare check-ins. Under UK GDPR that is personal data about staff, held on
 * a legitimate-interest basis, and keeping it forever is not defensible —
 * "we never got round to deleting it" is not a retention policy.
 *
 * Defaults below are deliberately short. Lengthen them if you have a reason you
 * could state to an officer who asked, and write that reason down. See
 * docs/PRIVACY.md.
 * ------------------------------------------------------------------ */
const RETENTION = {
  // Minute-by-minute vehicle tracking. Short: its operational value expires
  // within days, its intrusiveness does not.
  locations: Number(process.env.RETAIN_LOCATIONS_DAYS || 31),
  // Who was where on which job — the audit trail you would need for a client
  // dispute or an insurance claim.
  audit: Number(process.env.RETAIN_AUDIT_DAYS || 365),
  // Message records.
  messages: Number(process.env.RETAIN_MESSAGES_DAYS || 180),
  // Closed jobs.
  jobs: Number(process.env.RETAIN_JOBS_DAYS || 730),
  // Shift-handover notes — kept alongside the audit trail's horizon since
  // they carry the same "what happened at this site" evidentiary value.
  passdown: Number(process.env.RETAIN_PASSDOWN_DAYS || 365),
};

function pruneOlderThan(table, days, field) {
  if (!days || days <= 0) return 0;
  const cutoff = Date.now() - days * 86400000;
  const before = db[table].length;
  db[table] = db[table].filter((row) => {
    const at = Date.parse(row[field] || row.at || row.recorded_at || 0);
    return !at || at >= cutoff;
  });
  return before - db[table].length;
}

function retentionSweep() {
  const removed = {
    locations: pruneOlderThan('locations', RETENTION.locations, 'at'),
    audit_logs: pruneOlderThan('audit_logs', RETENTION.audit, 'at'),
    messages: pruneOlderThan('messages', RETENTION.messages, 'sent_at'),
    passdown_logs: pruneOlderThan('passdown_logs', RETENTION.passdown, 'created_at'),
  };

  // Jobs are only removed once they are finished — an open job is
  // operational data, not history, however old it is.
  const jobCutoff = Date.now() - RETENTION.jobs * 86400000;
  const keptJobs = db.jobs.filter((j) => !['COMPLETED', 'CANCELLED'].includes(j.status) || Date.parse(j.updated_at) >= jobCutoff);
  removed.jobs = db.jobs.length - keptJobs.length;
  const goneJobIds = new Set(db.jobs.filter((j) => !keptJobs.includes(j)).map((j) => j.id));
  db.jobs = keptJobs;
  db.job_assignments = db.job_assignments.filter((a) => !goneJobIds.has(a.job_id));

  // Same rule as jobs: a finished visit is history once it's old enough, an
  // open or missed one stays — coverage gaps should stay visible, not age out.
  const visitCutoff = Date.now() - RETENTION.jobs * 86400000;
  const keptVisits = db.site_visits.filter((v) => !['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status) || Date.parse(v.updated_at) >= visitCutoff);
  removed.site_visits = db.site_visits.length - keptVisits.length;
  db.site_visits = keptVisits;

  const total = Object.values(removed).reduce((a, b) => a + b, 0);
  if (total) {
    const detail = Object.entries(removed).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
    logEvent('retention.swept', `RETENTION SWEEP REMOVED ${total} RECORDS (${detail})`, removed);
    store.flushNow();
  }
  return removed;
}

route('GET', '/api/retention', CONTROL, () => ({
  policy_days: RETENTION,
  counts: Object.fromEntries(['locations', 'audit_logs', 'messages', 'jobs', 'site_visits']
    .map((t) => [t, db[t].length])),
  note: 'Location history is the most intrusive data here and is kept for the shortest time.',
}));
route('POST', '/api/retention/sweep', ADMIN, ({ user }) => {
  const removed = retentionSweep();
  logEvent('retention.manual', `MANUAL RETENTION SWEEP BY ${user.username}`);
  return removed;
});

/* Erasure request: remove one person's movement history without touching the
   operational record of jobs, which the business needs to keep. */
route('POST', '/api/personnel/:id/erase-location-history', ADMIN, ({ params, user }) => {
  const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
  const before = db.locations.length;
  db.locations = db.locations.filter((l) => l.personnel_id !== p.id);
  const removed = before - db.locations.length;
  logEvent('retention.erasure', `LOCATION HISTORY ERASED FOR ${callsignOf(p)} (${removed} points) BY ${user.username}`, { personnel_id: p.id, removed });
  store.flushNow();
  return { personnel: p.name, removed };
});

/* ------------------------------------------------------------------ *
 * Call requests
 *
 * An officer who cannot talk — or who does not want to tie up the channel —
 * asks control to call them. Routine and priority are separate queues at the
 * console: a priority request is the officer saying "something is happening",
 * one step below pressing SOS, and it should be answered in seconds.
 * ------------------------------------------------------------------ */
route('POST', '/api/calls/request', ALL, ({ body, user }) => {
  const person = user.role === 'FIELD_USER'
    ? db.personnel.find((p) => p.id === user.personnel_id)
    : findPersonnel(body.personnel);
  if (!person) throw httpError(404, 'personnel not found');

  const priority = body.priority === true || String(body.priority).toUpperCase() === 'PRIORITY';
  const open = db.call_requests.find((r) => r.personnel_id === person.id && r.state === 'PENDING');
  if (open) {
    // A second press escalates rather than stacking another row.
    if (priority && !open.priority) {
      open.priority = true; open.escalated_at = new Date().toISOString();
      broadcast('call.request', open);
      logEvent('call.request_escalated', `${callsignOf(person)} ESCALATED CALL REQUEST TO PRIORITY`, { request_id: open.id });
      store.flushNow();
    }
    return open;
  }

  const req = {
    id: nextId('call_requests'), personnel_id: person.id,
    callsign: callsignOf(person), priority, note: String(body.note || '').slice(0, 200) || null,
    state: 'PENDING',
    requested_at: new Date().toISOString(), answered_at: null, answered_by: null, cancelled_at: null,
  };
  db.call_requests.push(req);
  broadcast('call.request', req);
  logEvent('call.requested', `${req.callsign} REQUESTS ${priority ? 'PRIORITY ' : ''}CALL`, { request_id: req.id, personnel_id: person.id });
  if (priority) store.flushNow();
  return { __status: 201, __body: req };
});

route('GET', '/api/calls/requests', ALL, ({ query }) => {
  const state = (query.get('state') || 'PENDING').toUpperCase();
  return state === 'ALL' ? db.call_requests.slice(-200) : db.call_requests.filter((r) => r.state === state);
});

route('POST', '/api/calls/requests/:id/clear', ALL, ({ params, user }) => {
  const req = db.call_requests.find((r) => r.id === Number(params.id));
  if (!req) throw httpError(404, 'request not found');
  if (user.role === 'FIELD_USER' && user.personnel_id !== req.personnel_id) throw httpError(403, 'not your request');
  if (req.state !== 'PENDING') return req;
  const byOfficer = user.role === 'FIELD_USER';
  req.state = byOfficer ? 'CANCELLED' : 'ANSWERED';
  req[byOfficer ? 'cancelled_at' : 'answered_at'] = new Date().toISOString();
  if (!byOfficer) req.answered_by = user.display_name;
  broadcast('call.request_cleared', req);
  logEvent('call.request_cleared', `CALL REQUEST FROM ${req.callsign} ${req.state} ${byOfficer ? '' : 'BY ' + user.display_name}`.trim(), { request_id: req.id });
  return req;
});

/* ------------------------------------------------------------------ *
 * Lone worker welfare timers
 *
 * An officer sets a timer before entering a site. If they do not check in
 * before it expires, control is alerted with their last known position. This
 * is the feature that carries the most weight in a commercial security
 * operation — it is what your lone-worker policy and your insurer will ask
 * about, and it must fail loudly rather than silently.
 * ------------------------------------------------------------------ */
const WELFARE_TICK_MS = Number(process.env.WELFARE_TICK_MS || 5000);
const WELFARE_WARN_S = Number(process.env.WELFARE_WARN_S || 60);

function startWelfare(person, intervalS, note) {
  if (!Number.isFinite(intervalS) || intervalS < 30 || intervalS > 8 * 3600) {
    throw httpError(400, 'welfare interval must be between 30 seconds and 8 hours');
  }
  person.welfare_interval_s = Math.round(intervalS);
  person.welfare_due_at = new Date(Date.now() + person.welfare_interval_s * 1000).toISOString();
  person.welfare_warned = false;
  person.welfare_note = note || null;
  const payload = { personnel: publicPersonnel(person), note: person.welfare_note };
  broadcast('welfare.started', payload);
  logEvent('welfare.started', `${callsignOf(person)} WELFARE TIMER ${person.welfare_interval_s}s${note ? ' — ' + note : ''}`, { personnel_id: person.id });
  return person;
}

function checkInWelfare(person) {
  if (!person.welfare_due_at) throw httpError(409, 'no welfare timer running');
  person.welfare_due_at = new Date(Date.now() + person.welfare_interval_s * 1000).toISOString();
  person.welfare_warned = false;
  // Clear any overdue alarm this person had raised.
  for (const ev of db.emergency_events) {
    if (ev.personnel_id === person.id && ev.kind === 'WELFARE' && ev.state !== 'RESOLVED') {
      ev.state = 'RESOLVED'; ev.resolved_at = new Date().toISOString();
      broadcast('emergency.resolved', ev);
    }
  }
  broadcast('welfare.checked_in', publicPersonnel(person));
  logEvent('welfare.checked_in', `${callsignOf(person)} CHECKED IN`, { personnel_id: person.id });
  return person;
}

function stopWelfare(person, reason = 'cancelled') {
  person.welfare_interval_s = null; person.welfare_due_at = null; person.welfare_warned = false; person.welfare_note = null;
  broadcast('welfare.stopped', publicPersonnel(person));
  logEvent('welfare.stopped', `${callsignOf(person)} WELFARE TIMER ${reason.toUpperCase()}`, { personnel_id: person.id });
  return person;
}

function welfareTick() {
  const now = Date.now();
  for (const person of db.personnel) {
    if (!person.welfare_due_at) continue;
    const due = Date.parse(person.welfare_due_at);
    if (now >= due) {
      person.welfare_due_at = null; person.welfare_interval_s = null;
      const ev = {
        id: nextId('emergency_events'), kind: 'WELFARE', personnel_id: person.id,
        callsign: callsignOf(person), lat: null, lon: null, state: 'ACTIVE',
        note: person.welfare_note || null,
        activated_at: new Date().toISOString(), acknowledged_at: null, acknowledged_by: null, resolved_at: null,
      };
      db.emergency_events.push(ev);
      createEmergencyJob(ev);
      broadcast('welfare.overdue', ev);
      broadcast('emergency.activated', ev);
      pushToRoles(CONTROL, { title: 'Welfare alarm', body: `${ev.callsign} — no check-in`, url: '/control.html', tag: 'cccs-emergency' });
      logEvent('welfare.overdue', `!!! WELFARE OVERDUE — ${ev.callsign} NO CHECK-IN`, { emergency_id: ev.id, personnel_id: person.id });
      store.flushNow();
    } else if (!person.welfare_warned && due - now <= WELFARE_WARN_S * 1000) {
      person.welfare_warned = true;
      broadcast('welfare.due_soon', { personnel: publicPersonnel(person), seconds_left: Math.round((due - now) / 1000) }, { personnelIds: [person.id] });
    }
  }
}

route('POST', '/api/personnel/:id/welfare', ALL, ({ params, body, user }) => {
  const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
  if (user.role === 'FIELD_USER' && user.personnel_id !== p.id) throw httpError(403, 'not you');
  return publicPersonnel(startWelfare(p, Number(body.interval_s), body.note));
});
route('POST', '/api/personnel/:id/welfare/check', ALL, ({ params, user }) => {
  const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
  if (user.role === 'FIELD_USER' && user.personnel_id !== p.id) throw httpError(403, 'not you');
  return publicPersonnel(checkInWelfare(p));
});
route('DELETE', '/api/personnel/:id/welfare', ALL, ({ params, user }) => {
  const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
  if (user.role === 'FIELD_USER' && user.personnel_id !== p.id) throw httpError(403, 'not you');
  if (!p.welfare_due_at) throw httpError(409, 'no welfare timer running');
  return publicPersonnel(stopWelfare(p, user.role === 'FIELD_USER' ? 'cancelled by officer' : 'cancelled by control'));
});

/* Sites under contract — what alarm response jobs are attached to. */
route('GET', '/api/sites', ALL, () => db.sites);
route('POST', '/api/sites', CONTROL, ({ body }) => {
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'name required');
  if (db.sites.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'site already exists');
  const site = {
    id: nextId('sites'), name, address: body.address || '', lat: Number(body.lat) || null, lon: Number(body.lon) || null,
    keyholder: body.keyholder || '', contact_email: body.contact_email || '', contract: 'ACTIVE', checklist: [],
  };
  db.sites.push(site);
  logEvent('site.created', `SITE ${name} ADDED`);
  return { __status: 201, __body: site };
});
route('PATCH', '/api/sites/:id', ADMIN, ({ params, body }) => {
  const site = db.sites.find((x) => x.id === Number(params.id));
  if (!site) throw httpError(404, 'site not found');
  if ('name' in body) {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name required');
    if (db.sites.some((x) => x.id !== site.id && x.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'site already exists');
    site.name = name;
  }
  if ('address' in body) site.address = body.address || '';
  if ('lat' in body) site.lat = body.lat === null || body.lat === '' ? null : Number(body.lat);
  if ('lon' in body) site.lon = body.lon === null || body.lon === '' ? null : Number(body.lon);
  if ('keyholder' in body) site.keyholder = body.keyholder || '';
  if ('contact_email' in body) site.contact_email = body.contact_email || '';
  if ('checklist' in body) {
    if (!Array.isArray(body.checklist)) throw httpError(400, 'checklist must be an array');
    site.checklist = body.checklist.map((item) => ({
      id: item.id || crypto.randomUUID(), title: String(item.title || '').trim(), instructions: String(item.instructions || '').trim(),
    })).filter((item) => item.title);
  }
  logEvent('site.updated', `SITE ${site.name} UPDATED`, { site_id: site.id });
  return site;
});
route('DELETE', '/api/sites/:id', ADMIN, ({ params }) => {
  const site = db.sites.find((x) => x.id === Number(params.id));
  if (!site) throw httpError(404, 'site not found');
  if (db.jobs.some((j) => j.site_id === site.id && !['COMPLETED', 'CANCELLED'].includes(j.status))) {
    throw httpError(409, 'site has an open job — resolve or cancel it first');
  }
  if (db.patrol_schedules.some((s) => s.site_id === site.id)) {
    throw httpError(409, 'site has patrol schedules — delete them first');
  }
  if (db.beats.some((b) => b.site_id === site.id)) {
    throw httpError(409, 'site has beats — delete them first');
  }
  if (db.site_visits.some((v) => v.site_id === site.id && !['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status))) {
    throw httpError(409, 'site has an open site visit — resolve or cancel it first');
  }
  db.sites = db.sites.filter((x) => x.id !== site.id);
  logEvent('site.deleted', `SITE ${site.name} DELETED`, { site_id: site.id });
  return { ok: true };
});

/* Passdown logs — per-site shift-handover notes. Control can read/write any
 * site's log; a FIELD_USER can read/write a site's log only if they've
 * actually been assigned there (a current or past shift or site visit) — the
 * same "were you ever posted here" test either row type already answers, so
 * no separate roster is needed. Entries are an append-only log, like the
 * audit trail: no edit route, a DELETE for control to correct a mistake. */
function assertPassdownAccess(siteId, user) {
  if (isControlRole(user.role)) return;
  if (user.role === 'FIELD_USER' && user.personnel_id) {
    const hasShift = db.shifts.some((s) => s.personnel_id === user.personnel_id && s.site_id === siteId);
    const hasVisit = db.site_visits.some((v) => v.site_id === siteId
      && (v.personnel_id === user.personnel_id || (v.additional_personnel || []).includes(user.personnel_id)));
    if (hasShift || hasVisit) return;
  }
  throw httpError(403, 'not assigned to this site');
}
route('GET', '/api/passdown-logs', ALL, ({ query, user }) => {
  const siteId = Number(query.get('site_id'));
  if (!siteId) throw httpError(400, 'site_id required');
  if (!db.sites.some((s) => s.id === siteId)) throw httpError(404, 'site not found');
  assertPassdownAccess(siteId, user);
  return db.passdown_logs.filter((l) => l.site_id === siteId)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map(publicPassdownLog);
});
route('POST', '/api/passdown-logs', ALL, ({ body, user }) => {
  const site = db.sites.find((s) => s.id === Number(body.site_id));
  if (!site) throw httpError(400, 'site_id must reference an existing site');
  assertPassdownAccess(site.id, user);
  const text = String(body.body || '').trim();
  if (!text) throw httpError(400, 'body required');
  const author = user.role === 'FIELD_USER' && user.personnel_id ? db.personnel.find((p) => p.id === user.personnel_id) : null;
  const log = {
    id: nextId('passdown_logs'), site_id: site.id, body: text.slice(0, 4000),
    author_personnel_id: author ? author.id : null, author_name: author ? author.name : user.display_name,
    created_at: new Date().toISOString(),
  };
  db.passdown_logs.push(log);
  broadcast('passdown_log.created', publicPassdownLog(log));
  logEvent('passdown_log.created', `PASSDOWN NOTE ADDED FOR ${site.name} BY ${log.author_name}`, { site_id: site.id, passdown_log_id: log.id });
  return { __status: 201, __body: publicPassdownLog(log) };
});
route('DELETE', '/api/passdown-logs/:id', ADMIN, ({ params }) => {
  const l = db.passdown_logs.find((x) => x.id === Number(params.id)); if (!l) throw httpError(404, 'passdown log not found');
  db.passdown_logs = db.passdown_logs.filter((x) => x.id !== l.id);
  logEvent('passdown_log.deleted', 'PASSDOWN NOTE DELETED', { passdown_log_id: l.id, site_id: l.site_id });
  return { ok: true };
});

/* Beats — a named patrol route within a site (e.g. "Perimeter", "Car park
 * sweep"), for sites where one checklist doesn't describe the work. Purely
 * optional: a patrol schedule or a manually created visit can reference one,
 * but neither requires it — a site with no beats behaves exactly as before. */
route('GET', '/api/beats', ALL, ({ query }) => {
  let rows = db.beats.map(publicBeat);
  if (query.get('site_id')) rows = rows.filter((b) => b.site_id === Number(query.get('site_id')));
  return rows;
});
route('POST', '/api/beats', CONTROL, ({ body }) => {
  const site = db.sites.find((s) => s.id === Number(body.site_id));
  if (!site) throw httpError(400, 'site_id must reference an existing site');
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'name required');
  const beat = { id: nextId('beats'), site_id: site.id, name, description: body.description || '', waypoints: [], active: body.active !== false };
  db.beats.push(beat);
  logEvent('beat.created', `BEAT "${name}" CREATED FOR ${site.name}`, { beat_id: beat.id });
  return { __status: 201, __body: publicBeat(beat) };
});
route('PATCH', '/api/beats/:id', CONTROL, ({ params, body }) => {
  const b = db.beats.find((x) => x.id === Number(params.id)); if (!b) throw httpError(404, 'beat not found');
  if ('name' in body) { const name = String(body.name || '').trim(); if (!name) throw httpError(400, 'name required'); b.name = name; }
  if ('description' in body) b.description = body.description || '';
  if ('active' in body) b.active = Boolean(body.active);
  if ('waypoints' in body) {
    if (!Array.isArray(body.waypoints)) throw httpError(400, 'waypoints must be an array');
    b.waypoints = body.waypoints.map((w) => ({
      id: w.id || crypto.randomUUID(), title: String(w.title || '').trim(), instructions: String(w.instructions || '').trim(),
    })).filter((w) => w.title);
  }
  logEvent('beat.updated', `BEAT "${b.name}" UPDATED`, { beat_id: b.id });
  return publicBeat(b);
});
route('DELETE', '/api/beats/:id', ADMIN, ({ params }) => {
  const b = db.beats.find((x) => x.id === Number(params.id)); if (!b) throw httpError(404, 'beat not found');
  if (db.patrol_schedules.some((s) => s.beat_id === b.id)) throw httpError(409, 'beat has patrol schedules — reassign or delete them first');
  if (db.site_visits.some((v) => v.beat_id === b.id && !['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status))) {
    throw httpError(409, 'beat has an open site visit — resolve or cancel it first');
  }
  db.beats = db.beats.filter((x) => x.id !== b.id);
  logEvent('beat.deleted', `BEAT "${b.name}" DELETED`, { beat_id: b.id });
  return { ok: true };
});

/* ------------------------------------------------------------------ *
 * Patrol schedules and site visits
 *
 * A scheduled, recurring alternative to one-off jobs: a patrol_schedules
 * row describes a recurrence ("every Tuesday/Thursday at 22:00" or "every
 * 4 hours"); patrolScheduleTick() below turns a due occurrence into a
 * site_visits row, which then walks the same DISPATCHED -> ACKNOWLEDGED ->
 * EN_ROUTE -> ON_SCENE -> COMPLETED lifecycle as a job, reusing the same
 * checklist/photo/resolution-report machinery. Deliberately simpler than
 * job_assignments: a visit carries its assignee(s) directly (personnel_id +
 * additional_personnel[]) rather than through a join table, since a visit
 * is never assigned to an MDT — it's foot-patrol work.
 * ------------------------------------------------------------------ */
route('GET', '/api/patrol-schedules', ALL, ({ query }) => {
  let rows = db.patrol_schedules.map(publicPatrolSchedule);
  if (query.get('site_id')) rows = rows.filter((s) => s.site_id === Number(query.get('site_id')));
  return rows;
});
function resolveBeatId(rawBeatId, siteId) {
  if (!rawBeatId) return null;
  const beat = db.beats.find((b) => b.id === Number(rawBeatId));
  if (!beat) throw httpError(400, 'beat_id must reference an existing beat');
  if (beat.site_id !== siteId) throw httpError(400, 'beat does not belong to this site');
  return beat.id;
}
route('POST', '/api/patrol-schedules', CONTROL, ({ body }) => {
  const site = db.sites.find((s) => s.id === Number(body.site_id));
  if (!site) throw httpError(400, 'site_id must reference an existing site');
  const label = String(body.label || '').trim();
  if (!label) throw httpError(400, 'label required');
  const daysOfWeek = Array.isArray(body.days_of_week) ? body.days_of_week.map(Number).filter((d) => d >= 0 && d <= 6) : null;
  const intervalHours = body.interval_hours != null && body.interval_hours !== '' ? Number(body.interval_hours) : null;
  if (!(daysOfWeek && daysOfWeek.length) && !intervalHours) throw httpError(400, 'either days_of_week (with time_of_day) or interval_hours is required');
  const schedule = {
    id: nextId('patrol_schedules'), site_id: site.id, beat_id: resolveBeatId(body.beat_id, site.id), label,
    days_of_week: daysOfWeek && daysOfWeek.length ? daysOfWeek : null,
    time_of_day: body.time_of_day || null,
    interval_hours: intervalHours || null,
    duration_expected_min: Number(body.duration_expected_min) || 30,
    active: body.active !== false,
  };
  db.patrol_schedules.push(schedule);
  logEvent('patrol_schedule.created', `PATROL SCHEDULE "${label}" CREATED FOR ${site.name}`, { patrol_schedule_id: schedule.id });
  return { __status: 201, __body: publicPatrolSchedule(schedule) };
});
route('PATCH', '/api/patrol-schedules/:id', CONTROL, ({ params, body }) => {
  const s = db.patrol_schedules.find((x) => x.id === Number(params.id)); if (!s) throw httpError(404, 'patrol schedule not found');
  if ('label' in body) { const label = String(body.label || '').trim(); if (!label) throw httpError(400, 'label required'); s.label = label; }
  if ('days_of_week' in body) s.days_of_week = Array.isArray(body.days_of_week) && body.days_of_week.length ? body.days_of_week.map(Number) : null;
  if ('time_of_day' in body) s.time_of_day = body.time_of_day || null;
  if ('interval_hours' in body) s.interval_hours = body.interval_hours != null && body.interval_hours !== '' ? Number(body.interval_hours) : null;
  if ('duration_expected_min' in body) s.duration_expected_min = Number(body.duration_expected_min) || 30;
  if ('active' in body) s.active = Boolean(body.active);
  if ('beat_id' in body) s.beat_id = resolveBeatId(body.beat_id, s.site_id);
  logEvent('patrol_schedule.updated', `PATROL SCHEDULE "${s.label}" UPDATED`, { patrol_schedule_id: s.id });
  return publicPatrolSchedule(s);
});
route('DELETE', '/api/patrol-schedules/:id', ADMIN, ({ params }) => {
  const s = db.patrol_schedules.find((x) => x.id === Number(params.id)); if (!s) throw httpError(404, 'patrol schedule not found');
  db.patrol_schedules = db.patrol_schedules.filter((x) => x.id !== s.id);
  logEvent('patrol_schedule.deleted', `PATROL SCHEDULE "${s.label}" DELETED`, { patrol_schedule_id: s.id });
  return { ok: true };
});

function nextVisitReference() {
  return `VISIT-${new Date().getFullYear()}-${String(nextId('visitref') + 40).padStart(5, '0')}`;
}
route('GET', '/api/site-visits', ALL, ({ query }) => {
  let rows = db.site_visits.map(publicSiteVisit);
  if (query.get('status')) rows = rows.filter((v) => v.status === query.get('status').toUpperCase());
  if (query.get('site_id')) rows = rows.filter((v) => v.site_id === Number(query.get('site_id')));
  return rows;
});
route('POST', '/api/site-visits', CONTROL, ({ body, user }) => {
  const site = db.sites.find((s) => s.id === Number(body.site_id));
  if (!site) throw httpError(400, 'site_id must reference an existing site');
  const v = {
    id: nextId('site_visits'), reference: nextVisitReference(), site_id: site.id, schedule_id: null, beat_id: resolveBeatId(body.beat_id, site.id),
    personnel_id: null, additional_personnel: [], status: 'SCHEDULED',
    scheduled_for: body.scheduled_for || new Date().toISOString(),
    dispatched_at: null, acknowledged_at: null, en_route_at: null, on_scene_at: null, completed_at: null, cancelled_at: null, missed_at: null,
    notes: body.notes || '', checklist: instantiateChecklist(site), media: [], report_html: null,
    checkpoint_scans: [],
    created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  db.site_visits.push(v);
  broadcast('site_visit.created', publicSiteVisit(v));
  logEvent('site_visit.created', `VISIT ${v.reference} CREATED FOR ${site.name}`, { site_visit_id: v.id });
  return { __status: 201, __body: publicSiteVisit(v) };
});
route('POST', '/api/site-visits/:id/assign', CONTROL, ({ params, body }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  const p = findPersonnel(body.personnel); if (!p) throw httpError(400, 'personnel required');
  if (v.personnel_id === p.id || (v.additional_personnel || []).includes(p.id)) throw httpError(409, `${p.name} is already assigned to this visit`);
  if (!v.personnel_id) v.personnel_id = p.id;
  else { v.additional_personnel = v.additional_personnel || []; v.additional_personnel.push(p.id); }
  if (v.status === 'SCHEDULED') v.status = 'DISPATCHED';
  stampVisitStatus(v, 'DISPATCHED');
  v.updated_at = new Date().toISOString();
  const site = db.sites.find((s) => s.id === v.site_id);
  const payload = publicSiteVisit(v);
  broadcast('site_visit.dispatched', payload);
  broadcast('site_visit.assigned_to_you', payload, { personnelIds: [p.id] });
  pushToUsers(db.users.filter((u) => u.personnel_id === p.id).map((u) => u.id),
    { title: `Patrol visit ${v.reference}`, body: site ? site.name : 'Site visit', url: '/officer.html', tag: 'cccs-visit' });
  logEvent('site_visit.dispatched', `VISIT ${v.reference} DISPATCHED → ${p.name}`, { site_visit_id: v.id });
  return payload;
});
function assertVisitAccess(v, user) {
  if (isControlRole(user.role)) return;
  const mine = user.role === 'FIELD_USER' && user.personnel_id
    && (v.personnel_id === user.personnel_id || (v.additional_personnel || []).includes(user.personnel_id));
  if (!mine) throw httpError(403, 'visit not assigned to you');
}
route('POST', '/api/site-visits/:id/ack', ALL, ({ params, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  assertVisitAccess(v, user);
  if (v.status === 'DISPATCHED') v.status = 'ACKNOWLEDGED';
  stampVisitStatus(v, 'ACKNOWLEDGED');
  v.updated_at = new Date().toISOString();
  const who = user.role === 'FIELD_USER' ? (db.personnel.find((p) => p.id === user.personnel_id) || {}).name : user.display_name;
  broadcast('site_visit.acknowledged', { visit: publicSiteVisit(v), by: who });
  logEvent('site_visit.acknowledged', `${who} ACKNOWLEDGED VISIT ${v.reference}`, { site_visit_id: v.id });
  return publicSiteVisit(v);
});
route('PATCH', '/api/site-visits/:id', ALL, ({ params, body, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  if (body.status) {
    const s = String(body.status).toUpperCase();
    if (!SITE_VISIT_STATES.includes(s)) throw httpError(400, 'invalid visit status');
    assertVisitAccess(v, user);
    v.status = s;
    stampVisitStatus(v, s);
    if (s === 'COMPLETED') {
      const site = db.sites.find((x) => x.id === v.site_id);
      const beat = v.beat_id ? db.beats.find((x) => x.id === v.beat_id) : null;
      const waypoints = beat ? beat.waypoints || [] : [];
      const scannedIds = new Set((v.checkpoint_scans || []).map((sc) => sc.waypoint_id));
      v.report_html = buildResolutionReportHtml({
        reference: v.reference, kindLabel: 'Patrol visit', locationLabel: site ? site.name : 'Site visit', siteId: v.site_id,
        description: '', notes: v.notes,
        timeline: [
          ['Scheduled', v.scheduled_for], ['Dispatched', v.dispatched_at], ['Acknowledged', v.acknowledged_at],
          ['En route', v.en_route_at], ['On scene', v.on_scene_at], ['Completed', v.completed_at],
        ].filter(([, t]) => t),
        checklist: v.checklist, media: v.media,
        extraRows: waypoints.length ? [['Checkpoints', `${waypoints.filter((w) => scannedIds.has(w.id)).length} / ${waypoints.length} scanned` + (waypoints.some((w) => !scannedIds.has(w.id)) ? ` (missing: ${waypoints.filter((w) => !scannedIds.has(w.id)).map((w) => w.title).join(', ')})` : '')]] : [],
      });
      sendResolutionReportEmail({
        reference: v.reference, siteId: v.site_id, media: v.media, mediaDir: visitMediaDir(v.id),
        logType: 'site_visit.report_emailed', logIdKey: 'site_visit_id', logId: v.id,
      }, v.report_html);
      logEvent('site_visit.report_generated', `RESOLUTION REPORT GENERATED FOR ${v.reference}`, { site_visit_id: v.id });
    }
  }
  if (body.notes !== undefined) v.notes = String(body.notes).slice(0, 2000);
  v.updated_at = new Date().toISOString();
  broadcast('site_visit.status_changed', publicSiteVisit(v));
  logEvent('site_visit.status_changed', `VISIT ${v.reference} → ${v.status}`, { site_visit_id: v.id });
  return publicSiteVisit(v);
});
route('PATCH', '/api/site-visits/:id/checklist/:itemId', ALL, ({ params, body, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  assertVisitAccess(v, user);
  const item = (v.checklist || []).find((x) => x.id === params.itemId); if (!item) throw httpError(404, 'checklist item not found');
  if (body.status) {
    const s = String(body.status).toUpperCase();
    if (!['PENDING', 'COMPLETE'].includes(s)) throw httpError(400, 'invalid checklist status');
    item.status = s;
    if (s === 'COMPLETE') { item.completed_at = new Date().toISOString(); item.completed_by = user.display_name; }
    else { item.completed_at = null; item.completed_by = null; }
  }
  if (body.notes !== undefined) item.notes = String(body.notes).slice(0, 2000);
  v.updated_at = new Date().toISOString();
  broadcast('site_visit.status_changed', publicSiteVisit(v));
  logEvent('site_visit.checklist_updated', `${item.status === 'COMPLETE' ? 'COMPLETED' : 'UPDATED'} "${item.title}" on VISIT ${v.reference}`, { site_visit_id: v.id });
  return publicSiteVisit(v);
});
route('POST', '/api/site-visits/:id/media', ALL, ({ params, body, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  assertVisitAccess(v, user);
  const ext = MEDIA_MIME_EXT[body.mimetype];
  if (!ext) throw httpError(400, 'mimetype must be image/jpeg, image/png or image/webp');
  if (!body.data) throw httpError(400, 'data (base64) required');
  if (body.checklist_item_id && !(v.checklist || []).some((x) => x.id === body.checklist_item_id)) throw httpError(404, 'checklist item not found');
  const bytes = Buffer.from(body.data, 'base64');
  if (bytes.length > 8e6) throw httpError(413, 'photo too large');
  const dir = visitMediaDir(v.id);
  fs.mkdirSync(dir, { recursive: true });
  const mediaId = crypto.randomUUID();
  const filename = `${mediaId}${ext}`;
  fs.writeFileSync(path.join(dir, filename), bytes);
  const media = {
    id: mediaId, url: `/api/site-visits/${v.id}/media/${mediaId}`, filename, caption: String(body.caption || '').slice(0, 200),
    checklist_item_id: body.checklist_item_id || null, taken_by: user.display_name, taken_at: new Date().toISOString(),
  };
  v.media = v.media || [];
  v.media.push(media);
  v.updated_at = new Date().toISOString();
  broadcast('site_visit.status_changed', publicSiteVisit(v));
  logEvent('site_visit.media_added', `PHOTO ADDED TO VISIT ${v.reference}`, { site_visit_id: v.id });
  return { __status: 201, __body: media };
});
route('GET', '/api/site-visits/:id/media/:mediaId', ALL, ({ params, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  assertVisitAccess(v, user);
  const m = (v.media || []).find((x) => x.id === params.mediaId); if (!m) throw httpError(404, 'photo not found');
  const file = path.join(visitMediaDir(v.id), m.filename);
  if (!fs.existsSync(file)) throw httpError(404, 'photo file missing');
  return { __body: fs.readFileSync(file), __headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'private, max-age=86400' } };
});
route('GET', '/api/site-visits/:id/report', CONTROL, ({ params }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  if (!v.report_html) throw httpError(404, 'no report yet — the visit has not been completed');
  return { __body: v.report_html, __headers: { 'content-type': 'text/html; charset=utf-8' } };
});
route('POST', '/api/site-visits/:id/stand-down', CONTROL, ({ params, body }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  const p = findPersonnel(body.personnel); if (!p) throw httpError(400, 'personnel required');
  let removed = false;
  if (v.personnel_id === p.id) { v.personnel_id = (v.additional_personnel || []).shift() || null; removed = true; }
  else if ((v.additional_personnel || []).includes(p.id)) { v.additional_personnel = v.additional_personnel.filter((id) => id !== p.id); removed = true; }
  if (!removed) throw httpError(404, 'that person is not assigned to this visit');
  if (!v.personnel_id && !(v.additional_personnel || []).length && v.status === 'DISPATCHED') v.status = 'SCHEDULED';
  v.updated_at = new Date().toISOString();
  const payload = publicSiteVisit(v);
  broadcast('site_visit.status_changed', payload);
  broadcast('site_visit.stood_down', payload, { personnelIds: [p.id] });
  logEvent('site_visit.stood_down', `${p.name} STOOD DOWN FROM VISIT ${v.reference}`, { site_visit_id: v.id });
  return payload;
});

/* Guard tour checkpoint scanning — a beat's waypoints (see the Beats
 * section above) double as checkpoints: each one gets a QR code (just its
 * own id, printed/posted at the physical location — see admin.html's Beats
 * tab), and scanning it here is what proves an officer actually reached
 * that point rather than just clicking through a list from the break room.
 * Re-scanning the same waypoint is allowed — a real tour sometimes revisits
 * a point, and the log is a timeline, not a checklist that needs undoing. */
route('POST', '/api/site-visits/:id/checkpoint-scan', ALL, ({ params, body, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  assertVisitAccess(v, user);
  if (['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status)) throw httpError(409, 'visit is already closed');
  if (!v.beat_id) throw httpError(400, 'this visit has no beat — nothing to scan against');
  const beat = db.beats.find((b) => b.id === v.beat_id);
  const waypoint = beat && (beat.waypoints || []).find((w) => w.id === body.waypoint_id);
  if (!waypoint) throw httpError(404, 'waypoint not found on this visit\'s beat');
  const scan = {
    id: crypto.randomUUID(), waypoint_id: waypoint.id, waypoint_title: waypoint.title,
    scanned_at: new Date().toISOString(), scanned_by: user.role === 'FIELD_USER' ? user.personnel_id : null,
    lat: body.lat != null ? Number(body.lat) : null, lon: body.lon != null ? Number(body.lon) : null,
  };
  v.checkpoint_scans = v.checkpoint_scans || [];
  v.checkpoint_scans.push(scan);
  v.updated_at = new Date().toISOString();
  const payload = publicSiteVisit(v);
  broadcast('site_visit.status_changed', payload);
  const who = user.role === 'FIELD_USER' ? (db.personnel.find((p) => p.id === user.personnel_id) || {}).name : user.display_name;
  logEvent('site_visit.checkpoint_scanned', `${who} SCANNED "${waypoint.title}" ON VISIT ${v.reference}`, { site_visit_id: v.id, waypoint_id: waypoint.id });
  return { __status: 201, __body: payload };
});

/* ---- Patrol scheduling tick ------------------------------------------
 * Turns a due patrol_schedules occurrence into a SCHEDULED site_visits row,
 * and flags a SCHEDULED visit nobody ever dispatched, well past its window,
 * as MISSED — a silent gap in patrol coverage is exactly what this exists
 * to surface, not something to let quietly age out. */
const PATROL_SCHEDULE_TICK_MS = Number(process.env.PATROL_SCHEDULE_TICK_MS || 60000);
const VISIT_MISSED_GRACE_MIN = Number(process.env.VISIT_MISSED_GRACE_MIN || 120);
const OPEN_VISIT_STATES = ['SCHEDULED', 'DISPATCHED', 'ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE'];
function createSiteVisitFromSchedule(schedule, scheduledFor) {
  const site = db.sites.find((s) => s.id === schedule.site_id);
  if (!site) return null;
  const v = {
    id: nextId('site_visits'), reference: nextVisitReference(), site_id: site.id, schedule_id: schedule.id, beat_id: schedule.beat_id || null,
    personnel_id: null, additional_personnel: [], status: 'SCHEDULED',
    scheduled_for: scheduledFor.toISOString(),
    dispatched_at: null, acknowledged_at: null, en_route_at: null, on_scene_at: null, completed_at: null, cancelled_at: null, missed_at: null,
    notes: '', checklist: instantiateChecklist(site), media: [], report_html: null,
    checkpoint_scans: [],
    created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  db.site_visits.push(v);
  broadcast('site_visit.created', publicSiteVisit(v));
  logEvent('site_visit.created', `VISIT ${v.reference} SCHEDULED FOR ${site.name} (${schedule.label})`, { site_visit_id: v.id, patrol_schedule_id: schedule.id });
  return v;
}
function patrolScheduleTick() {
  const now = new Date();
  for (const schedule of db.patrol_schedules) {
    if (!schedule.active) continue;
    const existingForSchedule = db.site_visits.filter((v) => v.schedule_id === schedule.id);
    const hasOpen = existingForSchedule.some((v) => OPEN_VISIT_STATES.includes(v.status));

    if (schedule.interval_hours) {
      if (hasOpen) continue;
      const last = existingForSchedule.slice().sort((a, b) => Date.parse(b.scheduled_for) - Date.parse(a.scheduled_for))[0];
      const dueAt = last ? Date.parse(last.scheduled_for) + schedule.interval_hours * 3600000 : now.getTime();
      if (now.getTime() >= dueAt) createSiteVisitFromSchedule(schedule, now);
    } else if (schedule.days_of_week && schedule.time_of_day) {
      const todayIdx = now.getDay();
      if (!schedule.days_of_week.includes(todayIdx)) continue;
      const [hh, mm] = schedule.time_of_day.split(':').map(Number);
      const dueToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
      if (now < dueToday) continue;
      const alreadyToday = existingForSchedule.some((v) => {
        const d = new Date(v.scheduled_for);
        return d.getFullYear() === dueToday.getFullYear() && d.getMonth() === dueToday.getMonth() && d.getDate() === dueToday.getDate();
      });
      if (!alreadyToday) createSiteVisitFromSchedule(schedule, dueToday);
    }
  }

  const graceMs = VISIT_MISSED_GRACE_MIN * 60000;
  for (const v of db.site_visits) {
    if (v.status !== 'SCHEDULED') continue;
    if (now.getTime() - Date.parse(v.scheduled_for) < graceMs) continue;
    v.status = 'MISSED';
    stampVisitStatus(v, 'MISSED');
    v.updated_at = new Date().toISOString();
    broadcast('site_visit.missed', publicSiteVisit(v));
    logEvent('site_visit.missed', `VISIT ${v.reference} MISSED — NEVER DISPATCHED`, { site_visit_id: v.id });
    pushToRoles(CONTROL, { title: 'Missed patrol visit', body: v.reference, url: '/control.html', tag: 'cccs-visit-missed' });
  }
}

/* ------------------------------------------------------------------ *
 * HR rota — shifts and clock-in/out
 * ------------------------------------------------------------------ */
route('GET', '/api/shifts', ALL, ({ query }) => {
  let rows = db.shifts.map(publicShift);
  if (query.get('personnel_id')) rows = rows.filter((s) => s.personnel_id === Number(query.get('personnel_id')));
  if (query.get('site_id')) rows = rows.filter((s) => s.site_id === Number(query.get('site_id')));
  if (query.get('from')) rows = rows.filter((s) => s.ends_at >= query.get('from'));
  if (query.get('to')) rows = rows.filter((s) => s.starts_at <= query.get('to'));
  return rows.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
});
route('POST', '/api/shifts', CONTROL, ({ body, user }) => {
  const p = findPersonnel(body.personnel); if (!p) throw httpError(400, 'personnel required');
  const startsAt = body.starts_at ? new Date(body.starts_at) : null;
  const endsAt = body.ends_at ? new Date(body.ends_at) : null;
  if (!startsAt || isNaN(startsAt) || !endsAt || isNaN(endsAt)) throw httpError(400, 'starts_at and ends_at (ISO timestamps) required');
  if (endsAt <= startsAt) throw httpError(400, 'ends_at must be after starts_at');
  const site = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null;
  const s = {
    id: nextId('shifts'), personnel_id: p.id, site_id: site ? site.id : null,
    starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), role_type: body.role_type || '',
    status: 'SCHEDULED', clocked_in_at: null, clocked_out_at: null, notes: body.notes || '',
    created_by: user.id, created_at: new Date().toISOString(),
  };
  db.shifts.push(s);
  broadcast('shift.created', publicShift(s), { personnelIds: [p.id] });
  logEvent('shift.created', `SHIFT CREATED FOR ${p.name} ${s.starts_at} — ${s.ends_at}`, { shift_id: s.id, personnel_id: p.id });
  return { __status: 201, __body: publicShift(s) };
});
route('PATCH', '/api/shifts/:id', CONTROL, ({ params, body }) => {
  const s = db.shifts.find((x) => x.id === Number(params.id)); if (!s) throw httpError(404, 'shift not found');
  if ('starts_at' in body) { const d = new Date(body.starts_at); if (isNaN(d)) throw httpError(400, 'invalid starts_at'); s.starts_at = d.toISOString(); }
  if ('ends_at' in body) { const d = new Date(body.ends_at); if (isNaN(d)) throw httpError(400, 'invalid ends_at'); s.ends_at = d.toISOString(); }
  if (Date.parse(s.ends_at) <= Date.parse(s.starts_at)) throw httpError(400, 'ends_at must be after starts_at');
  if ('site_id' in body) { const site = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null; s.site_id = site ? site.id : null; }
  if ('role_type' in body) s.role_type = body.role_type || '';
  if ('notes' in body) s.notes = body.notes || '';
  if ('status' in body) {
    if (!SHIFT_STATES.includes(body.status)) throw httpError(400, 'invalid shift status');
    s.status = body.status;
  }
  broadcast('shift.updated', publicShift(s), { personnelIds: [s.personnel_id] });
  logEvent('shift.updated', `SHIFT ${s.id} UPDATED`, { shift_id: s.id, personnel_id: s.personnel_id });
  return publicShift(s);
});
route('DELETE', '/api/shifts/:id', ADMIN, ({ params }) => {
  const s = db.shifts.find((x) => x.id === Number(params.id)); if (!s) throw httpError(404, 'shift not found');
  db.shifts = db.shifts.filter((x) => x.id !== s.id);
  broadcast('shift.deleted', { id: s.id }, { personnelIds: [s.personnel_id] });
  logEvent('shift.deleted', `SHIFT ${s.id} DELETED`, { shift_id: s.id });
  return { ok: true };
});
function assertShiftAccess(s, user) {
  if (isControlRole(user.role)) return;
  if (user.role === 'FIELD_USER' && user.personnel_id === s.personnel_id) return;
  throw httpError(403, 'not your shift');
}
route('POST', '/api/shifts/:id/clock-in', ALL, ({ params, user }) => {
  const s = db.shifts.find((x) => x.id === Number(params.id)); if (!s) throw httpError(404, 'shift not found');
  assertShiftAccess(s, user);
  if (s.status === 'CLOCKED_IN') return publicShift(s);
  if (!['SCHEDULED', 'CONFIRMED'].includes(s.status)) throw httpError(409, `cannot clock in from ${s.status}`);
  s.status = 'CLOCKED_IN'; s.clocked_in_at = new Date().toISOString();
  const p = db.personnel.find((x) => x.id === s.personnel_id);
  broadcast('shift.updated', publicShift(s), { personnelIds: [s.personnel_id] });
  logEvent('shift.clocked_in', `${p ? p.name : 'PERSON'} CLOCKED IN`, { shift_id: s.id, personnel_id: s.personnel_id });
  return publicShift(s);
});
route('POST', '/api/shifts/:id/clock-out', ALL, ({ params, user }) => {
  const s = db.shifts.find((x) => x.id === Number(params.id)); if (!s) throw httpError(404, 'shift not found');
  assertShiftAccess(s, user);
  if (s.status !== 'CLOCKED_IN') throw httpError(409, 'not clocked in');
  s.status = 'CLOCKED_OUT'; s.clocked_out_at = new Date().toISOString();
  const p = db.personnel.find((x) => x.id === s.personnel_id);
  broadcast('shift.updated', publicShift(s), { personnelIds: [s.personnel_id] });
  logEvent('shift.clocked_out', `${p ? p.name : 'PERSON'} CLOCKED OUT`, { shift_id: s.id, personnel_id: s.personnel_id });
  return publicShift(s);
});

route('GET', '/api/config', ALL, () => ({
  audio: process.env.AUDIO !== 'off',
}));

route('GET', '/api/openapi.json', null, () => require('./openapi.json'));

// Admin: users
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(raw, { forId } = {}) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const email = String(raw).toLowerCase().trim();
  if (!EMAIL_RE.test(email)) throw httpError(400, 'not a valid email address');
  if (db.users.some((u) => u.id !== forId && u.email === email)) throw httpError(409, 'that email is already linked to another account');
  return email;
}

route('GET', '/api/users', ADMIN, () => db.users.map(publicUser));
route('POST', '/api/users', ADMIN, ({ body }) => {
  const username = String(body.username || '').toLowerCase().trim();
  if (!username || !body.password) throw httpError(400, 'username and password required');
  if (String(body.password).length < 8) throw httpError(400, 'password must be at least 8 characters');
  if (!ROLES.includes(body.role)) throw httpError(400, 'invalid role');
  if (db.users.some((u) => u.username === username)) throw httpError(409, 'username taken');
  const email = normalizeEmail(body.email) ?? null;
  const personnelId = body.personnel_id || null;
  if (personnelId && db.personnel.some((p) => p.id === personnelId && p.user_id)) throw httpError(409, 'that personnel record already has a login');
  const u = { id: nextId('users'), username, password_hash: hashPassword(String(body.password)), role: body.role, display_name: body.display_name || username, personnel_id: personnelId, mdt_id: body.mdt_id || null, email, created_at: new Date().toISOString() };
  db.users.push(u);
  if (personnelId) { const p = db.personnel.find((x) => x.id === personnelId); if (p) p.user_id = u.id; }
  logEvent('user.created', `USER ${username} CREATED (${u.role})`);
  return { __status: 201, __body: { id: u.id, username: u.username, role: u.role } };
});
route('PATCH', '/api/users/:id', ADMIN, ({ params, body }) => {
  const u = db.users.find((x) => x.id === Number(params.id));
  if (!u) throw httpError(404, 'user not found');
  if ('email' in body) u.email = normalizeEmail(body.email, { forId: u.id });
  if ('display_name' in body) u.display_name = String(body.display_name || '').trim() || u.username;
  if ('role' in body) {
    if (!ROLES.includes(body.role)) throw httpError(400, 'invalid role');
    u.role = body.role;
  }
  if ('personnel_id' in body) {
    const nextPersonnelId = body.personnel_id || null;
    if (nextPersonnelId && db.personnel.some((p) => p.id === nextPersonnelId && p.user_id && p.user_id !== u.id)) {
      throw httpError(409, 'that personnel record already has a login');
    }
    if (u.personnel_id && u.personnel_id !== nextPersonnelId) {
      const prev = db.personnel.find((p) => p.id === u.personnel_id);
      if (prev && prev.user_id === u.id) prev.user_id = null;
    }
    if (nextPersonnelId) { const p = db.personnel.find((x) => x.id === nextPersonnelId); if (p) p.user_id = u.id; }
    u.personnel_id = nextPersonnelId;
  }
  if ('mdt_id' in body) u.mdt_id = body.mdt_id || null;
  if ('password' in body && body.password) {
    if (String(body.password).length < 8) throw httpError(400, 'password must be at least 8 characters');
    u.password_hash = hashPassword(String(body.password));
  }
  logEvent('user.updated', `USER ${u.username} UPDATED`, { user_id: u.id });
  return publicUser(u);
});
route('DELETE', '/api/users/:id', ADMIN, ({ params, user }) => {
  const u = db.users.find((x) => x.id === Number(params.id));
  if (!u) throw httpError(404, 'user not found');
  if (u.id === user.id) throw httpError(400, 'cannot delete the account you are signed in as');
  if (u.personnel_id) { const p = db.personnel.find((x) => x.id === u.personnel_id); if (p && p.user_id === u.id) p.user_id = null; }
  db.users = db.users.filter((x) => x.id !== u.id);
  logEvent('user.deleted', `USER ${u.username} DELETED`, { user_id: u.id });
  return { ok: true };
});

/**
 * MDTs (terminals, crew sign-in, duty status), vehicles (DVLA lookup, fuel
 * logs and receipts, maintenance history) and the asset register (checkout
 * and return).
 *
 * UPLOADS_DIR, MEDIA_MIME_EXT and inventory are defined later in server.js,
 * so they come in through `late`, whose getters are only read when a
 * request arrives.
 *
 * Moved out of server.js unchanged. Registrar pattern: server.js passes in
 * what this needs, at the same point in route order as before.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function registerVehiclesAssets({ route, httpError, ALL, CONTROL, ADMIN, db, nextId, logEvent, broadcast, isControlRole, visibleToUser, normalizedBranchId, findCallsign, checkAutoJobProgress, recordStockMovement, dvla, MIME, publicMdt, publicVehicle, publicFuelLog, publicMaintenanceLog, publicAsset, publicAssetCheckout, late }) {

  // MDTs and vehicles
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
  route('GET', '/api/vehicles', ALL, ({ user }) => db.vehicles.filter((v) => visibleToUser(v, user)).map(publicVehicle));
  route('POST', '/api/vehicles', ADMIN, ({ body }) => {
    const registration = String(body.registration || '').trim().toUpperCase();
    if (!registration) throw httpError(400, 'registration required');
    if (db.vehicles.some((x) => x.registration === registration)) throw httpError(409, 'a vehicle with that registration already exists');
    const p = body.assigned_personnel_id ? db.personnel.find((x) => x.id === Number(body.assigned_personnel_id)) : null;
    const homeSite = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null;
    const v = {
      id: nextId('vehicles'), registration, type: body.type || 'Vehicle', make: body.make || '', model: body.model || '',
      service_due_at: body.service_due_at || null, insurance_due_at: body.insurance_due_at || null,
      mot_due_at: body.mot_due_at || null, tax_due_at: body.tax_due_at || null,
      site_id: homeSite ? homeSite.id : null,
      mileage: body.mileage != null && body.mileage !== '' ? Number(body.mileage) : null, condition: body.condition || '',
      assigned_personnel_id: p ? p.id : null,
      status: VEHICLE_STATUSES.includes(body.status) ? body.status : 'ACTIVE', notes: body.notes || '',
      branch_id: normalizedBranchId(body.branch_id),
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
    if ('mot_due_at' in body) v.mot_due_at = body.mot_due_at || null;
    if ('deep_clean_at' in body) v.deep_clean_at = body.deep_clean_at || null;
    if ('deep_clean_interval_days' in body) {
      const d = body.deep_clean_interval_days === null || body.deep_clean_interval_days === '' ? null : Number(body.deep_clean_interval_days);
      if (d !== null && (!Number.isInteger(d) || d < 1 || d > 365)) throw httpError(400, 'deep_clean_interval_days must be 1-365');
      v.deep_clean_interval_days = d;
    }
    if ('tax_due_at' in body) v.tax_due_at = body.tax_due_at || null;
    if ('site_id' in body) { const homeSite = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null; v.site_id = homeSite ? homeSite.id : null; }
    if ('mileage' in body) v.mileage = body.mileage != null && body.mileage !== '' ? Number(body.mileage) : null;
    if ('condition' in body) v.condition = body.condition || '';
    if ('assigned_personnel_id' in body) { const p = body.assigned_personnel_id ? db.personnel.find((x) => x.id === Number(body.assigned_personnel_id)) : null; v.assigned_personnel_id = p ? p.id : null; }
    if ('branch_id' in body) v.branch_id = normalizedBranchId(body.branch_id);
    if ('status' in body) { if (!VEHICLE_STATUSES.includes(body.status)) throw httpError(400, 'invalid status'); v.status = body.status; }
    if ('notes' in body) v.notes = body.notes || '';
    logEvent('vehicle.updated', `VEHICLE ${v.registration} UPDATED`, { vehicle_id: v.id });
    return publicVehicle(v);
  });
  /* Vehicle lookup (Vehicle Data Global — see dvla.js) — tax/MOT status and
   * basic details keyed on the registration already on file. A read on the
   * provider's end, but written here: updates the vehicle's make/colour and
   * tax/MOT status+dates so the Fleet view reflects real data, not what was
   * typed in by hand (or never updated) at creation. Route path and stored
   * field names (dvla-lookup, dvla_checked_at) are unchanged from the
   * previous DVLA-government-API version of this integration. */
  route('POST', '/api/vehicles/:id/dvla-lookup', ADMIN, async ({ params }) => {
    const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
    const r = await dvla.lookup(v.registration);
    if (!r.ok) throw httpError(r.httpStatus === 404 ? 404 : 502, `DVLA lookup failed: ${r.error}`);
    const d = r.data;
    if (d.make) v.make = d.make;
    if (d.colour) v.colour = d.colour;
    v.mot_status = d.motStatus || null;
    v.tax_status = d.taxStatus || null;
    if (d.motExpiryDate) v.mot_due_at = d.motExpiryDate;
    if (d.taxDueDate) v.tax_due_at = d.taxDueDate;
    v.dvla_checked_at = new Date().toISOString();
    logEvent('vehicle.dvla_lookup', `VEHICLE ${v.registration} DVLA LOOKUP — tax ${v.tax_status || 'unknown'}, MOT ${v.mot_status || 'unknown'}`, { vehicle_id: v.id });
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
  const fuelReceiptDir = (fuelLogId) => path.join(late.UPLOADS_DIR, 'fuel', String(fuelLogId));
  route('GET', '/api/vehicles/:id/fuel-logs', ALL, ({ params }) => {
    const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
    return db.fuel_logs.filter((f) => f.vehicle_id === v.id)
      .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))
      .map(publicFuelLog);
  });
  /** One fuel-log shape for both ways in: the fuel route below and the
   * "Vehicle fuel-up" form (applyVehicleReport). */
  function createFuelLog(v, user, body, extra = {}) {
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
      recorded_at: new Date().toISOString(), created_by: user.id, created_at: new Date().toISOString(), ...extra,
    };
    db.fuel_logs.push(log);
    if (odometer != null && !isNaN(odometer)) v.mileage = odometer;
    logEvent('fuel_log.created', `FUEL LOG ADDED FOR ${v.registration} — ${litres}L`, { vehicle_id: v.id, fuel_log_id: log.id });
    return log;
  }
  route('POST', '/api/vehicles/:id/fuel-logs', ALL, ({ params, body, user }) => {
    const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
    return { __status: 201, __body: publicFuelLog(createFuelLog(v, user, body)) };
  });

  /**
   * What a vehicle form changes on the vehicle itself, by the form's `effect`
   * (see routes-forms.js). Runs after the report is safely stored; the report
   * is the record, this keeps the vehicle's own fields in step with it.
   *
   * Mileage from a form only ever moves FORWARD. An odometer reading lower
   * than the one on file is far more likely a typo than a rolled-back clock,
   * and silently rewinding the mileage would hide service intervals coming
   * due — so it is kept on the report (and the fuel log) but not applied.
   */
  function applyVehicleReport(effect, vehicleId, values, user, submission) {
    const v = db.vehicles.find((x) => x.id === Number(vehicleId));
    if (!v) return;
    const forwardMileage = (reading) => {
      const n = Number(reading);
      if (reading == null || reading === '' || !Number.isFinite(n) || n < 0) return;
      if (v.mileage == null || n >= Number(v.mileage)) v.mileage = n;
      else logEvent('vehicle.mileage_not_rewound', `${v.registration}: ${submission.reference} gave ${n} miles, below the ${v.mileage} on file — kept on the report, mileage not changed`, { vehicle_id: v.id, submission_id: submission.id });
    };
    if (effect === 'FUEL_UP') {
      const before = v.mileage;
      createFuelLog(v, user, { litres: values.litres, odometer: null, cost: values.cost, fuel_type: values.fuel_type || '', notes: values.notes || '' },
        { odometer: values.odometer != null ? Number(values.odometer) : null, form_submission_id: submission.id, form_reference: submission.reference });
      v.mileage = before; forwardMileage(values.odometer);
    } else if (effect === 'DEEP_CLEAN') {
      const at = values.cleaned_at && !isNaN(Date.parse(values.cleaned_at)) ? new Date(values.cleaned_at).toISOString() : new Date().toISOString();
      if (!v.deep_clean_at || at > v.deep_clean_at) v.deep_clean_at = at;
      logEvent('vehicle.deep_cleaned', `${v.registration} DEEP CLEANED (${submission.reference})`, { vehicle_id: v.id, submission_id: submission.id });
    } else if (effect === 'INSPECTION') {
      forwardMileage(values.odometer);
    }
  }
  /**
   * A vehicle report was corrected after filing (routes-forms.js, PATCH
   * /api/form-submissions/:id): bring the vehicle back in line with it.
   *
   * Mileage stays forward-only for new readings, with one exception — when
   * the vehicle's mileage IS the reading being corrected (this report set
   * it), the typo is taken back out: mileage becomes the highest reading on
   * record without it. A correction never lowers mileage another record set.
   * The deep-clean date works the same way.
   */
  function reapplyVehicleReport(effect, vehicleId, before, after, user, submission) {
    const v = db.vehicles.find((x) => x.id === Number(vehicleId));
    if (!v) return;
    const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
    const oldOdo = num(before.odometer), newOdo = num(after.odometer);
    if ((effect === 'FUEL_UP' || effect === 'INSPECTION') && oldOdo !== newOdo) {
      if (oldOdo != null && Number(v.mileage) === oldOdo) {
        const others = [
          ...db.fuel_logs.filter((f) => f.vehicle_id === v.id && f.form_submission_id !== submission.id).map((f) => num(f.odometer)),
          ...db.form_submissions.filter((s) => s.id !== submission.id && s.subject_type === 'VEHICLE' && s.subject_id === v.id
            && ['FUEL_UP', 'INSPECTION'].includes(s.effect_applied)).map((s) => num(s.values.odometer)),
          newOdo,
        ].filter((x) => x != null);
        const was = v.mileage;
        v.mileage = others.length ? Math.max(...others) : null;
        logEvent('vehicle.mileage_corrected', `${v.registration} MILEAGE ${was} → ${v.mileage ?? 'not recorded'} (${submission.reference} corrected by ${user.display_name})`, { vehicle_id: v.id, submission_id: submission.id });
      } else if (newOdo != null && (v.mileage == null || newOdo > Number(v.mileage))) {
        v.mileage = newOdo;
      }
    }
    if (effect === 'FUEL_UP') {
      const log = db.fuel_logs.find((f) => f.form_submission_id === submission.id);
      if (log) {
        const litres = num(after.litres);
        if (litres && litres > 0) log.litres = litres;
        log.cost = num(after.cost); log.odometer = newOdo;
        log.fuel_type = after.fuel_type || ''; log.notes = after.notes || '';
        log.updated_at = new Date().toISOString();
      }
    }
    if (effect === 'DEEP_CLEAN') {
      const at = (vals, sub) => (vals.cleaned_at && !isNaN(Date.parse(vals.cleaned_at)) ? new Date(vals.cleaned_at).toISOString() : sub.submitted_at);
      const oldAt = at(before, submission), newAt = at(after, submission);
      if (oldAt === newAt) return;
      if (v.deep_clean_at === oldAt) {
        const all = db.form_submissions.filter((s) => s.subject_type === 'VEHICLE' && s.subject_id === v.id && s.effect_applied === 'DEEP_CLEAN')
          .map((s) => (s.id === submission.id ? newAt : at(s.values, s)));
        v.deep_clean_at = all.sort().pop() || newAt;
      } else if (!v.deep_clean_at || newAt > v.deep_clean_at) {
        v.deep_clean_at = newAt;
      }
    }
  }
  route('POST', '/api/fuel-logs/:id/receipt', ALL, ({ params, body }) => {
    const f = db.fuel_logs.find((x) => x.id === Number(params.id)); if (!f) throw httpError(404, 'fuel log not found');
    const ext = late.MEDIA_MIME_EXT[body.mimetype];
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

  const ASSET_CATEGORIES = ['EQUIPMENT', 'UNIFORM', 'KEY', 'DEVICE', 'RADIO', 'BODY_CAMERA', 'PPE', 'FIRST_AID', 'MEDICAL_CONSUMABLES', 'IT', 'CONSUMABLE', 'OTHER'];
  const ASSET_STATUSES = ['IN_USE', 'IN_STORE', 'IN_REPAIR', 'ON_HIRE', 'LOST', 'RETIRED'];
  const ASSET_CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED'];
  /** The asset-register and stock-catalogue details (routes-inventory.js):
   * shared by create and edit, each field optional and validated. */
  function applyAssetExtras(a, body) {
    const str = (k, max = 120) => { if (k in body) a[k] = String(body[k] ?? '').trim().slice(0, max); };
    const num = (k) => {
      if (!(k in body)) return;
      if (body[k] === null || body[k] === '') { a[k] = null; return; }
      const n = Number(body[k]);
      if (!Number.isFinite(n) || n < 0) throw httpError(400, `${k.replace(/_/g, ' ')} must be a number of 0 or more`);
      a[k] = n;
    };
    const date = (k) => {
      if (!(k in body)) return;
      if (!body[k]) { a[k] = null; return; }
      if (!/^\d{4}-\d{2}-\d{2}/.test(String(body[k])) || isNaN(Date.parse(body[k]))) throw httpError(400, `${k.replace(/_/g, ' ')} must be a date`);
      a[k] = String(body[k]).slice(0, 10);
    };
    ['make', 'model', 'supplier', 'unit', 'size', 'check_type'].forEach((k) => str(k));
    if ('sku' in body) {
      const sku = String(body.sku || '').trim().slice(0, 60) || null;
      if (sku && db.assets.some((x) => x.id !== a.id && x.sku === sku)) throw httpError(409, 'another item already uses that code');
      a.sku = sku;
    }
    ['purchase_cost', 'unit_cost', 'reorder_qty', 'check_interval_days', 'pat_interval_days'].forEach(num);
    ['warranty_expires_at', 'next_check_due_at', 'pat_next_due_at', 'pat_last_at'].forEach(date);
    if ('pat_required' in body) a.pat_required = body.pat_required === true;
    // PAT testing and inspections are for assets (one tagged item), never for
    // counted stock.
    if (a.is_stock_tracked && (a.pat_required || a.check_interval_days || a.next_check_due_at || a.pat_next_due_at)) {
      throw httpError(400, 'PAT tests and inspections belong on assets, not stock items — add it as an asset instead');
    }
    if ('condition' in body) {
      if (body.condition && !ASSET_CONDITIONS.includes(body.condition)) throw httpError(400, `condition must be one of ${ASSET_CONDITIONS.join(', ')}`);
      a.condition = body.condition || null;
    }
    if ('vehicle_id' in body) {
      const v = body.vehicle_id ? db.vehicles.find((x) => x.id === Number(body.vehicle_id)) : null;
      if (body.vehicle_id && !v) throw httpError(400, 'vehicle not found');
      a.vehicle_id = v ? v.id : null;
    }
    if ('location_id' in body) {
      const loc = body.location_id ? (db.stock_locations || []).find((l) => l.id === Number(body.location_id)) : null;
      if (body.location_id && !loc) throw httpError(400, 'store location not found');
      a.location_id = loc ? loc.id : null;
    }
    // Sub-category (two optional levels under the fixed category, kept in
    // stock_subcategories — routes-inventory.js). It always sits inside the
    // item's own category, so a category change drops one that no longer fits.
    const sub = (id) => (db.stock_subcategories || []).find((s) => s.id === Number(id));
    if ('subcategory_id' in body) {
      const s = body.subcategory_id ? sub(body.subcategory_id) : null;
      if (body.subcategory_id && !s) throw httpError(400, 'sub-category not found');
      if (s && s.category !== a.category) throw httpError(400, 'that sub-category belongs to a different category');
      a.subcategory_id = s ? s.id : null;
    } else if (a.subcategory_id) {
      const s = sub(a.subcategory_id);
      if (!s || s.category !== a.category) a.subcategory_id = null;
    }
  }
  route('GET', '/api/assets', ALL, ({ query, user }) => {
    let rows = db.assets.filter((a) => visibleToUser(a, user)).map((a) => publicAsset(a));
    if (query.get('assigned_to')) rows = rows.filter((a) => a.assigned_to === Number(query.get('assigned_to')));
    if (query.get('category')) rows = rows.filter((a) => a.category === query.get('category').toUpperCase());
    return rows;
  });
  route('POST', '/api/assets', ADMIN, ({ body, user }) => {
    const description = String(body.description || '').trim();
    if (!description) throw httpError(400, 'description required');
    if (!ASSET_CATEGORIES.includes(body.category)) throw httpError(400, 'invalid category');
    const tag = body.tag ? String(body.tag).trim() : null;
    if (tag && db.assets.some((x) => x.tag === tag)) throw httpError(409, 'an asset with that tag already exists');
    const p = body.assigned_to ? db.personnel.find((x) => x.id === Number(body.assigned_to)) : null;
    const site = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null;
    const parent = body.parent_asset_id ? db.assets.find((x) => x.id === Number(body.parent_asset_id)) : null;
    const isStockTracked = body.is_stock_tracked === true;
    const a = {
      id: nextId('assets'), tag, category: body.category, description, serial_no: body.serial_no || '',
      assigned_to: p ? p.id : null, site_id: site ? site.id : null,
      status: ASSET_STATUSES.includes(body.status) ? body.status : 'IN_STORE',
      purchase_date: body.purchase_date || null, last_checked_at: null, notes: body.notes || '',
      branch_id: normalizedBranchId(body.branch_id),
      is_stock_tracked: isStockTracked,
      low_stock_threshold: isStockTracked && body.low_stock_threshold != null && body.low_stock_threshold !== '' ? Number(body.low_stock_threshold) : null,
      expiry_date: isStockTracked ? (body.expiry_date || null) : null,
      parent_asset_id: parent ? parent.id : null, subcategory_id: null,
    };
    applyAssetExtras(a, body);
    if (!a.is_stock_tracked) late.inventory.firstDueDates(a);
    db.assets.push(a);
    if (isStockTracked && body.initial_quantity != null && body.initial_quantity !== '' && Number(body.initial_quantity) > 0) {
      recordStockMovement(a.id, Number(body.initial_quantity), 'RESTOCK', 'Initial stock on creation', null, user);
    }
    logEvent('asset.created', `ASSET ${tag || description} ADDED`, { asset_id: a.id });
    return { __status: 201, __body: publicAsset(a) };
  });
  /** Copies of an asset: the same item, each with its own tag and serial
   * number. Everything about WHAT it is is copied (category, name, make,
   * model, supplier, cost, warranty, PAT/inspection schedule, store location,
   * kit, notes); nothing about the individual item is — each copy starts in
   * store, with no check-outs, no test or inspection results (its first due
   * dates are worked out from today, as for any new asset), not kept in a
   * vehicle, not holding stock. All tags are checked before any copy is
   * made: either every copy is created or none is. */
  route('POST', '/api/assets/:id/duplicate', ADMIN, ({ params, body, user }) => {
    const src = db.assets.find((x) => x.id === Number(params.id)); if (!src) throw httpError(404, 'asset not found');
    if (src.is_stock_tracked) throw httpError(400, 'stock items are counted, not copied — change the quantity instead');
    const copies = Array.isArray(body.copies) ? body.copies : [];
    if (!copies.length) throw httpError(400, 'add at least one copy');
    if (copies.length > 100) throw httpError(400, 'at most 100 copies at a time');
    const rows = copies.map((c, i) => {
      const tag = String((c && c.tag) || '').trim().slice(0, 60);
      if (!tag) throw httpError(400, `copy ${i + 1}: an asset tag is required`);
      return { tag, serial_no: String((c && c.serial_no) || '').trim().slice(0, 120) };
    });
    const clash = rows.filter((r, i) => db.assets.some((x) => x.tag === r.tag) || rows.findIndex((o) => o.tag === r.tag) !== i).map((r) => r.tag);
    if (clash.length) throw httpError(409, `these tags are already used: ${[...new Set(clash)].join(', ')}`);
    const sameSerial = rows.filter((r, i) => r.serial_no && rows.findIndex((o) => o.serial_no === r.serial_no) !== i).map((r) => r.serial_no);
    if (sameSerial.length) throw httpError(400, `the same serial number is entered twice: ${[...new Set(sameSerial)].join(', ')}`);
    const COPY = ['make', 'model', 'supplier', 'unit', 'size', 'check_type', 'purchase_cost', 'unit_cost', 'check_interval_days', 'pat_interval_days',
      'pat_required', 'warranty_expires_at', 'condition', 'location_id'];
    const made = rows.map((r) => {
      const a = {
        id: nextId('assets'), tag: r.tag, category: src.category, description: src.description, serial_no: r.serial_no,
        assigned_to: null, site_id: src.site_id || null, status: 'IN_STORE', purchase_date: src.purchase_date || null, last_checked_at: null,
        notes: src.notes || '', branch_id: src.branch_id || null, is_stock_tracked: false, low_stock_threshold: null, expiry_date: null,
        parent_asset_id: src.parent_asset_id || null, subcategory_id: src.subcategory_id || null, duplicated_from: src.id,
      };
      for (const k of COPY) if (src[k] !== undefined) a[k] = src[k];
      late.inventory.firstDueDates(a);
      db.assets.push(a);
      return a;
    });
    logEvent('asset.duplicated', `${made.length} COP${made.length === 1 ? 'Y' : 'IES'} OF ${src.tag || src.description} ADDED BY ${user.display_name} (${made.map((a) => a.tag).join(', ')})`, { asset_id: src.id });
    return { __status: 201, __body: made.map(publicAsset) };
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
    if ('branch_id' in body) a.branch_id = normalizedBranchId(body.branch_id);
    if ('is_stock_tracked' in body) {
      a.is_stock_tracked = Boolean(body.is_stock_tracked);
      if (!a.is_stock_tracked) { a.low_stock_threshold = null; a.expiry_date = null; }
    }
    if ('low_stock_threshold' in body) {
      if (!a.is_stock_tracked && body.low_stock_threshold != null) throw httpError(400, 'only a stock-tracked asset can have a threshold');
      a.low_stock_threshold = body.low_stock_threshold != null && body.low_stock_threshold !== '' ? Number(body.low_stock_threshold) : null;
    }
    if ('expiry_date' in body) {
      if (!a.is_stock_tracked && body.expiry_date != null) throw httpError(400, 'only a stock-tracked asset can have an expiry date');
      a.expiry_date = body.expiry_date || null;
    }
    if ('parent_asset_id' in body) {
      const parent = body.parent_asset_id ? db.assets.find((x) => x.id === Number(body.parent_asset_id)) : null;
      if (parent && parent.id === a.id) throw httpError(400, 'an asset cannot be its own parent');
      a.parent_asset_id = parent ? parent.id : null;
    }
    applyAssetExtras(a, body);
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
      expected_return_at: body.expected_return_at && !isNaN(Date.parse(body.expected_return_at)) ? new Date(body.expected_return_at).toISOString() : null,
      condition_out: ASSET_CONDITIONS.includes(body.condition) ? body.condition : (a.condition || null),
    };
    if (['LOST', 'RETIRED', 'IN_REPAIR', 'ON_HIRE'].includes(a.status)) throw httpError(409, `this asset is ${a.status.replace('_', ' ').toLowerCase()} — it cannot be issued`);
    db.asset_checkouts.push(co);
    a.assigned_to = personnelId; a.status = 'IN_USE';
    const p = db.personnel.find((x) => x.id === personnelId);
    logEvent('asset.checked_out', `ASSET ${a.tag || a.description} CHECKED OUT TO ${p ? p.name : personnelId}`, { asset_id: a.id, checkout_id: co.id });
    return { __status: 201, __body: publicAsset(a) };
  });
  route('POST', '/api/assets/:id/return', ALL, ({ params, body, user }) => {
    const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
    const co = db.asset_checkouts.find((c) => c.asset_id === a.id && !c.returned_at);
    if (!co) throw httpError(409, 'asset is not currently checked out');
    if (!isControlRole(user.role) && user.personnel_id !== co.personnel_id) throw httpError(403, 'not your checkout');
    co.returned_at = new Date().toISOString(); co.returned_by = user.id;
    if (body && ASSET_CONDITIONS.includes(body.condition)) { co.condition_in = body.condition; a.condition = body.condition; }
    if (body && body.notes) co.return_notes = String(body.notes).slice(0, 500);
    a.assigned_to = null; a.status = body && body.condition === 'DAMAGED' ? 'IN_REPAIR' : 'IN_STORE'; a.last_checked_at = new Date().toISOString();
    logEvent('asset.returned', `ASSET ${a.tag || a.description} RETURNED`, { asset_id: a.id, checkout_id: co.id });
    return publicAsset(a);
  });

  return { ASSET_CATEGORIES, ASSET_STATUSES, applyVehicleReport, reapplyVehicleReport };
};

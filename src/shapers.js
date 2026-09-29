
/* ------------------------------------------------------------------ *
 * Domain logic
 * ------------------------------------------------------------------ */
/** Carries PII (contact_phone/email) unlike the other public* shapers'
 * source rows, which is why this one exists at all — vehicles/sites are
 * returned as raw rows elsewhere because they hold nothing sensitive,
 * personnel no longer can be. welfare_note is kept (control needs to see
 * it), but nothing here is ever handed to a role that isn't control or
 * this exact person -- callers gate that themselves. */
function publicPersonnel(p) {
  const cs = db.callsigns.find((c) => c.id === p.callsign_id);
  const veh = db.vehicles.find((v) => v.id === p.vehicle_id);
  return {
    id: p.id, employee_no: p.employee_no, name: p.name, rank: p.rank,
    contact_phone: p.contact_phone || '', contact_email: p.contact_email || '',
    employment_status: p.employment_status || 'ACTIVE',
    callsign: cs ? cs.name : null, callsign_id: p.callsign_id,
    vehicle: veh ? veh.registration : null, vehicle_id: p.vehicle_id,
    has_login: Boolean(p.user_id),
    welfare_interval_s: p.welfare_interval_s || null, welfare_due_at: p.welfare_due_at || null,
    welfare_note: p.welfare_note || null,
    notes: p.notes || '',
  };
}
function publicMdt(m) {
  const cs = db.callsigns.find((c) => c.id === m.callsign_id);
  const veh = db.vehicles.find((v) => v.id === m.vehicle_id);
  return { id: m.id, mdt_code: m.mdt_code, serial: m.serial, callsign: cs ? cs.name : null, callsign_id: m.callsign_id, vehicle: veh ? veh.registration : null, status: m.status, duty_status: m.duty_status || 'AVAILABLE', job_id: m.job_id, battery: m.battery, network: m.network, operator: m.operator, connected: m.connected, lat: m.lat, lon: m.lon, crew: m.crew || [], emergency: m.emergency || false };
}
function publicJob(j) {
  const assigns = db.job_assignments.filter((a) => a.job_id === j.id);
  return {
    ...j,
    resources: assigns.map((a) => {
      const p = a.personnel_id ? db.personnel.find((x) => x.id === a.personnel_id) : null;
      const m = a.mdt_id ? db.mdts.find((x) => x.id === a.mdt_id) : null;
      const cs = db.callsigns.find((c) => c.id === a.callsign_id);
      return { assignment_id: a.id, callsign: cs ? cs.name : null, personnel: p ? p.name : null, mdt: m ? m.mdt_code : null, acknowledged: a.acknowledged, acknowledged_at: a.acknowledged_at };
    }),
  };
}
function publicBeat(b) {
  const site = db.sites.find((x) => x.id === b.site_id);
  return { ...b, site_name: site ? site.name : null };
}
function publicPatrolSchedule(s) {
  const site = db.sites.find((x) => x.id === s.site_id);
  const beat = s.beat_id ? db.beats.find((x) => x.id === s.beat_id) : null;
  return { ...s, site_name: site ? site.name : null, beat_name: beat ? beat.name : null };
}
function publicSiteVisit(v) {
  const site = db.sites.find((x) => x.id === v.site_id);
  const beat = v.beat_id ? db.beats.find((x) => x.id === v.beat_id) : null;
  const primary = v.personnel_id ? db.personnel.find((x) => x.id === v.personnel_id) : null;
  const additional = (v.additional_personnel || []).map((id) => db.personnel.find((x) => x.id === id)).filter(Boolean);
  return {
    ...v,
    site_name: site ? site.name : null, site_address: site ? site.address : null,
    beat_name: beat ? beat.name : null, waypoints: beat ? beat.waypoints : [],
    checkpoint_scans: v.checkpoint_scans || [],
    lat: site ? site.lat : null, lon: site ? site.lon : null,
    resources: [
      ...(primary ? [{ personnel_id: primary.id, personnel: primary.name, primary: true }] : []),
      ...additional.map((p) => ({ personnel_id: p.id, personnel: p.name, primary: false })),
    ],
  };
}
function publicShift(s) {
  const p = db.personnel.find((x) => x.id === s.personnel_id);
  const site = s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
  return { ...s, personnel_name: p ? p.name : null, personnel_callsign: p ? (db.callsigns.find((c) => c.id === p.callsign_id) || {}).name || null : null, site_name: site ? site.name : null };
}
function publicVehicle(v) {
  const p = v.assigned_personnel_id ? db.personnel.find((x) => x.id === v.assigned_personnel_id) : null;
  return { ...v, assigned_personnel_name: p ? p.name : null };
}
function publicAsset(a) {
  const p = a.assigned_to ? db.personnel.find((x) => x.id === a.assigned_to) : null;
  const site = a.site_id ? db.sites.find((x) => x.id === a.site_id) : null;
  return { ...a, assigned_to_name: p ? p.name : null, site_name: site ? site.name : null };
}
function publicPassdownLog(l) {
  const site = db.sites.find((x) => x.id === l.site_id);
  return { ...l, site_name: site ? site.name : null };
}
function publicFuelLog(f) {
  const v = db.vehicles.find((x) => x.id === f.vehicle_id);
  const p = f.personnel_id ? db.personnel.find((x) => x.id === f.personnel_id) : null;
  return { ...f, vehicle_registration: v ? v.registration : null, driver_name: p ? p.name : null };
}
function publicMaintenanceLog(m) {
  const v = db.vehicles.find((x) => x.id === m.vehicle_id);
  return { ...m, vehicle_registration: v ? v.registration : null };
}
function publicAssetCheckout(c) {
  const p = db.personnel.find((x) => x.id === c.personnel_id);
  const byUser = db.users.find((x) => x.id === c.checked_out_by);
  const retUser = c.returned_by ? db.users.find((x) => x.id === c.returned_by) : null;
  return { ...c, personnel_name: p ? p.name : null, checked_out_by_name: byUser ? byUser.display_name : null, returned_by_name: retUser ? retUser.display_name : null };
}
const callsignOf = (r) => { const c = db.callsigns.find((x) => x.id === r.callsign_id); return c ? c.name : (r.mdt_code || r.name); };

/* ------------------------------------------------------------------ *
 * WebSocket message handling
 * ------------------------------------------------------------------ */
function handleWsMessage(conn, msg) {
  const { type, payload = {} } = msg;
  switch (type) {
    case 'ping': return conn.send('pong', {});
    case 'mdt.attach': {
      const mdt = findMdt(payload.mdt_code || payload.mdt_id);
      if (!mdt) return conn.send('error', { message: 'unknown MDT' });
      if (conn.user.role === 'MDT_USER' && conn.user.mdt_id !== mdt.id)
        return conn.send('error', { message: 'not authorised for this MDT' });
      conn.mdtId = mdt.id; mdt.connected = true; mdt.status = 'ONLINE';
      mdt.operator = conn.user.display_name;
      broadcast('mdt.status_changed', publicMdt(mdt));
      logEvent('mdt.connected', `${mdt.mdt_code} CONNECTED`, { mdt_id: mdt.id });
      return conn.send('mdt.attached', publicMdt(mdt));
    }
    default: return conn.send('error', { message: `unknown message ${type}` });
  }
}

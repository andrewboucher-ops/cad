
/* ------------------------------------------------------------------ *
 * Seed / demo data
 * ------------------------------------------------------------------ */
/**
 * Load seed.json if the operator has provided one, so a new deployment starts
 * with real call signs and sites rather than demo data. Runs on first boot only:
 * once the database has content this is never consulted, so it cannot overwrite
 * anything live.
 */
function seedFromFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byName = { vehicles: new Map(), callsigns: new Map(), personnel: new Map(), mdts: new Map() };

  for (const st of raw.sites || []) {
    db.sites.push({ id: nextId('sites'), name: st.name, address: st.address || '', lat: st.lat ?? null, lon: st.lon ?? null, keyholder: st.keyholder || '', contract: 'ACTIVE', checklist: [] });
  }
  for (const v of raw.vehicles || []) {
    const rec = { id: nextId('vehicles'), registration: v.registration, type: v.type || 'Vehicle', make: v.make || '', model: v.model || '', service_due_at: v.service_due_at || null, insurance_due_at: v.insurance_due_at || null, mileage: v.mileage || null, condition: v.condition || '', assigned_personnel_id: null, status: 'ACTIVE', notes: '' };
    db.vehicles.push(rec); byName.vehicles.set(v.registration, rec);
  }
  for (const cs of raw.callsigns || []) {
    const name = String(cs.name).toUpperCase();
    const rec = { id: nextId('callsigns'), name, description: cs.description || '', active: true };
    db.callsigns.push(rec); byName.callsigns.set(name, rec);
    const vehicle = cs.vehicle ? byName.vehicles.get(cs.vehicle) : null;

    // A seed entry can still just be a bare name (older seed.json files),
    // or a full object once an operator wants to fill in the rest --
    // never require re-authoring an existing seed file just for this.
    for (const person of cs.personnel || []) {
      const p = typeof person === 'string' ? { name: person } : person;
      const rec2 = {
        id: nextId('personnel'), employee_no: p.employee_no || null, name: p.name, rank: p.rank || '',
        contact_phone: p.contact_phone || '', contact_email: p.contact_email || '',
        employment_status: p.employment_status || 'ACTIVE', callsign_id: rec.id,
        user_id: null, vehicle_id: vehicle ? vehicle.id : null,
        welfare_interval_s: null, welfare_due_at: null, welfare_warned: false, welfare_note: '',
        notes: p.notes || '',
      };
      db.personnel.push(rec2);
      if (p.name) byName.personnel.set(p.name, rec2);
    }
    for (const m of cs.mdts || []) {
      const mdt = { id: nextId('mdts'), mdt_code: String(m.code).toUpperCase(), serial: m.serial || m.code, callsign_id: rec.id, vehicle_id: vehicle ? vehicle.id : null, status: 'OFFLINE', duty_status: 'AVAILABLE', job_id: null, battery: 100, network: 'LTE', operator: null, lat: null, lon: null, connected: false, crew: [], emergency: false };
      db.mdts.push(mdt); byName.mdts.set(mdt.mdt_code, mdt);
    }
  }

  for (const u of raw.users || []) {
    const username = String(u.username).toLowerCase();
    if (!u.password || u.password === 'CHANGE-ME') {
      throw new Error(`user ${username} in the seed file still has the placeholder password — set a real one`);
    }
    if (String(u.password).length < 8) throw new Error(`password for ${username} is too short`);
    if (!ROLES.includes(u.role)) throw new Error(`unknown role ${u.role} for ${username}`);
    const person = u.personnel ? byName.personnel.get(String(u.personnel)) : null;
    const mdt = u.mdt ? byName.mdts.get(String(u.mdt).toUpperCase()) : null;
    const user = {
      id: nextId('users'), username, password_hash: hashPassword(String(u.password)),
      role: u.role, display_name: u.display_name || username,
      personnel_id: person ? person.id : null, mdt_id: mdt ? mdt.id : null,
      email: u.email ? String(u.email).toLowerCase() : null,
      created_at: new Date().toISOString(),
    };
    db.users.push(user);
    if (person) person.user_id = user.id;
  }

  logEvent('system.seeded', `Loaded ${db.callsigns.length} call signs, ${db.personnel.length} personnel and ${db.sites.length} sites from ${path.basename(file)}`);
}

function seed() {
  const seedFile = process.env.SEED_FILE || path.join(__dirname, 'seed.json');
  if (fs.existsSync(seedFile)) {
    console.log(`[cccs] seeding from ${seedFile}`);
    return seedFromFile(seedFile);
  }
  console.warn('[cccs] no seed.json found — loading demo data. Copy seed.example.json to seed.json for your own call signs.');
  const mkUser = (username, password, role, extra = {}) => {
    const u = { id: nextId('users'), username, password_hash: hashPassword(password), role, display_name: extra.display_name || username, personnel_id: null, mdt_id: null, created_at: new Date().toISOString(), ...extra };
    db.users.push(u); return u;
  };
  const mkVehicle = (reg, type) => { const v = { id: nextId('vehicles'), registration: reg, type, make: '', model: '', service_due_at: null, insurance_due_at: null, mileage: null, condition: '', assigned_personnel_id: null, status: 'ACTIVE', notes: '' }; db.vehicles.push(v); return v; };
  const mkCallsign = (name, desc) => { const c = { id: nextId('callsigns'), name, description: desc, active: true }; db.callsigns.push(c); return c; };
  const mkPerson = (name, rank, callsign_id, vehicle_id = null) => {
    const p = {
      id: nextId('personnel'), employee_no: null, name, rank, contact_phone: '', contact_email: '',
      employment_status: 'ACTIVE', callsign_id, user_id: null, vehicle_id,
      welfare_interval_s: null, welfare_due_at: null, welfare_warned: false, welfare_note: '', notes: '',
    };
    db.personnel.push(p); return p;
  };
  const mkMdt = (code, serial, callsign_id, vehicle_id) => {
    const m = { id: nextId('mdts'), mdt_code: code, serial, callsign_id, vehicle_id, status: 'OFFLINE', duty_status: 'AVAILABLE', job_id: null, battery: 80 + Math.floor(Math.random() * 20), network: 'LTE', operator: null, lat: null, lon: null, connected: false, crew: [], emergency: false };
    db.mdts.push(m); return m;
  };

  const mkSite = (name, address, lat, lon, keyholder) => {
    const st = { id: nextId('sites'), name, address, lat, lon, keyholder, contract: 'ACTIVE', checklist: [] };
    db.sites.push(st); return st;
  };

  mkSite('Meridian Business Park', 'Unit 4, Meridian Way', 51.5290, -0.0870, 'J. Whitlock 07700 900412');
  mkSite('Carlton Retail Centre', '18 Carlton Road', 51.4930, -0.1620, 'Duty manager 07700 900188');
  mkSite('Northgate Distribution', 'Northgate Industrial Estate', 51.5510, -0.1050, 'Site office 07700 900233');
  mkSite('Ashcroft House', '112 Ashcroft Lane', 51.4820, -0.0940, 'Facilities 07700 900571');

  const v1 = mkVehicle('VAN-101', 'Patrol van');
  const v2 = mkVehicle('VAN-102', 'Patrol van');
  const v3 = mkVehicle('VAN-103', 'Patrol van');
  const v4 = mkVehicle('CAR-201', 'Response car');

  const p101 = mkCallsign('P101', 'Mobile patrol, north');
  const p102 = mkCallsign('P102', 'Mobile patrol, north');
  const p103 = mkCallsign('P103', 'Mobile patrol, south');
  const p104 = mkCallsign('P104', 'Static guard, Meridian');
  const m201 = mkCallsign('M201', 'Alarm response');
  const m202 = mkCallsign('M202', 'Alarm response');
  mkCallsign('CONTROL', 'Control room');
  mkCallsign('SUPERVISOR', 'Duty supervisor');

  const dan = mkPerson('Dan Whitfield', 'Patrol officer', p101.id, v1.id);
  mkPerson('Sam Oduya', 'Patrol officer', p101.id);
  const ellie = mkPerson('Ellie Marsh', 'Patrol officer', p102.id, v2.id);
  const ryan = mkPerson('Ryan Cole', 'Response officer', p103.id, v3.id);
  mkPerson('Jo Vance', 'Static guard', p104.id);

  const m1 = mkMdt('MDT-001', 'SN-MDT-0001', p101.id, v1.id);
  mkMdt('MDT-002', 'SN-MDT-0002', p102.id, v2.id);
  mkMdt('MDT-003', 'SN-MDT-0003', p103.id, v3.id);

  mkUser('admin', 'admin123', 'SYSTEM_ADMIN', { display_name: 'System Admin' });
  mkUser('dispatcher', 'dispatch123', 'DISPATCHER', { display_name: 'Controller Hale' });
  mkUser('supervisor', 'super123', 'SUPERVISOR', { display_name: 'Supervisor Reid' });
  const uDan = mkUser('dwhitfield', 'field123', 'FIELD_USER', { display_name: 'Dan Whitfield', personnel_id: dan.id });
  const uEllie = mkUser('emarsh', 'field123', 'FIELD_USER', { display_name: 'Ellie Marsh', personnel_id: ellie.id });
  const uRyan = mkUser('rcole', 'field123', 'FIELD_USER', { display_name: 'Ryan Cole', personnel_id: ryan.id });
  dan.user_id = uDan.id; ellie.user_id = uEllie.id; ryan.user_id = uRyan.id;
  mkUser('mdt001', 'mdt123', 'MDT_USER', { display_name: 'MDT-001 Operator', mdt_id: m1.id });

  logEvent('system.seeded', 'Demo data loaded');
}

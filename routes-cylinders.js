/**
 * Medical gas cylinders — oxygen and Entonox, one record per cylinder.
 *
 * A cylinder is not counted stock: each one has its own serial number,
 * contents, location and history, and most are rented from the gas supplier
 * and must go back. So it is its own register rather than a stock item:
 *   - RECEIVED from the supplier (serial, gas, size, batch, contents expiry,
 *     delivery reference) — it starts FULL in a store location;
 *   - CHECKED: a gauge reading (% full) and whether the seal is intact;
 *   - MOVED between store locations (main store, a vehicle's kit, a bag) —
 *     the same locations as stock, so a cylinder in a bag follows the bag;
 *   - USED: what is left afterwards; 0% makes it EMPTY;
 *   - EMPTY, FAULT (quarantined, not to be used) and RETURNED to the
 *     supplier with a collection reference — returned cylinders leave the
 *     working list but keep their history.
 * Every one of those is a cylinder_events row; the cylinder's own fields are
 * its current state. The overview flags contents expired or expiring within
 * 30 days, checks overdue (none in CHECK_DAYS), low cylinders, and empties
 * waiting to go back.
 *
 * Who: control roles (dispatchers, supervisors, admins) log checks, moves,
 * use, empties and returns — they run the stores and vehicles day to day.
 * Only an admin adds, edits or deletes a cylinder record, and one with any
 * history beyond its delivery cannot be deleted (return it instead).
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const GASES = ['OXYGEN', 'ENTONOX'];
const STATUSES = ['FULL', 'IN_USE', 'EMPTY', 'QUARANTINE', 'RETURNED'];
const OWNERSHIP = ['RENTED', 'OWNED'];
const EVENT_TYPES = ['CHECKED', 'MOVED', 'USED', 'EMPTY', 'FAULT', 'RETURNED', 'NOTE'];
const CHECK_DAYS = 7;
const DUE_SOON_DAYS = 30;
const LOW_PCT = 25;

module.exports = function registerCylinderRoutes({ route, httpError, CONTROL, ADMIN, db, nextId, logEvent }) {
  for (const t of ['gas_cylinders', 'cylinder_events', 'stock_locations']) if (!Array.isArray(db[t])) db[t] = [];

  const find = (id) => {
    const c = db.gas_cylinders.find((x) => x.id === Number(id));
    if (!c) throw httpError(404, 'cylinder not found');
    return c;
  };
  const location = (id) => {
    if (id == null || id === '') return null;
    const l = db.stock_locations.find((x) => x.id === Number(id));
    if (!l) throw httpError(400, 'store location not found');
    return l;
  };
  const pct = (raw) => {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw httpError(400, 'contents must be 0–100%');
    return Math.round(n);
  };
  const dateOrNull = (raw, what) => {
    if (!raw) return null;
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(raw)) || isNaN(Date.parse(raw))) throw httpError(400, `${what} must be a date`);
    return String(raw).slice(0, 10);
  };
  const str = (raw, max = 120) => String(raw ?? '').trim().slice(0, max);
  const label = (c) => `${c.gas === 'OXYGEN' ? 'Oxygen' : 'Entonox'} ${c.size || ''} ${c.serial}`.replace(/\s+/g, ' ');

  function addEvent(c, type, user, extra = {}) {
    const e = {
      id: nextId('cylinder_events'), cylinder_id: c.id, type, at: new Date().toISOString(), by: user.username,
      location_id: c.location_id || null, contents_pct: c.contents_pct, status: c.status, reference: '', note: '', ...extra,
    };
    db.cylinder_events.push(e);
    return e;
  }

  /** Current state plus everything the page flags. */
  function describe(c, now = Date.now()) {
    const today = new Date(now).toISOString().slice(0, 10);
    const soon = new Date(now + DUE_SOON_DAYS * 86400000).toISOString().slice(0, 10);
    const l = c.location_id ? db.stock_locations.find((x) => x.id === c.location_id) : null;
    const v = l && l.vehicle_id ? db.vehicles.find((x) => x.id === l.vehicle_id) : null;
    const active = c.status !== 'RETURNED';
    const lastCheck = c.last_check_at ? Date.parse(c.last_check_at) : null;
    return {
      ...c,
      location_name: l ? l.name : null,
      in_vehicle: v ? v.registration : null,
      expired: Boolean(active && c.expiry_date && c.expiry_date < today),
      expiring_soon: Boolean(active && c.expiry_date && c.expiry_date >= today && c.expiry_date <= soon),
      check_overdue: active && !['EMPTY', 'QUARANTINE'].includes(c.status) && (!lastCheck || now - lastCheck > CHECK_DAYS * 86400000),
      low: active && c.status === 'IN_USE' && c.contents_pct != null && c.contents_pct <= LOW_PCT,
    };
  }

  route('GET', '/api/cylinders', CONTROL, ({ query }) => {
    const all = query.get('include_returned') === '1';
    const rows = db.gas_cylinders.filter((c) => all || c.status !== 'RETURNED').map((c) => describe(c))
      .sort((a, b) => a.gas.localeCompare(b.gas) || String(a.size).localeCompare(String(b.size)) || a.serial.localeCompare(b.serial));
    const live = rows.filter((c) => c.status !== 'RETURNED');
    const count = (gas, status) => live.filter((c) => c.gas === gas && c.status === status).length;
    return {
      cylinders: rows,
      check_days: CHECK_DAYS,
      summary: {
        oxygen_full: count('OXYGEN', 'FULL'), entonox_full: count('ENTONOX', 'FULL'),
        in_use: live.filter((c) => c.status === 'IN_USE').length,
        to_return: live.filter((c) => c.status === 'EMPTY' || (c.status === 'QUARANTINE' && c.ownership === 'RENTED')).length,
        expiring: live.filter((c) => c.expired || c.expiring_soon).length,
        check_overdue: live.filter((c) => c.check_overdue).length,
      },
    };
  });

  route('GET', '/api/cylinders/:id/history', CONTROL, ({ params }) => {
    const c = find(params.id);
    return db.cylinder_events.filter((e) => e.cylinder_id === c.id).map((e) => {
      const l = e.location_id ? db.stock_locations.find((x) => x.id === e.location_id) : null;
      return { ...e, location_name: l ? l.name : null };
    }).reverse();
  });

  /** Delivery of a new cylinder from the supplier. */
  route('POST', '/api/cylinders', ADMIN, ({ body, user }) => {
    const serial = str(body.serial, 40);
    if (!serial) throw httpError(400, 'serial number required');
    if (db.gas_cylinders.some((c) => c.serial.toLowerCase() === serial.toLowerCase() && c.status !== 'RETURNED')) {
      throw httpError(409, 'a cylinder with that serial number is already on the register');
    }
    if (!GASES.includes(body.gas)) throw httpError(400, `gas must be one of ${GASES.join(', ')}`);
    const l = location(body.location_id);
    const c = {
      id: nextId('gas_cylinders'), serial, gas: body.gas, size: str(body.size, 12).toUpperCase(),
      capacity_litres: body.capacity_litres == null || body.capacity_litres === '' ? null : Number(body.capacity_litres),
      ownership: OWNERSHIP.includes(body.ownership) ? body.ownership : 'RENTED',
      supplier: str(body.supplier), batch_no: str(body.batch_no, 40), expiry_date: dateOrNull(body.expiry_date, 'expiry date'),
      status: 'FULL', contents_pct: 100, location_id: l ? l.id : null,
      received_at: new Date().toISOString(), last_check_at: null, notes: str(body.notes, 500),
    };
    if (c.capacity_litres != null && (!Number.isFinite(c.capacity_litres) || c.capacity_litres < 0)) throw httpError(400, 'capacity must be a number of litres');
    db.gas_cylinders.push(c);
    addEvent(c, 'RECEIVED', user, { reference: str(body.reference, 60), note: c.supplier ? `from ${c.supplier}` : '' });
    logEvent('cylinder.received', `${label(c).toUpperCase()} RECEIVED BY ${user.username}`, { cylinder_id: c.id });
    return { __status: 201, __body: describe(c) };
  });

  /** Correct the record itself (a mistyped serial, batch or expiry). */
  route('PATCH', '/api/cylinders/:id', ADMIN, ({ params, body }) => {
    const c = find(params.id);
    if ('serial' in body) {
      const serial = str(body.serial, 40);
      if (!serial) throw httpError(400, 'serial number required');
      if (db.gas_cylinders.some((x) => x.id !== c.id && x.serial.toLowerCase() === serial.toLowerCase() && x.status !== 'RETURNED')) throw httpError(409, 'a cylinder with that serial number is already on the register');
      c.serial = serial;
    }
    if ('gas' in body) { if (!GASES.includes(body.gas)) throw httpError(400, 'invalid gas'); c.gas = body.gas; }
    if ('size' in body) c.size = str(body.size, 12).toUpperCase();
    if ('capacity_litres' in body) {
      const n = body.capacity_litres == null || body.capacity_litres === '' ? null : Number(body.capacity_litres);
      if (n != null && (!Number.isFinite(n) || n < 0)) throw httpError(400, 'capacity must be a number of litres');
      c.capacity_litres = n;
    }
    if ('ownership' in body && OWNERSHIP.includes(body.ownership)) c.ownership = body.ownership;
    if ('supplier' in body) c.supplier = str(body.supplier);
    if ('batch_no' in body) c.batch_no = str(body.batch_no, 40);
    if ('expiry_date' in body) c.expiry_date = dateOrNull(body.expiry_date, 'expiry date');
    if ('notes' in body) c.notes = str(body.notes, 500);
    return describe(c);
  });

  /** Only a record entered by mistake: one with history is returned, not deleted. */
  route('DELETE', '/api/cylinders/:id', ADMIN, ({ params, user }) => {
    const c = find(params.id);
    if (db.cylinder_events.some((e) => e.cylinder_id === c.id && e.type !== 'RECEIVED')) {
      throw httpError(409, 'this cylinder has a history — mark it returned instead of deleting it');
    }
    db.gas_cylinders.splice(db.gas_cylinders.indexOf(c), 1);
    db.cylinder_events = db.cylinder_events.filter((e) => e.cylinder_id !== c.id);
    logEvent('cylinder.deleted', `${label(c).toUpperCase()} DELETED BY ${user.username}`, { cylinder_id: c.id });
    return { ok: true };
  });

  /** One route for everything that happens to a cylinder. */
  route('POST', '/api/cylinders/:id/log', CONTROL, ({ params, body, user }) => {
    const c = find(params.id);
    const type = body.type;
    if (!EVENT_TYPES.includes(type)) throw httpError(400, `type must be one of ${EVENT_TYPES.join(', ')}`);
    if (c.status === 'RETURNED' && type !== 'NOTE') throw httpError(409, 'this cylinder has been returned to the supplier');
    const note = str(body.note, 500), reference = str(body.reference, 60);
    switch (type) {
      case 'CHECKED': {
        const p = pct(body.contents_pct);
        if (p == null) throw httpError(400, 'enter the gauge reading');
        c.contents_pct = p;
        // Only a full gauge with the seal still on counts as FULL — a broken
        // seal means it has been opened, whatever the gauge says.
        if (c.status !== 'QUARANTINE') c.status = p === 0 ? 'EMPTY' : p === 100 && body.seal_intact !== false ? 'FULL' : 'IN_USE';
        c.last_check_at = new Date().toISOString();
        addEvent(c, 'CHECKED', user, { note: [body.seal_intact === false ? 'seal broken' : body.seal_intact === true ? 'seal intact' : '', note].filter(Boolean).join(' — ') });
        break;
      }
      case 'MOVED': {
        const l = location(body.location_id);
        if (!l) throw httpError(400, 'choose where it is going');
        const from = c.location_id;
        c.location_id = l.id;
        const fromL = from ? db.stock_locations.find((x) => x.id === from) : null;
        addEvent(c, 'MOVED', user, { note: [fromL ? `from ${fromL.name}` : '', note].filter(Boolean).join(' — ') });
        break;
      }
      case 'USED': {
        const p = pct(body.contents_pct);
        if (p == null) throw httpError(400, 'enter what is left (%)');
        if (c.contents_pct != null && p > c.contents_pct) throw httpError(400, `it was at ${c.contents_pct}% — use cannot add gas`);
        c.contents_pct = p;
        c.status = p === 0 ? 'EMPTY' : 'IN_USE';
        addEvent(c, 'USED', user, { reference, note });
        break;
      }
      case 'EMPTY':
        c.contents_pct = 0; c.status = 'EMPTY';
        addEvent(c, 'EMPTY', user, { note });
        break;
      case 'FAULT':
        if (!note) throw httpError(400, 'say what is wrong with it');
        c.status = 'QUARANTINE';
        addEvent(c, 'FAULT', user, { note });
        break;
      case 'RETURNED':
        c.status = 'RETURNED'; c.location_id = null; c.returned_at = new Date().toISOString();
        addEvent(c, 'RETURNED', user, { reference, note });
        break;
      case 'NOTE':
        if (!note) throw httpError(400, 'note required');
        addEvent(c, 'NOTE', user, { note });
        break;
      default: break;
    }
    if (type !== 'NOTE') logEvent(`cylinder.${type.toLowerCase()}`, `${label(c).toUpperCase()} ${type} BY ${user.username}`, { cylinder_id: c.id });
    return describe(c);
  });

  return { GASES, STATUSES };
};

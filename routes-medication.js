/**
 * Medication, including controlled drugs (CDs).
 *
 * A medicine is one drug in one form and strength — "Morphine sulfate
 * 10 mg/1 ml ampoule" — because a CD register keeps a separate page per
 * drug, form and strength. Stock is held per store location (the same
 * locations as stock and cylinders: a drugs safe, a vehicle's CD box, a
 * paramedic bag) and per batch with an expiry date.
 *
 * THE LEDGER. Every change is a med_movements row and nobody types a level
 * in: RECEIVED (supplier and invoice/requisition), TRANSFER_OUT/IN,
 * ADMINISTERED (patient, dose given, any dose wasted, authority), WASTED
 * (broken, drawn up and not used), DESTROYED (expired or unwanted stock),
 * RETURNED (to the supplier or pharmacy), STOCK_CHECK (a count; the
 * difference is booked and kept) and CORRECTION. Entries are never edited
 * or deleted — a mistake is put right by a CORRECTION entry that points at
 * the one it corrects, with a reason, so the register reads as it happened.
 * Each row carries the running balance after it, for that location and in
 * total. Levels can never go below zero, and expired stock can be
 * destroyed or returned but never administered.
 *
 * CONTROLLED DRUGS. A medicine marked controlled (with its schedule) is held
 * to more:
 *   - every entry needs a WITNESS: a second, different staff member, who
 *     confirms with their own username and password — so the witness is
 *     attributable, not a name typed by the person making the entry;
 *   - administration needs the patient's name; waste, destruction and
 *     corrections need a reason; receipts need the supplier;
 *   - its stock check records every count, correct or not, and any
 *     discrepancy is flagged for the CD Accountable Officer;
 *   - its strength, form and schedule cannot be changed once it has any
 *     entries (that would rewrite the register page).
 * Every CD write is flushed to disk at once rather than on the usual
 * interval.
 *
 * Who: administering and recording waste is any staff role (the crew giving
 * the drug). Receiving, moving, destroying, returning, stock checks and
 * corrections are control roles. The catalogue is admin only. Hiding the
 * section from a role in the menu does not change any of that.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const STAFF = ['FIELD_USER', 'DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'];
const FORMS = ['AMPOULE', 'VIAL', 'TABLET', 'CAPSULE', 'ORAL_SOLUTION', 'PREFILLED_SYRINGE', 'INHALER', 'NEBULE', 'SPRAY', 'PATCH', 'SACHET', 'OTHER'];
const LEGAL = ['POM', 'P', 'GSL'];
const SCHEDULES = [2, 3, 4, 5];
const DUE_SOON_DAYS = 60;
const round = (n) => Math.round(n * 100) / 100;

module.exports = function registerMedicationRoutes({ route, httpError, CONTROL, ADMIN, db, nextId, logEvent, verifyPassword, flushNow = () => {} }) {
  for (const t of ['medicines', 'med_movements', 'stock_locations', 'users']) if (!Array.isArray(db[t])) db[t] = [];

  const str = (raw, max = 120) => String(raw ?? '').trim().slice(0, max);
  const findMed = (id) => {
    const m = db.medicines.find((x) => x.id === Number(id));
    if (!m) throw httpError(404, 'medicine not found');
    return m;
  };
  const findLoc = (id, what = 'location') => {
    const l = id ? db.stock_locations.find((x) => x.id === Number(id)) : null;
    if (!l) throw httpError(400, `choose a ${what}`);
    return l;
  };
  const qty = (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw httpError(400, 'quantity must be more than 0');
    return round(n);
  };
  const dateOrNull = (raw, what) => {
    if (!raw) return null;
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(raw)) || isNaN(Date.parse(raw))) throw httpError(400, `${what} must be a date`);
    return String(raw).slice(0, 10);
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const label = (m) => `${m.name} ${m.strength}${m.form ? ' ' + m.form.toLowerCase().replace(/_/g, ' ') : ''}`.trim();
  const unitText = (m, n) => `${n} ${m.unit || ''}`.trim();

  /* ---- levels, per location and batch, from the ledger ---- */
  const batchKey = (mv) => `${mv.location_id}|${mv.batch_no || ''}|${mv.expiry_date || ''}`;
  function batches(medId, rows = db.med_movements.filter((x) => x.medicine_id === medId)) {
    const held = new Map();
    for (const mv of rows) {
      const k = batchKey(mv);
      held.set(k, round((held.get(k) || 0) + mv.delta));
    }
    return [...held].filter(([, n]) => n > 0).map(([k, n]) => {
      const [loc, batch_no, expiry_date] = k.split('|');
      return { location_id: Number(loc), batch_no, expiry_date: expiry_date || null, qty: n };
    }).sort((a, b) => String(a.expiry_date || '9999').localeCompare(String(b.expiry_date || '9999')));
  }
  const levelAt = (medId, locId) => round(batches(medId).filter((b) => b.location_id === locId).reduce((n, b) => n + b.qty, 0));
  const total = (medId) => round(db.med_movements.filter((x) => x.medicine_id === medId).reduce((n, x) => n + x.delta, 0));

  /** The second person on a CD entry: a different staff member who proves
   * it with their own password. Returned as { username, name }. */
  function witness(body, user, required) {
    const name = str(body.witness_username, 60).toLowerCase();
    if (!name) { if (required) throw httpError(400, 'a controlled drug entry needs a witness'); return null; }
    const w = db.users.find((u) => u.username === name);
    if (!w || !verifyPassword(String(body.witness_password || ''), w.password_hash)) {
      logEvent('medication.witness_failed', `CD WITNESS CHECK FAILED FOR ${name} (ENTRY BY ${user.username})`);
      throw httpError(400, 'witness username or password is wrong');
    }
    if (w.id === user.id) throw httpError(400, 'the witness must be someone else');
    if (!STAFF.includes(w.role)) throw httpError(400, 'the witness must be a member of staff');
    return { username: w.username, name: w.display_name || w.username };
  }

  /** Writes ledger rows, each with the balance after it. */
  function record(m, rows, user, shared) {
    const group = nextId('med_movements');
    const out = rows.map((r) => {
      const mv = {
        id: nextId('med_movements'), group_id: group, medicine_id: m.id, at: new Date().toISOString(),
        by: user.username, by_name: user.display_name || user.username, controlled: Boolean(m.controlled),
        batch_no: '', expiry_date: null, witness: null, witness_name: null, ...shared, ...r,
      };
      db.med_movements.push(mv);
      mv.location_balance_after = levelAt(m.id, mv.location_id);
      mv.balance_after = total(m.id);
      return mv;
    });
    if (m.controlled) flushNow();
    return out;
  }

  /** Takes n out of a location: from the batch given, or earliest expiry
   * first. Returns one row per batch it came from. */
  function take(m, locId, n, { batch_no, expiry_date, allowExpired }) {
    let bs = batches(m.id).filter((b) => b.location_id === locId);
    if (batch_no != null && batch_no !== '') bs = bs.filter((b) => b.batch_no === batch_no && (!expiry_date || b.expiry_date === expiry_date));
    if (!allowExpired) bs = bs.filter((b) => !b.expiry_date || b.expiry_date >= today());
    const have = round(bs.reduce((s, b) => s + b.qty, 0));
    if (have < n) {
      const expiredToo = !allowExpired && levelAt(m.id, locId) >= n;
      throw httpError(409, `only ${unitText(m, have)} ${expiredToo ? 'in date ' : ''}there${batch_no ? ' in that batch' : ''}`);
    }
    const rows = [];
    let left = n;
    for (const b of bs) {
      if (left <= 0) break;
      const part = Math.min(left, b.qty);
      rows.push({ location_id: locId, batch_no: b.batch_no, expiry_date: b.expiry_date, delta: -round(part) });
      left = round(left - part);
    }
    return rows;
  }

  function describe(m) {
    const bs = batches(m.id);
    const t = today(), soon = new Date(Date.now() + DUE_SOON_DAYS * 86400000).toISOString().slice(0, 10);
    const levels = {};
    for (const b of bs) levels[b.location_id] = round((levels[b.location_id] || 0) + b.qty);
    const tot = round(bs.reduce((n, b) => n + b.qty, 0));
    return {
      ...m, total: tot, levels,
      batches: bs.map((b) => ({ ...b, expired: Boolean(b.expiry_date && b.expiry_date < t), expiring_soon: Boolean(b.expiry_date && b.expiry_date >= t && b.expiry_date <= soon) })),
      below_reorder: m.reorder_level != null && tot <= m.reorder_level,
      has_entries: db.med_movements.some((x) => x.medicine_id === m.id),
    };
  }
  const locName = (id) => (db.stock_locations.find((l) => l.id === id) || {}).name || '—';
  const publicMove = (mv) => {
    const m = db.medicines.find((x) => x.id === mv.medicine_id);
    const corrected = db.med_movements.find((x) => x.corrects_id === mv.id);
    return { ...mv, medicine: m ? label(m) : '?', unit: m ? m.unit : '', location_name: locName(mv.location_id), corrected_by: corrected ? corrected.id : null };
  };

  /* ================= catalogue (admin) ================= */
  function applyMed(m, body, isNew) {
    const locked = !isNew && db.med_movements.some((x) => x.medicine_id === m.id);
    if ('name' in body) { const n = str(body.name, 80); if (!n) throw httpError(400, 'name required'); m.name = n; }
    for (const k of ['strength', 'form', 'controlled', 'cd_schedule']) {
      if (!(k in body) || isNew) continue;
      const changed = k === 'controlled' ? Boolean(body[k]) !== Boolean(m[k]) : String(body[k] ?? '') !== String(m[k] ?? '');
      if (locked && changed && (m.controlled || k === 'controlled')) throw httpError(409, `${k.replace('_', ' ')} cannot change once a controlled drug has register entries — add a new medicine instead`);
    }
    if ('strength' in body) m.strength = str(body.strength, 40);
    if ('form' in body) { if (body.form && !FORMS.includes(body.form)) throw httpError(400, 'invalid form'); m.form = body.form || 'OTHER'; }
    if ('unit' in body) m.unit = str(body.unit, 20);
    if ('legal_category' in body) { if (body.legal_category && !LEGAL.includes(body.legal_category)) throw httpError(400, 'invalid legal category'); m.legal_category = body.legal_category || 'POM'; }
    if ('controlled' in body) m.controlled = body.controlled === true;
    if ('cd_schedule' in body || 'controlled' in body) {
      const s = body.cd_schedule == null || body.cd_schedule === '' ? (m.controlled ? m.cd_schedule : null) : Number(body.cd_schedule);
      if (m.controlled && !SCHEDULES.includes(s)) throw httpError(400, 'a controlled drug needs its schedule (2, 3, 4 or 5)');
      m.cd_schedule = m.controlled ? s : null;
    }
    if ('reorder_level' in body) {
      const n = body.reorder_level == null || body.reorder_level === '' ? null : Number(body.reorder_level);
      if (n != null && (!Number.isFinite(n) || n < 0)) throw httpError(400, 'reorder level must be 0 or more');
      m.reorder_level = n;
    }
    if ('active' in body) m.active = body.active !== false;
    if ('notes' in body) m.notes = str(body.notes, 500);
    if (!m.name) throw httpError(400, 'name required');
    if (db.medicines.some((x) => x.id !== m.id && x.name.toLowerCase() === m.name.toLowerCase() && x.strength.toLowerCase() === m.strength.toLowerCase() && x.form === m.form)) {
      throw httpError(409, 'that medicine, strength and form is already in the list');
    }
  }
  route('POST', '/api/medication/medicines', ADMIN, ({ body, user }) => {
    const m = { id: 0, name: '', strength: '', form: 'OTHER', unit: '', legal_category: 'POM', controlled: false, cd_schedule: null, reorder_level: null, active: true, notes: '', created_at: new Date().toISOString() };
    applyMed(m, body, true);
    m.id = nextId('medicines');
    db.medicines.push(m);
    logEvent('medication.medicine_added', `MEDICINE ${label(m).toUpperCase()}${m.controlled ? ` (CD SCHEDULE ${m.cd_schedule})` : ''} ADDED BY ${user.username}`, { medicine_id: m.id });
    return { __status: 201, __body: describe(m) };
  });
  route('PATCH', '/api/medication/medicines/:id', ADMIN, ({ params, body }) => {
    const m = findMed(params.id);
    applyMed(m, body, false);
    return describe(m);
  });
  route('DELETE', '/api/medication/medicines/:id', ADMIN, ({ params, user }) => {
    const m = findMed(params.id);
    if (db.med_movements.some((x) => x.medicine_id === m.id)) throw httpError(409, 'it has entries — mark it inactive instead');
    db.medicines.splice(db.medicines.indexOf(m), 1);
    logEvent('medication.medicine_deleted', `MEDICINE ${label(m).toUpperCase()} DELETED BY ${user.username}`, { medicine_id: m.id });
    return { ok: true };
  });

  /* ================= reading ================= */
  route('GET', '/api/medication', STAFF, () => {
    const meds = db.medicines.map(describe).sort((a, b) => a.name.localeCompare(b.name) || a.strength.localeCompare(b.strength));
    const since = Date.now() - 30 * 86400000;
    const discrepancies = db.med_movements.filter((x) => x.type === 'STOCK_CHECK' && x.delta !== 0 && Date.parse(x.at) >= since).map(publicMove).reverse();
    return {
      medicines: meds,
      locations: db.stock_locations.filter((l) => l.active !== false).map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
      discrepancies,
      summary: {
        medicines: meds.filter((m) => m.active !== false).length,
        controlled: meds.filter((m) => m.controlled && m.active !== false).length,
        below_reorder: meds.filter((m) => m.active !== false && m.below_reorder).length,
        expiring: meds.filter((m) => m.batches.some((b) => b.expired || b.expiring_soon)).length,
        discrepancies: discrepancies.filter((d) => d.controlled).length,
      },
    };
  });
  route('GET', '/api/medication/movements', STAFF, ({ query }) => {
    let rows = db.med_movements;
    if (query.get('medicine_id')) rows = rows.filter((x) => x.medicine_id === Number(query.get('medicine_id')));
    if (query.get('location_id')) rows = rows.filter((x) => x.location_id === Number(query.get('location_id')));
    const limit = Math.min(Number(query.get('limit')) || 300, 2000);
    return rows.slice(-limit).reverse().map(publicMove);
  });
  /** One medicine's register page: every entry in order, with the running
   * balance after each, in total and for the location it touched. */
  route('GET', '/api/medication/register/:id', STAFF, ({ params }) => {
    const m = findMed(params.id);
    return { medicine: describe(m), entries: db.med_movements.filter((x) => x.medicine_id === m.id).map(publicMove) };
  });

  /* ================= entries ================= */
  const entryLog = (m, type, rows, user, extra = '') => logEvent(`medication.${type.toLowerCase()}`,
    `${m.controlled ? 'CD ' : ''}${type} ${unitText(m, Math.abs(round(rows.reduce((n, r) => n + r.delta, 0))) || '')} ${label(m).toUpperCase()} BY ${user.username}${rows[0] && rows[0].witness ? ` WITNESS ${rows[0].witness}` : ''}${extra}`,
    { medicine_id: m.id, movement_ids: rows.map((r) => r.id) });
  const wit = (m, body, user) => {
    const w = witness(body, user, Boolean(m.controlled));
    return w ? { witness: w.username, witness_name: w.name } : {};
  };

  route('POST', '/api/medication/:id/receive', CONTROL, ({ params, body, user }) => {
    const m = findMed(params.id);
    const n = qty(body.quantity), l = findLoc(body.location_id);
    const expiry = dateOrNull(body.expiry_date, 'expiry date');
    if (!expiry) throw httpError(400, 'expiry date required');
    const supplier = str(body.supplier);
    if (m.controlled && !supplier) throw httpError(400, 'a controlled drug receipt needs the supplier');
    const rows = record(m, [{ type: 'RECEIVED', location_id: l.id, delta: n, batch_no: str(body.batch_no, 40), expiry_date: expiry }], user,
      { supplier, reference: str(body.reference, 60), note: str(body.note, 300), ...wit(m, body, user) });
    entryLog(m, 'RECEIVED', rows, user);
    return { __status: 201, __body: rows };
  });

  route('POST', '/api/medication/:id/transfer', CONTROL, ({ params, body, user }) => {
    const m = findMed(params.id);
    const n = qty(body.quantity), from = findLoc(body.from_location_id, 'location to move from'), to = findLoc(body.to_location_id, 'location to move to');
    if (from.id === to.id) throw httpError(400, 'from and to are the same place');
    const w = wit(m, body, user);
    const out = take(m, from.id, n, { batch_no: body.batch_no, expiry_date: body.expiry_date, allowExpired: true }).map((r) => ({ ...r, type: 'TRANSFER_OUT' }));
    const rows = record(m, [...out, ...out.map((r) => ({ ...r, type: 'TRANSFER_IN', location_id: to.id, delta: -r.delta }))], user,
      { note: str(body.note, 300), from_location_id: from.id, to_location_id: to.id, ...w });
    entryLog(m, 'TRANSFER', rows.filter((r) => r.type === 'TRANSFER_IN'), user, ` ${from.name.toUpperCase()} TO ${to.name.toUpperCase()}`);
    return { __status: 201, __body: rows };
  });

  route('POST', '/api/medication/:id/administer', STAFF, ({ params, body, user }) => {
    const m = findMed(params.id);
    const n = qty(body.quantity), l = findLoc(body.location_id, 'location it came from');
    const patient = str(body.patient_name, 80), ref = str(body.patient_ref, 60), dose = str(body.dose_given, 60);
    if (m.controlled && !patient) throw httpError(400, "a controlled drug administration needs the patient's name");
    if (!patient && !ref) throw httpError(400, 'enter the patient or the job / patient report number');
    if (!dose) throw httpError(400, 'enter the dose given');
    const w = wit(m, body, user);
    const rows = record(m, take(m, l.id, n, { batch_no: body.batch_no, expiry_date: body.expiry_date }).map((r) => ({ ...r, type: 'ADMINISTERED' })), user,
      { patient_name: patient, patient_ref: ref, dose_given: dose, dose_wasted: str(body.dose_wasted, 60), route: str(body.route, 30), authority: str(body.authority, 80), note: str(body.note, 300), ...w });
    entryLog(m, 'ADMINISTERED', rows, user);
    return { __status: 201, __body: rows };
  });

  for (const [path, type, roles, allowExpired] of [['waste', 'WASTED', STAFF, true], ['destroy', 'DESTROYED', CONTROL, true], ['return', 'RETURNED', CONTROL, true]]) {
    route('POST', `/api/medication/:id/${path}`, roles, ({ params, body, user }) => {
      const m = findMed(params.id);
      const n = qty(body.quantity), l = findLoc(body.location_id);
      const reason = str(body.reason, 300);
      if ((m.controlled || type !== 'RETURNED') && !reason) throw httpError(400, 'a reason is required');
      const w = wit(m, body, user);
      const rows = record(m, take(m, l.id, n, { batch_no: body.batch_no, expiry_date: body.expiry_date, allowExpired }).map((r) => ({ ...r, type })), user,
        { reason, reference: str(body.reference, 60), note: str(body.note, 300), ...w });
      entryLog(m, type, rows, user);
      return { __status: 201, __body: rows };
    });
  }

  /** Count one location. Each line: { medicine_id, batch_no, expiry_date,
   * counted }. A CD line is recorded even when the count is right; any
   * difference is booked as a STOCK_CHECK entry with the reason. A count
   * that includes a CD needs a witness. */
  route('POST', '/api/medication/stock-check', CONTROL, ({ body, user }) => {
    const l = findLoc(body.location_id);
    const lines = Array.isArray(body.counts) ? body.counts : [];
    if (!lines.length) throw httpError(400, 'enter at least one count');
    const meds = lines.map((c) => findMed(c.medicine_id));
    const anyCd = meds.some((m) => m.controlled);
    const w = witness(body, user, anyCd);
    const reason = str(body.reason, 300);
    const plan = lines.map((c, n) => {
      const m = meds[n];
      const counted = Number(c.counted);
      if (!Number.isFinite(counted) || counted < 0) throw httpError(400, `count for ${label(m)} must be 0 or more`);
      const b = batches(m.id).find((x) => x.location_id === l.id && x.batch_no === String(c.batch_no || '') && (x.expiry_date || '') === String(c.expiry_date || ''));
      const expected = b ? b.qty : 0;
      return { m, counted: round(counted), expected, diff: round(counted - expected), batch_no: String(c.batch_no || ''), expiry_date: c.expiry_date || null };
    });
    if (plan.some((p) => p.diff !== 0) && !reason) throw httpError(400, 'a count that does not match needs a reason');
    const check = nextId('med_movements');
    const out = [];
    for (const p of plan) {
      if (p.diff === 0 && !p.m.controlled) continue;
      out.push(...record(p.m, [{ type: 'STOCK_CHECK', location_id: l.id, delta: p.diff, batch_no: p.batch_no, expiry_date: p.expiry_date, counted: p.counted, expected: p.expected }], user,
        { check_id: check, reason: p.diff ? reason : '', note: str(body.note, 300), ...(w ? { witness: w.username, witness_name: w.name } : {}) }));
    }
    const off = plan.filter((p) => p.diff !== 0);
    logEvent(off.some((p) => p.m.controlled) ? 'medication.cd_discrepancy' : 'medication.stock_check',
      `MEDICATION STOCK CHECK AT ${l.name.toUpperCase()} BY ${user.username}${w ? ` WITNESS ${w.username}` : ''}: ${plan.length} COUNTED, ${off.length} DIFFERENT${off.some((p) => p.m.controlled) ? ' — CD DISCREPANCY' : ''}`,
      { location_id: l.id, check_id: check });
    if (anyCd) flushNow();
    return { __status: 201, __body: { check_id: check, lines: plan.map((p) => ({ medicine_id: p.m.id, medicine: label(p.m), controlled: p.m.controlled, batch_no: p.batch_no, expected: p.expected, counted: p.counted, diff: p.diff })) } };
  });

  /** Put a wrong entry right. The original stays as it was; this entry
   * points at it and moves the balance by `delta` at its location/batch. */
  route('POST', '/api/medication/correct', CONTROL, ({ body, user }) => {
    const orig = db.med_movements.find((x) => x.id === Number(body.corrects_id));
    if (!orig) throw httpError(404, 'entry to correct not found');
    if (db.med_movements.some((x) => x.corrects_id === orig.id)) throw httpError(409, 'that entry has already been corrected — correct the correction instead');
    const m = findMed(orig.medicine_id);
    const reason = str(body.reason, 300);
    if (!reason) throw httpError(400, 'a correction needs a reason');
    const delta = round(Number(body.delta));
    if (!Number.isFinite(delta)) throw httpError(400, 'delta must be a number (negative to take out)');
    const w = wit(m, body, user);
    if (delta < 0) {
      const b = batches(m.id).find((x) => x.location_id === orig.location_id && x.batch_no === (orig.batch_no || '') && (x.expiry_date || null) === (orig.expiry_date || null));
      if (!b || b.qty < -delta) throw httpError(409, `that would take the balance below zero (${unitText(m, b ? b.qty : 0)} there)`);
    }
    const rows = record(m, [{ type: 'CORRECTION', location_id: orig.location_id, batch_no: orig.batch_no, expiry_date: orig.expiry_date, delta }], user,
      { corrects_id: orig.id, reason, note: str(body.note, 300), ...w });
    entryLog(m, 'CORRECTION', rows, user, ` OF ENTRY ${orig.id}`);
    return { __status: 201, __body: rows };
  });

  return { FORMS, SCHEDULES };
};

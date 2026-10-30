/**
 * Enhanced-rate days — a list of dates on which hours cost more than the
 * normal rate (bank holidays, Christmas Day, a one-off flat override).
 * There are two independent lists, because what staff are paid on a bank
 * holiday is not what clients are charged for it:
 *
 *   payroll_rate_days  /api/payroll/rate-days   what staff are paid (routes-payroll.js)
 *   client_rate_days   /api/invoices/rate-days  what clients are charged (routes-invoices.js),
 *                                               the same for every client
 *
 * Each list is seeded once, when empty, and admins edit freely after that.
 * A day is a calendar date (one entry per date) and either multiplies the
 * normal rate or replaces it with a flat £/hour — never below normal.
 */
'use strict';

const r2 = (n) => Math.round(n * 100) / 100;

/** Rate for an hour on rate day rd, never below the normal rate. */
const rateDayRate = (rd, baseRate) => Math.max(rd.kind === 'FLAT' ? Number(rd.flat_rate) : r2(baseRate * rd.multiplier), baseRate);

module.exports = function registerRateDays({ route, httpError, ADMIN, db, nextId, logEvent, flushNow = () => {}, table, base, eventPrefix, what, defaults }) {
  if (!Array.isArray(db[table])) db[table] = [];
  if (db[table].length === 0) {
    for (const d of defaults) db[table].push({ id: nextId(table), flat_rate: null, created_by: 'system', created_at: new Date().toISOString(), ...d });
  }
  const findRateDay = (id) => { const r = db[table].find((x) => x.id === Number(id)); if (!r) throw httpError(404, 'rate day not found'); return r; };
  const rateDayFor = (dateISO) => db[table].find((r) => r.date === String(dateISO).slice(0, 10)) || null;

  const publicRateDay = (r) => ({ ...r });
  route('GET', base, ADMIN, () => db[table].slice().sort((a, b) => a.date < b.date ? -1 : 1).map(publicRateDay));
  /** Admin adds a one-off — a late-notice shift at a flat override rate, an
   * extra bank holiday for a specific year, whatever's needed — on top of
   * the seeded defaults. Applies to that date, not a named person. */
  route('POST', base, ADMIN, ({ body, user }) => {
    const date = String(body.date || '').slice(0, 10);
    if (!date || isNaN(Date.parse(date))) throw httpError(400, 'a valid date is required');
    if (rateDayFor(date)) throw httpError(409, 'a rate day already exists for that date — edit or delete it instead');
    const label = String(body.label || '').trim().slice(0, 120);
    if (!label) throw httpError(400, 'a label is required, e.g. "Late-notice cover"');
    const kind = body.kind === 'FLAT' ? 'FLAT' : 'MULTIPLIER';
    let multiplier = null, flat_rate = null;
    if (kind === 'MULTIPLIER') {
      multiplier = Number(body.multiplier);
      if (!Number.isFinite(multiplier) || multiplier <= 1) throw httpError(400, 'multiplier must be a number greater than 1');
    } else {
      flat_rate = r2(Number(body.flat_rate));
      if (!Number.isFinite(flat_rate) || flat_rate <= 0) throw httpError(400, 'flat_rate must be a positive number');
    }
    const r = { id: nextId(table), date, label, kind, multiplier, flat_rate, created_by: user.display_name, created_at: new Date().toISOString() };
    db[table].push(r);
    logEvent(`${eventPrefix}.rate_day_added`, `${user.username} ADDED ${what} ${date} (${label}, ${kind === 'FLAT' ? `flat £${flat_rate}/h` : `×${multiplier}`})`, { rate_day_id: r.id });
    flushNow();
    return { __status: 201, __body: publicRateDay(r) };
  });
  route('PATCH', `${base}/:id`, ADMIN, ({ params, body, user }) => {
    const r = findRateDay(params.id);
    if ('label' in body) { const label = String(body.label || '').trim().slice(0, 120); if (!label) throw httpError(400, 'label required'); r.label = label; }
    if ('kind' in body) r.kind = body.kind === 'FLAT' ? 'FLAT' : 'MULTIPLIER';
    if ('multiplier' in body) {
      const m = body.multiplier === null ? null : Number(body.multiplier);
      if (m !== null && (!Number.isFinite(m) || m <= 1)) throw httpError(400, 'multiplier must be a number greater than 1');
      r.multiplier = m;
    }
    if ('flat_rate' in body) {
      const f = body.flat_rate === null ? null : r2(Number(body.flat_rate));
      if (f !== null && (!Number.isFinite(f) || f <= 0)) throw httpError(400, 'flat_rate must be a positive number');
      r.flat_rate = f;
    }
    if (r.kind === 'MULTIPLIER' && !Number.isFinite(r.multiplier)) throw httpError(400, 'a multiplier rate day needs a multiplier');
    if (r.kind === 'FLAT' && !Number.isFinite(r.flat_rate)) throw httpError(400, 'a flat-rate day needs a flat_rate');
    logEvent(`${eventPrefix}.rate_day_edited`, `${user.username} EDITED ${what} ${r.date} (${r.label})`, { rate_day_id: r.id });
    flushNow();
    return publicRateDay(r);
  });
  route('DELETE', `${base}/:id`, ADMIN, ({ params, user }) => {
    const r = findRateDay(params.id);
    db[table] = db[table].filter((x) => x.id !== r.id);
    logEvent(`${eventPrefix}.rate_day_deleted`, `${user.username} REMOVED ${what} ${r.date} (${r.label})`, { rate_day_id: r.id });
    flushNow();
    return { ok: true };
  });

  return { findRateDay, rateDayFor };
};
module.exports.rateDayRate = rateDayRate;

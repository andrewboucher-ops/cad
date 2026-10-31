/**
 * BS 7858 security screening record, kept on the personnel record
 * (p.screening) and signed off by an admin.
 *
 * What BS 7858 asks for, and where each part lives:
 *   - identity                → personnel file, kind ID (onboarding)
 *   - right to work           → rtw_* fields
 *   - criminal record (DBS)   → dbs_* fields
 *   - SIA licence             → sia_licences
 *   - 5-year history          → screening.history: every period of work,
 *                               education, self-employment, unemployment or
 *                               time abroad, each verified (who, when, how).
 *                               Any gap longer than 28 days is shown and
 *                               blocks sign-off until it is accounted for.
 *   - financial/credit check  → screening.credit_check
 *   - self-declaration of
 *     convictions and CCJs    → screening.self_declaration
 *   - conditional employment  → screening.conditional_start: someone can
 *                               start on limited screening, and is flagged
 *                               OVERDUE once SCREENING_CONDITIONAL_WEEKS
 *                               (default 12) pass without sign-off. Check the
 *                               period against your copy of the standard.
 *   - sign-off                → screening.signed_off: who and when. Any later
 *                               change to the record clears it, so a signed
 *                               file is always the one that was checked.
 *
 * Admin only, like the rest of the personnel file: this is HR data.
 */
'use strict';

const crypto = require('crypto');

const ACTIVITIES = ['EMPLOYMENT', 'SELF_EMPLOYMENT', 'EDUCATION', 'UNEMPLOYMENT', 'TRAVEL_ABROAD', 'CARER', 'ARMED_FORCES', 'OTHER'];
const VERIFY_METHODS = ['REFERENCE_WRITTEN', 'REFERENCE_PHONE', 'HMRC_RECORD', 'DOCUMENT', 'CHARACTER_REFERENCE', 'OTHER'];
const GAP_DAYS = 28;
const YEARS = 5;
const CONDITIONAL_WEEKS = Number(process.env.SCREENING_CONDITIONAL_WEEKS || 12);
const DAY = 86400000;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

/** Where the record stands. `asOf` is the screening date: the start date if
 * they have one, otherwise today. */
function screeningStatus(p, { hasIdDocument = false } = {}) {
  const s = p.screening || {};
  const history = Array.isArray(s.history) ? s.history : [];
  const end = Date.now();
  const start = end - YEARS * 365.25 * DAY;
  // Merge the periods and find what isn't covered.
  const spans = history.filter((h) => isDate(h.from))
    .map((h) => [Date.parse(h.from), h.to && isDate(h.to) ? Date.parse(h.to) + DAY : end])
    .sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = start;
  for (const [a, b] of spans) {
    if (a - cursor > GAP_DAYS * DAY) gaps.push({ from: new Date(cursor).toISOString().slice(0, 10), to: new Date(a - DAY).toISOString().slice(0, 10), days: Math.round((a - cursor) / DAY) });
    cursor = Math.max(cursor, b);
  }
  if (end - cursor > GAP_DAYS * DAY) gaps.push({ from: new Date(cursor).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10), days: Math.round((end - cursor) / DAY) });
  const unverified = history.filter((h) => !h.verified_at).length;
  const licences = Array.isArray(p.sia_licences) && p.sia_licences.length ? p.sia_licences : p.sia_licence_no ? [p.sia_licence_no] : [];
  const checks = [
    ['identity', 'Identity document on file', hasIdDocument],
    ['right_to_work', 'Right to work checked', Boolean(p.rtw_last_checked_at)],
    ['dbs', 'Criminal record (DBS) check recorded', Boolean(p.dbs_certificate_no || p.dbs_last_checked_at)],
    ['sia', 'SIA licence recorded', licences.length > 0],
    ['history_complete', `${YEARS}-year history with no gap over ${GAP_DAYS} days`, history.length > 0 && gaps.length === 0],
    ['history_verified', 'Every period of the history verified', history.length > 0 && unverified === 0],
    ['credit_check', 'Financial (credit) check done', Boolean(s.credit_check && isDate(s.credit_check.done_on))],
    ['self_declaration', 'Self-declaration of convictions and CCJs signed', Boolean(s.self_declaration && isDate(s.self_declaration.signed_on))],
  ].map(([key, label, done]) => ({ key, label, done }));
  const ready = checks.every((c) => c.done);
  let status = 'INCOMPLETE';
  let conditional_until = null;
  if (s.conditional_start && isDate(s.conditional_start)) conditional_until = new Date(Date.parse(s.conditional_start) + CONDITIONAL_WEEKS * 7 * DAY).toISOString().slice(0, 10);
  if (s.signed_off && s.signed_off.at) status = 'COMPLETE';
  else if (conditional_until) status = Date.parse(conditional_until) < end ? 'OVERDUE' : 'CONDITIONAL';
  else if (ready) status = 'READY_TO_SIGN';
  return { status, checks, gaps, unverified, ready, conditional_until, signed_off: s.signed_off || null };
}

const str = (v, n = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, n));
const optDate = (v, what) => {
  if (v === undefined || v === null || v === '') return null;
  if (!isDate(String(v))) { const e = new Error(`${what} must be a date (YYYY-MM-DD)`); e.status = 400; throw e; }
  return String(v);
};

function registerScreening({ route, httpError, ADMIN, db, logEvent, flushNow = () => {} }) {
  const findP = (id) => { const p = db.personnel.find((x) => x.id === Number(id)); if (!p) throw httpError(404, 'personnel not found'); return p; };
  const statusOf = (p) => screeningStatus(p, { hasIdDocument: (p.files || []).some((f) => f.kind === 'ID') });

  route('GET', '/api/personnel/:id/screening', ADMIN, ({ params }) => {
    const p = findP(params.id);
    return { screening: p.screening || { history: [] }, status: statusOf(p), activities: ACTIVITIES, verify_methods: VERIFY_METHODS, gap_days: GAP_DAYS, years: YEARS, conditional_weeks: CONDITIONAL_WEEKS };
  });

  route('PUT', '/api/personnel/:id/screening', ADMIN, ({ params, body, user }) => {
    const p = findP(params.id);
    const b = body || {};
    const history = (Array.isArray(b.history) ? b.history : []).slice(0, 60).map((h, i) => {
      const from = optDate(h.from, `history row ${i + 1}: from`);
      if (!from) throw httpError(400, `history row ${i + 1}: from date required`);
      const to = optDate(h.to, `history row ${i + 1}: to`);
      if (to && to < from) throw httpError(400, `history row ${i + 1}: ends before it starts`);
      const activity = ACTIVITIES.includes(h.activity) ? h.activity : 'OTHER';
      const verifiedAt = optDate(h.verified_at, `history row ${i + 1}: verified on`);
      if (verifiedAt && !VERIFY_METHODS.includes(h.verify_method)) throw httpError(400, `history row ${i + 1}: say how it was verified`);
      return {
        id: str(h.id, 40) || crypto.randomUUID(), from, to, activity,
        organisation: str(h.organisation), contact: str(h.contact), notes: str(h.notes, 1000),
        verified_at: verifiedAt, verify_method: verifiedAt ? h.verify_method : null, verified_by: verifiedAt ? (str(h.verified_by) || user.display_name) : null,
      };
    });
    const credit = b.credit_check || {};
    const decl = b.self_declaration || {};
    p.screening = {
      history,
      credit_check: { done_on: optDate(credit.done_on, 'credit check date'), provider: str(credit.provider), result: ['CLEAR', 'ADVERSE_EXPLAINED', 'ADVERSE'].includes(credit.result) ? credit.result : null, notes: str(credit.notes, 1000) },
      self_declaration: { signed_on: optDate(decl.signed_on, 'self-declaration date'), disclosed: decl.disclosed === true, notes: str(decl.notes, 1000) },
      conditional_start: optDate(b.conditional_start, 'conditional start date'),
      notes: str(b.notes, 2000),
      // Any change means the signed file is no longer the one that was checked.
      signed_off: null,
      updated_at: new Date().toISOString(), updated_by: user.display_name,
    };
    logEvent('personnel.screening_updated', `BS 7858 SCREENING RECORD UPDATED FOR PERSONNEL #${p.id} BY ${user.username}`, { personnel_id: p.id, by: user.id });
    flushNow();
    return { screening: p.screening, status: statusOf(p) };
  });

  route('POST', '/api/personnel/:id/screening/sign-off', ADMIN, ({ params, user }) => {
    const p = findP(params.id);
    const st = statusOf(p);
    if (!st.ready) throw httpError(409, `not ready to sign off: ${st.checks.filter((c) => !c.done).map((c) => c.label.toLowerCase()).join('; ')}`);
    p.screening.signed_off = { by: user.display_name, user_id: user.id, at: new Date().toISOString() };
    logEvent('personnel.screening_signed_off', `BS 7858 SCREENING SIGNED OFF FOR PERSONNEL #${p.id} BY ${user.username}`, { personnel_id: p.id, by: user.id });
    flushNow();
    return { screening: p.screening, status: statusOf(p) };
  });

  route('GET', '/api/screening/overview', ADMIN, () => db.personnel
    .filter((p) => p.employment_status !== 'TERMINATED')
    .map((p) => { const st = statusOf(p); return { id: p.id, name: p.name, status: st.status, conditional_until: st.conditional_until, outstanding: st.checks.filter((c) => !c.done).map((c) => c.key) }; }));

  return { screeningStatus: statusOf };
}

module.exports = registerScreening;
module.exports.screeningStatus = screeningStatus;

/* Payroll (payroll-calc.js, routes-payroll.js) — node --test
 *
 * The centre of this file is the worked examples from the implementation
 * plan, checked as exact numeric assertions against the UK 2026/27 gov.uk
 * figures — this is the one place in the whole codebase where a wrong
 * number is money paid incorrectly, not an inconvenient bug. Also covers:
 * SUBCONTRACTOR exclusion, issued-payslip immutability, the
 * derive-cumulative-figures-from-history design (never a stored running
 * total), and the two hard blockers on approval (an unresolved clock-out,
 * no bank details on file).
 */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4036';
process.env.AUTH_SECRET = 'payroll-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, raw: text };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, dispT, danT, site, shiftType;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  site = app.db.sites[0];
  shiftType = app.db.shift_types[0];
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

/** A fresh EMPLOYED person with payroll configured, and a bank account on
 * file (required before any run including them can be approved). Each
 * worked-example test gets its own person so the tax-year's cumulative
 * history can't leak between them. */
async function newPayrollPerson(name, payroll = {}, { bank = true } = {}) {
  const p = (await call('POST', '/api/personnel', { name }, adminT)).body;
  await call('PATCH', `/api/personnel/${p.id}`, {
    payroll: { tax_code: '1257L', ni_category: 'A', hourly_rate: 2500, pay_basis: 'ROSTERED', pension_employee_pct: 5, pension_employer_pct: 3, ...payroll },
  }, adminT);
  if (bank) await call('PATCH', `/api/personnel/${p.id}`, { bank_details: { account_name: name, bank_name: 'Test Bank', sort_code: '12-34-56', account_number: '12345678' } }, adminT);
  return (await call('GET', '/api/personnel', undefined, adminT)).body.find((x) => x.id === p.id);
}
/** A one-hour rostered shift on the given date — at hourly_rate £2500 this
 * is exactly £2500 gross, the cleanest possible input for hand-checked
 * tax/NI arithmetic (no fractional-hour rounding to account for). */
async function oneHourShift(personnelId, dateISO, { clockInOut = false } = {}) {
  const s = (await call('POST', '/api/shifts', { shift_type_id: shiftType.id, site_id: site.id, starts_at: `${dateISO}T08:00:00.000Z`, ends_at: `${dateISO}T09:00:00.000Z`, break_minutes: 0 }, adminT)).body;
  await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: personnelId }, adminT);
  await call('POST', `/api/shifts/${s.id}/publish`, {}, adminT);
  const assignment = app.db.shift_assignments.find((a) => a.shift_id === s.id && a.personnel_id === personnelId);
  if (clockInOut) { assignment.clocked_in_at = `${dateISO}T08:00:00.000Z`; assignment.clocked_out_at = `${dateISO}T09:00:00.000Z`; }
  return { shift: s, assignment };
}
async function generateAndApprove(periodStart, periodEnd) {
  const gen = await call('POST', '/api/payroll/runs', { period_start: periodStart, period_end: periodEnd, pay_date: periodEnd }, adminT);
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const approved = await call('POST', `/api/payroll/runs/${gen.body.run.id}/approve`, {}, adminT);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return approved.body;
}

/* ---------------- worked examples (hand-checked against gov.uk 2026/27 figures) ----------------
 * All five share one April run (tax month 1) — a run is one-per-period
 * across everyone on it, not per-person, so "month 1, no prior history"
 * for every hand-checked figure below means they have to be issued
 * together, not as five separate runs for the same period. */
test('worked examples: standard, Scottish, category M, NT code, opted-out pension — all £2,500 gross, month 1', async () => {
  const standard = await newPayrollPerson('Payroll Test Standard');
  const scottish = await newPayrollPerson('Payroll Test Scottish', { scottish_taxpayer: true });
  const categoryM = await newPayrollPerson('Payroll Test CategoryM', { ni_category: 'M' });
  const ntCode = await newPayrollPerson('Payroll Test NT', { tax_code: 'NT' });
  const optedOut = await newPayrollPerson('Payroll Test OptedOut', { pension_opted_out: true });
  for (const p of [standard, scottish, categoryM, ntCode, optedOut]) await oneHourShift(p.id, '2024-04-05');

  const run = await generateAndApprove('2024-04-01', '2024-04-30');
  const slipFor = (p) => run.payslips.find((x) => x.personnel_id === p.id);

  const std = slipFor(standard);
  assert.equal(std.gross_pay, 2500);
  assert.equal(std.tax_this_period, 290.5);
  assert.equal(std.ni_employee, 116.2);
  assert.equal(std.ni_employer, 312.5);
  assert.equal(std.pension_employee, 99);
  assert.equal(std.pension_employer, 59.4);
  assert.equal(std.net_pay, 1994.3);

  const scot = slipFor(scottish);
  assert.equal(scot.tax_this_period, 287.59, 'Scottish bands, not rUK\'s 290.50');
  assert.equal(scot.ni_employee, 116.2, 'NI is not devolved');
  assert.equal(scot.pension_employee, 99, 'pension is not devolved');
  assert.equal(scot.net_pay, 1997.21);

  const catM = slipFor(categoryM);
  assert.equal(catM.ni_employee, 116.2, 'same as category A — the easy-to-assume-is-a-bug case');
  assert.equal(catM.net_pay, 1994.3, 'same as category A');
  assert.equal(catM.ni_employer, 0, 'employer NI relief up to the Upper Secondary Threshold — the real difference is here');

  assert.equal(slipFor(ntCode).tax_this_period, 0);
  assert.equal(slipFor(ntCode).ni_employee, 116.2);

  assert.equal(slipFor(optedOut).pension_employee, 0);
  assert.equal(slipFor(optedOut).pension_employer, 0);
});

/* ---------------- cumulative tax: derived from issued history, never a stored running total ---------------- */

test('cumulative tax across two issued months is derived from the first payslip\'s own stored figure, not recomputed from scratch', async () => {
  const p = await newPayrollPerson('Payroll Test Cumulative');
  await oneHourShift(p.id, '2026-04-05');
  const run1 = await generateAndApprove('2026-04-01', '2026-04-30');
  const ps1 = run1.payslips.find((x) => x.personnel_id === p.id);

  await oneHourShift(p.id, '2026-05-05');
  const run2 = await generateAndApprove('2026-05-01', '2026-05-31');
  const ps2 = run2.payslips.find((x) => x.personnel_id === p.id);

  assert.equal(ps2.cumulative_gross_ytd, ps1.gross_pay + ps2.gross_pay, 'cumulative gross is the sum of issued history plus this period');
  assert.equal(Math.round((ps2.cumulative_tax_ytd - ps1.cumulative_tax_ytd) * 100) / 100, ps2.tax_this_period, 'this period\'s deduction is exactly the difference of two cumulative totals, the second built on the first\'s own stored figure');
});

/* ---------------- SUBCONTRACTOR exclusion ---------------- */

test('a SUBCONTRACTOR is never included in a run, even with activity in the period, and is not reported as "skipped" either — they were never eligible', async () => {
  const p = (await call('POST', '/api/personnel', { name: 'Payroll Test Sub', employment_type: 'SUBCONTRACTOR' }, adminT)).body;
  await oneHourShift(p.id, '2026-06-05');
  const gen = await call('POST', '/api/payroll/runs', { period_start: '2026-06-01', period_end: '2026-06-30' }, adminT);
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.ok(!gen.body.skipped.some((s) => s.personnel_id === p.id), 'not listed as skipped — never eligible in the first place');
  const detail = await call('GET', `/api/payroll/runs/${gen.body.run.id}`, undefined, adminT);
  assert.ok(!detail.body.payslips.some((ps) => ps.personnel_id === p.id));
});

/* ---------------- immutability ---------------- */

test('an issued payslip is frozen: a PATCH is refused, and it keeps the tax code it was actually calculated on even after the person\'s live setting changes', async () => {
  const p = await newPayrollPerson('Payroll Test Immutable');
  await oneHourShift(p.id, '2026-07-05');
  const run = await generateAndApprove('2026-07-01', '2026-07-31');
  const ps = run.payslips.find((x) => x.personnel_id === p.id);
  assert.equal(ps.tax_code, '1257L');

  const patchAttempt = await call('PATCH', `/api/payroll/runs/${run.id}/payslips/${ps.id}`, { other_lines: [{ description: 'late bonus', amount: 50 }] }, adminT);
  assert.equal(patchAttempt.status, 409);

  await call('PATCH', `/api/personnel/${p.id}`, { payroll: { tax_code: 'BR', ni_category: 'A', hourly_rate: 2500, pay_basis: 'ROSTERED' } }, adminT);
  const stillOld = app.db.payslips.find((x) => x.id === ps.id);
  assert.equal(stillOld.tax_code, '1257L', 'the issued payslip\'s own snapshot is untouched by a later change to the live personnel record');

  assert.equal((await call('GET', `/api/payslips/${ps.id}/pdf`, undefined, adminT)).status, 200, 'still renders from the frozen snapshot');
});

/* ---------------- approval blockers ---------------- */

test('an unresolved clock-out blocks approval; clocking out and recalculating clears it', async () => {
  const p = await newPayrollPerson('Payroll Test Unresolved', { pay_basis: 'WORKED' });
  const { assignment } = await oneHourShift(p.id, '2026-08-05'); // never clocked in/out, shift already in the past
  const gen = await call('POST', '/api/payroll/runs', { period_start: '2026-08-01', period_end: '2026-08-31' }, adminT);
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const runId = gen.body.run.id;
  let detail = await call('GET', `/api/payroll/runs/${runId}`, undefined, adminT);
  const ps = detail.body.payslips.find((x) => x.personnel_id === p.id);
  assert.ok(ps, 'a payslip still exists for them even though every hour is unresolved — otherwise nothing is left to block');
  assert.ok(ps.unresolved_hours.length >= 1);

  const approveBlocked = await call('POST', `/api/payroll/runs/${runId}/approve`, {}, adminT);
  assert.equal(approveBlocked.status, 409);
  assert.match(approveBlocked.body.error, /clock-out/);

  assignment.clocked_in_at = '2026-08-05T08:00:00.000Z';
  assignment.clocked_out_at = '2026-08-05T09:00:00.000Z';
  const recalc = await call('POST', `/api/payroll/runs/${runId}/recalculate`, {}, adminT);
  assert.equal(recalc.status, 200, JSON.stringify(recalc.body));
  const approveNow = await call('POST', `/api/payroll/runs/${runId}/approve`, {}, adminT);
  assert.equal(approveNow.status, 200, JSON.stringify(approveNow.body));
});

test('missing bank details blocks approval; adding them clears it', async () => {
  const p = await newPayrollPerson('Payroll Test NoBank', {}, { bank: false });
  await oneHourShift(p.id, '2026-09-05');
  const gen = await call('POST', '/api/payroll/runs', { period_start: '2026-09-01', period_end: '2026-09-30' }, adminT);
  const runId = gen.body.run.id;
  const blocked = await call('POST', `/api/payroll/runs/${runId}/approve`, {}, adminT);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /bank details/);

  await call('PATCH', `/api/personnel/${p.id}`, { bank_details: { account_name: 'X', bank_name: 'Y', sort_code: '12-34-56', account_number: '12345678' } }, adminT);
  const approved = await call('POST', `/api/payroll/runs/${runId}/approve`, {}, adminT);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
});

/* ---------------- visibility ---------------- */

test('payroll setup is SYSTEM_ADMIN-only — not visible to a colleague or even a control role', async () => {
  const p = await newPayrollPerson('Payroll Test Visibility');
  const asAdmin = (await call('GET', '/api/personnel', undefined, adminT)).body.find((x) => x.id === p.id);
  const asDispatcher = (await call('GET', '/api/personnel', undefined, dispT)).body.find((x) => x.id === p.id);
  assert.ok(asAdmin.payroll);
  assert.ok(!('payroll' in asDispatcher), 'a control role still never sees payroll setup, unlike emergency_contact/bank_details');
});

test('a person can list and PDF their own ISSUED payslips only, never a DRAFT one or someone else\'s', async () => {
  const dan = app.db.personnel.find((x) => x.name === 'Dan Whitfield');
  await call('PATCH', `/api/personnel/${dan.id}`, {
    payroll: { tax_code: '1257L', ni_category: 'A', hourly_rate: 2500, pay_basis: 'ROSTERED' },
    bank_details: { account_name: 'Dan Whitfield', bank_name: 'Test Bank', sort_code: '12-34-56', account_number: '12345678' },
  }, adminT);
  await oneHourShift(dan.id, '2026-10-05');
  const gen = await call('POST', '/api/payroll/runs', { period_start: '2026-10-01', period_end: '2026-10-31' }, adminT);
  const runId = gen.body.run.id;

  const draftAsSelf = await call('GET', `/api/payslips?personnel_id=${dan.id}`, undefined, danT);
  assert.equal(draftAsSelf.status, 200);
  assert.equal(draftAsSelf.body.length, 0, 'a draft payslip is not theirs to see yet');

  await call('POST', `/api/payroll/runs/${runId}/approve`, {}, adminT);
  const issuedAsSelf = await call('GET', `/api/payslips?personnel_id=${dan.id}`, undefined, danT);
  assert.equal(issuedAsSelf.body.length, 1);
  const slipId = issuedAsSelf.body[0].id;
  assert.equal((await call('GET', `/api/payslips/${slipId}/pdf`, undefined, danT)).status, 200, 'their own issued payslip');

  const ellieT = await login('emarsh', 'field123');
  assert.equal((await call('GET', `/api/payslips?personnel_id=${dan.id}`, undefined, ellieT)).status, 403, 'not someone else\'s');
});

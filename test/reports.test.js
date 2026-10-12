/* Reports — control room staffing cost vs revenue (routes-reports.js) —
 * node --test
 *
 * Cost must come from ISSUED payroll only, scoped to DISPATCHER/SUPERVISOR
 * logins specifically (not the broader CONTROL role group payroll's own
 * ADMIN-only gate otherwise uses, and not FIELD_USER); revenue from
 * recognised invoices only. Mirrors test/payroll.test.js's fixture style.
 */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4037';
process.env.AUTH_SECRET = 'reports-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, dispT, site, shiftType;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  site = app.db.sites[0];
  shiftType = app.db.shift_types[0];
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

let loginCounter = 0;
/** A personnel record with a login of the given role, and payroll set up
 * (hourly_rate £2500/h so one hour is a clean, hand-checkable gross). */
async function personWithRole(name, role) {
  const p = (await call('POST', '/api/personnel', { name }, adminT)).body;
  await call('PATCH', `/api/personnel/${p.id}`, {
    payroll: { tax_code: '1257L', ni_category: 'A', hourly_rate: 2500, pay_basis: 'ROSTERED', pension_employee_pct: 5, pension_employer_pct: 3 },
    bank_details: { account_name: name, bank_name: 'Test Bank', sort_code: '12-34-56', account_number: '12345678' },
  }, adminT);
  const username = `rep${++loginCounter}`;
  const u = await call('POST', '/api/users', { username, password: 'realpassword1', role, personnel_id: p.id }, adminT);
  assert.equal(u.status, 201, JSON.stringify(u.body));
  return p;
}
async function oneHourShift(personnelId, dateISO) {
  const s = (await call('POST', '/api/shifts', { shift_type_id: shiftType.id, site_id: site.id, starts_at: `${dateISO}T08:00:00.000Z`, ends_at: `${dateISO}T09:00:00.000Z`, break_minutes: 0 }, adminT)).body;
  await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: personnelId }, adminT);
  await call('POST', `/api/shifts/${s.id}/publish`, {}, adminT);
}
async function generateAndApprove(periodStart, periodEnd) {
  const gen = await call('POST', '/api/payroll/runs', { period_start: periodStart, period_end: periodEnd, pay_date: periodEnd }, adminT);
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const approved = await call('POST', `/api/payroll/runs/${gen.body.run.id}/approve`, {}, adminT);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return approved.body;
}
/** A minimal invoice row pushed directly — invoice generation itself is
 * covered in test/agreements-invoices.test.js; this file only needs rows
 * with a given status/issue_date/total to check the revenue aggregation. */
function fakeInvoice(status, issueDate, total) {
  const inv = { id: app.db.invoices.length ? Math.max(...app.db.invoices.map((x) => x.id)) + 1 : 1, status, issue_date: issueDate, total, number: `TST-${issueDate}`, history: [] };
  app.db.invoices.push(inv);
  return inv;
}

test('control room cost counts only ISSUED payslips for DISPATCHER/SUPERVISOR logins — not SYSTEM_ADMIN, not FIELD_USER, not a DRAFT run', async () => {
  const dispatcher = await personWithRole('Reports Test Dispatcher', 'DISPATCHER');
  const supervisor = await personWithRole('Reports Test Supervisor', 'SUPERVISOR');
  const admin = await personWithRole('Reports Test Admin', 'SYSTEM_ADMIN');
  const field = await personWithRole('Reports Test Field', 'FIELD_USER');
  for (const p of [dispatcher, supervisor, admin, field]) await oneHourShift(p.id, '2026-04-05');
  const draftRun = await call('POST', '/api/payroll/runs', { period_start: '2026-04-01', period_end: '2026-04-30' }, adminT);
  assert.equal(draftRun.status, 201);

  const r1 = await call('GET', '/api/reports/staffing-cost?from=2026-04-01&to=2026-04-30', undefined, adminT);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.total_cost, 0, 'nothing issued yet — a draft run never counts');
  assert.deepEqual(r1.body.by_person.map((x) => x.personnel_id).sort(), [], 'nobody counted yet');
  assert.ok(r1.body.missing_payroll.some((m) => m.personnel_id === dispatcher.id));
  assert.ok(r1.body.missing_payroll.some((m) => m.personnel_id === supervisor.id));
  assert.ok(!r1.body.missing_payroll.some((m) => m.personnel_id === admin.id), 'SYSTEM_ADMIN is not control room at all, missing or otherwise');
  assert.ok(!r1.body.missing_payroll.some((m) => m.personnel_id === field.id), 'neither is FIELD_USER');

  await call('POST', `/api/payroll/runs/${draftRun.body.run.id}/approve`, {}, adminT);
  const r2 = await call('GET', '/api/reports/staffing-cost?from=2026-04-01&to=2026-04-30', undefined, adminT);
  const ids = r2.body.by_person.map((x) => x.personnel_id).sort((a, b) => a - b);
  assert.deepEqual(ids, [dispatcher.id, supervisor.id].sort((a, b) => a - b), 'exactly the two control-room logins — not the admin, not the field officer');
  // £2500 gross + £312.50 employer NI + £59.40 employer pension = £2871.90 — same worked figures as test/payroll.test.js.
  const dRow = r2.body.by_person.find((x) => x.personnel_id === dispatcher.id);
  assert.equal(dRow.cost, 2871.9);
  assert.equal(dRow.payslip_count, 1);
  assert.equal(r2.body.total_cost, 2871.9 * 2);
  assert.equal(r2.body.missing_payroll.length, 0, 'both now have issued payroll in range');
});

test('revenue counts only APPROVED/IN_XERO/PAID invoices by issue date, not DRAFT or VOID, and cost % of revenue is derived from both totals', async () => {
  fakeInvoice('DRAFT', '2026-05-10', 50000);
  fakeInvoice('VOID', '2026-05-11', 60000);
  fakeInvoice('APPROVED', '2026-05-12', 1000);
  fakeInvoice('IN_XERO', '2026-05-13', 500);
  fakeInvoice('PAID', '2026-05-14', 250);
  fakeInvoice('PAID', '2026-06-01', 999); // outside the range below

  const r = await call('GET', '/api/reports/staffing-cost?from=2026-05-01&to=2026-05-31', undefined, adminT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total_revenue, 1750, 'only the three recognised, in-range invoices — not draft, void, or the June one');
  assert.equal(r.body.total_cost, 0, 'no control-room payroll was issued for May in this file');
  assert.equal(r.body.cost_pct_of_revenue, 0, 'revenue exists but cost is genuinely zero — a real 0%, not the null reserved for a zero-revenue denominator');
  const may = r.body.by_month.find((m) => m.month === '2026-05');
  assert.equal(may.revenue, 1750);
});

test('with no revenue in range, cost_pct_of_revenue is null rather than a division-by-zero figure', async () => {
  const r = await call('GET', '/api/reports/staffing-cost?from=2099-01-01&to=2099-01-31', undefined, adminT);
  assert.equal(r.status, 200);
  assert.equal(r.body.total_revenue, 0);
  assert.equal(r.body.cost_pct_of_revenue, null);
});

test('admin only, and both dates are required and validated', async () => {
  assert.equal((await call('GET', '/api/reports/staffing-cost?from=2026-01-01&to=2026-01-31', undefined, dispT)).status, 403, 'a control role cannot see this — payroll-derived cost stays admin-only, same as payroll itself');
  assert.equal((await call('GET', '/api/reports/staffing-cost', undefined, adminT)).status, 400, 'both dates required');
  assert.equal((await call('GET', '/api/reports/staffing-cost?from=2026-02-01&to=2026-01-01', undefined, adminT)).status, 400, 'to before from');
  assert.equal((await call('GET', '/api/reports/staffing-cost?from=not-a-date&to=2026-01-31', undefined, adminT)).status, 400);
});

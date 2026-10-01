/**
 * Finance — a read-only view of the cost/billing figures that already
 * exist elsewhere (a shift's pay_rate/bill_rate, a vehicle's fuel and
 * maintenance costs), for a role that needs to see them without touching
 * dispatch. FINANCE is deliberately not in server.js's ALL (see the
 * comment on ROLES there) — this file is the only place that role ever
 * appears, the same shape routes-client.js uses for CLIENT: its own
 * registrar module, handed only what it needs, nothing it returns lets a
 * caller act on what it shows.
 *
 * Scoping reuses the existing branch/site mechanism rather than inventing
 * a parallel one: a FINANCE user with a branch_id set (or site_ids, for
 * the finer-grained option) sees only that branch/those sites' figures,
 * same as a branch-scoped SUPERVISOR; one with neither set sees everything,
 * for a head-office finance user who needs the whole picture.
 *
 * V1 scope, on purpose: this exposes the raw rate/cost fields as they're
 * already stored, not a computed margin or payroll total. pay_rate/
 * bill_rate carry no documented unit (hourly vs a flat shift rate) anywhere
 * else in the codebase, so computing "cost" or "margin" here would be
 * guessing at semantics nothing else in the system commits to — a real
 * rollup is a follow-up once that's pinned down, not a guess shipped now.
 *
 * Registrar pattern, like routes-client.js and routes-shift-applications.js.
 */
'use strict';

module.exports = function registerFinanceRoutes({
  route, httpError, CONTROL, FINANCE, db, siteVisibleTo, visibleToUser, publicFuelLog, publicMaintenanceLog,
}) {
  const READ = [...CONTROL, ...FINANCE];

  route('GET', '/api/finance/shifts', READ, ({ query, user }) => {
    let rows = db.shifts.filter((s) => s.status !== 'DRAFT' && siteVisibleTo(s.site_id, user));
    if (query.get('site_id')) rows = rows.filter((s) => s.site_id === Number(query.get('site_id')));
    if (query.get('from')) rows = rows.filter((s) => s.ends_at >= query.get('from'));
    if (query.get('to')) rows = rows.filter((s) => s.starts_at <= query.get('to'));
    return rows
      .map((s) => {
        const site = s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
        const type = s.shift_type_id ? db.shift_types.find((x) => x.id === s.shift_type_id) : null;
        const activeCount = db.shift_assignments.filter((a) => a.shift_id === s.id && ['ASSIGNED', 'CONFIRMED'].includes(a.status)).length;
        return {
          id: s.id, site_id: s.site_id, site_name: site ? site.name : null,
          shift_type_name: type ? type.name : null, status: s.status,
          starts_at: s.starts_at, ends_at: s.ends_at,
          required_headcount: s.required_headcount, assigned_count: activeCount,
          pay_rate: s.pay_rate, bill_rate: s.bill_rate,
        };
      })
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  });

  route('GET', '/api/finance/vehicle-costs', READ, ({ query, user }) => {
    const vehicleId = query.get('vehicle_id') ? Number(query.get('vehicle_id')) : null;
    const from = query.get('from'); const to = query.get('to');
    const inScope = (vehicleId2) => { const v = db.vehicles.find((x) => x.id === vehicleId2); return v && visibleToUser(v, user); };
    const fuel = db.fuel_logs
      .filter((f) => inScope(f.vehicle_id) && (!vehicleId || f.vehicle_id === vehicleId) && (!from || f.recorded_at >= from) && (!to || f.recorded_at <= to))
      .map((f) => ({ type: 'FUEL', date: f.recorded_at, cost: f.cost, ...publicFuelLog(f) }));
    const maintenance = db.maintenance_logs
      .filter((m) => inScope(m.vehicle_id) && (!vehicleId || m.vehicle_id === vehicleId) && (!from || m.performed_at >= from) && (!to || m.performed_at <= to))
      .map((m) => ({ type: 'MAINTENANCE', date: m.performed_at, cost: m.cost, ...publicMaintenanceLog(m) }));
    return [...fuel, ...maintenance].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  });
};

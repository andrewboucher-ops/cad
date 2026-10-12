/**
 * Reports — admin-only cross-cutting views built from other modules'
 * data, without loosening their own access rules. Payroll is ADMIN-only
 * everywhere (routes-payroll.js's own header comment); this file only
 * ever reads it, never writes it, and stays ADMIN-only itself.
 *
 * STAFFING COST VS REVENUE. For deciding whether the control room is
 * costing too much relative to what the business brings in, and which
 * people/months are driving it. Two figures, from ISSUED payroll and
 * recognised invoices only — nothing provisional (a DRAFT payslip or
 * invoice isn't a real cost or a real sale yet):
 *   cost    = gross pay + employer NI + employer pension, for everyone
 *             whose linked login is DISPATCHER or SUPERVISOR — the people
 *             who actually answer calls and dispatch, not admin logins
 *             generally (SYSTEM_ADMIN is deliberately excluded even
 *             though it's folded into the broader CONTROL role group used
 *             for permissions elsewhere; that grouping is about who can
 *             do what, not who the control room's headcount is).
 *   revenue = invoice totals (VAT-inclusive) for invoices recognised as
 *             real sales: APPROVED, IN_XERO or PAID — the same `issued`
 *             test routes-invoices.js itself uses, not DRAFT or VOID.
 * Both are bucketed by calendar month (a payslip's period_start, an
 * invoice's issue_date) so cost and revenue trends can sit side by side
 * even though payroll periods and invoice dates don't line up exactly.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

module.exports = function registerReports({ route, httpError, ADMIN, db }) {
  const CONTROL_ROOM_ROLES = ['DISPATCHER', 'SUPERVISOR'];
  const round2 = (n) => Math.round(n * 100) / 100;
  const pct = (cost, revenue) => (revenue > 0 ? Math.round((cost / revenue) * 1000) / 10 : null);
  const monthKey = (iso) => String(iso).slice(0, 7);

  function controlRoomPersonnelIds() {
    const ids = new Set();
    for (const u of db.users || []) if (CONTROL_ROOM_ROLES.includes(u.role) && u.personnel_id) ids.add(u.personnel_id);
    return ids;
  }

  route('GET', '/api/reports/staffing-cost', ADMIN, ({ query }) => {
    const from = String(query.get('from') || '').slice(0, 10);
    const to = String(query.get('to') || '').slice(0, 10);
    if (!from || isNaN(Date.parse(from)) || !to || isNaN(Date.parse(to)) || to < from) {
      throw httpError(400, 'valid from and to dates are required, with to on or after from');
    }
    const crIds = controlRoomPersonnelIds();
    const costOf = (ps) => (ps.gross_pay || 0) + (ps.ni_employer || 0) + (ps.pension_employer || 0);
    const slips = (db.payslips || []).filter((ps) =>
      ps.status === 'ISSUED' && crIds.has(ps.personnel_id) && ps.period_start >= from && ps.period_start <= to);

    const byPerson = new Map();
    const costByMonth = new Map();
    let totalCost = 0;
    for (const ps of slips) {
      const cost = costOf(ps);
      totalCost += cost;
      if (!byPerson.has(ps.personnel_id)) byPerson.set(ps.personnel_id, { personnel_id: ps.personnel_id, name: ps.employee_name, cost: 0, payslip_count: 0 });
      const row = byPerson.get(ps.personnel_id);
      row.cost += cost; row.payslip_count += 1;
      const m = monthKey(ps.period_start);
      costByMonth.set(m, (costByMonth.get(m) || 0) + cost);
    }

    const invoices = (db.invoices || []).filter((i) => ['APPROVED', 'IN_XERO', 'PAID'].includes(i.status) && i.issue_date >= from && i.issue_date <= to);
    const revByMonth = new Map();
    let totalRevenue = 0;
    for (const i of invoices) {
      totalRevenue += i.total || 0;
      const m = monthKey(i.issue_date);
      revByMonth.set(m, (revByMonth.get(m) || 0) + (i.total || 0));
    }

    const months = [...new Set([...costByMonth.keys(), ...revByMonth.keys()])].sort();
    // Control-room staff with no ISSUED payslip at all in range — not
    // necessarily zero cost, more likely payroll just hasn't been run or
    // issued for them yet, which would silently understate the total if
    // left unflagged.
    const covered = new Set(byPerson.keys());
    const missingPayroll = [...crIds].filter((id) => !covered.has(id)).map((id) => {
      const p = db.personnel.find((x) => x.id === id);
      return { personnel_id: id, name: p ? p.name : `#${id}` };
    });

    return {
      from, to, roles: CONTROL_ROOM_ROLES,
      total_cost: round2(totalCost), total_revenue: round2(totalRevenue), cost_pct_of_revenue: pct(totalCost, totalRevenue),
      by_person: [...byPerson.values()].map((r) => ({ ...r, cost: round2(r.cost) })).sort((a, b) => b.cost - a.cost),
      by_month: months.map((m) => ({ month: m, cost: round2(costByMonth.get(m) || 0), revenue: round2(revByMonth.get(m) || 0), cost_pct_of_revenue: pct(costByMonth.get(m) || 0, revByMonth.get(m) || 0) })),
      missing_payroll: missingPayroll,
    };
  });

  return {};
};

/**
 * Payroll — monthly runs, calculated from hours already clocked/rostered
 * and leave already approved, issuing a real payslip. The actual
 * arithmetic (gross -> tax -> NI -> pension -> net) lives in
 * payroll-calc.js as pure functions; this file is the db-dependent half:
 * gathering hours and leave per person, running the calculation, and the
 * admin routes around a run's lifecycle.
 *
 * ADMIN only, no exceptions, for every payroll-setup and payroll-run
 * route — not FINANCE, not any control role (see routes-finance.js's own
 * header comment on why pay_rate/bill_rate were deliberately never turned
 * into a payroll total there). The one deliberate carve-out: a person may
 * read their own ISSUED payslips and nothing else — never a DRAFT figure,
 * never another person's.
 *
 * A DRAFT run is provisional and fully mutable (recalculate, delete, edit
 * other_lines). Once ISSUED, a payslip is immutable forever — same "a
 * filed report is a record" rule routes-forms.js already applies to
 * form_submissions. A mistake found later gets a correcting line on the
 * NEXT run, not an edit to history.
 *
 * Nothing here is a substitute for a qualified accountant or payroll
 * professional checking it against a real pay run before it is relied on
 * to actually pay anyone. No HMRC RTI submission happens from this file —
 * that remains a documented gap, stated once on the payslip PDF itself.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Doc, A4 } = require('./pdf.js');
const payrollCalc = require('./payroll-calc.js');

module.exports = function registerPayroll({
  route, httpError, ALL, ADMIN, db, nextId, logEvent, attendance, flushNow = () => {},
}) {
  for (const t of ['payroll_runs', 'payslips']) if (!Array.isArray(db[t])) db[t] = [];

  const { round2 } = payrollCalc;
  const findRun = (id) => { const r = db.payroll_runs.find((x) => x.id === Number(id)); if (!r) throw httpError(404, 'payroll run not found'); return r; };
  const findPayslip = (id) => { const p = db.payslips.find((x) => x.id === Number(id)); if (!p) throw httpError(404, 'payslip not found'); return p; };

  /* ---------------------------------------------------------------- *
   * UK tax year (6 Apr - 5 Apr) and cumulative figures, derived fresh
   * every time from ISSUED payslips — never a stored running total.
   * ---------------------------------------------------------------- */
  // The real UK tax year runs 6 April - 5 April, but pay periods here are
  // calendar months (Assumption 1 in the plan), so a strict 6 April cutoff
  // would wrongly exclude an April period (starting the 1st) from its own
  // tax year's history — grouping instead uses 1 April, consistent with
  // "April = tax month 1" everywhere else in this file.
  function ukTaxYearRange(dateISO) {
    const d = new Date(`${String(dateISO).slice(0, 10)}T12:00:00Z`);
    const y = d.getUTCFullYear();
    const aprilFirstThisYear = Date.UTC(y, 3, 1);
    const startY = d.getTime() >= aprilFirstThisYear ? y : y - 1;
    return { start: new Date(Date.UTC(startY, 3, 1)).toISOString().slice(0, 10), end: new Date(Date.UTC(startY + 1, 2, 31)).toISOString().slice(0, 10) };
  }
  function priorCumulativeFor(personnelId, periodStartISO) {
    const { start, end } = ukTaxYearRange(periodStartISO);
    const prior = db.payslips
      .filter((ps) => ps.personnel_id === personnelId && ps.status === 'ISSUED' && ps.period_start >= start && ps.period_start <= end && ps.period_start < periodStartISO)
      .sort((a, b) => a.period_start.localeCompare(b.period_start));
    const priorCumulativeGrossYTD = round2(prior.reduce((sum, ps) => sum + ps.gross_pay, 0));
    const last = prior[prior.length - 1];
    return { priorCumulativeGrossYTD, priorCumulativeTaxYTD: last ? last.cumulative_tax_ytd : 0 };
  }

  /* ---------------------------------------------------------------- *
   * Hours: mirrors routes-invoices.js's hoursFor(), but across every
   * site a person worked, not one contract's — payroll isn't scoped to
   * a client. WORKED basis blocks approval on an unresolved clock-out;
   * ROSTERED is always resolvable.
   * ---------------------------------------------------------------- */
  function hoursForPersonnel(personnelId, periodStart, periodEnd, payBasis) {
    const t0 = Date.parse(`${periodStart}T00:00:00.000Z`), t1 = Date.parse(`${periodEnd}T23:59:59.999Z`);
    let hours = 0;
    const unresolved = [];
    for (const a of db.shift_assignments) {
      if (a.personnel_id !== personnelId || !['ASSIGNED', 'CONFIRMED'].includes(a.status)) continue;
      const s = db.shifts.find((x) => x.id === a.shift_id);
      if (!s || ['CANCELLED', 'DRAFT'].includes(s.status)) continue;
      const startsAt = Date.parse(s.starts_at);
      if (startsAt < t0 || startsAt > t1) continue;
      if (payBasis === 'ROSTERED') {
        hours += Math.max(0, (Date.parse(s.ends_at) - startsAt) / 3600000 - (Number(s.break_minutes) || 0) / 60);
      } else if (a.clocked_in_at && a.clocked_out_at) {
        hours += attendance.worked(a).worked_min / 60;
      } else if (a.attendance === 'NO_SHOW') {
        // 0 hours, not unresolved — a no-show is a known outcome.
      } else if (Date.parse(s.ends_at) > Date.now()) {
        // shift hasn't finished yet — not payable yet, not a blocker either.
      } else {
        unresolved.push({ shift_id: s.id, assignment_id: a.id, date: s.starts_at.slice(0, 10), site_name: (db.sites.find((x) => x.id === s.site_id) || {}).name || null });
      }
    }
    return { hours: round2(hours), unresolved };
  }

  /** Overlap-apportioned days of a leave type within a period — more
   * precise than leaveBalanceForPerson()'s start_date-only check (fine for
   * a running balance; not precise enough for money). leaveBalanceForPerson()
   * itself is left untouched — different consumer, different stakes. */
  function leaveDaysInPeriod(personnelId, type, periodStart, periodEnd) {
    const pStart = Date.parse(periodStart), pEnd = Date.parse(periodEnd);
    let total = 0;
    for (const r of db.leave_requests) {
      if (r.personnel_id !== personnelId || r.type !== type || r.status !== 'APPROVED') continue;
      const rStart = Date.parse(r.start_date), rEnd = Date.parse(r.end_date);
      const overlapStart = Math.max(rStart, pStart), overlapEnd = Math.min(rEnd, pEnd);
      if (overlapEnd < overlapStart) continue;
      const totalSpanDays = Math.round((rEnd - rStart) / 86400000) + 1;
      const overlapDays = Math.round((overlapEnd - overlapStart) / 86400000) + 1;
      total += r.days * (overlapDays / totalSpanDays);
    }
    return round2(total);
  }

  /** The full payslip for one person in a run — built fresh every time
   * (generate, recalculate, approve), always from current data. Returns
   * null when there's nothing to pay (no hours, no leave) — such a person
   * simply isn't included, not reported as a problem. */
  function buildPayslip(run, p) {
    const pr = p.payroll;
    const { hours, unresolved } = hoursForPersonnel(p.id, run.period_start, run.period_end, pr.pay_basis);
    const holidayDays = leaveDaysInPeriod(p.id, 'ANNUAL', run.period_start, run.period_end);
    const sickDays = leaveDaysInPeriod(p.id, 'SICK', run.period_start, run.period_end);
    // An unresolved shift counts as "activity" even though it adds 0 hours
    // — someone whose entire period is an unfixed clock-out must still get
    // a payslip row, or the approval blocker below could never engage for
    // them (nothing to block if they were never included at all).
    if (hours <= 0 && holidayDays <= 0 && sickDays <= 0 && unresolved.length === 0) return null;

    const grossFromHours = round2(hours * pr.hourly_rate);
    const holidayPay = round2(holidayDays * pr.hourly_rate * pr.standard_daily_hours);
    const sspPay = round2(sickDays * payrollCalc.sspPerDay());
    const { priorCumulativeGrossYTD, priorCumulativeTaxYTD } = priorCumulativeFor(p.id, run.period_start);
    const calc = payrollCalc.calculatePayslip({
      grossFromHours, holidayPay, sspPay, otherLines: [],
      taxCode: pr.tax_code, scottish: pr.scottish_taxpayer, niCategory: pr.ni_category,
      periodStart: run.period_start, priorCumulativeGrossYTD, priorCumulativeTaxYTD,
      pensionEmployeePct: pr.pension_employee_pct, pensionEmployerPct: pr.pension_employer_pct, pensionOptedOut: pr.pension_opted_out,
      studentLoanPlan: pr.student_loan_plan,
    });
    return {
      id: nextId('payslips'), run_id: run.id, personnel_id: p.id,
      employee_name: p.name, employee_no: p.employee_no || null,
      tax_code: pr.tax_code, ni_category: pr.ni_category, scottish_taxpayer: pr.scottish_taxpayer,
      student_loan_plan: pr.student_loan_plan, pension_scheme_name: pr.pension_scheme_name,
      pension_employee_pct: pr.pension_employee_pct, pension_employer_pct: pr.pension_employer_pct, pension_opted_out: pr.pension_opted_out,
      hourly_rate: pr.hourly_rate, pay_basis: pr.pay_basis,
      period_start: run.period_start, period_end: run.period_end, pay_date: run.pay_date,
      hours_worked: hours, hours_source: pr.pay_basis,
      gross_from_hours: calc.grossFromHours,
      holiday_days_paid: holidayDays, holiday_pay: calc.holidayPay,
      sick_days_paid: sickDays, ssp_pay: calc.sspPay,
      other_lines: [], gross_pay: calc.grossPay,
      cumulative_gross_ytd: calc.cumulativeGrossYTD, cumulative_tax_ytd: calc.cumulativeTaxYTD, free_pay_ytd: calc.freePayYTD,
      tax_this_period: calc.taxThisPeriod,
      ni_employee: calc.niEmployee, ni_employer: calc.niEmployer,
      pension_employee: calc.pensionEmployee, pension_employer: calc.pensionEmployer,
      pension_qualifying_earnings: calc.pensionQualifyingEarnings,
      student_loan: calc.studentLoan, net_pay: calc.netPay,
      unresolved_hours: unresolved,
      status: 'DRAFT', issued_at: null, issued_by: null, created_at: new Date().toISOString(),
    };
  }

  /** Re-runs the whole engine for an existing DRAFT payslip (hours, leave,
   * cumulative figures — everything) — what `recalculate` uses. Replaces
   * the row's figures in place; returns false (and leaves it untouched) if
   * the person no longer has any payable activity, same "nothing to pay"
   * rule buildPayslip() applies when a run is first generated. */
  function refreshPayslip(payslip) {
    const p = db.personnel.find((x) => x.id === payslip.personnel_id);
    if (!p || !p.payroll || !p.payroll.hourly_rate) return false;
    const run = { period_start: payslip.period_start, period_end: payslip.period_end, pay_date: payslip.pay_date, id: payslip.run_id };
    const fresh = buildPayslip(run, p);
    if (!fresh) return false;
    Object.assign(payslip, fresh, { id: payslip.id, run_id: payslip.run_id, status: payslip.status, created_at: payslip.created_at });
    return true;
  }

  /** Recomputes tax/NI/pension/net from the payslip's OWN stored
   * gross_from_hours/holiday_pay/ssp_pay plus a new other_lines array —
   * used when an admin edits a manual adjustment, which must not silently
   * also re-derive hours or leave from current data (that's what
   * `recalculate` is for, explicitly, as its own separate action). */
  function recalcWithOtherLines(payslip, otherLines) {
    const { priorCumulativeGrossYTD, priorCumulativeTaxYTD } = priorCumulativeFor(payslip.personnel_id, payslip.period_start);
    const calc = payrollCalc.calculatePayslip({
      grossFromHours: payslip.gross_from_hours, holidayPay: payslip.holiday_pay, sspPay: payslip.ssp_pay, otherLines,
      taxCode: payslip.tax_code, scottish: payslip.scottish_taxpayer, niCategory: payslip.ni_category,
      periodStart: payslip.period_start, priorCumulativeGrossYTD, priorCumulativeTaxYTD,
      pensionEmployeePct: payslip.pension_employee_pct, pensionEmployerPct: payslip.pension_employer_pct, pensionOptedOut: payslip.pension_opted_out,
      studentLoanPlan: payslip.student_loan_plan,
    });
    Object.assign(payslip, {
      other_lines: otherLines, gross_pay: calc.grossPay,
      cumulative_gross_ytd: calc.cumulativeGrossYTD, cumulative_tax_ytd: calc.cumulativeTaxYTD, free_pay_ytd: calc.freePayYTD,
      tax_this_period: calc.taxThisPeriod, ni_employee: calc.niEmployee, ni_employer: calc.niEmployer,
      pension_employee: calc.pensionEmployee, pension_employer: calc.pensionEmployer,
      student_loan: calc.studentLoan, net_pay: calc.netPay,
    });
  }

  const publicRun = (r) => ({ ...r });
  const publicPayslip = (ps) => ({ ...ps });
  /** employer_cost is what actually leaves the business: gross pay (which
   * already covers tax/NI/pension withheld from the employee, and net pay
   * paid out) plus the employer's own NI and pension contributions on top
   * — the two figures nobody sees on the employee's own payslip. */
  function runTotals(run) {
    const slips = db.payslips.filter((ps) => ps.run_id === run.id);
    const sum = (f) => round2(slips.reduce((n, ps) => n + (ps[f] || 0), 0));
    const gross_pay = sum('gross_pay'), ni_employer = sum('ni_employer'), pension_employer = sum('pension_employer');
    return {
      payslip_count: slips.length,
      gross_pay, tax: sum('tax_this_period'), ni_employee: sum('ni_employee'), ni_employer,
      pension_employee: sum('pension_employee'), pension_employer, student_loan: sum('student_loan'),
      net_pay: sum('net_pay'),
      employer_cost: round2(gross_pay + ni_employer + pension_employer),
    };
  }

  /* ---------------------------------------------------------------- *
   * Routes
   * ---------------------------------------------------------------- */
  route('POST', '/api/payroll/runs', ADMIN, ({ body, user }) => {
    const period_start = String(body.period_start || '').slice(0, 10);
    const period_end = String(body.period_end || '').slice(0, 10);
    if (!period_start || isNaN(Date.parse(period_start)) || !period_end || isNaN(Date.parse(period_end)) || period_end < period_start) {
      throw httpError(400, 'valid period_start and period_end are required, with period_end on or after period_start');
    }
    const pay_date = body.pay_date ? String(body.pay_date).slice(0, 10) : period_end;
    if (db.payroll_runs.some((r) => !(r.period_end < period_start || r.period_start > period_end))) {
      throw httpError(409, 'a payroll run already covers part of this period');
    }
    const run = {
      id: nextId('payroll_runs'), period_start, period_end, pay_date, status: 'DRAFT',
      notes: String(body.notes || '').trim().slice(0, 500),
      created_at: new Date().toISOString(), created_by: user.display_name, issued_at: null, issued_by: null,
    };
    db.payroll_runs.push(run);

    const skipped = [];
    let included = 0;
    for (const p of db.personnel) {
      if ((p.employment_type || 'EMPLOYED') !== 'EMPLOYED') continue; // never eligible — not even listed as skipped
      if (!p.payroll || !p.payroll.hourly_rate) { skipped.push({ personnel_id: p.id, name: p.name, reason: 'no hourly rate set' }); continue; }
      const slip = buildPayslip(run, p);
      if (slip) { db.payslips.push(slip); included++; }
    }
    logEvent('payroll.run_generated', `PAYROLL RUN ${period_start}..${period_end} GENERATED BY ${user.username} — ${included} payslip(s), ${skipped.length} skipped (no rate set)`, { run_id: run.id });
    flushNow();
    return { __status: 201, __body: { run: publicRun(run), skipped } };
  });

  route('GET', '/api/payroll/runs', ADMIN, () => db.payroll_runs.slice().sort((a, b) => (a.period_start < b.period_start ? 1 : -1)).map((r) => ({ ...publicRun(r), totals: runTotals(r) })));

  route('GET', '/api/payroll/runs/:id', ADMIN, ({ params }) => {
    const run = findRun(params.id);
    return { ...publicRun(run), totals: runTotals(run), payslips: db.payslips.filter((ps) => ps.run_id === run.id).map(publicPayslip) };
  });

  route('PATCH', '/api/payroll/runs/:id/payslips/:payslipId', ADMIN, ({ params, body, user }) => {
    const run = findRun(params.id);
    if (run.status !== 'DRAFT') throw httpError(409, 'only a draft run can be edited');
    const ps = findPayslip(params.payslipId);
    if (ps.run_id !== run.id) throw httpError(404, 'payslip not found on this run');
    if (!Array.isArray(body.other_lines)) throw httpError(400, 'other_lines must be an array');
    if (body.other_lines.length > 20) throw httpError(400, 'too many adjustment lines');
    const otherLines = body.other_lines.map((l, i) => {
      const description = String((l && l.description) || '').trim().slice(0, 200);
      if (!description) throw httpError(400, `adjustment ${i + 1}: description required`);
      const amount = Number(l && l.amount);
      if (!Number.isFinite(amount)) throw httpError(400, `adjustment ${i + 1}: amount must be a number`);
      return { description, amount: round2(amount) };
    });
    recalcWithOtherLines(ps, otherLines);
    logEvent('payroll.payslip_adjusted', `PAYSLIP ${ps.employee_name} (${run.period_start}) ADJUSTED BY ${user.username}`, { run_id: run.id, payslip_id: ps.id });
    flushNow();
    return publicPayslip(ps);
  });

  route('POST', '/api/payroll/runs/:id/recalculate', ADMIN, ({ params, user }) => {
    const run = findRun(params.id);
    if (run.status !== 'DRAFT') throw httpError(409, 'only a draft run can be recalculated');
    const existing = db.payslips.filter((ps) => ps.run_id === run.id);
    const keepIds = new Set();
    for (const ps of existing) { if (refreshPayslip(ps)) keepIds.add(ps.id); }
    db.payslips = db.payslips.filter((ps) => ps.run_id !== run.id || keepIds.has(ps.id));
    // Anyone newly eligible since generation (a rate just set, a shift
    // just added) gets picked up too, same as a fresh generate would.
    const already = new Set(db.payslips.filter((ps) => ps.run_id === run.id).map((ps) => ps.personnel_id));
    let added = 0;
    for (const p of db.personnel) {
      if (already.has(p.id) || (p.employment_type || 'EMPLOYED') !== 'EMPLOYED' || !p.payroll || !p.payroll.hourly_rate) continue;
      const slip = buildPayslip(run, p);
      if (slip) { db.payslips.push(slip); added++; }
    }
    logEvent('payroll.run_recalculated', `PAYROLL RUN ${run.period_start}..${run.period_end} RECALCULATED BY ${user.username}${added ? ` — ${added} newly added` : ''}`, { run_id: run.id });
    flushNow();
    return { ...publicRun(run), totals: runTotals(run), payslips: db.payslips.filter((ps) => ps.run_id === run.id).map(publicPayslip) };
  });

  route('POST', '/api/payroll/runs/:id/approve', ADMIN, ({ params, user }) => {
    const run = findRun(params.id);
    if (run.status !== 'DRAFT') throw httpError(409, 'already issued');
    for (const ps of db.payslips.filter((p) => p.run_id === run.id)) refreshPayslip(ps);
    const slips = db.payslips.filter((ps) => ps.run_id === run.id);
    if (!slips.length) throw httpError(400, 'nothing to issue — no payslips on this run');
    const blockers = [];
    for (const ps of slips) {
      if (ps.unresolved_hours.length) blockers.push(`${ps.employee_name}: ${ps.unresolved_hours.length} shift(s) with no clock-out`);
      const p = db.personnel.find((x) => x.id === ps.personnel_id);
      if (!p || !p.bank_details || !p.bank_details.account_number) blockers.push(`${ps.employee_name}: no bank details on file`);
    }
    if (blockers.length) throw httpError(409, `cannot issue — ${blockers.join('; ')}`);
    const now = new Date().toISOString();
    run.status = 'ISSUED'; run.issued_at = now; run.issued_by = user.display_name;
    for (const ps of slips) { ps.status = 'ISSUED'; ps.issued_at = now; ps.issued_by = user.display_name; }
    logEvent('payroll.run_issued', `PAYROLL RUN ${run.period_start}..${run.period_end} ISSUED BY ${user.username} — ${slips.length} payslip(s)`, { run_id: run.id });
    flushNow();
    return { ...publicRun(run), totals: runTotals(run), payslips: slips.map(publicPayslip) };
  });

  route('DELETE', '/api/payroll/runs/:id', ADMIN, ({ params, user }) => {
    const run = findRun(params.id);
    if (run.status !== 'DRAFT') throw httpError(409, 'only a draft run can be deleted');
    db.payslips = db.payslips.filter((ps) => ps.run_id !== run.id);
    db.payroll_runs = db.payroll_runs.filter((r) => r.id !== run.id);
    logEvent('payroll.run_deleted', `DRAFT PAYROLL RUN ${run.period_start}..${run.period_end} DELETED BY ${user.username}`);
    flushNow();
    return { ok: true };
  });

  route('GET', '/api/payslips', ALL, ({ query, user }) => {
    const personnelId = Number(query.get('personnel_id'));
    if (!personnelId) throw httpError(400, 'personnel_id required');
    const self = user.personnel_id === personnelId;
    if (!self && user.role !== 'SYSTEM_ADMIN') throw httpError(403, 'insufficient role');
    return db.payslips
      .filter((ps) => ps.personnel_id === personnelId && (!self || ps.status === 'ISSUED'))
      .sort((a, b) => (a.period_start < b.period_start ? 1 : -1))
      .map(publicPayslip);
  });

  /* ---------------------------------------------------------------- *
   * Payslip PDF — same brand language as the invoice/contract PDFs
   * (routes-invoices.js's invoicePdf()): a navy header band, the
   * pre-flattened navy-background logo, doc.pairs()/doc.table() for the
   * body, the same { __body, __headers } shape.
   * ---------------------------------------------------------------- */
  const NAVY = [0.047, 0.086, 0.141], AMBER = [0.949, 0.663, 0.235], WHITE = [1, 1, 1], LIGHT = [0.78, 0.82, 0.88];
  const grey = [0.35, 0.38, 0.42];
  const company = () => {
    const r = (db.ui_settings || []).find((x) => x.key === 'rental') || {};
    return { company_name: r.company_name || 'Echelon', company_address: r.company_address || '', company_phone: r.company_phone || '', company_email: r.company_email || '' };
  };
  const money = (n) => `£${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const longDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

  function payslipPdf(ps) {
    const c = company();
    const doc = new Doc({ footer: `${c.company_name} — payslip ${ps.employee_name}, ${longDate(ps.period_start)}` });
    const bandH = 104;
    doc.rect(0, A4.h - bandH, A4.w, bandH, { fill: NAVY, stroke: null });
    const logoFile = path.join(__dirname, 'public', 'assets', 'echelon-wordmark-navy.jpg');
    if (fs.existsSync(logoFile)) { doc.y = A4.h - 30; doc.image(fs.readFileSync(logoFile), { maxH: 20, maxW: 170, x: doc.margin }); }
    else doc.text(c.company_name.toUpperCase(), doc.margin, A4.h - 40, { size: 17, bold: true, color: WHITE });
    const label = 'PAYSLIP';
    const rightEdge = A4.w - doc.margin;
    doc.text(label, rightEdge - doc.textWidth(label, 10, true), A4.h - 36, { size: 10, bold: true, color: AMBER });
    const period = `${longDate(ps.period_start)} – ${longDate(ps.period_end)}`;
    doc.text(period, rightEdge - doc.textWidth(period, 11, true), A4.h - 54, { size: 11, bold: true, color: WHITE });
    const payDate = `Pay date ${longDate(ps.pay_date)}`;
    doc.text(payDate, rightEdge - doc.textWidth(payDate, 9), A4.h - 70, { size: 9, color: LIGHT });
    doc.y = A4.h - bandH - 26;

    doc.pairs([
      ['Employee', ps.employee_name], ['Employee number', ps.employee_no || '—'],
      ['Tax code', ps.tax_code + (ps.scottish_taxpayer ? ' (Scottish)' : '')], ['NI category', ps.ni_category],
      ['Hours this period', `${ps.hours_worked} (${ps.hours_source === 'ROSTERED' ? 'rostered' : 'worked'})`],
      ['Hourly rate', money(ps.hourly_rate)],
    ]);
    doc.rule();

    const rows = [
      ['Gross pay (hours)', money(ps.gross_from_hours)],
      ...(ps.holiday_pay ? [['Holiday pay', money(ps.holiday_pay)]] : []),
      ...(ps.ssp_pay ? [['Statutory Sick Pay', money(ps.ssp_pay)]] : []),
      ...ps.other_lines.map((l) => [l.description, money(l.amount)]),
    ];
    doc.table([{ title: 'Payments', width: 0.7 }, { title: 'Amount', width: 0.3, align: 'right' }], rows, { size: 9.5 });
    doc.room(16); doc.y -= 14;
    doc.text('Gross pay', doc.margin, doc.y, { size: 10, bold: true });
    doc.text(money(ps.gross_pay), rightEdge - doc.textWidth(money(ps.gross_pay), 10, true), doc.y, { size: 10, bold: true });
    doc.y -= 16;

    doc.heading('Deductions', 11);
    const deductionRows = [
      ['Income Tax (PAYE)', money(ps.tax_this_period)],
      [`National Insurance (Class 1, category ${ps.ni_category})`, money(ps.ni_employee)],
      ...(ps.pension_employee ? [[`Pension contribution (${ps.pension_scheme_name || 'workplace pension'}, ${ps.pension_employee_pct}%)`, money(ps.pension_employee)]] : []),
      ...(ps.student_loan ? [[`Student Loan (${ps.student_loan_plan})`, money(ps.student_loan)]] : []),
    ];
    doc.table([{ title: 'Description', width: 0.7 }, { title: 'Amount', width: 0.3, align: 'right' }], deductionRows, { size: 9.5 });

    doc.room(30); doc.y -= 6;
    doc.rect(doc.margin, doc.y - 20, doc.width, 24, { fill: NAVY, stroke: null });
    doc.text('Net pay', doc.margin + 10, doc.y - 14, { size: 11, bold: true, color: WHITE });
    const netStr = money(ps.net_pay);
    doc.text(netStr, doc.margin + doc.width - 10 - doc.textWidth(netStr, 11, true), doc.y - 14, { size: 11, bold: true, color: AMBER });
    doc.y -= 34;

    doc.heading('For information — not deducted from the above', 9.5);
    doc.pairs([
      ['Employer pension', money(ps.pension_employer)],
      ['Cumulative pay (this tax year)', money(ps.cumulative_gross_ytd)],
      ['Cumulative tax (this tax year)', money(ps.cumulative_tax_ytd)],
    ], { size: 9 });

    doc.para('Figures are calculated by this system and have not been separately submitted to HMRC via Real Time Information (RTI).', { size: 8, color: grey, gap: 2 });
    return doc.toBuffer();
  }

  route('GET', '/api/payslips/:id/pdf', ALL, ({ params, user }) => {
    const ps = findPayslip(params.id);
    const self = user.personnel_id === ps.personnel_id;
    if (!self && user.role !== 'SYSTEM_ADMIN') throw httpError(403, 'insufficient role');
    if (self && ps.status !== 'ISSUED') throw httpError(404, 'payslip not found');
    return {
      __body: payslipPdf(ps),
      __headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="payslip-${ps.employee_name.replace(/[^a-z0-9]+/gi, '-')}-${ps.period_start}.pdf"`, 'cache-control': 'private, no-store' },
    };
  });

  return { ukTaxYearRange, buildPayslip };
};

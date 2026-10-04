/**
 * Payroll calculation — pure functions, no `db` access. Every figure a
 * caller needs (prior cumulative gross/tax for the tax year) is passed in,
 * computed by routes-payroll.js from stored ISSUED payslips — this module
 * never stores or re-derives history itself, only does the arithmetic for
 * one period at a time.
 *
 * Nothing in this file, or the payslip it produces, is a substitute for a
 * qualified accountant or payroll professional checking it against a real
 * pay run before it is relied on to actually pay anyone.
 *
 * Figures are the UK 2026/27 tax year, from gov.uk's "Rates and thresholds
 * for employers 2026 to 2027" guidance. THESE CHANGE EVERY 6 APRIL — see
 * the comment on TAX_YEAR_2026_27 below for exactly what to update and
 * where. If this is still the active table after 5 April 2027, every
 * payslip from that point is wrong.
 */
'use strict';

/** One named, swappable block per tax year — update this whole object (and
 * only this object) each April rather than hunting for inline numbers. */
const TAX_YEAR_2026_27 = {
  personalAllowance: 12570,
  rUK: { bands: [[37700, 0.20], [125140, 0.40], [Infinity, 0.45]] },
  scotland: { bands: [[3967, 0.19], [16956, 0.20], [31092, 0.21], [62430, 0.42], [125140, 0.45], [Infinity, 0.48]] },
  ni: {
    primaryThreshold: 12570, secondaryThreshold: 5000, upperEarningsLimit: 50270, upperSecondaryThreshold: 50270,
    employerRate: 0.15,
    employeeRates: {
      A: [0, 0.08, 0.02], B: [0, 0.0185, 0.02], C: [0, 0, 0],
      H: [0, 0.08, 0.02], J: [0, 0.02, 0.02], M: [0, 0.08, 0.02], V: [0, 0.08, 0.02],
    },
    employerReliefCategories: ['H', 'M', 'V'],
  },
  pension: { lowerQualifying: 6240, upperQualifying: 50270 },
  ssp: { weekly: 123.25 },
  studentLoan: {
    thresholds: { PLAN1: 26900, PLAN2: 29385, PLAN4: 33795, PLAN5: 25000, POSTGRAD: 21000 },
    rate: { PLAN1: 0.09, PLAN2: 0.09, PLAN4: 0.09, PLAN5: 0.09, POSTGRAD: 0.06 },
  },
};
const NI_CATEGORIES = Object.keys(TAX_YEAR_2026_27.ni.employeeRates);
const STUDENT_LOAN_PLANS = Object.keys(TAX_YEAR_2026_27.studentLoan.thresholds);
const TAX_CODE_RE = /^(\d{1,4}L|0T|BR|D0|D1|NT)$/;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Marginal-band amount: `bands` is ascending [[upperBound, rate], ...],
 * each upper bound ABOVE the previous one's (the last is normally
 * Infinity). Shared by income tax (several bands) and NI (one band, same
 * shape: `[[upperBound, rate]]` with the rate applying everywhere above
 * the start of that band — see niForPeriod() for how it's actually used
 * there with two explicit thresholds instead). */
function bandedAmount(taxable, bands) {
  let total = 0, prev = 0;
  for (const [upper, rate] of bands) {
    if (taxable <= prev) break;
    total += (Math.min(taxable, upper) - prev) * rate;
    prev = upper;
  }
  return total;
}

/** April = tax month 1 ... March = tax month 12, from a period's start
 * date — the standard mapping real monthly payroll software uses. */
function taxMonthNumber(periodStartISO) {
  const m = new Date(`${String(periodStartISO).slice(0, 10)}T12:00:00Z`).getUTCMonth(); // 0=Jan..11=Dec
  return ((m - 3) + 12) % 12 + 1; // Apr(3)->1 ... Mar(2)->12
}

function parseTaxCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!TAX_CODE_RE.test(code)) throw new Error(`invalid tax code: ${raw}`);
  if (code === 'NT') return { kind: 'NONE' };
  if (code === 'BR') return { kind: 'FLAT', rate: 0.20 };
  if (code === 'D0') return { kind: 'FLAT', rate: 0.40 };
  if (code === 'D1') return { kind: 'FLAT', rate: 0.45 };
  if (code === '0T') return { kind: 'CUMULATIVE', annualAllowance: 0 };
  return { kind: 'CUMULATIVE', annualAllowance: Number(code.slice(0, -1)) * 10 };
}

/**
 * Cumulative PAYE for this period. `priorCumulativeGrossYTD`/
 * `priorCumulativeTaxYTD` are the figures already stored on the person's
 * last ISSUED payslip this tax year (0/0 if none) — the caller derives
 * these by summing issued payslips, never from a running total kept on
 * the personnel record itself.
 *
 * Allowed to return a negative `taxThisPeriod` (an in-period refund) —
 * genuine cumulative-PAYE behaviour, not a bug to clamp away.
 */
function incomeTaxForPeriod({ taxCode, scottish, periodStart, grossThisPeriod, priorCumulativeGrossYTD = 0, priorCumulativeTaxYTD = 0 }) {
  const parsed = parseTaxCode(taxCode);
  if (parsed.kind === 'NONE') return { taxThisPeriod: 0, cumulativeGrossYTD: round2(priorCumulativeGrossYTD + grossThisPeriod), cumulativeTaxYTD: priorCumulativeTaxYTD, freePayYTD: null };
  if (parsed.kind === 'FLAT') {
    const taxThisPeriod = round2(grossThisPeriod * parsed.rate);
    return { taxThisPeriod, cumulativeGrossYTD: round2(priorCumulativeGrossYTD + grossThisPeriod), cumulativeTaxYTD: round2(priorCumulativeTaxYTD + taxThisPeriod), freePayYTD: null };
  }
  const month = taxMonthNumber(periodStart);
  const freePayYTD = round2(parsed.annualAllowance * month / 12);
  const cumulativeGrossYTD = round2(priorCumulativeGrossYTD + grossThisPeriod);
  const taxableYTD = Math.max(0, round2(cumulativeGrossYTD - freePayYTD));
  const table = scottish ? TAX_YEAR_2026_27.scotland.bands : TAX_YEAR_2026_27.rUK.bands;
  const scaledBands = table.map(([upper, rate]) => [upper === Infinity ? Infinity : round2(upper * month / 12), rate]);
  const taxDueYTD = round2(bandedAmount(taxableYTD, scaledBands));
  const taxThisPeriod = round2(taxDueYTD - priorCumulativeTaxYTD);
  return { taxThisPeriod, cumulativeGrossYTD, cumulativeTaxYTD: taxDueYTD, freePayYTD };
}

/** NI is per-period, independent of every other period — no cumulative
 * tracking needed, unlike income tax. */
function niForPeriod({ grossThisPeriod, category }) {
  if (!NI_CATEGORIES.includes(category)) throw new Error(`invalid NI category: ${category}`);
  const { primaryThreshold, secondaryThreshold, upperEarningsLimit, upperSecondaryThreshold, employerRate, employeeRates, employerReliefCategories } = TAX_YEAR_2026_27.ni;
  const pt = primaryThreshold / 12, uel = upperEarningsLimit / 12;
  const [, midRate, topRate] = employeeRates[category];
  const employee = round2(bandedAmount(grossThisPeriod, [[pt, 0], [uel, midRate], [Infinity, topRate]]));
  const employerThreshold = (employerReliefCategories.includes(category) ? upperSecondaryThreshold : secondaryThreshold) / 12;
  const employer = round2(Math.max(0, grossThisPeriod - employerThreshold) * employerRate);
  return { employee, employer };
}

function pensionForPeriod({ grossThisPeriod, employeePct, employerPct, optedOut }) {
  if (optedOut) return { employee: 0, employer: 0, qualifyingEarnings: 0 };
  const { lowerQualifying, upperQualifying } = TAX_YEAR_2026_27.pension;
  const lower = lowerQualifying / 12, upper = upperQualifying / 12;
  const qualifyingEarnings = round2(Math.max(0, Math.min(grossThisPeriod, upper) - lower));
  return {
    employee: round2(qualifyingEarnings * (employeePct || 0) / 100),
    employer: round2(qualifyingEarnings * (employerPct || 0) / 100),
    qualifyingEarnings,
  };
}

function studentLoanForPeriod({ grossThisPeriod, plan }) {
  if (!plan) return 0;
  if (!STUDENT_LOAN_PLANS.includes(plan)) throw new Error(`invalid student loan plan: ${plan}`);
  const { thresholds, rate } = TAX_YEAR_2026_27.studentLoan;
  return round2(Math.max(0, grossThisPeriod - thresholds[plan] / 12) * rate[plan]);
}

/** A day of SSP, at the flat weekly rate — no waiting days, no
 * qualifying-day pattern, per the business's own accepted simplification. */
const sspPerDay = () => round2(TAX_YEAR_2026_27.ssp.weekly / 7);

/**
 * The whole payslip for one person, one period. `grossFromHours`,
 * `holidayPay` and `sspPay` are pre-computed by the caller (hours/leave
 * are db-dependent); everything downstream of gross pay is computed here.
 */
function calculatePayslip({
  grossFromHours, holidayPay = 0, sspPay = 0, otherLines = [],
  taxCode, scottish = false, niCategory, periodStart,
  priorCumulativeGrossYTD = 0, priorCumulativeTaxYTD = 0,
  pensionEmployeePct = 0, pensionEmployerPct = 0, pensionOptedOut = false,
  studentLoanPlan = null,
}) {
  const otherTotal = (otherLines || []).reduce((n, l) => n + Number(l.amount || 0), 0);
  const grossPay = round2(round2(grossFromHours) + round2(holidayPay) + round2(sspPay) + round2(otherTotal));

  const tax = incomeTaxForPeriod({ taxCode, scottish, periodStart, grossThisPeriod: grossPay, priorCumulativeGrossYTD, priorCumulativeTaxYTD });
  const ni = niForPeriod({ grossThisPeriod: grossPay, category: niCategory });
  const pension = pensionForPeriod({ grossThisPeriod: grossPay, employeePct: pensionEmployeePct, employerPct: pensionEmployerPct, optedOut: pensionOptedOut });
  const studentLoan = studentLoanForPeriod({ grossThisPeriod: grossPay, plan: studentLoanPlan });

  const netPay = round2(grossPay - tax.taxThisPeriod - ni.employee - pension.employee - studentLoan);

  return {
    grossFromHours: round2(grossFromHours), holidayPay: round2(holidayPay), sspPay: round2(sspPay), otherLines, grossPay,
    taxThisPeriod: tax.taxThisPeriod, cumulativeGrossYTD: tax.cumulativeGrossYTD, cumulativeTaxYTD: tax.cumulativeTaxYTD, freePayYTD: tax.freePayYTD,
    niEmployee: ni.employee, niEmployer: ni.employer,
    pensionEmployee: pension.employee, pensionEmployer: pension.employer, pensionQualifyingEarnings: pension.qualifyingEarnings,
    studentLoan,
    netPay,
  };
}

module.exports = {
  TAX_YEAR_2026_27, NI_CATEGORIES, STUDENT_LOAN_PLANS, TAX_CODE_RE,
  round2, bandedAmount, taxMonthNumber, parseTaxCode,
  incomeTaxForPeriod, niForPeriod, pensionForPeriod, studentLoanForPeriod, sspPerDay,
  calculatePayslip,
};

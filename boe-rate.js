/**
 * Bank of England Bank Rate (base rate), fetched from the Bank's own
 * statistical database (series IUDBEDR, the official Bank Rate, daily), for
 * statutory late payment interest (routes-late-charges.js).
 *
 * Under the Late Payment of Commercial Debts (Interest) Act 1998 the
 * "reference rate" is the base rate in force on 31 December (for debts that
 * become late January to June) or 30 June (July to December), and it stays
 * fixed for that debt while it is unpaid. referenceDate() / rateOn() do that.
 *
 * Source: the Bank's "Bank Rate history" page (boeapps/database/Bank-Rate.asp),
 * a table of "Date Changed" / "Rate" rows ("05 Nov 26 | 4.00"). If that can't
 * be read, the statistical database CSV for series IUDBEDR (daily, "DATE,
 * IUDBEDR" then "02 Jan 2024,5.25"). Both refuse requests that don't look
 * like a browser, hence the User-Agent. BOE_RATE_URL overrides the address
 * (tests or a mirror); either format is understood from any address.
 */
'use strict';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

/** "02 Jan 2024", "05 Nov 26", "02/Jan/2024", "2024-01-02" or "02/01/2024" → "2024-01-02". */
function parseDay(s) {
  const t = String(s || '').trim().replace(/^"|"$/g, '');
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{4}|\d{2})$/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 4 ? m[3] : `${Number(m[3]) >= 70 ? 19 : 20}${m[3]}`;
    return `${y}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}

/** The CSV as [[date, rate], …], oldest first, keeping only the days the rate changed. */
function parseCsv(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const [a, b] = line.split(',');
    const d = parseDay(a), r = Number(String(b || '').trim().replace(/^"|"$/g, ''));
    if (d && String(b || '').trim() !== '' && Number.isFinite(r) && r >= 0 && r < 30) rows.push([d, r]);
  }
  return dedupe(rows);
}

/** The history page's table, as [[date, rate], …] oldest first. */
function parseHtml(html) {
  const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const rows = [];
  const re = /\b(\d{1,2} [A-Za-z]{3} (?:\d{4}|\d{2}))\s+(\d{1,2}\.\d{1,4})\b/g;
  let m;
  while ((m = re.exec(text))) { const d = parseDay(m[1]); if (d) rows.push([d, Number(m[2])]); }
  return dedupe(rows);
}
function dedupe(rows) {
  rows.sort((x, y) => x[0].localeCompare(y[0]));
  const out = [];
  for (const row of rows) if (!out.length || out[out.length - 1][1] !== row[1]) out.push(row);
  return out;
}
const parseAny = (text) => (/<\w+[\s>]/.test(text) ? parseHtml(text) : parseCsv(text));

const HISTORY_URL = 'https://www.bankofengland.co.uk/boeapps/database/Bank-Rate.asp';
function sourceUrl(fromYear) {
  if (process.env.BOE_RATE_URL) return process.env.BOE_RATE_URL;
  return `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=01/Jan/${fromYear}&Dateto=now&SeriesCodes=IUDBEDR&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`;
}

async function getText(url, fetchImpl, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; CCCS invoicing)', accept: 'text/html,text/csv,*/*' } });
    if (!res.ok) throw new Error(`Bank of England answered ${res.status}`);
    return await res.text();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'the Bank of England did not answer in time' : e.message);
  } finally { clearTimeout(timer); }
}
/** Bank Rate changes as [[date, rate], …], oldest first. */
async function fetchRates({ fromYear = new Date().getUTCFullYear() - 4, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const urls = process.env.BOE_RATE_URL ? [process.env.BOE_RATE_URL] : [HISTORY_URL, sourceUrl(fromYear)];
  let last;
  for (const url of urls) {
    try {
      const rates = parseAny(await getText(url, fetchImpl, timeoutMs));
      if (rates.length) return rates;
      last = new Error('the Bank of England page had no rates on it');
    } catch (e) { last = e; }
  }
  throw last;
}

/** The statutory reference date for a debt that became late on `lateDay`. */
function referenceDate(lateDay) {
  const y = Number(lateDay.slice(0, 4)), m = Number(lateDay.slice(5, 7));
  return m <= 6 ? `${y - 1}-12-31` : `${y}-06-30`;
}
/** The rate in force at the end of `day`: the last change on or before it. */
function rateOn(rates, day) {
  let r = null;
  for (const [d, v] of rates || []) { if (d <= day) r = v; else break; }
  return r;
}

module.exports = { parseCsv, parseHtml, parseDay, fetchRates, referenceDate, rateOn, sourceUrl };

/* Patient report form completeness rules.
 *
 * Shared by the browser form (public/prf/prf.js) and the server (prf.js), so the
 * review screen and the finalise check can never disagree. Loaded in the browser
 * after uk.js; required from Node by the server.
 *
 * Three levels, as in most ePCR review screens:
 *   mandatory  must be complete before the PRF can be finalised
 *   format     a value is present but invalid (also blocks finalising)
 *   warning    worth a second look, but doesn't block finalising */
(function (root) {
  const uk = typeof module !== 'undefined' ? require('./uk.js') : root;

  // [label, key]
  const REQUIRED = [
    ['Event Number', 'event'],
    ['Call Type', 'callType'],
    ['Dispatch Time', 'dispatch'],
    ['Incident Address', 'address'],
    ['Destination', 'destination'],
    ['Chief Complaint', 'chief'],
    ['Airway', 'airway'],
    ['Breathing', 'breathing'],
    ['Circulation', 'circulation'],
    ['Focused Assessment', 'assessment'],
    ['Disposition', 'disposition'],
    ['Mental Capacity', 'capacity'],
    ['Consent', 'consent'],
    ['Safeguarding Concern', 'safeguarding'],
    ['Care Summary / Narrative', 'narrative'],
  ];

  // Optional UK identifiers: blank is fine, a wrong value is not.
  const FORMAT = {
    health: ['NHS Number', uk.validNhsNumber, 'Not a valid NHS number (check digit fails)'],
    postal: ['Postcode', uk.validPostcode, 'Not a valid UK postcode'],
    incidentPostcode: ['Incident Postcode', uk.validPostcode, 'Not a valid UK postcode'],
  };

  // Times that should run in this order. A later one before an earlier one is
  // flagged (shown in red on the form, and as a warning on review).
  const TIME_ORDER = [
    ['callReceived', 'Call Received'], ['dispatch', 'Dispatch'], ['enRoute', 'En Route'],
    ['scene', 'At Scene'], ['contact', 'Patient Contact'], ['depart', 'Left Scene'],
    ['arrive', 'At Destination'], ['transfer', 'Transfer of Care'], ['available', 'Clear / Available'],
  ];

  const str = (d, k) => String((d || {})[k] ?? '').trim();
  const refused = (d) => str(d, 'disposition') === 'Refused care' || str(d, 'consent') === 'Refused';
  const safeguardingRaised = (d) => str(d, 'safeguarding').startsWith('Yes');
  const sig = (d, who) => {
    const s = d && d.signatures && d.signatures[who];
    return Boolean(s && typeof s.data === 'string' && s.data.startsWith('data:image/png;base64,'));
  };

  function formatHint(d, key) {
    const c = FORMAT[key], x = str(d, key);
    return c && x && !c[1](x) ? c[2] : '';
  }

  /** Keys of times that come before a time that should precede them. */
  function timeIssues(d) {
    const bad = new Set();
    let lastKey = null, last = null;
    for (const [k] of TIME_ORDER) {
      const x = str(d, k);
      if (!x) continue;
      const t = Date.parse(x.length === 5 ? '1970-01-01T' + x : x);
      if (Number.isNaN(t)) continue;
      if (last !== null && t < last) { bad.add(k); bad.add(lastKey); }
      else { last = t; lastKey = k; }
    }
    return bad;
  }

  /** Keys that are mandatory for this record right now (drives the red asterisks). */
  function requiredKeys(d) {
    const keys = new Set(REQUIRED.map(([, k]) => k));
    if (refused(d)) keys.add('refusal');
    if (safeguardingRaised(d)) keys.add('safeguardingDetails');
    return keys;
  }

  /** Every item the review shows: { label, key, level, ok, status }. */
  function checkRecord(d) {
    d = d || {};
    const filled = (k) => str(d, k) !== '';
    const item = (label, key, ok, status, level = 'mandatory') => ({ label, key, level, ok, status: ok ? 'Complete' : status });

    const out = REQUIRED.map(([label, k]) => item(label, k, filled(k), 'Required'));
    if (refused(d)) {
      out.push(item('Refusal of Care Details', 'refusal', filled('refusal'), 'Required (care refused)'));
      out.push(item('Patient Signature or Reason Unable to Sign', 'sig_patient', sig(d, 'patient') || filled('unableToSign'), 'Required (care refused)'));
    }
    if (safeguardingRaised(d)) out.push(item('Safeguarding Details & Referral', 'safeguardingDetails', filled('safeguardingDetails'), 'Required (concern raised)'));
    out.push(item('Clinician Signature', 'sig_clinician', sig(d, 'clinician'), 'Required'));
    for (const k of Object.keys(FORMAT)) if (formatHint(d, k)) out.push({ label: FORMAT[k][0], key: k, level: 'format', ok: false, status: 'Invalid format' });

    // Warnings: don't block finalising.
    const warn = (label, key, status) => out.push({ label, key, level: 'warning', ok: false, status });
    const vit = (d.vitals || []).filter((v) => v && Object.values(v).some(Boolean));
    if (!vit.length) warn('Vital Signs', 'vitals', 'No observations recorded');
    else if (!vit.some((v) => !uk.news2(v).missing)) warn('NEWS2', 'vitals', 'No complete set for a NEWS2 score');
    const lastNews = vit.map((v) => uk.news2(v)).filter((n) => !n.missing).pop();
    if (lastNews && lastNews.score >= 5 && ['Treated and released', 'Refused care'].includes(str(d, 'disposition')))
      warn('NEWS2 ' + lastNews.score + ' and not conveyed', 'narrative', 'Document escalation and advice given');
    const t = timeIssues(d);
    if (t.size) warn('Times', [...t][0], 'Out of sequence: ' + TIME_ORDER.filter(([k]) => t.has(k)).map(([, l]) => l).join(', '));
    if (!filled('first') && !filled('last')) warn('Patient Name', 'first', 'Not recorded');
    if (!filled('dob')) warn('Date of Birth', 'dob', 'Not recorded');
    if (!filled('health')) warn('NHS Number', 'health', 'Not recorded');
    if ((d.txLog || []).some((x) => x && !x.response)) warn('Treatment Log', 'txLog', 'An entry has no response recorded');
    return out;
  }

  const blocking = (d) => checkRecord(d).filter((c) => !c.ok && c.level !== 'warning');

  const api = { REQUIRED, FORMAT, TIME_ORDER, checkRecord, blocking, requiredKeys, formatHint, timeIssues, refused, safeguardingRaised };
  if (typeof module !== 'undefined') module.exports = api;
  else root.PRFRules = api;
})(typeof window !== 'undefined' ? window : globalThis);

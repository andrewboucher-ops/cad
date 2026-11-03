/* Patient report form completeness rules.
 *
 * Shared by the browser form (public/prf/prf.js) and the server (prf.js), so the
 * review screen and the finalise check can never disagree. Loaded in the browser
 * after uk.js; required from Node by the server. */
(function (root) {
  const uk = typeof module !== 'undefined' ? require('./uk.js') : root;

  const REQUIRED = [
    ['Event Number', 'event'],
    ['Call Type', 'callType'],
    ['Dispatch Time', 'dispatch'],
    ['Incident Address', 'address'],
    ['Chief Complaint', 'chief'],
    ['Airway', 'airway'],
    ['Breathing', 'breathing'],
    ['Circulation', 'circulation'],
    ['Focused Assessment', 'assessment'],
    ['Disposition', 'disposition'],
    ['Destination', 'destination'],
    ['Mental Capacity', 'capacity'],
    ['Consent', 'consent'],
    ['Safeguarding Concern', 'safeguarding'],
    ['Care Plan / Narrative', 'narrative'],
  ];

  // Optional UK identifiers: blank is fine, a wrong value is not.
  const FORMAT = {
    health: ['NHS Number', uk.validNhsNumber, 'Not a valid NHS number (check digit fails)'],
    postal: ['Postcode', uk.validPostcode, 'Not a valid UK postcode'],
    incidentPostcode: ['Incident Postcode', uk.validPostcode, 'Not a valid UK postcode'],
  };

  const str = (d, k) => String((d || {})[k] ?? '').trim();
  const refused = (d) => str(d, 'disposition') === 'Refused care' || str(d, 'consent') === 'Refused';
  const safeguardingRaised = (d) => str(d, 'safeguarding').startsWith('Yes');

  function formatHint(d, key) {
    const c = FORMAT[key], x = str(d, key);
    return c && x && !c[1](x) ? c[2] : '';
  }

  /** Every item the review shows, as { label, ok, status }. */
  function checkRecord(d) {
    const filled = (k) => str(d, k) !== '';
    const out = REQUIRED.map(([label, k]) => ({ label, ok: filled(k), status: filled(k) ? 'Complete' : 'Required' }));
    if (refused(d)) out.push({ label: 'Refusal of Care Details', ok: filled('refusal'), status: filled('refusal') ? 'Complete' : 'Required (care refused)' });
    if (safeguardingRaised(d)) out.push({ label: 'Safeguarding Details & Referral', ok: filled('safeguardingDetails'), status: filled('safeguardingDetails') ? 'Complete' : 'Required (concern raised)' });
    for (const k of Object.keys(FORMAT)) if (formatHint(d, k)) out.push({ label: FORMAT[k][0], ok: false, status: 'Invalid format' });
    return out;
  }

  const api = { REQUIRED, FORMAT, checkRecord, formatHint, refused, safeguardingRaised };
  if (typeof module !== 'undefined') module.exports = api;
  else root.PRFRules = api;
})(typeof window !== 'undefined' ? window : globalThis);

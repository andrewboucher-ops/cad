/**
 * DVLA Vehicle Enquiry Service (VES) — hand-rolled against the published
 * REST API using Node's built-in `fetch`, same reasoning as sms.js and
 * msauth.js: zero-dependency for a single JSON POST.
 *
 * This is a free, read-only UK government lookup (register at
 * https://developer-portal.driver-vehicle-licensing.api.gov.uk/ for an API
 * key) — given a registration number it returns tax/MOT status and basic
 * vehicle details. No side effects on DVLA's end, so unlike sms.js there is
 * no LIVE gate: a lookup never sends anything to the vehicle's keeper, it
 * only reads back what DVLA already holds.
 *
 * DVLA_API_ENV=sandbox points at the UAT environment (fixed test
 * registrations only, documented in DVLA's developer portal) for trying
 * this out before a live key is issued.
 */
'use strict';

const DVLA_API_KEY = process.env.DVLA_API_KEY || '';
const BASE = process.env.DVLA_API_ENV === 'sandbox'
  ? 'https://uat.driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles'
  : 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';

const configured = () => Boolean(DVLA_API_KEY);

/** DVLA wants the bare registration, no spaces, uppercase. */
function normalizeReg(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9]{2,7}$/.test(s) ? s : null;
}

/**
 * Looks up one vehicle. Never throws for a transport or API error — resolves
 * with { ok, data, error, httpStatus } so a failed/misconfigured lookup
 * cannot break whatever is updating the vehicle record alongside it (same
 * contract as sms.js's send()).
 *
 * @param {string} registration
 */
async function lookup(registration) {
  const reg = normalizeReg(registration);
  if (!reg) return { ok: false, error: `not a usable registration: ${registration}` };
  if (!configured()) return { ok: false, error: 'DVLA lookup is not configured (need DVLA_API_KEY)' };

  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: {
        'x-api-key': DVLA_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ registrationNumber: reg }),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (out && out.errors && out.errors[0] && (out.errors[0].title || out.errors[0].detail))
        || `${res.status} ${res.statusText}`;
      return { ok: false, error: msg, httpStatus: res.status };
    }
    return { ok: true, data: out };
  } catch (e) {
    console.warn('[dvla] lookup threw:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { lookup, normalizeReg, configured };

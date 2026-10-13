/**
 * Vehicle registration lookup via Vehicle Data Global (formerly "UK Vehicle
 * Data Ltd" — same company, same API, rebranded). Replaces this module's
 * previous integration with the actual DVLA government VES API: same idea
 * (given a reg, get back tax/MOT status and basic details), different
 * supplier, different request/response shape.
 *
 * Vehicle Data Global doesn't publish full technical docs outside their
 * account control panel (panel.ukvehicledata.co.uk) — the request shape
 * below is reconstructed from their product-page sample and several
 * third-party client libraries (PHP, Ruby, Chilkat), which independently
 * agree on a GET with the key and VRM as query parameters. The exact
 * response field names are less certain (their own sample page admits its
 * JSON is "illustrative"); `pick()` below tries a short list of plausible
 * paths per field rather than one hard-coded path, and a lookup that finds
 * none of them comes back as an explicit error instead of a silently
 * half-empty result — if that happens, it means the real sandbox response
 * uses different field names than guessed here, visible immediately
 * instead of showing blank vehicle details.
 *
 * VDG_PACKAGE_ID picks which of their data packages to call — 'VehicleData'
 * is their general package (registration + status); change it without a
 * code change if that turns out wrong. Sandbox vs live is a property of
 * which key you have, not a different host/env toggle: a sandbox key is
 * restricted by Vehicle Data Global to registrations containing the
 * letter 'A' (their own stated sandbox rule), same host either way.
 */
'use strict';

const VDG_API_KEY = process.env.VDG_API_KEY || '';
const VDG_PACKAGE_ID = process.env.VDG_PACKAGE_ID || 'VehicleData';
const BASE = 'https://uk1.ukvehicledata.co.uk/api/datapackage';

const configured = () => Boolean(VDG_API_KEY);

/** Vehicle Data Global wants the bare registration, no spaces, uppercase —
 * same convention as the DVLA gov API this replaces. */
function normalizeReg(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9]{2,7}$/.test(s) ? s : null;
}

/** Tries each dotted path in turn against obj, returns the first present,
 * non-empty value — the schema-uncertainty hedge described above. */
function pick(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

/**
 * Looks up one vehicle. Never throws for a transport or API error — resolves
 * with { ok, data, error, httpStatus } so a failed/misconfigured lookup
 * cannot break whatever is updating the vehicle record alongside it.
 * `data` keeps the same field names the DVLA-gov version returned (make,
 * colour, taxStatus, taxDueDate, motStatus, motExpiryDate) so the caller
 * in server.js needed no changes for this swap.
 *
 * @param {string} registration
 */
async function lookup(registration) {
  const reg = normalizeReg(registration);
  if (!reg) return { ok: false, error: `not a usable registration: ${registration}` };
  if (!configured()) return { ok: false, error: 'Vehicle lookup is not configured (need VDG_API_KEY)' };

  const url = `${BASE}/${encodeURIComponent(VDG_PACKAGE_ID)}?v=2&api_nullitems=1&key_VRM=${encodeURIComponent(reg)}&auth_apikey=${encodeURIComponent(VDG_API_KEY)}`;

  try {
    const res = await fetch(url, { method: 'GET' });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = pick(out, ['StatusMessage', 'Response.StatusMessage', 'message', 'error']) || `${res.status} ${res.statusText}`;
      return { ok: false, error: msg, httpStatus: res.status };
    }

    const r = (out && out.Response) || out || {};
    const statusCode = pick(r, ['StatusCode']);
    const statusMessage = pick(r, ['StatusMessage']);
    if (statusCode != null && !['0', 'SUCCESS'].includes(String(statusCode).toUpperCase())) {
      return { ok: false, error: statusMessage || `vehicle data provider returned status ${statusCode}`, httpStatus: res.status };
    }

    const reg1 = pick(r, ['VehicleRegistration', 'DataItems.VehicleRegistration']) || {};
    const statusBlock = pick(r, ['DataItems.VehicleStatus.MotVed', 'VehicleStatus.MotVed', 'DataItems.VehicleStatus', 'VehicleStatus']) || {};
    const data = {
      make: pick(reg1, ['Make']),
      colour: pick(reg1, ['Colour']),
      taxStatus: pick(statusBlock, ['TaxStatus', 'VedStatus']),
      taxDueDate: pick(statusBlock, ['TaxDue', 'VedDue', 'TaxDueDate']),
      motStatus: pick(statusBlock, ['MotStatus']),
      motExpiryDate: pick(statusBlock, ['MotDue', 'MotExpiryDate']),
    };
    if (!data.make && !data.colour && !data.taxDueDate && !data.motExpiryDate && !data.taxStatus && !data.motStatus) {
      return {
        ok: false,
        error: 'lookup succeeded but none of the expected vehicle fields were found in the response — the provider\'s response shape likely differs from what this integration guessed (see dvla.js\'s header comment); check the raw response against VDG_PACKAGE_ID',
        httpStatus: res.status,
      };
    }
    return { ok: true, data };
  } catch (e) {
    console.warn('[vehicle-lookup] lookup threw:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { lookup, normalizeReg, configured };

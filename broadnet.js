/**
 * BroadNet Dispatch — push a CCCS job out as an "incident" so it reaches
 * BroadNet radio handsets, and translate a terminal's inbound status code.
 * Zero dependencies (Node's fetch), same shape as dvla.js/gocardless.js.
 *
 * BroadNet's API is invite-only beta (email support@broadnet.systems to
 * request access, describing the use case). Confirmed directly against
 * their docs while logged in to broadnethelp.freshdesk.com:
 *   POST https://api-dispatch.broadnet.systems/api_dispatch/v1/organisations/<endpoint key>/incidents
 * The "endpoint key" is embedded in the URL path itself — their examples
 * show no separate Authorization header, unlike GoCardless/Xero. Unlike
 * GoCardless, BroadNet's webhook docs show no HMAC/signature scheme at
 * all, so inbound authenticity is instead an unguessable token in the
 * webhook URL — see server.js's webhook route.
 *
 * SETUP: once BroadNet grants access, their portal gives an organisation
 * endpoint key and, per team, a team_uuid/channel_uuid to target. Set
 * BROADNET_ORG_KEY in cccs.env. BROADNET_API_KEY is optional and sent as
 * a Bearer header only if set — their public docs never show one being
 * needed, but this is defensive in case real onboarding adds one; confirm
 * against the first real account rather than assuming either way.
 */
'use strict';

const ORG_KEY = process.env.BROADNET_ORG_KEY || '';
const API_KEY = process.env.BROADNET_API_KEY || '';
const API = (process.env.BROADNET_API_BASE || 'https://api-dispatch.broadnet.systems').replace(/\/+$/, '');

const configured = () => Boolean(ORG_KEY);

/** Creates an incident in BroadNet Dispatch so it reaches handsets.
 * `grade` is BroadNet's own 1 (highest) to 5 (lowest) severity scale —
 * mapping a CCCS job priority onto it is the caller's job, not this
 * client's (same division of concerns as xero.js leaving VAT handling to
 * its caller). Returns BroadNet's incident object, which must carry a
 * `uuid` — that's the only handle later webhooks use to refer back to it.
 */
async function createIncident({ description, grade, lat, lon, label, teamUuid, channelUuid, terminalUuid }) {
  if (!configured()) throw new Error('BroadNet is not set up on this server (BROADNET_ORG_KEY)');
  const incident = {
    description: String(description || '').slice(0, 500),
    grade: Math.min(5, Math.max(1, Number(grade) || 3)),
  };
  if (lat != null && lon != null) incident.locations = [{ lat: Number(lat), lng: Number(lon), label: label || undefined }];
  if (teamUuid) incident.team_uuid = teamUuid;
  if (channelUuid) incident.allocation = { type: 'channel', channel_uuid: channelUuid };
  else if (terminalUuid) incident.allocation = { type: 'terminal', terminal_uuid: terminalUuid };

  const res = await fetch(`${API}/api_dispatch/v1/organisations/${encodeURIComponent(ORG_KEY)}/incidents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify({ incident }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`BroadNet: ${(data && (data.error || data.message)) || res.status}`);
  const out = (data && data.incident) || data;
  if (!out || !out.uuid) throw new Error('BroadNet did not return an incident uuid');
  return out;
}

/* Terminal status is a TLA code on the way in; CCCS's map already shares
 * one small status vocabulary between MDTs and personnel (see public/
 * app.js's colour()) — translating here means no frontend change is
 * needed to show a BroadNet terminal alongside them. */
const STATUS_MAP = {
  AVL: 'AVAILABLE', DEP: 'ON_TASK', ASC: 'ON_TASK', BSY: 'BUSY', DLY: 'BUSY', RST: 'BUSY',
  NOGPS: 'OFFLINE', OFF: 'OFFLINE', CLS: 'OFFLINE', EMG: 'EMERGENCY',
};
function canonicalStatus(tla) {
  return STATUS_MAP[String(tla || '').toUpperCase()] || 'OFFLINE';
}

module.exports = { configured, createIncident, canonicalStatus };

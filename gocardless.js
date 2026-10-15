/**
 * GoCardless — just enough of the API to set up a Direct Debit mandate via
 * a hosted Billing Request Flow, collect a payment against an active
 * mandate, and verify webhook events. Zero dependencies (Node's fetch),
 * like sms.js, msauth.js and xero.js.
 *
 * Auth is a single static access token (GOCARDLESS_ACCESS_TOKEN) — unlike
 * Xero there is no OAuth dance or refresh to manage, just a Bearer header.
 *
 * SETUP: create an access token in the GoCardless dashboard (Developers →
 * Create access token, read-write, Components left OFF — this integration
 * uses the hosted Billing Request Flow, not an embedded form) and a
 * webhook endpoint pointed at
 *   https://<your site>/api/webhooks/gocardless
 * Both the access token and the webhook endpoint's own secret go in
 * cccs.env as GOCARDLESS_ACCESS_TOKEN / GOCARDLESS_WEBHOOK_SECRET.
 *
 * Mandate setup never trusts the browser redirect back from GoCardless as
 * confirmation — GoCardless's own docs say explicitly not to ("always use
 * webhooks") — so the redirect only brings the payer back to the client
 * portal; the mandate's real status is whatever the last `mandates`
 * webhook event said, read in routes-client.js.
 */
'use strict';

const crypto = require('crypto');

const ACCESS_TOKEN = process.env.GOCARDLESS_ACCESS_TOKEN || '';
const WEBHOOK_SECRET = process.env.GOCARDLESS_WEBHOOK_SECRET || '';
const API = (process.env.GOCARDLESS_API_BASE || 'https://api.gocardless.com').replace(/\/+$/, '');
// GoCardless requires an API version header on every request — pinned so a
// future GoCardless default-version bump can't silently change behaviour
// here. https://docs.gocardless.com/docs/getting-started/api-versioning
const GC_VERSION = process.env.GOCARDLESS_VERSION || '2015-07-06';

const configured = () => Boolean(ACCESS_TOKEN);

async function call(method, path, body) {
  if (!configured()) throw new Error('GoCardless is not set up on this server (GOCARDLESS_ACCESS_TOKEN)');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${ACCESS_TOKEN}`, 'content-type': 'application/json', 'GoCardless-Version': GC_VERSION },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data.error && (data.error.message || (data.error.errors && data.error.errors[0] && data.error.errors[0].message))) || res.status;
    throw new Error(`GoCardless: ${detail}`);
  }
  return data;
}

/** Starts mandate setup: a Billing Request (mandate only — no immediate
 * payment) plus a hosted Billing Request Flow pointed at it. Returns the
 * authorisation_url to send the payer to, and the billing_request id
 * (kept on the client record so the webhook, once it arrives, can be
 * matched back to who it's for via the fulfilled mandate's own links —
 * see routes-client.js). An existing GoCardless customer id reuses that
 * customer rather than creating a duplicate one.
 */
async function startMandateSetup({ existingCustomerId, redirectUri, prefilledEmail, prefilledName }) {
  const mandateRequest = { scheme: 'bacs' };
  const brBody = { billing_requests: { mandate_request: mandateRequest } };
  if (existingCustomerId) brBody.billing_requests.links = { customer: existingCustomerId };
  const br = await call('POST', '/billing_requests', brBody);
  const billingRequestId = br.billing_requests.id;

  const flowBody = {
    billing_request_flows: {
      redirect_uri: redirectUri,
      exit_uri: redirectUri,
      links: { billing_request: billingRequestId },
      ...(prefilledEmail ? { prefilled_customer: { email: prefilledEmail, given_name: prefilledName || undefined } } : {}),
    },
  };
  const flow = await call('POST', '/billing_request_flows', flowBody);
  return { billingRequestId, authorisationUrl: flow.billing_request_flows.authorisation_url };
}

/** Reads back a billing request — used once the payer returns, purely to
 * show "processing" state in the portal (never treated as confirmation;
 * see this file's header comment). */
async function getBillingRequest(id) {
  const out = await call('GET', `/billing_requests/${encodeURIComponent(id)}`);
  return out.billing_requests;
}

/** Creates a payment against an active mandate — one invoice's worth.
 * amountPence is an integer in the smallest currency unit (pennies for
 * GBP), matching GoCardless's own convention. `reference` is truncated to
 * 10 characters — Bacs's own limit. */
async function createPayment({ mandateId, amountPence, currency = 'GBP', reference, description }) {
  const out = await call('POST', '/payments', {
    payments: {
      amount: Math.round(amountPence), currency, reference: String(reference || '').slice(0, 10),
      description: description ? String(description).slice(0, 200) : undefined,
      links: { mandate: mandateId },
    },
  });
  return out.payments;
}

/** HMAC-SHA256 of the RAW, untouched request body, hex-encoded, compared
 * in constant time — per GoCardless's own webhook docs. Must run against
 * the exact bytes GoCardless sent, never a JSON.parse/stringify round
 * trip (key order/whitespace can differ and silently break the digest) —
 * see routes-client.js's webhook route, which is registered in
 * server.js's RAW_BODY_PATHS for exactly this reason. */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8'), b = Buffer.from(String(signatureHeader), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { configured, startMandateSetup, getBillingRequest, createPayment, verifyWebhookSignature };

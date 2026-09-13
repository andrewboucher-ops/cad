/**
 * Verifies Microsoft Entra ID (Azure AD) id_tokens without pulling in a JOSE
 * library — the app has no npm dependencies and this keeps it that way.
 * Signature is checked against the tenant's published JWKS; expiry, audience
 * and issuer are checked against the values Entra ID is documented to send.
 */
'use strict';

const crypto = require('crypto');

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // tenantId -> { at, jwks }

function b64uJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function getJwks(tenantId) {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.jwks;

  const discoveryRes = await fetch(`https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`);
  if (!discoveryRes.ok) throw new Error(`could not reach Microsoft discovery document (${discoveryRes.status})`);
  const discovery = await discoveryRes.json();

  const jwksRes = await fetch(discovery.jwks_uri);
  if (!jwksRes.ok) throw new Error(`could not fetch Microsoft signing keys (${jwksRes.status})`);
  const jwks = await jwksRes.json();

  cache.set(tenantId, { at: Date.now(), jwks });
  return jwks;
}

/**
 * @returns the decoded claims if the token is validly signed, unexpired, and
 * issued by this tenant for this application. Throws otherwise.
 */
async function verifyMicrosoftIdToken(idToken, { tenantId, clientId }) {
  if (!idToken || typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw new Error('malformed id_token');
  }
  const [headerB64, payloadB64, sigB64] = idToken.split('.');
  const header = b64uJson(headerB64);
  const payload = b64uJson(payloadB64);
  if (header.alg !== 'RS256') throw new Error(`unsupported id_token algorithm ${header.alg}`);

  const jwks = await getJwks(tenantId);
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('id_token was signed with an unknown key — Microsoft may have rotated keys, try signing in again');

  const publicKey = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(sigB64, 'base64url');
  if (!crypto.createVerify('RSA-SHA256').update(signedData).verify(publicKey, signature)) {
    throw new Error('id_token signature is invalid');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('id_token has expired');
  if (payload.nbf && payload.nbf > now) throw new Error('id_token is not yet valid');
  if (payload.aud !== clientId) throw new Error('id_token was not issued for this application');
  if (payload.tid !== tenantId) throw new Error('id_token was issued by a different tenant');
  if (payload.iss !== `https://login.microsoftonline.com/${payload.tid}/v2.0`) {
    throw new Error('id_token issuer does not match Microsoft Entra ID');
  }

  return payload;
}

module.exports = { verifyMicrosoftIdToken };

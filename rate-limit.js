/* Request rate limiting for /api/.
 *
 * One fixed one-minute window per key. What the key is matters more than the
 * numbers:
 *
 *  - A signed-in request is counted against its user, not its address. A
 *    whole control room behind one office router, or every user behind a
 *    reverse proxy that isn't listed in TRUSTED_PROXIES, shares one address;
 *    counting by address put all of them in one bucket, and once a busy
 *    minute filled it nobody could do anything, including sign in.
 *  - Sign-in routes have their own per-address bucket, so ordinary anonymous
 *    traffic (portal pages, integrations) filling the general bucket can't
 *    stop anyone signing in. Password guessing is still held back by the
 *    per-account lockout in server.js, and a Microsoft callback is useless
 *    without a state value this server issued.
 *  - Everything else is counted per address, as before.
 *
 * A bucket that overflows is logged once per window with the paths that
 * filled it, so the cause shows up in the service log rather than only as
 * a 429 in someone's browser. */
'use strict';

const WINDOW_MS = 60 * 1000;
const LIMITS = { user: 600, auth: 120, ip: 600 };
const AUTH_PATH_RE = /^\/api\/auth\/(login|microsoft\/(status|login|callback|session)|session-cookie)$/;

function createRateLimiter({ limits = LIMITS, windowMs = WINDOW_MS, now = Date.now, log = console.warn } = {}) {
  const buckets = new Map();

  function bucketFor({ pathname, ip, userId }) {
    if (userId != null) return { key: `user:${userId}`, limit: limits.user };
    if (AUTH_PATH_RE.test(pathname)) return { key: `auth:${ip}`, limit: limits.auth };
    return { key: `ip:${ip}`, limit: limits.ip };
  }

  /** true when the request may go ahead. */
  function check({ pathname, ip, userId = null }) {
    const t = now();
    const { key, limit } = bucketFor({ pathname, ip, userId });
    let win = buckets.get(key);
    if (!win || t - win.start >= windowMs) { win = { start: t, count: 0, paths: new Map(), logged: false }; buckets.set(key, win); }
    win.count++;
    const p = pathname.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, '/…');
    if (win.paths.size < 50 || win.paths.has(p)) win.paths.set(p, (win.paths.get(p) || 0) + 1);
    if (win.count <= limit) return true;
    if (!win.logged) {
      win.logged = true;
      const top = [...win.paths].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ×${n}`).join(', ');
      log(`[cccs] rate limit hit for ${key} (${limit}/min): ${top}`);
    }
    return false;
  }

  // Drop finished windows so the map doesn't grow with every address seen.
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, w] of buckets) if (t - w.start >= windowMs) buckets.delete(k);
  }, windowMs);
  if (sweep.unref) sweep.unref();

  return { check, bucketFor, reset: () => buckets.clear(), stop: () => clearInterval(sweep) };
}

module.exports = { createRateLimiter, AUTH_PATH_RE, LIMITS };

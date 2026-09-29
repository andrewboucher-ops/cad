
/* ------------------------------------------------------------------ *
 * GPS simulation
 * ------------------------------------------------------------------ */
function simulationTick() {
  for (const m of db.mdts) {
    if (!m.connected || m.lat == null || m.lon == null) continue;
    const job = m.job_id ? db.jobs.find((j) => j.id === m.job_id) : null;
    let target = m.sim_target;
    if (job && ['DISPATCHED', 'ACKNOWLEDGED', 'EN_ROUTE'].includes(job.status)) target = { lat: job.lat, lon: job.lon };
    if (!target || Math.hypot(target.lat - m.lat, target.lon - m.lon) < 0.0006) {
      target = { lat: 51.5074 + (Math.random() - 0.5) * 0.08, lon: -0.1278 + (Math.random() - 0.5) * 0.10 };
      m.sim_target = target;
    }
    const dLat = target.lat - m.lat, dLon = target.lon - m.lon;
    const dist = Math.hypot(dLat, dLon) || 1;
    const step = Math.min(dist, 0.00035 + Math.random() * 0.0004);
    m.lat += (dLat / dist) * step; m.lon += (dLon / dist) * step;
    if (Math.random() < 0.05) m.battery = Math.max(5, m.battery - 1);
    const at = new Date().toISOString();
    db.locations.push({ id: nextId('locations'), mdt_id: m.id, personnel_id: null, lat: m.lat, lon: m.lon, speed: null, heading: null, at });
    if (db.locations.length > 20000) db.locations.shift();
    broadcast('mdt.status_changed', publicMdt(m));
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function start() {
  const restored = store.load();
  if (restored) console.log(`[cccs] state restored from ${store.file}`);
  else { seed(); store.flushNow(); }
  if (SIMULATION) setInterval(simulationTick, 2000).unref?.();
  setInterval(welfareTick, WELFARE_TICK_MS).unref?.();
  patrolScheduleTick();
  setInterval(patrolScheduleTick, PATROL_SCHEDULE_TICK_MS).unref?.();
  if (process.env.RETENTION !== 'off') {
    retentionSweep();
    setInterval(retentionSweep, 6 * 60 * 60 * 1000).unref?.();
  }
  server.listen(PORT, HOST, () => {
    console.log(`\n  CCCS POC — simulation only, not for operational use`);
    console.log(`  Control Room : http://localhost:${PORT}/control.html`);
    console.log(`  MDT          : http://localhost:${PORT}/mdt.html`);
    console.log(`  Demo logins  : dispatcher/dispatch123 · dwhitfield/field123 · mdt001/mdt123 · admin/admin123`);
    console.log(`  Storage      : ${store.enabled ? store.file : 'in memory only (PERSISTENCE=off)'}`);
    console.log(`  Microsoft SSO: ${MS_ENABLED ? 'enabled (tenant ' + MS_TENANT_ID + ')' : 'not configured — set MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET/MS_REDIRECT_URI'}\n`);
  });
  if (httpsServer) {
    const tlsPort = Number(process.env.TLS_PORT || 443);
    // Never let a problem with this secondary listener (e.g. permission to
    // bind a low port) take down the primary HTTP server the edge depends on.
    httpsServer.on('error', (e) => console.error(`  Direct HTTPS listener failed to start (${e.code || e.message}) — continuing on HTTP only`));
    // '::' not HOST -- HOST defaults to the IPv4-only 0.0.0.0 for the
    // edge-facing HTTP server above; this listener's only job is serving
    // the IPv6 clients that bypass the edge, so it needs the IPv6 wildcard.
    const tlsHost = process.env.TLS_HOST || '::';
    httpsServer.listen(tlsPort, tlsHost, () => console.log(`  Direct HTTPS : https://comms.echeloncic.com:${tlsPort} (IPv6 clients, bypasses the edge)`));
  }
}

if (require.main === module) start();
module.exports = { server, db, seq, store, start, seed, retentionSweep, patrolScheduleTick, RETENTION, hashPassword, verifyPassword, sign, PORT };

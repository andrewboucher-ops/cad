# Getting to production — a plan for one person

You're building this alone. That changes the right answer at almost every
decision point: buy rather than build, boring rather than clever, and cut scope
before cutting quality. This document is the sequence I'd follow and the things
I'd refuse to do.

> **Updated for commercial security.** The question below is settled: this is
> commercial security dispatch, not 999. That makes the plan realistic for one
> person, and Phases 1 and 2 are now done and in the repo.

## The honest position

What exists now is the signalling and dispatch layer, plus real browser-to-browser
audio, plus a telephony gateway that works against a simulated PBX. That is a
genuine chunk of the system — probably 25–30% of the engineering, and the part
that's hardest to get conceptually right.

What's missing is mostly the part that makes it *dependable* rather than
*functional*: persistence, scale-out, failover, device management, offline
behaviour, monitoring, and the operational practice around all of it. That
portion is not intellectually hard. It is just a lot, and it is the difference
between a system that demos and a system that people rely on.

### What still deserves care, even at commercial stakes

Two things carry real consequences regardless of the 999 question.

**Lone worker welfare.** If an officer is alone on a site at 3am and the system
fails to raise an overdue check-in, that is a person nobody is coming for. The
timers are evaluated server-side for exactly this reason, and the alarm path
flushes to disk immediately. Test this deliberately, on a real handset, on a real
network, before you rely on it — and keep a manual fallback that control actually
practises.

**Don't let it become the only route to emergency services.** Officers must know
to dial 999 directly from a phone, not through your dispatch system. Say so in
training and put it on the handset. This is the one place where a commercial
system quietly acquires safety-critical responsibility by accident.

Otherwise the consequences of a bad hour here are commercial: a missed alarm
response, an unhappy client, an SLA credit. Recoverable. Build accordingly.

---

## Phase 1 — Survive a restart ✅ done

SQLite via `node:sqlite`, write-through every second, full restore on boot,
verified across a real process restart. Not Postgres: for one control room and
tens of radios, a single file you can copy beats a daemon you have to operate.
`store.js` is the only file that changes if you outgrow it.

## Phase 2 — Deploy it properly ✅ done

`bash deploy/install.sh your.domain` gives you Node 22, Caddy with automatic TLS,
a service account, generated secrets in root-only `/etc/cccs/cccs.env`, a hardened
systemd unit, and nightly backups with 30-day retention.

Two things the installer can't do for you:

- **Restore a backup and open it.** Do this in week one. An untested backup is not
  a backup.
- **Uptime monitoring that pages you.** Healthchecks.io or UptimeRobot — not a
  dashboard you have to remember to look at.

## Phase 3 — Audio that works on mobile networks (2–3 weeks)

The current mesh is correct for one talker to a handful of listeners. Two things
it needs:

1. **coturn.** Non-negotiable. A third of mobile sessions won't connect without
   it. One small VPS, credentials rotated per session.
2. **An SFU once talkgroups exceed about a dozen listeners.** LiveKit is the
   right choice for a solo builder — it's a single binary, it has a sane API, and
   the server-side floor control you already have maps onto it directly. Replace
   `publishTo` in `public/app.js`; that's the whole integration surface.

Test on a real mobile network in a moving vehicle, not on your desk wifi. The
failures are all handover and packet loss failures, and they don't reproduce at home.

## Phase 4 — Android (2–4 weeks)

Build from `android/`. Order of work:

1. Get a debug APK installing and loading the console over HTTPS.
2. Foreground service surviving screen-off for an hour.
3. Background GPS pushing fixes at a sane interval.
4. Emergency and job notifications with a high-priority channel and a sound that
   cuts through.
5. Hardware keys: `MainActivity` already forwards every keycode to the web layer,
   so binding is done in Settings on the device — press the key, it is captured.
   Nothing to code per handset; just confirm the key is forwarded and not
   swallowed by the OS.
6. Battery optimisation exemption prompt on first run.

Buy the target handset before writing step 5. PTT key behaviour is vendor
specific and you cannot design around a device you don't have.

## Phase 5 — PBX (1 week, after Phase 3)

Follow `docs/PBX-FREEPBX.md` in the test order given. Do not start this before
audio works radio-to-radio — otherwise a silent call gives you two suspects.

## Phase 5b — Lone worker ✅ done, but not finished

Server-side welfare timers with warning, overdue alarm carrying last known
position, and check-in clearing a fired alarm are built and tested. What remains
is yours and cannot be written from here:

- Test it on the actual handset, backgrounded, screen off, on a real mobile network.
- Decide what control does when an alarm fires, and rehearse it.
- Add man-down (accelerometer) if your client contracts call for it — that's an
  Android-side sensor listener feeding the same alarm path.

## Phase 6 — The operational layer (ongoing)

This is the part that gets skipped and then hurts:

- **Offline behaviour ✅ built.** Writes queue on the device and replay in order
  with idempotency keys; the MDT shows unconfirmed state honestly rather than
  faking it. What remains is deciding your retention: the queue lives in browser
  storage, so clearing app data discards it.
- **Client reporting.** Commercial security lives on proving service: patrol visit
  logs, response times against SLA, incident reports per site. The audit log has
  the data; it needs a per-site monthly export. This is what clients renew on.
- **Device provisioning.** Issuing a radio, retiring one, rotating an ISSI.
- **Retention.** Audit logs and location history grow without bound. Partition
  `locations` by month and drop old partitions.
- **Access review.** Who can reset an emergency, and how you'd know if the wrong
  person did.

## What I'd defer or skip entirely

- Kubernetes. One VM with systemd and a backup will serve you far longer than the
  time k8s costs you.
- Multi-control-room and HA, until you have more than one control room.
- Native Kotlin/Swift apps, unless a handset SDK forces it.
- Push notifications via FCM, until the foreground service proves insufficient.
- Analytics dashboards. The audit log answers the questions you'll actually have.

## Where to spend money instead of time

As one person, these are worth paying for rather than building:

| Buy | Rather than | Roughly |
|---|---|---|
| LiveKit Cloud | running your own SFU | usage-based |
| Managed Postgres | your own backups and failover | £15–50/mo |
| Sentry | your own error aggregation | free tier works |
| coturn on a small VPS | — (must self-host or buy) | £5–10/mo |

The pattern: every hour not spent on infrastructure is an hour on dispatch logic,
which is where the actual product value is and where nobody else's off-the-shelf
component will help you.

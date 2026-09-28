# Getting to production — a plan for one person

You're building this alone. That changes the right answer at almost every
decision point: buy rather than build, boring rather than clever, and cut scope
before cutting quality. This document is the sequence to follow.

> **Pivot.** BroadNet now handles radio hardware and comms for the business, so
> CCCS's radio-communications side (PTT, talkgroups, the handset apps, the
> WebRTC/PBX telephony layer) has been removed. The product is now an
> operations-management platform: dispatch to sites, patrol/paperwork
> tracking, HR rota, and asset tracking — matching and eventually exceeding
> CommandHub Solutions' feature set, plus UK-specific compliance features.

## Where things stand

**Phase A — radio removal + rename: code-complete, not yet deployed.**
`server.js`/`store.js` are rebuilt around `personnel`/`mdts`/`job_assignments`
(no more `radio_id`, no PTT, no talkgroups, no PBX/telephony). Every client
page (`control.html`, the new `officer.html`, `mdt.html`, `admin.html`,
`index.html`, `log.html`) is radio-free. `db/schema.sql` and the test suite
still need updating to match, and nothing has shipped to the live container
yet — see *Deploying Phase A* below before that happens.

**Phase B — Sites/Patrols: not started.** Scheduled patrol visits
(`patrol_schedules`, `site_visits`) as a distinct, persistent model from
one-off `jobs`, reusing the existing checklist/photo/resolution-report
machinery.

**Phase C — HR Rota: not started.** Real personnel CRUD (currently
read-only), shifts/clock-in-out, a control-room rota builder, and the
officer-facing shift view in `officer.html`.

**Phase D — Asset tracking: not started.** Vehicle CRUD (currently
read-only) and a new general-purpose `assets` collection (equipment,
uniform, keys, devices) with checkout/return tracking.

---

## Deploying Phase A

This changes the shape of a live, daily-used system, so treat it as its own
deliberate step, not a drive-by deploy:

1. Confirm the git state on the container (`/opt/cccs-src`) and branch/commit
   before deploying, so the removal is reversible.
2. **Migrate live accounts first.** Any existing `RADIO_USER` account on the
   production database must be converted to a `FIELD_USER` with a matching
   `personnel` row *before* deploying code that no longer recognises that
   role — otherwise those accounts fail to log in with no clear error.
3. Deploy, then run the smoke pass in the *Verification* section of the
   implementation plan: log in as each surviving role, create a job, assign
   it to a person and to a team, walk the checklist/photo/report path to
   completion, trigger and resolve an emergency, confirm a welfare check-in
   fires and clears, confirm `db.locations` is actually accumulating rows
   for MDTs, confirm the event log and push notifications fire throughout.
4. The deployment-layout rename (systemd unit filename, `/etc/cccs/cccs.env`
   path, `/opt/cccs` / `/opt/cccs-src` directory names) is a separate,
   deliberate step done after the code-level removal has run stable for a
   while — not part of this deploy.

## What still deserves care, regardless of the pivot

**Lone worker welfare.** If an officer is alone on a site at 3am and the
system fails to raise an overdue check-in, that is a person nobody is coming
for. The timers are evaluated server-side for exactly this reason, and the
alarm path flushes to disk immediately. Test this deliberately, on a real
device, on a real network, before you rely on it — and keep a manual fallback
that control actually practises.

**Don't let it become the only route to emergency services.** Officers must
know to dial 999 directly from a phone, not through this system. Say so in
training.

---

## Phase 1 — Survive a restart ✅ done

SQLite via `node:sqlite`, write-through every second, full restore on boot,
verified across a real process restart. Not Postgres: for one control room
and a modest headcount, a single file you can copy beats a daemon you have to
operate. `store.js` is the only file that changes if you outgrow it.

## Phase 2 — Deploy it properly ✅ done

`bash deploy/install.sh your.domain` gives you Node 22, Caddy with automatic
TLS, a service account, generated secrets in root-only `/etc/cccs/cccs.env`,
a hardened systemd unit, and nightly backups with 30-day retention.

Two things the installer can't do for you:

- **Restore a backup and open it.** Do this in week one. An untested backup is
  not a backup.
- **Uptime monitoring that pages you.** Healthchecks.io or UptimeRobot — not a
  dashboard you have to remember to look at.

## Phase 3 — Sites/Patrols (2–3 weeks)

New `patrol_schedules` and `site_visits` collections, a scheduling tick that
creates a `SCHEDULED` visit when one is due, and routes mirroring `/api/jobs*`
for assign/ack/checklist/media/report. Genericise the resolution-report HTML
builder to accept `{reference, locationLabel, checklist, media, timeline,
resources}` so both jobs and site-visits can use it.

## Phase 4 — HR Rota (2–3 weeks)

Real `personnel` CRUD, a `shifts` collection with clock-in/out, a
control-room rota builder (`public/rota.html`), and the shift/clock-in view
inside `officer.html`.

## Phase 5 — Asset tracking (1–2 weeks)

Real `vehicles` CRUD and a new `assets` collection (equipment, uniform, keys,
devices) with a checkout/return audit trail.

## Phase 6 — The operational layer (ongoing)

- **Offline behaviour ✅ built.** Writes queue on the device and replay in
  order with idempotency keys; the MDT and officer terminal show unconfirmed
  state honestly rather than faking it. What remains is deciding your
  retention: the queue lives in browser storage, so clearing app data
  discards it.
- **Client reporting.** Commercial security lives on proving service: patrol
  visit logs, response times against SLA, incident reports per site. Once
  Phase 3 lands, `GET /api/sites/:id/report` should aggregate from
  `site_visits` directly rather than re-deriving from the audit log.
- **Device/asset provisioning.** Issuing and retiring MDTs, vehicles and
  equipment.
- **Retention.** Audit logs and location history grow without bound.
  Partition `locations` by month and drop old partitions.
- **Access review.** Who can reset an emergency, and how you'd know if the
  wrong person did.

## The extended roadmap (beyond Phase 3–5, roughly by what it extends)

**Extends Sites/Patrols**
- Guard Tour checkpoint scanning (NFC/QR/geofence points per site)
- Beats (patrol routes as their own entity)
- Passdown logs (per-site shift-handover notes)
- Forms: trespass advisals, parking citations, vehicle inspections,
  patient care/first-aid reports, safeguarding reports (the latter needs
  restricted-visibility handling given its sensitivity)

**Extends HR Rota**
- Full HR suite: leave management, attendance reporting, onboarding
- Payroll — likely an export, not a payroll engine; confirm the real
  requirement before designing
- **SIA licence checks** and **DBS Update Service checks** — needs a research
  spike before design: verify the actual integration mechanism (public
  API vs. employer portal vs. commercial integration) before building
  `personnel.sia_licence_no/expiry/status` and
  `personnel.dbs_certificate_no/type/status`
- Automated invoicing via **Xero** (not QuickBooks) — contract/rate fields on
  `sites`, an invoice-generation routine

**Extends Asset tracking**
- Fleet fuel-up reports/records (odometer, litres, cost, receipt photo)
- Vehicle maintenance scheduling
- Asset checkout/return audit trail

**New surfaces, larger lifts**
- Client portal — a genuinely new external-facing role, its own auth/access
  model
- Live employee tracking + geofencing for foot officers (a real gap today —
  see `docs/PRIVACY.md`)
- Training/academy module, applicant tracking
- Multi-branch — only worth building if the business genuinely operates as
  multiple branches
- AI assistant — revisit once the core product has real usage data

## What I'd defer or skip entirely

- Kubernetes. One VM with systemd and a backup will serve you far longer than
  the time k8s costs you.
- Multi-control-room and HA, until you have more than one control room.
- Native mobile apps, unless a real device requirement forces it — the
  officer terminal is a home-screen PWA today.
- Analytics dashboards. The audit log answers the questions you'll actually
  have, until client reporting (Phase 6) makes a dashboard worth it.

## Where to spend money instead of time

As one person, these are worth paying for rather than building:

| Buy | Rather than | Roughly |
|---|---|---|
| Managed Postgres | your own backups and failover | £15–50/mo |
| Sentry | your own error aggregation | free tier works |
| Xero API | building an invoicing engine | existing subscription |

The pattern: every hour not spent on infrastructure is an hour on the ops
logic that is where the actual product value is.

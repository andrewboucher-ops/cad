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

**Phase A — radio removal + rename: done and deployed.**
`server.js`/`store.js` are rebuilt around `personnel`/`mdts`/`job_assignments`
(no more `radio_id`, no PTT, no talkgroups, no PBX/telephony). Every client
page (`control.html`, `officer.html`, `mdt.html`, `admin.html`, `index.html`,
`log.html`) is radio-free, `db/schema.sql` and the test suite match, and this
has shipped to the live container.

**Phase B — Sites/Patrols: done and deployed.** `patrol_schedules` and
`site_visits` are live: a scheduling tick (`patrolScheduleTick`, every 60s)
turns a due occurrence into a `SCHEDULED` visit and flags one nobody
dispatched in time as `MISSED`; visits walk the same
DISPATCHED→ACKNOWLEDGED→EN_ROUTE→ON_SCENE→COMPLETED lifecycle as a job,
reusing the checklist/photo/resolution-report machinery. Control room has a
Patrol Visits panel, `admin.html` has a Patrol Schedules tab, `officer.html`
shows and acts on an assigned visit. Covered by tests. Live on the container.

**Phase C — HR Rota: done and deployed.** Personnel CRUD
(`POST`/`PATCH`/`DELETE /api/personnel`, ADMIN-gated, with delete guards
against an open job/visit assignment or a linked login), a `shifts`
collection with clock-in/out (gated to the shift's own person or control),
and reciprocal `user.personnel_id` ↔ `personnel.user_id` linking (a real bug
in the existing user-linking code was fixed in the process — it only set one
side). `admin.html` has a Personnel tab and a "linked personnel" select on
the account form; `public/rota.html` is a new week-grid rota builder;
`officer.html` shows the officer's current/next shift with clock-in/out.
Covered by tests. Live on the container.

**Phase D — Asset tracking: done and deployed.** Vehicle CRUD
(`POST`/`PATCH`/`DELETE /api/vehicles`, unique registration, delete blocked
while an MDT or person is still linked to it) and a new `assets` collection
(equipment/uniform/key/device/other, optional unique tag, assignable to a
person or a site) with the same CRUD shape. `admin.html` has Vehicles and
Assets tabs. Covered by tests. Live on the container alongside Phases B/C.

**Passdown logs — done and deployed.** The first "Extends Sites/Patrols"
roadmap item: a `passdown_logs` collection of append-only, site-scoped
handover notes (`GET`/`POST /api/passdown-logs`, `DELETE` admin-only).
Control can read/write any site's log; a `FIELD_USER` can read/write a
site's log only once they've had a shift or site visit there. `admin.html`'s
site editor shows and adds to a site's log; `officer.html` shows the log for
the officer's current shift/visit site. Covered by tests. Live on the
container.

**Fuel logs — done and deployed.** The first "Extends Asset tracking"
roadmap item: a `fuel_logs` collection against a vehicle (odometer, litres,
cost, an optional single receipt photo, driver). `GET`/`POST
/api/vehicles/:id/fuel-logs`, `POST /api/fuel-logs/:id/receipt`, `DELETE`
admin-only. Logging one with an odometer reading also updates the vehicle's
own `mileage`. `admin.html`'s vehicle editor shows and adds to a vehicle's
fuel log; `officer.html` has a "Log fuel" button next to an officer's
assigned vehicle. Covered by tests. Live on the container.

**Vehicle maintenance logs — done, not yet deployed.** The second "Extends
Asset tracking" item: a `maintenance_logs` collection against a vehicle
(description, cost, odometer, `next_due_at`). `GET`/`POST
/api/vehicles/:id/maintenance-logs` (control-only to log — an officer
doesn't coordinate a garage visit), `DELETE` admin-only. Logging one with
`next_due_at` also updates the vehicle's `service_due_at`, and `admin.html`'s
Vehicles table flags an overdue one in red. Covered by tests. Live on the
container.

**Asset checkout/return audit trail — done, not yet deployed.** The third
"Extends Asset tracking" item, closing out that section: a dedicated
`asset_checkouts` collection alongside the existing blunt `assigned_to`/
`status` PATCH (kept for admin corrections). `POST /api/assets/:id/checkout`
and `/return`, `GET /api/assets/:id/checkouts`. A `FIELD_USER` can only check
an asset out to themselves and only return their own checkout; control can
act on anyone's. `admin.html`'s asset editor shows the history and the
checkout/return action; `officer.html` has a "My equipment" panel with a
Return button per item. Covered by tests. Live on the container.

**Beats — done, not yet deployed.** The last "Extends Sites/Patrols" item: a
`beats` collection — a named patrol route within a site with an ordered
waypoint list (same shape as a site's checklist), purely optional so a site
with none behaves exactly as before. `GET`/`POST`/`PATCH /api/beats`
(control-only), `DELETE` admin-only, blocked while a patrol schedule or open
site visit still references it. A patrol schedule can optionally reference
one; any visit it generates inherits it, and a manually created visit can
set one directly. `admin.html` has a Beats tab and a beat picker on the
patrol schedule form (scoped to the schedule's site); control room and
`officer.html` show the beat name alongside the site wherever a visit
appears. Covered by tests. Live on the container.

**Dashboard + theming — done, not yet deployed.** Not from the roadmap list
above — a direct request once the roadmap sweep landed. Two pieces:

- A real landing page, `public/dashboard.html`: `SYSTEM_ADMIN`/`DISPATCHER`/
  `SUPERVISOR` land here after login instead of straight into
  `control.html`; live counts (jobs by priority, emergencies, patrol
  visits, personnel/fleet), quick-action buttons, and an admin-only
  System panel. Control room becomes a sidebar link, gated to roles that
  have it — `FIELD_USER`/`MDT_USER` are unaffected, still landing on their
  own terminal directly.
- Six named themes (Cosmic/Midnight/Harbour/Rosewood/Terminal/Graphite,
  matching a reference product's default look and settings page as
  closely as practical), an independent light/dark/system toggle, four
  surface knobs (field bloom, panel translucency, corner radius, glow),
  and a colour-blind-safe priority ramp — all in a new `public/settings.html`,
  stored per-user (`users.ui_prefs`, `PATCH /api/me/preferences`) so they
  follow a login to any workstation. The priority/status colour set stays
  outside the theme system entirely — see the comment at the top of
  `console.css`'s theming section for why. `public/theme-init.js` stamps
  the cached preference onto `<html>` before `console.css` paints, so nothing
  flashes the default theme first.

Covered by a new preferences test. Verified live in-browser: every theme
switch, surface knob, and the colour-blind ramp visibly took effect
immediately and survived a full page reload. Live on the container.

**Guard Tour checkpoint scanning — done, not yet deployed.** The one
remaining "Extends Sites/Patrols" item that wasn't just a decision away —
it needed a scanning mechanism chosen first. Went with QR codes (no special
hardware) plus NFC where the device supports it (`NDEFReader`/Web NFC —
Android Chrome today, nothing on iOS Safari), rather than geofencing, since
either QR or NFC gives a real "you were physically there" proof without
needing beacon infrastructure. A beat waypoint's own id is the scan code —
`admin.html`'s Beats tab can print it as a QR code or write it to an NFC
tag; `officer.html` scans it back via camera, NFC, or a typed fallback,
whichever the device and site support, and rejects a mismatched code before
it reaches the server. `POST /api/site-visits/:id/checkpoint-scan` records
the scan; control sees live coverage on the visit, and a completed visit's
resolution report includes a scan-coverage line. Covered by a new test.
Verified live in-browser (scan/mismatch/progress round-tripped through
officer.html and control.html; caught and fixed a real popup-blocked crash
in the admin print flow along the way). Live on the container.

That closed every "Extends Sites/Patrols" item except configurable Forms at
the time — see below, it's since landed too.

**Control room redesign — first pass done and deployed (later superseded).**
`control.html`'s job and patrol-visit detail views (status stepper,
resources, notes, assign/complete/cancel, checkpoint coverage) moved out of
popup modals into the existing Detail panel (renamed from "Resource Detail").
That first pass deliberately left the smaller, occasional-action modals
(create job/visit, assign by call sign, send a message, push notification
setup) alone. **A separate, later effort (`feat/control-redesign`, built
with another agent while this session waited on a usage reset) went further
and is what's now live**: map-primary layout, translucent docked panels, a
merged Dispatch panel (jobs + visits together) with a "needs attendance"
filter, an On-shift panel grouped by shift, and genuinely zero modals —
create/assign/message are Detail-panel modes now, not popups. GoldenLayout
was removed entirely in that pass (multi-monitor popouts went with it).

**Configurable Forms — done and deployed**, also via `feat/control-redesign`.
Five default types (trespass advisal, parking citation, vehicle inspection,
patient care, safeguarding); patient care and safeguarding are `RESTRICTED`
by default. Restriction is enforced server-side in projection — a canary
leak test asserts a restricted report never appears in any other user's
response or raw WebSocket traffic, and is proven to fail when the rule is
broken. Officers file from `officer.html` with a canvas signature pad;
reports are read in a new `forms.html`; an admin form builder
(`routes-forms.js`) defines types and named readers rather than the five
defaults being hardcoded forever.

**New, not from this roadmap — contact routes (click-to-dial + SMS).** Also
from `feat/control-redesign`'s stack of branches. `personnel.supervisor_id`
(line management) and `shifts.is_duty_supervisor` (operational, per shift)
are both settable for the first time — deliberately two separate concepts,
since they can disagree. An officer's contact resolves to the duty
supervisor first, falling back to the line manager. Dial records an
`ATTEMPTED` outcome only — nothing on that path may claim `ANSWERED` without
a real PBX event confirming it; SMS goes via Twilio, logged-only by default
(`SMS_LIVE=off`). **Not yet verified**: a real call has never been placed
through it, and Twilio has never sent a real webhook here — both need
hands-on access this session doesn't have (FreePBX GUI, a phone, a public
Twilio callback URL). See `HANDOVER.md` for the full detail and the honest
list of what's unverified.

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

## Phase 3 — Sites/Patrols ✅ done and deployed

`patrol_schedules` and `site_visits` collections, a scheduling tick that
creates a `SCHEDULED` visit when one is due, and routes mirroring `/api/jobs*`
for assign/ack/checklist/media/report. The resolution-report HTML builder is
generic across jobs and site-visits. Beats and passdown logs (both from
"Extends Sites/Patrols" below) are also done; what's left there is Guard Tour
checkpoint scanning and configurable Forms.

## Phase 4 — HR Rota ✅ done and deployed

Real `personnel` CRUD, a `shifts` collection with clock-in/out, a
control-room rota builder (`public/rota.html`), and the shift/clock-in view
inside `officer.html`. SIA/DBS compliance tracking and leave management
have since landed too (see below). What's left under "Extends HR Rota"
below — attendance reporting, onboarding, payroll export, Xero invoicing —
all still need a decision or research spike before they can be designed,
not just built.

## Phase 5 — Asset tracking ✅ done and deployed

Real `vehicles` CRUD and a new `assets` collection (equipment, uniform, keys,
devices). Fuel logs, maintenance logs, and a dedicated checkout/return audit
trail (all from "Extends Asset tracking" below) are also done — asset
tracking's extended roadmap is now fully built out.

## Phase 6 — The operational layer (ongoing)

- **Offline behaviour ✅ built.** Writes queue on the device and replay in
  order with idempotency keys; the MDT and officer terminal show unconfirmed
  state honestly rather than faking it. What remains is deciding your
  retention: the queue lives in browser storage, so clearing app data
  discards it.
- ~~**Client reporting.**~~ — done. `GET /api/sites/:id/report?from=&to=`
  (control roles, default last 30 days) aggregates alarm jobs (count,
  completed/cancelled, average `created_at`→`on_scene_at` response time
  against the site's own optional `response_sla_minutes` and how many fell
  within it), patrol visit counts (completed/missed/cancelled), and incident
  reports filed against the site or any job/visit at it in the period.
  Incidents go through `forms.canRead()` exactly like every other read — a
  RESTRICTED safeguarding report doesn't surface in the rollup for a reader
  without a grant, covered by a dedicated test alongside the existing leak
  tests. `admin.html`'s site editor has a new SLA field and a "Service
  report" button with a date-range picker.
- **Device/asset provisioning.** Issuing and retiring MDTs, vehicles and
  equipment.
- **Retention.** Audit logs and location history grow without bound.
  Partition `locations` by month and drop old partitions.
- ~~**Access review.**~~ — done, see `docs/ACCESS.md`. Emergency
  ack/resolve was already correctly control-role-only; the real finding was
  a role check repeated across six routes (`role === 'FIELD_USER'`) that
  meant `MDT_USER` fell through unrestricted on every one, including
  silently clearing or cancelling another officer's welfare alarm — fixed
  to check `!isControlRole()` instead. Also fixed: `resolved_by` was never
  recorded on an emergency (only `acknowledged_by` was), welfare actions
  never named who acted on someone else's timer, and any login could mark
  someone else's message read. Covered by `test/access-review.test.js`.

## Phase 7 — Full scheduling platform (in progress)

A much larger brief: shift templates/recurrence, staff self-service
apply-for-a-shift with an approval workflow, vehicle/asset allocation per
shift with a stock ledger, SMS/email/iCal notifications, and a versioned
site-document store (assignment instructions, site maps). Working through
it incrementally, same as everything else in this document — one
self-contained slice at a time, tested and deployed before the next.

- ~~**Increment 1 — shifts become slots.**~~ — done. `shifts` restructured
  from one person inline to a slot (`site_id`, `shift_type_id`, time
  window, `required_headcount`, pay/bill rate, uniform/PPE, briefing, a
  typed `detail` blob) with a new `shift_assignments` table carrying who's
  actually on it (role, confirmed/declined, attendance, clock in/out) —
  the prerequisite for every later increment that needs a shift to hold
  more than one person. `shift_types` is a new admin-extensible collection
  (Control Room, Mobile Patrol, Alarm Response, Event, Static Guard,
  General), seeded once on boot like `forms.installDefaults()`. Duty
  supervisor, clock state and the leave-conflict flag all moved from the
  shift to the assignment; `routes-contact.js`'s "call supervisor"
  resolution, the passdown-access check, and the personnel-delete guard
  were all updated to match. `deploy/migrate-shifts-to-assignments.js`
  upgrades a live single-assignment database (dry-run first; safe to run
  before or after deploying, since the new code tolerates an old-shaped
  shift — it just shows unfilled until migrated). Deliberately added no
  new screen: `rota.html`, `officer.html` and `control.html`'s "on shift"
  board all needed updating to read the new shape, but every existing
  capability (create/edit/delete a shift, clock in/out, duty supervisor,
  the leave-conflict warning) works exactly as before — the only visible
  addition is a required "Shift type" field. `required_headcount` > 1 and
  the multi-assignment editing UI are supported by the API (see
  `test/cccs.test.js`) but not yet reachable from `rota.html` — that's
  Increment 2. Covered by `test/cccs.test.js`, `test/contact.test.js`,
  `test/leave.test.js` and the new `test/migrate-shifts.test.js`.
- ~~**Increment 2 — shift types + extended site/vehicle fields.**~~ — done,
  see README.md. `admin.html` gets a real Shift Types tab (name, key,
  colour, active/retired) instead of the fixed five; retiring a type
  hides it from new shifts without touching shifts already using it, and
  `rota.html`'s type dropdown keeps a retired type correctly selected
  (labelled "(retired)") rather than silently drifting the shift to a
  different type on save. `sites` gained code/postcode/timezone/
  risk_level/access_instructions/`is_control_room`; `vehicles` gained a
  home-base site and MOT/tax due dates, with the admin vehicle list
  flagging whichever of service/insurance/MOT/tax is overdue. The real
  multi-assignment editing UI landed in `rota.html`: a shift's modal
  lists everyone on it with duty-supervisor/clock-in-out/remove per
  person and an add-person control, `required_headcount` is directly
  editable with a live "N of M" count, and every row action reopens the
  modal with fresh server data so several edits in one sitting never act
  on stale state. Asset-field extensions (stock/quantity concepts) were
  left for Increment 6, where the stock ledger actually needs them.
- ~~**Increment 3 — site document store.**~~ — done, see README.md.
  `documents` gained two versioned types (`ASSIGNMENT_INSTRUCTIONS`,
  `SITE_MAP`, each keyed by a `title`) alongside the existing
  `CONTRACT`/`SITE_DOCUMENT`; a new upload under the same site+type+title
  archives the old one (kept, never deleted) rather than replacing it.
  `GET /api/sites/:id/documents` opened up from `CONTROL`-only to every
  staff role, scoped inside the handler to "control sees everything, staff
  see only the current versions for a site they're actually posted to" —
  reusing the passdown-access check already built for exactly that
  question. The client portal's document routes got the mirror-image fix:
  the two new types are explicitly excluded, so a client never sees the
  operational detail staff work from. File serving moved from buffering
  the whole file into memory to a real stream, the one addition to the
  request dispatcher itself (a handler can return `__stream` instead of
  `__body`), with an `inline`/`attachment` split by type and a long cache
  lifetime since a version's file is immutable once uploaded.
  `admin.html` got a versioned list (current prominent, archive
  collapsed) for instructions and a thumbnail gallery with a built-in
  zoom/pan viewer for maps — a PDF opens in the browser's own viewer
  instead, which already does both. `officer.html` got the read-only
  side: a "Site documents" button on whatever job or visit an officer
  currently has.
- ~~**Increment 4 — rota grid rework.**~~ — done, see README.md. A real
  draft-then-publish workflow: `POST /api/shifts` accepts an optional
  `status` (`DRAFT` or `PUBLISHED` only — the others make no sense on a
  shift that doesn't exist yet), `GET /api/shifts` hides a draft from
  anyone who isn't a control role, and every broadcast touching a draft
  shift goes `controlOnly` so its assignee can't learn about it a moment
  early over the socket either. `rota.html` got a coverage badge
  (red/amber `N/required`) on any chip whose shift isn't exactly staffed,
  a one-line "N shifts need staff / N drafts unpublished" summary, a
  shift-type filter, and two bulk actions: "Publish drafts" (every draft
  in view, one pass) and "Duplicate week forward" (copies every shift and
  its active assignees N weeks ahead, always as drafts — a bulk copy is
  exactly the moment to review before announcing, not after). Covered by
  a new test in `test/cccs.test.js` for the draft-creation/visibility
  boundary; the two bulk actions are client-side orchestration of
  already-tested single-shift endpoints, verified live rather than by a
  new server test.
- **Increment 5 — shift requests/applications.** Staff apply for a
  published open shift; control approves/rejects — mirrors the leave
  request pipeline's append-only, actor-and-timestamp-stamped shape.
- **Increment 6 — vehicle/asset allocation + stock ledger.** Per-shift
  vehicle/asset allocation with conflict checking, a stock-movements
  ledger for consumables (never overwrite a balance without a ledger
  entry, matching this codebase's audit-trail conventions elsewhere), and
  a stock dashboard.
- **Increment 7 — notifications.** SMS via the existing `sms.js` (already
  built, currently only operator-triggered) wired to shift
  assigned/changed/cancelled events; email via the existing MS Graph
  `sendMail` path; a personal iCal feed per staff member.
- **Increment 8 — permissions hardening + performance pass.** Site-level
  (not just branch-level) supervisor scoping; a Finance/read-only role;
  index/eager-load audit on the rota queries.

## The extended roadmap (beyond Phase 3–5, roughly by what it extends)

**Extends Sites/Patrols**
- ~~Guard Tour checkpoint scanning (NFC/QR/geofence points per site)~~ — done, see above (QR + NFC, not geofence)
- ~~Beats (patrol routes as their own entity)~~ — done, see above
- ~~Passdown logs (per-site shift-handover notes)~~ — done, see above
- ~~Forms: trespass advisals, parking citations, vehicle inspections,
  patient care/first-aid reports, safeguarding reports~~ — done, see above
  (`feat/control-redesign`); this section is now fully built out.

**Extends HR Rota**
- ~~Supervisor concepts (line manager + duty supervisor) and contact
  routes (click-to-dial, SMS)~~ — done, see above; real-PBX/real-Twilio
  verification still outstanding, not the code
- ~~Leave management~~ — done, see README.md. `personnel.employment_type`
  (`EMPLOYED`/`SUBCONTRACTOR`) gates the whole feature — a subcontractor
  invoices for their own time and never accrues an entitlement through
  this business, checked at every entry point in `routes-leave.js`. A
  running annual-leave balance is always derived
  (`leaveBalanceForPerson()`), never stored, against a calendar-year
  default and a 28-day statutory-minimum default allowance, either
  overridable per person. Self-service from `officer.html`
  (request/cancel-while-pending), approve/reject from `admin.html`'s Leave
  tab (rejection requires a reason), and a non-blocking amber conflict
  flag on `rota.html` when a shift falls inside approved leave. Sick,
  unpaid and other leave types are logged the same way but never touch
  the balance. Covered by `test/leave.test.js`.
- Full HR suite: attendance reporting, onboarding
- Payroll — likely an export, not a payroll engine; confirm the real
  requirement before designing
- ~~**SIA licence checks** and **DBS Update Service checks**~~ — research
  spike done: neither service has a public API (confirmed via SIA FOI 0622,
  24 Aug 2026, and the DBS employer guide, updated 28 Aug 2026); the only
  sanctioned mechanisms are a manual web portal (SIA) and a manual,
  consent-based per-person check (DBS Update Service), and DBS never
  proactively notifies of changes. Built as compliance *tracking* instead —
  `personnel.sia_licence_no/expiry` and
  `personnel.dbs_certificate_no/type/update_service_id/last_checked_at`
  (`db/schema-compliance.sql`), a computed `compliance: { sia, dbs }` flag
  on `GET /api/personnel`, fields and a "Mark checked today" action in
  `admin.html`, and counts on the dashboard System panel — see README.md
- Automated invoicing via **Xero** (not QuickBooks) — contract/rate fields on
  `sites`, an invoice-generation routine

**Extends Asset tracking**
- ~~Fleet fuel-up reports/records (odometer, litres, cost, receipt photo)~~ — done, see above
- ~~Vehicle maintenance scheduling~~ — done, see above
- ~~Asset checkout/return audit trail~~ — done, see above

**New surfaces, larger lifts**
- ~~Client portal~~ — done. A new `CLIENT` role, deliberately excluded from
  `ALL` (see README's Client portal section for why) so it gets nothing by
  default. `client.html`: a client's own sites, open jobs/visits (no
  personnel names), the same service-report numbers admin gets, uploaded
  documents (contracts/site paperwork), and a two-way request channel.
  `admin.html`'s new Clients tab manages client orgs, site access, and
  requests. `broadcast()` now treats CLIENT sockets as opt-in only via a new
  `siteIds` option — never the default "everyone" delivery, never the
  control-role bypass. Covered by a leak test in the same spirit as the
  forms RESTRICTED test: cross-tenant isolation on every route (a site
  that isn't theirs is a 404), and an untargeted broadcast reaching a
  CLIENT socket. Two things deliberately deferred, not silently skipped:
  the incident list isn't shown to clients yet (would need a careful
  change to `routes-forms.js`'s `canRead()`, not a bolt-on), and there's no
  live push to the portal yet (nothing broadcasts with `siteIds` yet, so
  it polls) — see README for both.
- ~~Live employee tracking + geofencing for foot officers~~ — done. Off by
  deployment default (`FOOT_TRACKING` env var, per the confirmation that
  the legal groundwork is already done/in progress — the flag is how you
  actually flip it on when ready). Once on, `officer.html` reports a fix
  every ~30s while clocked in; `control.html`'s map shows the officer live;
  `checkAutoProgressForPerson()` — the foot-officer twin of the existing
  MDT proximity check — auto-progresses their own job/visit through
  EN_ROUTE/ON_SCENE by distance, which is the "geofencing" this item asked
  for (arrival-radius detection, not a separate zone-drawing feature — see
  README's Live tracking section for that scoping call). Covered by
  `test/foot-tracking.test.js`: off-by-default refusal, own-record-only
  reporting, both auto-progress paths, and erasure clearing the live dot
  too. See `docs/PRIVACY.md` for the updated data table, staff-notice
  wording, and the legitimate-interest-assessment reminder that has to
  happen before an operator sets the flag.
- ~~Training/academy module~~ — done, the training-records half. Decision
  made: a hybrid, not purely tracked or purely delivered — a course either
  gets logged by an admin after it happens externally (a classroom
  session), or is taken in-app with material and a short multiple-choice
  assessment scored server-side (`correct_index` never reaches the
  officer). Status per person per course (never/overdue/expiring/ok) is
  derived the same way SIA/DBS already is. `admin.html`'s new Training tab
  defines courses and logs external completions from a person's own
  record; `officer.html` has a Training panel to take one. Covered by
  `test/training.test.js`: assessment validation, the answer-key leak
  check, server-side scoring (failing creates no record), external logging,
  and a retired course dropping out of the live summary. See README's
  Training section for the full design and the deliberate v1
  simplifications (no course versioning, no DELETE — retire via `active:
  false`). ~~Applicant tracking~~ — also done: a recruitment pipeline
  (APPLIED → SCREENING → INTERVIEW → OFFER, freely, plus REJECTED/
  WITHDRAWN) gated to control roles, not ALL, since a field/MDT user has no
  reason to see who's applying. `HIRED` is deliberately not a plain stage
  change — only `POST /api/applicants/:id/hire` creates it, because that's
  the actual point of the feature: it creates a real `personnel` record so
  everything else in CCCS picks the person up from that moment on, without
  creating a login (a separate, explicit Accounts-tab decision, same as
  any new personnel record). `admin.html`'s new Applicants tab handles
  notes, interview scheduling and CV upload. Covered by
  `test/applicants.test.js`. See README's Applicant tracking section.
  **Also found and fixed while building this**: `store.js`'s persistence
  whitelist never included the client portal, multi-branch or training
  collections — they were never actually surviving a restart. Fixed, and
  `test/persistence.test.js` now guards against it happening again for
  any future collection, applicants included.
- ~~**Multi-branch**~~ — done. Decision made: a staff-visibility split, not
  full tenant separation — `SUPERVISOR`/`FIELD_USER`/`MDT_USER` see only
  their own branch's sites/personnel/vehicles/assets (and jobs/visits at
  those sites); `DISPATCHER`/`SYSTEM_ADMIN` always see every branch. Opt-in
  per record and per account, so nothing changes for an install that never
  sets a `branch_id`. `admin.html`'s new Branches tab manages branches;
  every relevant editor gets a Branch picker. Deliberately not scoped:
  MDTs, and the emergency/audit-log feeds — see README's Multi-branch
  section for why. Covered by `test/branches.test.js`: cross-branch
  isolation on every scoped resource, shared (no-branch) records staying
  visible to everyone, an unassigned scoped-role account seeing
  everything, and dispatcher/admin never being filtered.
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

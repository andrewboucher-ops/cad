# CCCS — Critical Communications, Dispatch & Control-Room System

An operations-management platform for commercial security: dispatch to
call signs, alarm-response dispatch against contracted sites, on-scene
checklists with photo evidence and emailed resolution reports, lone-worker
welfare timers, emergency alerting, GPS tracking for vehicle terminals, and a
persistent audit trail. Radio hardware and comms are handled outside this
system (BroadNet); CCCS is the ops layer above it.

> **Scope.** Built for commercial security dispatch — patrols, keyholding,
> alarm response, static guarding. It is not a 999 system and should not be
> relied on as the sole means of summoning emergency services.

---

## Run it

```bash
cp .env.example .env      # then edit AUTH_SECRET
npm start                 # Node 22+, zero dependencies
```

State persists to `./data/cccs.db` and survives restarts. Deploying to a server is one command — see *Deployment* below.

Or with Docker:

```bash
cp .env.example .env      # AUTH_SECRET is required
docker compose up --build
```

Open <http://localhost:4000>. Tests: `npm test` — no network needed. They
cover the server over real HTTP and WebSocket sockets, and drive the actual
client code in `public/app.js` for the offline queue.

### Demo accounts

| Username | Password | Role | Opens |
|---|---|---|---|
| `dispatcher` | `dispatch123` | DISPATCHER | control room |
| `supervisor` | `super123` | SUPERVISOR | control room + emergency reset |
| `admin` | `admin123` | SYSTEM_ADMIN | control room + user/site/MDT admin |
| `dwhitfield` | `field123` | FIELD_USER | officer terminal, call sign P101 |
| `emarsh` | `field123` | FIELD_USER | officer terminal, call sign P102 |
| `rcole` | `field123` | FIELD_USER | officer terminal, call sign P103 |

(`emarsh` is Ellie Marsh, `rcole` is Ryan Cole.)
| `mdt001` | `mdt123` | MDT_USER | MDT-001 |

These are deliberately weak demo credentials for a POC. Replace them before the system leaves your laptop.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_SECRET` | generated per boot (with a warning) | HMAC key for session tokens |
| `PORT` | `4000` | HTTP + WebSocket port |
| `SIMULATION` | `on` | set `off` to freeze simulated MDT GPS movement |
| `TOKEN_TTL_MS` | `28800000` | session lifetime |
| `MDT_TOKEN_TTL_MS` | `86400000` | vehicle-terminal session lifetime |
| `DATA_FILE` | `./data/cccs.db` | SQLite database file |
| `PERSISTENCE` | `on` | `off` runs entirely in memory |
| `FLUSH_MS` | `1000` | write-through interval |
| `WELFARE_TICK_MS` | `5000` | how often welfare timers are evaluated |
| `WELFARE_WARN_S` | `60` | warning given to the officer before a timer expires |
| `SEED_FILE` | `./seed.json` | your fleet definition, read on first boot only |
| `RETENTION` | `on` | `off` disables automatic deletion (you had better have a reason) |
| `RETAIN_LOCATIONS_DAYS` | `31` | movement history |
| `RETAIN_AUDIT_DAYS` | `365` | audit trail |
| `RETAIN_MESSAGES_DAYS` | `180` | message metadata |
| `RETAIN_JOBS_DAYS` | `730` | closed jobs |
| `GUARDM8_SECRET` | — | shared secret for GuardM8's `POST /api/integrations/guardm8/jobs` |
| `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_REDIRECT_URI` | — | Microsoft Entra ID SSO — see `docs/SSO.md` |

No secrets are hardcoded. If `AUTH_SECRET` is unset the server generates an ephemeral one and warns; sessions then drop on restart.

### Your own fleet

Copy `seed.example.json` to `seed.json`, put your sites, call signs, vehicles
and personnel in it, and start the server. It is read on first boot only —
once the database has content the file is ignored, so it cannot overwrite
anything live. Placeholder passwords, weak passwords and unknown roles are
all refused rather than silently accepted.

With no `seed.json` present you get the demo fleet below.

### Demo seed data

Loaded automatically at boot, no migration step needed, and only on first
boot — after that the database is the source of truth.

- Personnel Dan Whitfield → P101, Ellie Marsh → P102, Ryan Cole → P103
- MDTs `MDT-001`→P101, `MDT-002`→P102, `MDT-003`→P103
- Vehicles VAN-101, VAN-102, VAN-103, CAR-201; personnel attached to call signs
- Sites under contract: Meridian Business Park, Carlton Retail Centre, Northgate Distribution, Ashcroft House — each with an address, position and keyholder

To start from your own data instead: delete `data/cccs.db`, edit `seed()` in `server.js`, restart.

---

## A. System architecture

```
 browser consoles                node process                     state
 ────────────────                ────────────                     ─────
 control.html  ─┐           ┌─ REST router (/api/*)  ──┐
 officer.html  ─┼─ HTTP ───▶│    auth · RBAC · rate    │──▶ domain services ──▶ store
 mdt.html      ─┘           │    limit · validation    │      (personnel, mdts,      │
                │           └──────────────────────────┘       jobs, emergency)    │
                └─ WS /ws ──▶ connection registry ◀── broadcast(event, targeting) ◀──┘
```

Every state change follows one path: an HTTP request mutates the store through a domain function, that function writes an audit row, and then fans the change out over WebSockets. Consoles never poll — they load one snapshot from `GET /api/state` on connect and are event-driven from then on. That keeps every open console consistent by construction: there is no second code path that can update one surface and not the others.

**Stack deviation, stated up front.** This POC is Node with zero dependencies, vanilla ES modules in the browser, and an in-memory store shaped exactly like the SQL schema in `db/schema.sql`. The reason is that it had to be verifiably runnable and testable in an offline environment — no `npm install`, no database daemon, no CDN. Everything you can do in the UI, the test suite does over real sockets. The trade is real: you lose type checking, component reuse and a real database engine. The migration path is deliberately short, and the interfaces that matter (`publicJob`, `publicPersonnel`, `broadcast`, the domain functions) are already the seams you would cut along. See `docs/ROADMAP.md`.

## B. Database schema

Full DDL with foreign keys, indexes and enums is in [`db/schema.sql`](db/schema.sql). Core relationships:

```
callsigns ─┬─< mdts
           ├─< personnel
           └─< job_assignments >── jobs
personnel · mdts ─< locations · emergency_events
messages · audit_logs · users · vehicles · sites · call_requests
```

The call sign is the operational identity, and it is the join point: a call sign may hold several MDTs, a vehicle and multiple personnel. Jobs are dispatched *to call signs, personnel or MDTs directly*. A `job_assignments` row carries a `personnel_id` and/or an `mdt_id` — a person doing a driving patrol has both, a foot patrol just the person.

## C. UI architecture

**Dashboard** (`public/dashboard.html`) — the default landing page for `SYSTEM_ADMIN`/`DISPATCHER`/`SUPERVISOR` after login (control.html is no longer landed on directly — see "Dashboard and theming" below). Live counts (open jobs by priority, active emergencies, open patrol visits, personnel/fleet), a "Fleet & coverage" and "Recent activity" panel, and quick-action buttons into Control room/Rota/Log/Admin. `SYSTEM_ADMIN` additionally gets a "System" panel (account counts by role, sites under contract) — everyone else sees the same operational picture without it.

**Control room** (`public/control.html`) — dark console, three live columns: personnel/MDT resources with status pills, the operational map, and open jobs; below that the event timeline with a live filter and a Detail panel. Emergencies push a red banner across the top with acknowledge, locate and reset in one row. Pending callback requests get their own bar. Reached from the Dashboard or the sidebar's "Control room" link — only shown to roles with control access. Selecting a person, MDT, job or patrol visit anywhere on the page shows its full detail — status stepper, resources, notes, assign/complete/cancel — inline in the always-visible Detail panel, not a popup: a real-time console is something you keep glancing at during a shift, so the thing you clicked stays on screen and keeps updating live rather than blocking everything else behind a dialog you have to close. Quick, occasional actions (create a job or visit, assign by call sign, send a message, enable push notifications) still use a small modal — that distinction is deliberate, not leftover: a modal fits a short one-off form, not something you want to keep watching.

**Officer terminal** (`public/officer.html`) — the individual-login, personnel-facing terminal: emergency button, welfare timer, current job with on-scene checklist and photo capture, status progression (accept, en route, on scene, completed), and messaging with control. This is a `FIELD_USER`'s own landing page — already a personal dashboard, not restructured.

**MDT** (`public/mdt.html`) — a vehicle terminal: terminal identity down the left, the current job filling the right with full incident detail and the status progression as buttons.

**My settings** (`public/settings.html`) — every role's own account page: theme, light/dark, surface (field bloom/panels/corners/glow), the priority colour ramp, sound, and reduced motion. See "Dashboard and theming" below.

The map is a Leaflet-based renderer (`CCCS.makeMap`) exposing a `render(units, jobs, onPick)` interface.

## Dashboard and theming

Logging in as `SYSTEM_ADMIN`/`DISPATCHER`/`SUPERVISOR` now opens `dashboard.html`, not `control.html` directly — the control room is a real console you dock into for a shift, not a dashboard, and CommandHub-style competitors treat them as separate things for the same reason. The sidebar carries a "Control room" link for roles that have it; `FIELD_USER`/`MDT_USER` are unaffected, still landing on their own terminal.

Six named themes (Cosmic/Midnight/Harbour/Rosewood/Terminal/Graphite — Harbour is the default, matching GuardM8's), an independent light/dark/system toggle, four surface knobs (field bloom colour, panel translucency, corner radius, glow), and a colour-blind-safe priority ramp, all set from `settings.html` and stored on the user's own record (`ui_prefs`) so they follow a login to any workstation rather than living in browser storage. `PATCH /api/me/preferences` is self-service for every role.

The priority/status colours (`--emergency`/`--priority`/`--available`/`--busy`/`--on-task`/`--offline`) are deliberately outside the theme system — they only change via the colour-blind-safe ramp toggle, never via a theme choice, so a real alarm can never be made to look like a test signal by a chrome preference. `console.css` documents this at the top of its theming section.

A tiny synchronous script, `public/theme-init.js`, runs at the very top of every page's `<head>` (before `console.css` paints) and stamps the cached preference from `localStorage` onto `<html>`, so a page never flashes the default theme before switching to the operator's own. `CCCS.applyTheme()` in `app.js` does the same thing after login and after a live preference change, for instant feedback with no reload.

## D. Real-time architecture

One WebSocket endpoint, `/ws?token=…`, authenticated by the same signed token as the REST API; an unauthenticated upgrade is refused at the handshake (covered by a test). On connect an MDT identifies itself with `mdt.attach`; the server binds that device to the socket, marks it on air, and treats socket loss as the device going OFFLINE. A `FIELD_USER` is identified by their session alone — no attach step needed.

Client → server: `mdt.attach`, `ping`.

Server → client: `mdt.status_changed`, `mdt.created`, `mdt.assigned`, `mdt.crew_changed`, `mdt.deleted`, `job.created`, `job.dispatched`, `job.assigned_to_you`, `job.acknowledged`, `job.status_changed`, `job.stood_down`, `emergency.activated`, `emergency.acknowledged`, `emergency.resolved`, `welfare.started`, `welfare.checked_in`, `welfare.stopped`, `welfare.due_soon`, `welfare.overdue`, `call.request`, `call.request_cleared`, `message.received`, `event.logged`.

Targeting is explicit: `broadcast(type, payload, { personnelIds, mdtIds })` sends to the named recipients, and control-room roles receive everything so the console stays a complete picture.

## E. Project structure

```
server.js            REST API, WebSocket server, domain logic, seed data
openapi.json         API documentation (served at /api/openapi.json)
public/
  index.html         sign-in and console launcher
  dashboard.html     landing page for control-access roles
  control.html       dispatcher console
  officer.html       individual officer terminal
  mdt.html           mobile data terminal
  settings.html      per-operator theme/sound/motion preferences
  app.js             shared client: auth, REST, WS bus, Leaflet map
  theme-init.js      no-flash theme stamp, runs before console.css paints
  console.css        design tokens, themes, and status colours
db/schema.sql        target PostgreSQL schema
test/cccs.test.js    hand-rolled WebSocket client included
Dockerfile · docker-compose.yml · .env.example
```

For a production split this becomes `apps/{control-room,officer,mdt}`, `services/{api,realtime}`, `packages/{database,types,ui,shared}`. `server.js` is already organised in those bands and is the natural cut line.

---

## Demonstration script

Open three browser windows. The whole sequence works without touching any stored data by hand.

1. **Control room** — sign in as `dispatcher`, choose Control room.
2. **Officer P101** — new window, sign in as `dwhitfield`.
3. **MDT-001** — new window, sign in as `mdt001`.

**Dispatch a job** — in control press *Create job*, set priority RED, a location, select P101 in the resource list, *Create and dispatch*. The officer terminal gets a new-job alert; MDT-001 gets the full incident because it is assigned to the same call sign. Accept on either: control logs the acknowledgement. Walk the checklist and attach a photo from the officer terminal; progress the job through en route, on scene and completed.

**Emergency** — on the officer terminal press *EMERGENCY* and confirm. The control room raises a red banner with call sign, position and time, sounds a tone, and offers acknowledge, locate and reset. Acknowledge, then reset.

**Welfare** — start a welfare timer from the officer terminal, let it run down without checking in, and watch it raise an alarm identical to an emergency in the control room.

**Map and assignments** — click any resource on the map for its identity, job, speed and last fix. *Assignments* moves MDTs between call signs live.

---

## Staff privacy and data retention

This system tracks vehicle location continuously while a terminal is on. Retention is enforced in
code — a sweep every six hours deletes location history after 31 days, message
metadata after 180, and the audit trail after a year. `GET /api/retention`
shows the policy and the current record counts; the `RETAIN_*_DAYS` variables
change them.

An officer's or vehicle's movement history can be erased on request with
`POST /api/personnel/:id/erase-location-history` without touching the job record
the business needs to keep.

[`docs/PRIVACY.md`](docs/PRIVACY.md) covers what you owe staff before go-live —
the notice, the legitimate interest assessment, the DPIA — and includes a draft
notice you can adapt. It is not legal advice; have someone qualified read it.

## Security

Implemented: scrypt password hashing, HMAC-signed session tokens with expiry, constant-time signature and password comparison, role-based authorisation on every route, ownership checks (a field user can only update jobs assigned to them and cannot acknowledge their own emergency), WebSocket authentication at the handshake, request body size limits, input validation, per-IP rate limiting, path traversal protection on static files, and an audit row for every meaningful action including failed logins.

[`docs/ACCESS.md`](docs/ACCESS.md) is a plain walk-through of who can act on
someone else's record and how you'd know if the wrong person did — done in
response to a specific open question in `docs/ROADMAP.md`. It found and fixed
a real gap: an `MDT_USER` (a vehicle terminal, not a person) could silently
clear or cancel another officer's welfare alarm, among five other routes with
the same blind spot. Re-run its closing grep after touching any role gate.

Not implemented, and needed before any real deployment: TLS, refresh tokens and revocation, CSRF defence for cookie-based sessions, account lockout, per-role rate limits, secrets management, and penetration testing.

## Known limitations

- **Foot officers have no continuous GPS.** Only vehicle terminals (MDTs) report position continuously; an officer's location is only captured as a single fix at the moment they raise an emergency. Continuous personal tracking is on the roadmap, not built.
- **Single process.** No Redis pub/sub, so this does not scale past one node or survive failover. For one control room that is the right trade; it stops being right the day you open a second.
- **Offline queue holds writes only.** Work done without a link is saved and replayed, but the device cannot see new jobs or status changes while it is down, and the queue lives in browser storage — clearing app data discards it.
- **Simulated MDT GPS.** Vehicle positions are generated by a server-side movement model until real terminals report. Set `SIMULATION=off` once they do.
- **Browser tokens live in `sessionStorage`**, which is acceptable for a POC and not for production.

## Storage

State lives in memory for speed and is written through to SQLite (`node:sqlite`,
built into Node 22 — still no dependencies). Restart the service and every
job, site, message and audit row comes back; devices are correctly reset to
disconnected rather than pretending they survived.

SQLite rather than PostgreSQL is a deliberate choice for a single-operator
commercial security setup: one control room and a modest headcount is well within
what SQLite in WAL mode handles, and the database being one file you can copy is
worth more to you than anything Postgres adds. `db/schema.sql` remains the
Postgres target if you outgrow it; `store.js` is the only file that changes.

A hard crash loses at most one flush interval — a location fix or two. Emergencies,
welfare alarms and audit rows flush immediately.

`store.js`'s `TABLES` is a hand-maintained whitelist — `load()`/`flushNow()`
only ever look at what's named there, so a new collection that forgets to
be added to it doesn't error, it just silently never survives a restart.
That exact thing happened to the client portal, multi-branch and training
records when they first landed (found and fixed while building applicant
tracking) — every test in this suite runs with `PERSISTENCE=off`, so none
of them would ever have caught it. `test/persistence.test.js` now asserts
every key on `db` is in `TABLES`, so the next new collection can't repeat
it quietly, plus a real round-trip test (write, force a real restart via
`require.cache`, read back) for one of the previously-broken ones.

## Lone worker welfare timers

The feature your insurer and your lone-worker policy will ask about. An officer
starts a welfare timer, picks an interval and notes what they're doing. They get an
audible warning before it expires; if no check-in arrives, control gets an alarm
carrying the call sign, the last known position, the time, and what the officer
said they were doing. The control-room banner treats it like an emergency because
operationally it is one. Checking in clears an alarm that has already fired.

Timers are evaluated server-side, so they survive the app being backgrounded
or the device dropping off the network — which is exactly when you need them
to work.

## Sites and alarm response

Jobs can be raised against a site under contract and inherit its address, position
and keyholder details, so an alarm activation becomes two clicks rather than
retyping an address at 3am. Incident types are pre-populated for security work:
alarm activation, intruder on site, keyholding response, lock and unlock, patrol
visit, fire alarm, vandalism, trespass. Each job carries an on-scene checklist —
from the site's own template if it has one, else a sane default — with photo
evidence, and completing a job builds and emails a resolution report to the
site's contact via Microsoft Graph.

## Scheduled patrol visits

A recurring alternative to one-off jobs: a patrol schedule describes a
cadence (every N hours, or specific days and a time of day) against a site.
A background tick creates a `SCHEDULED` visit when one falls due, and flags
one nobody ever dispatched, well past its window, as `MISSED` — a silent gap
in patrol coverage is meant to be surfaced, not quietly age out. A visit
walks the same dispatch → acknowledge → en route → on scene → completed
lifecycle as a job, with the same checklist, photo evidence and emailed
resolution report. Manage schedules from `admin.html`'s Patrol Schedules
tab; control room has a Patrol Visits panel; officers see and act on their
assigned visit in `officer.html` alongside any job.

## HR rota

Personnel are a real, editable record (`admin.html`'s Personnel tab) rather
than a read-only stub — name, rank, employee number, contact details,
employment status, and an optional linked user login. `public/rota.html` is
a week-at-a-time grid (personnel rows × day columns) for building the rota;
click a cell to add a shift, click a shift to edit or delete it. Officers
see their current or next shift and clock in/out from `officer.html`; a
shift can also be edited or clocked by control. Deleting a person is
blocked while they're assigned to an open job or site visit, have an
upcoming or active shift, or still have a login linked — unlink or resolve
those first.

**A shift is a slot, not a person.** `shifts` (site, shift type, time
window, `required_headcount`, pay/bill rate, uniform/PPE, briefing, a typed
`detail` blob per shift type) is separate from `shift_assignments` (who's
actually on it — role, confirmed/declined, attendance, clock in/out). This
is what lets a shift eventually need more than one person; a shift's own
`status` (`PUBLISHED`/`IN_PROGRESS`/`COMPLETED`/`CANCELLED`, plus an unused
`DRAFT` reserved for a real draft-then-publish workflow later) never carries
one person's attendance, and `assigned_count`/`coverage_gap` are always
derived from the live assignments, never stored — the same "make the gap
visible, don't cache it" pattern as `personnel.compliance`/`leave_balance`.
Shift types (`shift_types`: Control Room, Mobile Patrol, Alarm Response,
Event, Static Guard, and a General catch-all) are an admin-extensible
collection, not a hardcoded enum, seeded once on first boot the same way
`forms.installDefaults()` seeds the standard report forms.

Clock-in/out, duty-supervisor and the leave-conflict flag all moved from
the shift to the assignment they're actually about — `routes-contact.js`'s
"call supervisor" resolution and the rota's on-leave warning both read the
assignment now, not the shift. A live production database on the old
single-assignment shape upgrades via
`deploy/migrate-shifts-to-assignments.js` (dry-run first; safe to run
either before or after deploying this code, since the new server tolerates
an old-shaped shift — it just shows as unfilled until migrated).

This is intentionally the first of several increments toward a fuller
scheduling platform (shift templates/recurrence, staff self-service
apply-for-a-shift, vehicle/asset allocation per shift with a stock ledger,
SMS/email/iCal notifications, a versioned site-document store) — see
`docs/ROADMAP.md`. This increment is the structural one everything else
builds on; it deliberately adds no new screen, only restructures shifts
under the UI that already existed.

**Increment 2** builds the admin surface the restructuring made possible.
`admin.html`'s new Shift Types tab is real CRUD (name, a stable key, a
colour used for the rota, active/retired) rather than the hardcoded five —
retiring a type hides it from new shifts without touching ones that
already use it, and `rota.html`'s type dropdown always keeps a retired
type's current shift correctly selected (as a labelled "(retired)"
option) rather than silently drifting it to whatever option happens to be
first. Sites gained `code`/`postcode`/`timezone`/`risk_level`/
`access_instructions`/`is_control_room`; vehicles gained a home-base site
and MOT/tax due dates alongside the existing service/insurance ones, with
the admin vehicle list flagging whichever of the four is overdue.

The real capability this increment adds is multi-assignment editing in
`rota.html`: a shift's modal now lists everyone on it (not just the one
person whose row was clicked), with a duty-supervisor toggle, clock
in/out and a Remove button per person, plus an "Add" control scoped to
people not already on the shift. Each row action calls its own
assignment-level endpoint and reopens the modal with fresh data from the
server — several adds/removes/clock-ins in one sitting never act on
stale state. `required_headcount` is now directly editable, with a live
"N of M" count. Creating a shift still starts with one person via the
same convenience `personnel` field as before; building toward a
headcount beyond one is something you now do from the edit view, not the
create flow — keeping the "+ add shift" cell click exactly as simple as
it always was.

**Increment 4** adds a real draft-then-publish workflow and the first
coverage-at-a-glance views, on top of the rota grid rather than replacing
it. A shift can now be created as `DRAFT` — not SCHEDULED, not CLOCKED_IN,
invisible to `GET /api/shifts` for anyone who isn't a control role, and
every `broadcast()` touching a draft shift (creation, edits, adding or
updating an assignment) goes `controlOnly` rather than to the assignee, so
the officer it names finds out only once it's actually published, not a
moment sooner over the socket. `rota.html` renders a draft chip dashed and
dimmed, with a "Publish drafts" bulk action that PATCHes every draft shift
in the current view to `PUBLISHED` in one pass. A shift whose
`coverage_gap`/`over_staffed` (already computed server-side since
Increment 1) is nonzero shows a small red/amber `N/required` badge right
on its chip, and a one-line summary above the grid counts how many shifts
in view need staff or are still unpublished — the "coverage strip" the
brief asks for, built as a signal layered onto the existing per-person
grid rather than a second, site-oriented grid view. A shift-type filter
narrows the whole grid to one type at a time. "Duplicate week forward"
copies every shift in the current view (and its active assignees — the
same core team usually covers a recurring week) N weeks ahead, always
landing as drafts: a bulk copy is exactly the moment a date needs nudging
or someone's left, so it's reviewed and explicitly published rather than
notifying everyone immediately.

**Increment 5** adds the self-service half of staffing a shift —
`routes-shift-applications.js`, mirroring `routes-leave.js`'s shape
closely. "Open" needs no new flag: a shift is available the moment it's
`PUBLISHED`, has `coverage_gap > 0` and hasn't started yet, so
`GET /api/shifts/available` is a filter over data this codebase already
computes, not a new concept layered on top. A `FIELD_USER` applies for
themselves only — `POST /api/shift-applications` ignores any other
personnel a request might name, the same self-service boundary leave
requests already enforce — and control shortlists, approves or rejects
(a reason is required to reject, exactly like leave). Approving is the
one action with a real side effect: it creates the actual
`shift_assignment` via the same path `POST /api/shifts/:id/assignments`
already uses, and if that fills the shift, every other still-open
application for it is marked `EXPIRED` rather than left to quietly become
impossible — the applicant finds out, not just stops hearing back.
Cancelling or deleting the shift does the same. "Invite or directly
assign" — the brief's other staffing path — was already
`POST /api/shifts/:id/assignments` from Increment 1; this file adds
nothing to that path, only the self-service one control doesn't use.

`officer.html` gets an "Available shifts" panel (apply in one click) and
"My applications" (status, a reason if rejected, withdraw while still
open). `rota.html`'s shift modal gets a matching "Applications for this
shift" section next to the existing assignments list, so approving an
application and directly assigning someone are two doors into the same
room rather than two disconnected screens.

## Vehicle/asset allocation and the stock ledger

`routes-fleet-stock.js` adds per-shift allocation for two different kinds
of thing, deliberately handled differently. A **vehicle**, and a
**non-stock-tracked asset** (a specific physical item — one named radio,
not "radios" as a quantity), can only ever be on one shift at a time:
allocating one checks every other allocation of the same vehicle/asset
for a time-overlapping, non-cancelled shift and refuses the conflict —
cancelling a shift frees whatever it was holding. A **stock-tracked
asset** has no such rule; allocating a quantity just withdraws that much
from its own ledger, and the only limit is how much is on hand.

That ledger — `stock_movements` — is this codebase's "derive, never
cache" convention applied to a running count: `stockLevel()` is always
the most recent movement's `resulting_balance`, never a field on the
asset itself that something could overwrite directly. Allocating to a
shift writes an `ALLOCATED` movement (negative); returning writes a
`RETURNED` one for whatever quantity actually comes back — which can be
less than what went out, and the difference (used, lost, damaged) is
simply never credited back, rather than requiring a separate
reconciliation step. A manual `RESTOCK`/`DAMAGED`/`AUDIT_CORRECTION`
entry works the same way and is refused if it would take stock below
zero. `GET /api/stock-dashboard` (control-only) flags anything at or
below its own `low_stock_threshold` or expiring within 30 days.

`admin.html`'s asset form gained `is_stock_tracked`, an initial quantity,
a threshold, an expiry date, and a "lives inside" parent-asset link (a
consumable kept inside a kit) — ticking the box reveals the stock fields
inline. A new Stock tab lists every stock-tracked asset with a one-click
restock. `rota.html`'s shift modal gained a "Resources" section —
vehicles and equipment, each with their own allocate/return controls —
alongside the existing personnel and applications sections.

Deliberately out of scope for this pass: the brief's "fleet board" (a
day/week view of every vehicle's allocations across the fleet) and
nested kit-contents browsing (seeing a first-aid kit's line items as a
group rather than as individually-listed stock rows). Both are real,
server-already-supports-it additions — `parent_asset_id` and
`GET /api/vehicles/:id/allocations` exist precisely so a future pass can
build them without another data-model change — just not built out as UI
yet.

## Shift notifications and the personal iCal feed

Every place `broadcast()` already decides who's allowed to know about a
shift event now also sends that person an SMS and an email: assigned,
time/site changed, cancelled (whether by status change or hard delete),
removed from a shift by control, and a rejected shift application. A
draft shift never notifies, the same boundary that already keeps it off
the socket and out of `GET /api/shifts` for anyone who isn't control.

Sending is synchronous and fire-and-forget, matching the rest of the
system's lack of a job queue — `notifyShiftEvent()` is called inline from
the route handler but not awaited, so a slow or failing send can't add
latency to the request that triggered it, and every attempt (success or
failure) writes a `dial_log` row — the same audit shape
`routes-contact.js`'s operator-triggered SMS already writes, so a missed
notification is visible, not silent. SMS reuses `sms.js` exactly as built
(dry-run unless `SMS_LIVE=on`); email is a new generic `sendGraphEmail(to,
subject, html)`, pulled out of the resolution-report sender's Graph
plumbing rather than duplicating it. Two checkboxes on the personnel
record, `sms_opt_out`/`email_opt_out`, suppress a channel per person,
independently of each other.

A shift's `revision` counter (bumped on every `PATCH` and on any
assignment status change) doubles as the iCal `SEQUENCE` for that shift's
events, so a calendar client knows a later version of the same `UID`
has arrived rather than treating it as a duplicate.

The personal feed (`GET /api/me/ical-feed`, regenerable from `rota.html`'s
and `officer.html`'s new "Calendar sync" button) is keyed by a long
unguessable token on the `users` record rather than a session — a
calendar app has no way to carry a bearer token, so the URL itself is the
credential, the same trust model as a webhook. `GET /api/rota/ical/:token.ics`
is registered with no role gate at all (the one other precedent for this
in the codebase is Twilio's status-callback webhook); it looks the token
up itself and serves a field officer their own assignments, or a
dispatcher/supervisor/admin the whole operation's non-draft shifts. A
cancelled shift, or an assignment someone was removed from, keeps its
`UID` in the feed with `STATUS:CANCELLED` rather than disappearing, so a
subscribed calendar actually updates instead of leaving a stale entry
behind.

Deliberately out of scope: quiet hours. The brief asks for them, but
honouring one means holding a message and releasing it later — exactly
the queue the system doesn't have and this phase deliberately didn't
build, and a shift notification is inherently the kind of thing someone
needs to know about now, not at a more polite hour.

## Site-level supervisor scoping, the FINANCE role, and a rota performance pass

Branch scoping (`BRANCH_SCOPED_ROLES`, `visibleToUser`/`siteVisibleTo`)
already existed for SUPERVISOR/FIELD_USER/MDT_USER; `users.site_ids` adds
a finer option on top of it — an explicit list of sites rather than a
whole branch — checked first, and falling back to branch-level (or no
restriction at all) when left unset, so an install that never sets it
sees no change. Building it surfaced a real, pre-existing gap: `GET
/api/shifts` and every shift write route (`POST`/`PATCH`/`DELETE
/api/shifts`, `POST /api/shifts/:id/assignments`, `PATCH
/api/shift-assignments/:id`) had **no** branch/site check at all, unlike
every other scoped list in the system (jobs, site-visits, shift
applications) — a branch-scoped supervisor could see, and even staff,
another branch's shifts. Both the read and write sides are fixed now,
and `assertPassdownAccess` was tightened the same way: a scoped
supervisor's control-role passdown access is no longer an unconditional
"any site," matching the rest of the pattern.

**FINANCE** is a new, deliberately narrow role for reading the pay/bill/
cost figures that already existed (a shift's `pay_rate`/`bill_rate`, a
vehicle's fuel and maintenance costs) without touching dispatch at all —
modelled directly on CLIENT's shape in `routes-client.js`: its own
registrar module (`routes-finance.js`), excluded from server.js's `ALL`
on purpose, every route re-checked server-side rather than trusting
anything the caller supplies. It reuses the existing branch-scoping
machinery (a FINANCE user can have a `branch_id` or `site_ids` just like
a SUPERVISOR) rather than inventing a parallel one. `finance.html` is a
small read-only page — shift rates and vehicle costs, each with a date
filter — the same shape as `client.html`. Deliberately out of scope: a
computed margin or payroll rollup. `pay_rate`/`bill_rate` carry no
documented unit anywhere else in the codebase (hourly? a flat shift
rate?) — computing a number from them here would be guessing at
semantics the rest of the system never commits to, not a real feature.

The performance half: `publicShift()` was doing five-plus full-collection
scans per shift (sites, shift types, assignments, vehicle allocations,
asset allocations), each assignment/allocation row then doing two to
three more (personnel, callsigns, vehicles, assets, leave requests) — so
a list of N shifts cost O(N × total collection sizes), not O(N). It now
takes an optional pre-built index of grouped-by-shift Maps; `GET
/api/shifts` and `GET /api/shifts/available` (which used to run that
full cost over *every* shift before even filtering by status/date) build
one index per request and reuse it across every shift in the response.
A single-shift call site (create/patch, which only ever touches the one
shift it just changed) keeps calling `publicShift(s)` with no index at
all — same cost as before, no regression, no added complexity for a case
that was never the bottleneck. The stock dashboard got the identical
treatment for `stockLevel()`/`publicAsset()`.

One real bug came out of this refactor and is worth naming: `publicAsset`
and `publicVehicleAllocation` gained an optional second parameter, and
two existing call sites — `GET /api/assets` and `GET
/api/vehicles/:id/allocations` — passed them straight to `Array.map()`
as a bare function reference. `map` calls its callback with `(element,
index, array)`, so every row past the first silently received its own
array index as that new parameter instead of `undefined`, and crashed
trying to call `.get()` on a number. Both call sites now wrap the call in
an arrow function; `test/permissions-scoping.test.js` asserts against
exactly this with three-plus rows, specifically so this class of mistake
can't reappear silently in a future pass.

There is no integration with either service, because none exists to build:
the SIA's own Freedom of Information response (FOI 0622, 24 Aug 2026)
confirms it provides no API, data feed or special access for single or bulk
licence checks — not even to the paid third-party checker services — and the
DBS Update Service is, by design, a manual, consent-based, per-person web
check with no automation route (see the DBS employer guide, updated 28 Aug
2026); DBS does not proactively notify of status changes either. A handful
of unofficial GitHub projects exist that either browser-scrape the SIA's
public checker form or call an undocumented endpoint of the DBS Update
Service's own web app — neither is a sanctioned integration, and CCCS
deliberately does not build against either.

So `admin.html`'s Personnel tab instead records what an admin found when
they last actually performed the check by hand — SIA licence number and
expiry, DBS certificate number/type and Update Service ID, and a dedicated
"Mark checked today" action that stamps when the DBS check was actually
run (typing in a certificate number is not the same act as performing the
check, so it's never inferred from editing the other fields). `GET
/api/personnel` returns a computed `compliance: { sia, dbs }` flag per
person — `expiring`/`expired` for a licence within 30 days of or past its
expiry, `overdue` for a DBS recheck more than a year old (a risk-based
default, not a legal requirement, since DBS sets no fixed frequency) — the
same "make the silent gap visible" pattern already used for overdue vehicle
service and missed patrol visits, surfaced as a red flag on the personnel
table and counted on the admin dashboard's System panel.

## Asset tracking

Vehicles are a real, editable record (`admin.html`'s Vehicles tab) — make,
model, mileage, service/insurance due dates, condition, status, and an
optional assigned person — rather than the bare registration-and-type stub
they started as. A vehicle can't be deleted while an MDT or a person is
still linked to it. A new Assets tab covers everything else worth tracking
— equipment, uniform, keys, devices — each with an optional unique tag,
assignable to a person or a site, with a status (in use, in store, lost,
retired) and a "checked" timestamp you can bump on inspection. A dedicated
checkout/return path (also reachable from `officer.html` as "My equipment")
audit-trails who has an asset out and when it came back, alongside the
blunter direct-edit "assigned to" field for a quick admin correction.

## Passdown logs

Per-site shift-handover notes — "side gate padlock swapped, spare key with
the keyholder", "fire panel silenced after a false trigger in zone 2" — the
kind of thing the next person on site needs to know that doesn't belong in a
patrol checklist or a job record. Entries are append-only (no edit, a control
delete for corrections) and site-scoped: control can read and write any
site's log; a field officer can read and write a site's log only once
they've actually been posted there, via a shift or a site visit — the same
test either record already answers, so there's no separate roster to
maintain. `admin.html`'s site editor shows and adds to a site's log;
`officer.html` shows the log for whichever site the officer's current shift
or patrol visit puts them at, with a box to add a note before they hand over.

## Fuel logs

A fill-up form against a vehicle — odometer, litres, cost, an optional
receipt photo, and who was driving. Anyone can log one (whoever's at the
pump), control can review or delete a mistaken entry from `admin.html`'s
vehicle editor, and an officer with a vehicle assigned to them gets a "Log
fuel" button next to it in `officer.html`. Logging one with an odometer
reading also bumps the vehicle's own mileage field, so it stays current
without a separate manual update.

## Vehicle maintenance logs

A service history against a vehicle — description, cost, odometer, and when
it's next due — logged by control from `admin.html`'s vehicle editor (not
something an officer does themselves). Logging one with a next-due date
updates the vehicle's own `service_due_at`, and the Vehicles table flags one
that's overdue in red rather than making you open each record to check.

## Beats

A named patrol route within a site — "Perimeter", "Car park sweep" — for
sites where one checklist doesn't describe the work. Purely optional: a site
with no beats behaves exactly as before. `admin.html` has a Beats tab (site,
description, an ordered list of waypoints); a patrol schedule can optionally
reference one, and any site visit it generates inherits it. Control room and
`officer.html` show the beat name alongside the site wherever a visit is
displayed.

## Guard tour checkpoint scanning

Each waypoint on a beat doubles as a checkpoint: its own id is the scan
code, printed as a QR code (`admin.html`'s Beats tab — "Print all as QR
codes") or written to an NFC tag from any device whose browser supports Web
NFC ("Write NFC tag", quietly disabled elsewhere). `officer.html` shows a
visit's checkpoints as a checklist and scans against whichever the site has
— QR via the camera (`BarcodeDetector`), NFC (`NDEFReader`), or the printed
fallback code typed by hand — each offered only where the device actually
supports it. Scanning the wrong tag is rejected client-side before it ever
reaches the server. `POST /api/site-visits/:id/checkpoint-scan` records who,
when, and (if available) where; control sees live scan coverage ("3 / 5
scanned, missing: Loading bay") on the visit, and a completed visit's
resolution report includes the same summary as proof of coverage.

## Client portal

The first genuinely external-facing role: a customer logs in and lands on
`client.html`, not any internal terminal. `CLIENT` is a real role but
deliberately **not** part of `ALL` — the constant most of the API is gated
on — because `ALL` predates this role and assumed "authenticated" meant
"staff". A new role landing in it by default would hand an outside party
every site, every person, every form submission; `routes-client.js` is the
only place CLIENT gets anything, and every route re-checks the caller's own
`client` record's `site_ids` rather than trusting an id the request supplies
— a site that isn't theirs is a 404, not a 403, same reasoning as a
restricted form submission elsewhere in this codebase.

A client sees, for their own sites only: open jobs and patrol visits
(status only — no personnel names, no keyholder, no internal notes), the
same service-report numbers admin gets (alarm response against the site's
SLA, patrol visit counts), uploaded documents (contracts and site
paperwork, PDF/PNG/JPEG, magic-byte checked like every other upload in this
codebase), and a two-way request channel — they raise one, control
acknowledges and closes it from `admin.html`'s Clients tab. Admin manages
client organisations and which sites each can see from the same tab, and
grants a CLIENT-role login from the Accounts tab exactly like a field-user
or MDT login.

`broadcast()` treats a CLIENT socket as an external trust boundary: it
never gets the default "untargeted reaches everyone" delivery and never
gets the control-role bypass, only a message explicitly scoped with
`siteIds` that includes one of its own sites. Nothing broadcasts with
`siteIds` yet, so `client.html` polls rather than subscribing — safe by
construction, live-push is a v2 item. The client-facing service report also
deliberately omits the incident list: `routes-forms.js`'s `canRead()` is
"control roles, the filer, or a named grant", and widening that to include
an owning client is a real change to that file's security invariant,
worth its own careful pass rather than a bolt-on here.

## Site documents — assignment instructions and maps

`documents` (the same collection the client portal's contracts live in)
gained two versioned types: `ASSIGNMENT_INSTRUCTIONS` and `SITE_MAP`, each
keyed by a `title` so a site can carry several distinguishable maps
("Perimeter", "Building layout") or just one set of instructions.
Uploading a new file under the same site, type and title (case-insensitive)
archives the one before it (`is_current: false`) rather than replacing it —
the archive is kept, never deleted, with each row's own `version` number.
`CONTRACT`/`SITE_DOCUMENT` keep their original, independent-upload
behaviour; versioning only applies to the two new types.

`GET /api/sites/:id/documents` moved from `CONTROL`-only to every staff
role, with the access split made inside the handler: a control role sees
everything (optionally filtered by `?type=`/`?current=1`), while anyone
else only ever sees the *current* assignment instructions and maps for a
site they're actually posted to right now — reusing
`assertPassdownAccess()`, the same "have you been posted here" check
passdown logs already use. A contract, an archived version, or another
site's documents are never reachable this way, by role or by guessing an
id directly (a type/currency mismatch on `GET /api/documents/:id/file` is a
404, not a 403 — the same "don't confirm it exists" reasoning the client
portal's `ownedSite()` already uses). The client portal's own document
routes got the mirror-image fix: `ASSIGNMENT_INSTRUCTIONS`/`SITE_MAP` are
explicitly excluded, so a client never sees the operational detail staff
work from for their own site.

A document's file is now served streamed (`fs.createReadStream` piped
straight to the response) rather than read whole into memory first — the
one addition to the request dispatcher itself, gated behind a handler
returning `__stream` instead of `__body` so every other route's buffered
response is unaffected. An assignment-instructions or site-map file opens
`inline` (view in the browser) where a contract still forces `attachment`
(download), and carries a week-long `Cache-Control` — each version's file
is immutable once uploaded, a new version is always a new row and a new
file, so there's nothing for a long cache lifetime to go stale against.

`admin.html`'s site editor shows the current version of each title
prominently with its earlier versions collapsed underneath, and site maps
as a thumbnail gallery; opening a map image zooms and pans in a small
built-in viewer (wheel to zoom, drag to pan), while a map or instructions
PDF opens in the browser's own PDF viewer — already zoomable and
pannable — rather than reimplementing one. `officer.html` gets the
read-only side of this: a "Site documents" button on whatever job or
patrol visit an officer currently has, open to whatever the API already
scopes them to see.

## Multi-branch

A staff-visibility split, not a tenancy wall like the client portal: a
`SUPERVISOR`, `FIELD_USER` or `MDT_USER` sees only their own branch's
sites, personnel, vehicles and assets (and the jobs/patrol visits at those
sites) — for day-to-day work and reporting, not as a security boundary.
`DISPATCHER` and `SYSTEM_ADMIN` always see every branch, no exceptions:
company-wide oversight and cross-branch dispatch stay with them, by
explicit decision when this was scoped.

It's opt-in per record and per account, so an install that never touches
branches sees no behaviour change: a site/person/vehicle/asset with no
`branch_id` is shared and visible to everyone regardless of role, and a
scoped-role account with no `branch_id` of its own also sees everything.
`admin.html`'s new Branches tab creates branches and shows how many sites,
personnel, vehicles and assets are on each; every other editor (Site,
Personnel, Vehicle, Asset, and the Accounts form for a
Supervisor/Field/MDT account) gets a Branch picker.

Deliberately **not** scoped, on purpose: MDTs (not one of the named
resources this was built for), and the emergency feed and audit log on
`GET /api/state` (hiding either from any signed-in internal role would be
a safety/oversight regression, not a feature — the RESTRICTED-forms
invariant already keeps the truly sensitive content out of the log
itself). A job or patrol visit with no `site_id` — an ad-hoc job raised
with a location string, say — has nothing to scope it to, so it reads as
shared too.

## Live tracking (foot officers)

Vehicle terminals have always reported continuous GPS; a foot officer's own
position was, until now, only ever captured as a single fix the moment they
raised an emergency — a materially different, much less intrusive, privacy
position (see `docs/PRIVACY.md`). This closes that gap, but strictly
opt-in at the deployment level: set `FOOT_TRACKING=on` and it's live;
leave it unset (the default) and `POST /api/personnel/:id/location`
refuses outright, not just quietly unused — a half-built feature nobody
enabled by accident is worse than no feature.

Once on, `officer.html` reports a fix roughly every 30 seconds — an
interval poll via `getCurrentPosition`, not the browser's own
continuous-tracking `watchPosition`, deliberately costing one fix at a
time rather than draining a phone in someone's pocket all shift — but only
while that officer is actually clocked in, stopping the instant they clock
out or sign out. A visible strip on `officer.html` says plainly that their
location is being shared for as long as it actually is; `docs/PRIVACY.md`
has the staff-notice wording and the legitimate-interest-assessment
reminder that has to happen before an operator sets the flag, not after.

A reported position does two things, mirroring exactly what an MDT's own
location report already does: `control.html`'s map shows the officer as a
live dot (their own marker kind, so clicking one opens the personnel
detail panel, not the MDT one), and `checkAutoProgressForPerson()` — the
foot-officer twin of the existing `checkAutoJobProgress()` — advances
whichever of their own active job or patrol visit they're assigned to
through ACKNOWLEDGED → EN_ROUTE → ON_SCENE by proximity, without anyone
touching a button, the same arrival/movement thresholds a vehicle already
gets. A person can only ever report their own position (`FIELD_USER`,
matching `personnel_id`) — there's no legitimate reason for anyone else to
phone in someone else's GPS fix, unlike an MDT's console-operable
terminal. Erasing someone's location history
(`POST /api/personnel/:id/erase-location-history`) also clears their
last-known dot, not just the history behind it.

## Training

A hybrid of the SIA/DBS "record what happened" pattern and actual in-app
delivery, for a variable admin-defined set of courses rather than two
fixed checks. `admin.html`'s Training tab defines a course — name,
category, an optional renewal period, and either nothing else (a
classroom session or toolbox talk an admin logs after the fact from a
person's own record) or `material` plus a short multiple-choice
assessment an officer takes on `officer.html` itself.

`training_records` is append-only, like `dial_log` — a completion is
never mutated in place, so a retake keeps its own history — and the
current status per person per course (`never` / `overdue` / `expiring` /
`ok`) is always derived from the most recent one, the same "make the gap
visible" shape as `personnelCompliance()`. A course with no renewal period
doesn't expire: a one-time induction stays `ok` forever once done, there
is nothing to renew. Scoring happens server-side only — `correct_index`
never reaches an officer taking the assessment, only `admin.html`'s course
editor, so there is no answer key to read out of the page even by
inspecting what the client received. A course is retired via `active:
false`, never deleted, since `training_records` must always be able to
resolve their `course_id`; editing a course's content in place, with no
`form_definitions`-style versioning, is a deliberate v1 simplification —
a quiz's wording changing later doesn't carry the audit-fidelity stakes a
restricted safeguarding report does.

## Applicant tracking

A recruitment pipeline for candidates before they become staff — genuinely
separate from training records, which are about people who already are.
Pure back-office HR data: a `FIELD_USER`/`MDT_USER` has no legitimate
reason to see who's applying for a job, so `routes-applicants.js` gates
the whole surface to control roles, not `ALL`, and branch-scopes it the
same way personnel/vehicles/sites already are.

An applicant moves through `APPLIED → SCREENING → INTERVIEW → OFFER`
fairly freely — `admin.html`'s Applicants tab lets you set any stage, add
timestamped notes (append-only, always attributed to who wrote them,
never edited or removed), schedule an interview, and upload a CV
(magic-byte checked, same as every other upload in this codebase).
Rejecting one requires a reason.

`HIRED` is different on purpose: it's never a plain stage change. It only
happens through `POST /api/applicants/:id/hire` — the actual point of the
feature — which creates a real `personnel` record from the applicant's
details (name, contact info, `role_applied_for` falling back into `rank`)
so everything else in CCCS — compliance tracking, training, branch
assignment, the rota — picks them up from that moment on like any other
member of staff. It deliberately does not create a login; that stays a
separate, explicit decision from the Accounts tab, the same as it already
is for any new personnel record. Hiring is blocked for a candidate
already marked `REJECTED` or `WITHDRAWN` — move them back to an earlier
stage first, so hiring never overrides a decision that was already made
about them, only reopens it — and a `HIRED` applicant can't be deleted,
since the personnel record it became still references that history.

## Leave management

A personnel record now carries `employment_type` — `EMPLOYED` or
`SUBCONTRACTOR`, defaulting to `EMPLOYED` — because leave entitlement is
an employed concept: a subcontractor invoices for their own time under
their own arrangement and was never accruing a UK-style statutory
entitlement through this business. Every route in `routes-leave.js`
refuses to create or approve a request against a subcontractor, checked
at each entry point rather than trusted from one place, the same
repeated-check convention `routes-client.js` already uses for site
ownership.

The balance itself (`leaveBalanceForPerson()` in `server.js`, embedded in
`publicPersonnel()` next to `compliance` and `training`) is always
derived, never stored: `allowance` (a per-person override, or the
statutory-minimum default of 28 days) minus `taken` (the sum of `days`
across a person's `APPROVED` `ANNUAL` requests whose `start_date` falls in
the current leave year). Sick, unpaid and other leave are logged the same
way but deliberately never touch it — they aren't annual leave. The leave
year defaults to the calendar year (`LEAVE_YEAR_START_MONTH`), a
deliberate v1 default rather than a promise it fits every contract, the
same spirit as `DBS_RECHECK_DUE_DAYS`.

Requests are append-only and self-service, mirroring the applicant and
client-request pipelines: an officer requests their own leave from
`officer.html` (`POST /api/leave-requests` silently ignores any
`personnel` a `FIELD_USER` names — their own record is always used, never
honoured from the body), control approves or rejects from `admin.html`'s
Leave tab, and only the requester (while still `PENDING`) or control can
touch a request after that — a rejection requires a reason. An `MDT_USER`
has no legitimate reason to file or see leave requests and is refused
outright, the same access-control shape as the rest of this codebase's
control-vs-field split.

The rota shows, but never blocks on, a conflict: `publicShift()` carries
an `on_leave_conflict` flag (`onApprovedLeave()` — does an `APPROVED`
request cover this shift's calendar day) that `rota.html` renders as an
amber-flagged chip. Creating or keeping a shift against approved leave is
never refused — this is a warning for a human to notice and resolve, not
a rule the system enforces, the same "warn, don't block" philosophy the
foot-tracking auto-progression already follows.

## Working without a link

A van drops into a dead spot mid-job. The MDT and officer terminal keep working: whoever's on it
can still acknowledge, change status, and message control. Those writes are saved
on the device and replayed in order when the link returns, each carrying an
idempotency key so a lost reply cannot produce a duplicate acknowledgement.

What the interface will not do is pretend. The MDT shows a clear "no link to
control" bar with a count of what is waiting, and any status set
offline is marked *unconfirmed* until control has actually seen it. Reads are
never faked — showing stale data as live is how a controller ends up
dispatching to a unit that cleared twenty minutes ago.

The offline queue is visible and under the user's control: it can be flushed
on demand or discarded with a warning that discarded work never reaches
control.

## GuardM8 integration

`POST /api/integrations/guardm8/jobs` lets GuardM8 (Echelon's separate
guarding/alarm-receiving product) push an alarm straight in as a dispatchable
job, authenticated with a shared secret (`GUARDM8_SECRET`) rather than a user
session. `external_ref` lets GuardM8 retry a send without creating a
duplicate job.

## Deployment

On Proxmox — an LXC container, reverse-proxy config for nginx or Caddy, backups
off the box: [`deploy/proxmox.md`](deploy/proxmox.md).

On a fresh Debian or Ubuntu server:

```bash
bash deploy/install.sh cccs.yourdomain.com
```

This installs Node 22 and Caddy, creates a service account, generates secrets
into `/etc/cccs/cccs.env` (root-only, never printed or committed), installs a
hardened systemd unit, obtains a TLS certificate, and schedules nightly
backups with 30-day retention.

TLS is not optional: browsers block geolocation access on plain HTTP, so
without a certificate position reporting silently stops working.

`deploy/backup.sh` uses SQLite's own backup so it is safe to run against a live
database — do not just copy the file.

## Recommended next steps toward production

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full sequence, scoped for one person.

1. **Persist.** Apply `db/schema.sql`, put a query layer behind the existing domain functions, add migrations. The read models (`publicJob`, `publicPersonnel`) become queries; nothing above them changes.
2. **Port to TypeScript and React.** Share a `packages/types` module between server and clients so event payloads are checked at both ends — the WebSocket contract is the highest-value thing to type.
3. **Scale out.** Move `broadcast` behind Redis pub/sub so multiple API nodes share one event bus.
4. **Harden.** TLS termination, SSO/OIDC for users, token revocation, structured logging, metrics and alerting.
5. **Build out ops functionality.** Scheduled site visits/patrols, HR rota, asset tracking, and the extended roadmap in `docs/ROADMAP.md`.
6. **Before any operational use:** independent security review, resilience and failover testing, and a formal safety case for the welfare/emergency path — it fails when someone is waiting for help; it needs to be engineered accordingly.

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

**Control room** (`public/control.html`) — dark console, three live columns: personnel/MDT resources with status pills, the operational map, and open jobs; below that the event timeline with a live filter and a resource detail panel. Emergencies push a red banner across the top with acknowledge, locate and reset in one row. Pending callback requests get their own bar.

**Officer terminal** (`public/officer.html`) — the individual-login, personnel-facing terminal: emergency button, welfare timer, current job with on-scene checklist and photo capture, status progression (accept, en route, on scene, completed), and messaging with control.

**MDT** (`public/mdt.html`) — a vehicle terminal: terminal identity down the left, the current job filling the right with full incident detail and the status progression as buttons.

The map is a Leaflet-based renderer (`CCCS.makeMap`) exposing a `render(units, jobs, onPick)` interface.

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
  control.html       dispatcher console
  officer.html       individual officer terminal
  mdt.html           mobile data terminal
  app.js             shared client: auth, REST, WS bus, Leaflet map
  console.css        design tokens and status colours
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

## Asset tracking

Vehicles are a real, editable record (`admin.html`'s Vehicles tab) — make,
model, mileage, service/insurance due dates, condition, status, and an
optional assigned person — rather than the bare registration-and-type stub
they started as. A vehicle can't be deleted while an MDT or a person is
still linked to it. A new Assets tab covers everything else worth tracking
— equipment, uniform, keys, devices — each with an optional unique tag,
assignable to a person or a site, with a status (in use, in store, lost,
retired) and a "checked" timestamp you can bump on inspection.

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

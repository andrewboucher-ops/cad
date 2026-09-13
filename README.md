# CCCS — Critical Communications, Dispatch & Control-Room System

A push-to-talk radio, MDT and control-room dispatch platform for commercial security operations: ISSIs, call signs, talkgroups, real WebRTC audio, floor-controlled PTT, alarm-response dispatch against contracted sites, lone-worker welfare timers, emergency alerting, GPS tracking, dial-9 telephony through your PBX, and a persistent audit trail.

> **Scope.** Built for commercial security dispatch — patrols, keyholding, alarm response, static guarding. It is not a 999 system, does not connect to Airwave or TETRA, and should not be relied on as the sole means of summoning emergency services. No proprietary protocols or interfaces are reproduced.

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

Open <http://localhost:4000>. Tests: `npm test` — 75 tests, no network needed. They cover the server over real HTTP and WebSocket sockets, and drive the actual client code in `public/app.js` for the offline queue and key bindings.

### Demo accounts

| Username | Password | Role | Opens |
|---|---|---|---|
| `dispatcher` | `dispatch123` | DISPATCHER | control room |
| `supervisor` | `super123` | SUPERVISOR | control room + emergency reset |
| `admin` | `admin123` | SYSTEM_ADMIN | control room + radio/user creation |
| `radio101` | `radio123` | RADIO_USER | patrol P101, ISSI 234100001 |
| `radio102` | `radio123` | RADIO_USER | patrol P102, ISSI 234100002 |
| `radio103` | `radio123` | RADIO_USER | patrol P103, ISSI 234100003 |
| `mdt001` | `mdt123` | MDT_USER | MDT-001 |

These are deliberately weak demo credentials for a POC. Replace them before the system leaves your laptop.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_SECRET` | generated per boot (with a warning) | HMAC key for session tokens |
| `PORT` | `4000` | HTTP + WebSocket port |
| `SIMULATION` | `on` | set `off` to freeze simulated GPS movement |
| `TOKEN_TTL_MS` | `28800000` | session lifetime |
| `DATA_FILE` | `./data/cccs.db` | SQLite database file |
| `PERSISTENCE` | `on` | `off` runs entirely in memory |
| `FLUSH_MS` | `1000` | write-through interval |
| `WELFARE_TICK_MS` | `5000` | how often welfare timers are evaluated |
| `WELFARE_WARN_S` | `60` | warning given to the officer before a timer expires |
| `SEED_FILE` | `./seed.json` | your fleet definition, read on first boot only |
| `RETENTION` | `on` | `off` disables automatic deletion (you had better have a reason) |
| `RETAIN_LOCATIONS_DAYS` | `31` | movement history |
| `RETAIN_AUDIT_DAYS` | `365` | audit trail |
| `RETAIN_COMMS_DAYS` | `180` | call and message metadata |
| `RETAIN_JOBS_DAYS` | `730` | closed jobs |
| `ICE_SERVERS` | Google STUN | JSON array of WebRTC ICE servers; add TURN for mobile networks |
| `PBX_MODE` | `simulated` | `asterisk` to talk to FreePBX over ARI |
| `PSTN_PREFIX` | `9` | outside-line prefix on the radio dial pad |
| `ARI_URL` / `ARI_USER` / `ARI_PASSWORD` | — | Asterisk REST Interface credentials |
| `PBX_OUTBOUND_CONTEXT` | `from-internal` | FreePBX context for outbound routes |
| `PBX_SECRET` | — | shared secret the dialplan sends on inbound calls |

No secrets are hardcoded. If `AUTH_SECRET` is unset the server generates an ephemeral one and warns; sessions then drop on restart.

### Your own fleet

Copy `seed.example.json` to `seed.json`, put your sites, call signs, radios and
officers in it, and start the server. It is read on first boot only — once the
database has content the file is ignored, so it cannot overwrite anything live.
Placeholder passwords, weak passwords, unknown roles and duplicate ISSIs are all
refused rather than silently accepted.

With no `seed.json` present you get the demo fleet below.

### Demo seed data

Loaded automatically at boot, no migration step needed.

Loaded on first boot only — after that the database is the source of truth.

- Radios `234100001`→P101, `234100002`→P102, `234100003`→P103, `234100004`→P104, `234100005`→M201, `234100006`→M202
- MDTs `MDT-001`→P101, `MDT-002`→P102, `MDT-003`→P103
- Talkgroups PATROL 1, PATROL 2, SUPERVISORS, CONTROL, INCIDENT
- Vehicles VAN-101, VAN-102, VAN-103, CAR-201; officers attached to call signs
- Sites under contract: Meridian Business Park, Carlton Retail Centre, Northgate Distribution, Ashcroft House — each with an address, position and keyholder

To start from your own data instead: delete `data/cccs.db`, edit `seed()` in `server.js`, restart.

---

## A. System architecture

```
 browser consoles                node process                     state
 ────────────────                ────────────                     ─────
 control.html ─┐            ┌─ REST router (/api/*)  ──┐
 radio.html   ─┼─ HTTP ────▶│    auth · RBAC · rate    │──▶ domain services ──▶ store
 mdt.html     ─┘            │    limit · validation    │      (radios, calls,      │
               │            └──────────────────────────┘       jobs, emergency)    │
               └─ WS /ws ──▶ connection registry ◀── broadcast(event, targeting) ◀──┘
```

Every state change follows one path: an HTTP request mutates the store through a domain function, that function writes an audit row, and then fans the change out over WebSockets. Consoles never poll — they load one snapshot from `GET /api/state` on connect and are event-driven from then on. That keeps the control room, radios and MDTs consistent by construction: there is no second code path that can update one surface and not the others.

**Stack deviation, stated up front.** The brief asked for React + TypeScript, Node + TypeScript, and PostgreSQL. This POC is Node with zero dependencies, vanilla ES modules in the browser, and an in-memory store shaped exactly like the SQL schema in `db/schema.sql`. The reason is that it had to be verifiably runnable and testable in an offline environment — no `npm install`, no database daemon, no CDN. Everything you can do in the UI, the test suite does over real sockets. The trade is real: you lose type checking, component reuse and persistence. The migration path is deliberately short, and the interfaces that matter (`publicRadio`, `broadcast`, the domain functions) are already the seams you would cut along. See *Next steps*.

## B. Database schema

Full DDL with foreign keys, indexes and enums is in [`db/schema.sql`](db/schema.sql). Core relationships:

```
callsigns ─┬─< radios >── talkgroup_members >── talkgroups
           ├─< mdts                              │
           ├─< personnel                         └── floor_holder_radio_id
           └─< job_assignments >── jobs
radios ─< locations · radio_status_history · emergency_events
communications ─< communication_participants
messages · audit_logs · users · vehicles
```

The call sign is the operational identity, and it is the join point: a call sign may hold several radios, several MDTs, a vehicle and multiple crew. Jobs are dispatched *to call signs*, which is what makes "dispatch to A101" reach the handheld, the vehicle radio and the MDT in one action. `radios.issi` carries a unique constraint plus a format check, so a duplicate ISSI is rejected by the database and not only by application code.

## C. UI architecture

**Control room** (`public/control.html`) — dark console, three live columns over a communications band: resources with status dots, the operational map, and open jobs; below that the event timeline with a live filter, a resource detail panel, and a persistent action bar (call, group call, message, talkgroups, assignments, console PTT). Emergencies push a red banner across the top of the console with acknowledge, call, locate and reset in one row.

**Radio** (`public/radio.html`) — a handset: call sign and ISSI large, talkgroup and status under it, an oversized PTT that also binds to the space bar, then private call, status, job, talkgroup, messages, position, and a separate emergency key. Incoming calls and jobs take over the alert slot directly under the screen.

**MDT** (`public/mdt.html`) — a vehicle terminal: terminal identity down the left, the current job filling the right with full incident detail and the status progression (accept, en route, on scene, transporting, completed) as buttons.

The map is a hand-built SVG renderer (`CCCS.makeMap`) rather than Leaflet, so the POC works with no internet connection. It exposes a `render(units, jobs, onPick)` interface — swapping in Leaflet/OpenStreetMap means replacing that one function.

## D. Real-time architecture

One WebSocket endpoint, `/ws?token=…`, authenticated by the same signed token as the REST API; an unauthenticated upgrade is refused at the handshake (covered by a test). On connect a client identifies itself with `radio.attach` or `mdt.attach`; the server binds that device to the socket, marks it on air, and treats socket loss as the device going OFFLINE.

Client → server: `radio.attach`, `mdt.attach`, `radio.ptt_start`, `radio.ptt_release`, `ping`.

Server → client: `radio.connected`, `radio.status_changed`, `radio.location_changed`, `radio.ptt_started`, `radio.ptt_released`, `ptt.denied`, `call.incoming`, `call.accepted`, `call.rejected`, `call.ended`, `job.created`, `job.dispatched`, `job.assigned_to_you`, `job.acknowledged`, `job.status_changed`, `emergency.activated`, `emergency.acknowledged`, `emergency.resolved`, `message.received`, `event.logged`.

Targeting is explicit: `broadcast(type, payload, { radioIds, mdtIds })` sends to the named devices, and control-room roles receive everything so the console stays a complete picture. Private call signalling only reaches its participants plus control.

PTT floor control lives on the talkgroup record: one holder at a time, console or radio. A second transmitter gets `ptt.denied` naming the current holder rather than silently colliding. Releasing the floor, or dropping the socket, frees it.

## E. Project structure

```
server.js            REST API, WebSocket server, domain logic, seed data
openapi.json         API documentation (served at /api/openapi.json)
public/
  index.html         sign-in and console launcher
  control.html       dispatcher console
  radio.html         radio terminal simulator
  mdt.html           mobile data terminal
  app.js             shared client: auth, REST, WS bus, SVG map
  console.css        design tokens and status colours
db/schema.sql        target PostgreSQL schema
test/cccs.test.js    18 tests including a hand-rolled WebSocket client
Dockerfile · docker-compose.yml · .env.example
```

For a production split this becomes `apps/{control-room,radio,mdt}`, `services/{api,realtime}`, `packages/{database,types,ui,shared}`. `server.js` is already organised in those bands and is the natural cut line.

---

## Demonstration script

Open four browser windows. The whole sequence works without touching any stored data by hand.

1. **Control room** — sign in as `dispatcher`, choose Control room.
2. **Radio A101** — new window, sign in as `radio101`. It registers automatically; A101 turns green in the control room within a second.
3. **Radio A102** — new window, `radio102`.
4. **MDT-001** — new window, `mdt001`.

**Status** — on A101 press *Status* → `EN ROUTE`. The resource list, detail panel and event timeline in control all change immediately.

**Private call, control → radio** — in control press *Call radio*, pick A101, *Start call*. A101 shows INCOMING PRIVATE CALL with answer and decline. Answer: both sides go connected. *Clear call* on either end ends it and writes the duration to the log.

**Private call, radio → radio** — on A101 press *Private call*, dial `234100002`, *Call*. A102 rings. Decline it and A101 sees `DECLINED`. Calling a radio that is not on air returns a clean "not on air" message rather than ringing into nothing.

**Group call** — in control press *Group call*, choose AMBULANCE 1, start. Every connected member of the talkgroup rings at once. You can instead multi-select individual radios.

**PTT** — on A101 hold the PTT button (or the space bar). A101 reads TRANSMITTING, A102 reads RECEIVING A101, and the control room action bar shows `TX A101 · AMBULANCE 1`. Hold PTT on A102 at the same time and it is refused with CHANNEL BUSY naming A101. Control can transmit into a talkgroup from the same bar.

**Dispatch a job** — in control press *Create job*, set priority RED, a location, select A101 in the resource list, *Create and dispatch*. A101 gets a NEW JOB card; MDT-001 gets the full incident because MDT-001 is assigned to call sign A101. Press *Accept* on either: control logs `A101 ACKNOWLEDGED`. Progress the job through en route, on scene and completed from the MDT; the radio's status follows and the map marker moves toward the incident.

**Emergency** — on A101 press *EMERGENCY* and confirm. The control room raises a red banner with call sign, ISSI, position and time, sounds a tone, turns the resource red on the list and on the map, and offers acknowledge, call radio, view location and reset. Acknowledge, then reset; A101 sees both.

**Map and assignments** — click any resource on the map for its ISSI, vehicle, job, speed, battery, signal and last fix. *Assignments* moves radios and MDTs between call signs live; *Talkgroups* creates them and moves radios in and out.

---

## Building the handset app

`.github/workflows/android.yml` builds the APK on GitHub's runners, so no machine
of yours needs an Android SDK. Every push to `main` produces a debug APK as a
build artefact; pushing a `v*` tag produces a signed release and attaches it to
the GitHub release.

Set these first, under Settings → Secrets and variables → Actions:

| Name | Kind | What |
|---|---|---|
| `APP_SERVER_URL` | variable | `https://cccs.yourcompany.co.uk` — where the app connects |
| `ANDROID_KEYSTORE_BASE64` | secret | `base64 -w0 cccs-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | secret | keystore password |
| `ANDROID_KEY_ALIAS` | secret | usually `cccs` |
| `ANDROID_KEY_PASSWORD` | secret | key password |

Only the variable is needed for debug builds. The workflow deletes the decoded
keystore from the runner whether the build succeeds or fails.

`.github/workflows/test.yml` runs the full suite on every push and confirms the
server boots and authenticates.

## Staff privacy and data retention

This system tracks employees' locations continuously. Retention is enforced in
code — a sweep every six hours deletes location history after 31 days, call and
message metadata after 180, and the audit trail after a year. `GET /api/retention`
shows the policy and the current record counts; the `RETAIN_*_DAYS` variables
change them.

An officer's movement history can be erased on request with
`POST /api/radios/:issi/erase-location-history` without touching the job record
the business needs to keep.

[`docs/PRIVACY.md`](docs/PRIVACY.md) covers what you owe staff before go-live —
the notice, the legitimate interest assessment, the DPIA — and includes a draft
notice you can adapt. It is not legal advice; have someone qualified read it.

## Security

Implemented: scrypt password hashing, HMAC-signed session tokens with expiry, constant-time signature and password comparison, role-based authorisation on every route, ownership checks (a radio user can only act as its own radio, can only update jobs assigned to it, and cannot acknowledge its own emergency), WebSocket authentication at the handshake, request body size limits, input validation on ISSIs, statuses and priorities, per-IP rate limiting, path traversal protection on static files, and an audit row for every meaningful action including failed logins.

Not implemented, and needed before any real deployment: TLS, refresh tokens and revocation, CSRF defence for cookie-based sessions, account lockout, per-role rate limits, secrets management, and penetration testing.

## Known limitations

- **Audio is a WebRTC mesh.** Real media, correct for one talker to a handful of listeners, which is what PTT is. Past roughly a dozen listeners per talkgroup you need an SFU — `publishTo` in `public/app.js` is the single function to swap. You also need a TURN server before this works reliably on mobile networks.
- **The PBX gateway defaults to a simulated driver** with no media. It drives the full call lifecycle so dial-9 can be demonstrated and tested without a PBX. The Asterisk/ARI driver in `pbx.js` has real code paths but has never been run against a live PBX — see `docs/PBX-FREEPBX.md`.
- **The Android project has never been compiled.** No SDK or network was available when it was written. It is source to build, not a binary to install — see `android/README.md`.
- **Single process.** No Redis pub/sub, so this does not scale past one node or survive failover. For one control room that is the right trade; it stops being right the day you open a second.
- **Offline queue holds writes only.** Work done without a link is saved and replayed, but the device cannot see new jobs or status changes while it is down, and the queue lives in browser storage — clearing app data discards it.
- **Simulated GPS.** Positions are generated by a server-side movement model until real devices report. Set `SIMULATION=off` once they do.
- **Custom SVG map** rather than real cartography.
- **Browser tokens live in `sessionStorage`**, which is acceptable for a POC and not for production.
- Call "no answer" is a fixed 30-second timeout; there is no call queueing, late entry, or priority pre-emption between calls.

## Storage

State lives in memory for speed and is written through to SQLite (`node:sqlite`,
built into Node 22 — still no dependencies). Restart the service and every radio,
job, site, message and audit row comes back; devices and open calls are correctly
reset to disconnected rather than pretending they survived.

SQLite rather than PostgreSQL is a deliberate choice for a single-operator
commercial security setup: one control room and tens of radios is well within
what SQLite in WAL mode handles, and the database being one file you can copy is
worth more to you than anything Postgres adds. `db/schema.sql` remains the
Postgres target if you outgrow it; `store.js` is the only file that changes.

A hard crash loses at most one flush interval — a location fix or two. Emergencies,
welfare alarms and audit rows flush immediately.

## Lone worker welfare timers

The feature your insurer and your lone-worker policy will ask about. An officer
presses *Welfare*, picks an interval and notes what they're doing. They get an
audible warning before it expires; if no check-in arrives, control gets an alarm
carrying the call sign, the last known position, the time, and what the officer
said they were doing. The control-room banner treats it like an emergency because
operationally it is one. Checking in clears an alarm that has already fired.

Timers are evaluated server-side, so they survive the handset locking, the app
being backgrounded, or the radio dropping off the network — which is exactly when
you need them to work.

## Sites and alarm response

Jobs can be raised against a site under contract and inherit its address, position
and keyholder details, so an alarm activation becomes two clicks rather than
retyping an address at 3am. Incident types are pre-populated for security work:
alarm activation, intruder on site, keyholding response, lock and unlock, patrol
visit, fire alarm, vandalism, trespass.

## Working without a link

A van drops into a dead spot mid-job. The MDT and radio keep working: the officer
can still acknowledge, change status, and message control. Those writes are saved
on the device and replayed in order when the link returns, each carrying an
idempotency key so a lost reply cannot produce a duplicate acknowledgement.

What the interface will not do is pretend. The MDT shows a clear "no link to
control" bar with a count of what is waiting, and any status the officer sets
offline is marked *unconfirmed* until control has actually seen it. If the
terminal is reloaded with no signal it shows the last job it saw, labelled as not
confirmed. Reads are never faked — showing stale data as live is how a controller
ends up dispatching to a unit that cleared twenty minutes ago.

The queue is visible and under the officer's control: *Settings → Queued for
sending* lists every waiting item, retries on demand, and can discard the queue
with a warning that discarded work never reaches control.

## Hardware buttons

Rugged handsets disagree about which keycode the side button sends, so bindings
are learned on the device rather than compiled in. The Android shell forwards
every key it sees to the web layer; *Settings → Learn* captures the next press and
binds it. A new handset model means pressing a button, not a new APK.

- **Push to talk** — defaults to the space bar, rebindable to any physical key.
- **SOS** — unbound by default, and must be *held*, not tapped. The hold time is
  configurable from one to five seconds, with an audible warning while it arms and
  a cancel if released early. An SOS raised by a pocket costs you a real response;
  a tap-to-send button will do that weekly.
- If the radio has no link when SOS fires, the alert is queued and sent the instant
  the link returns — and the officer is told which of those happened.

Volume, power, back and home stay with Android, so the app can never trap someone
or stop them turning the radio down.

## Deployment

On Proxmox — an LXC container, reverse-proxy config for nginx or Caddy, backups
off the box: [`deploy/proxmox.md`](deploy/proxmox.md).

On a fresh Debian or Ubuntu server:

```bash
bash deploy/install.sh cccs.yourdomain.com
```

On a fresh Debian or Ubuntu server that installs Node 22 and Caddy, creates a
service account, generates secrets into `/etc/cccs/cccs.env` (root-only, never
printed or committed), installs a hardened systemd unit, obtains a TLS certificate,
and schedules nightly backups with 30-day retention.

TLS is not optional: browsers block microphone access and WebRTC on plain HTTP, so
without a certificate the radios have no audio.

`deploy/backup.sh` uses SQLite's own backup so it is safe to run against a live
database — do not just copy the file. `deploy/turnserver.conf` is a coturn config
for the TURN server you will need before trusting audio on mobile networks.

## Working with no signal

A van drops into a basement car park mid-job. Everything the officer does —
accepting a job, changing status, checking in, sending a message, raising an
emergency — is held on the device and replayed in order when the link returns.
Each held write carries an idempotency key, so a retry after a lost reply is
answered rather than applied twice: no duplicate job acknowledgements, no second
alarm.

Reads deliberately fail loudly instead of showing cached data. A controller
dispatching to a unit that cleared twenty minutes ago is a worse outcome than a
screen that admits it has no link.

The radio and MDT both show a count of what is waiting, and the MDT marks a job
"unconfirmed — waiting for link" so the officer knows control has not seen it yet.

## Hardware keys — talk and SOS

Rugged handsets disagree about which keycode the side button sends, so nothing is
compiled in. The Android shell forwards every key press to the web layer and takes
no view on what it means; Settings on the radio lets the officer press the key they
want and binds whatever it actually sends. A different handset next year is a
button press, not a new build.

**Talk** defaults to the space bar in a browser and is learned on a device. **SOS**
starts unbound. The keypad follows common PMR convention:

| Hold | Does |
|---|---|
| **1** | Request a call from control |
| **#** | Priority call request — a separate, louder queue at the console, one step below SOS |
| **\*** | Lock the keypad and touchscreen (hold again to unlock) |
| **0** | Return the last call, in or out, radio or telephone |
| **2** | Talkgroup selector |
| **3** | Send a status code |
| **5** | Covert mode |
| **8** | Send a position report |

**Tap** a digit and it speed-dials whatever is stored against it — a radio or, with
a 9 in front, a telephone number. Tap and hold are separate gestures on the same
key, which is how a keypad radio behaves.

These are generic PMR conventions rather than a copy of any manufacturer's layout,
and every one of them is a rebind in Settings if your crews expect something else.

**Status codes** are two digits and no channel time: 01 available, 02 busy, 03 en
route, 04 on scene, 05 on task, 06 site clear, 07 meal break, 08 out of service.
Edit `STATUS_CODES` in `server.js` to match what your control room already says
out loud.

**Covert mode** dims the screen, silences tones, and — importantly — tells control,
who see "covert" against the call sign. A controller who doesn't know a radio is
covert will keep calling it and assume the officer is ignoring them.
- **SOS** starts unbound and must be *held*, not tapped — 2 seconds by default,
  configurable. A key caught on a seatbelt should not raise an alarm, and the
  officer gets a tone and an on-screen countdown while it arms.
- Bindings are stored against the officer's account as well as the device, so a
  replacement handset restores them at first sign-in. Each key can only be bound
  to one action; the server rejects a collision.

**Handsets with no keypad.** The long-press shortcuts simply never fire, and the
radio knows it has seen no hardware key on this device, so Settings says so and
the same three actions sit on screen as buttons. Nothing is only reachable
through a key you might not have.

**What the lock does and doesn't cover.** It covers the keypad and the
touchscreen, which is the point — a radio in a pocket shouldn't dial. Talk and SOS
stay live on the lock screen, and incoming calls still come through. A lock that
stops an officer shouting for help is worse than an accidental key press.

### Call requests at the console

Pending requests sit in a bar across the top of the control room, priority first
and visually distinct, each with *Call*, *Locate* and *Clear*. Calling the officer
clears their request automatically — no separate step to forget. A second press
while one is already pending escalates it to priority rather than queueing a
duplicate, and the officer can cancel their own.

Volume keys are left alone by default because officers use them. If you want
volume-down as SOS, remove it from `shouldForward` in `MainActivity.kt` and accept
that it stops changing the volume.

## Telephony — dial 9 for an outside line

A radio presses *Dial 9*, keys a number, and CCCS asks the PBX to place the call.
Radios never speak SIP: each has a PJSIP extension on FreePBX, and the gateway
originates and bridges channels on its behalf, so the dialplan, trunk credentials,
CDR and recording stay on the PBX. Radio-to-radio and talkgroup audio never touches
it. Inbound DDI calls ring a radio as a normal private call via
`POST /api/pbx/inbound`, authenticated with a shared secret.

Out of the box this runs on the simulated driver — dial `902071234567` from a radio
and watch the call ring, answer and clear, with no PBX in the loop. Setting
`PBX_MODE=asterisk` switches to the real thing. Full FreePBX configuration,
including the seven WebRTC extension settings people usually miss, is in
[`docs/PBX-FREEPBX.md`](docs/PBX-FREEPBX.md).

## Android

[`android/`](android/README.md) is a Capacitor shell around the radio and MDT
consoles, with the native pieces a browser tab can't provide: a foreground service
so the radio stays registered with the screen off, background location, hardware
PTT key capture, and high-priority emergency notifications. Build with
`npx cap add android && ./gradlew assembleDebug`.

## Recommended next steps toward production

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full sequence, scoped for one person.


1. **Persist.** Apply `db/schema.sql`, put a query layer behind the existing domain functions, add migrations. The read models (`publicRadio`, `publicJob`) become queries; nothing above them changes.
2. **Port to TypeScript and React.** Share a `packages/types` module between server and clients so event payloads are checked at both ends — the WebSocket contract is the highest-value thing to type.
3. **Add real audio.** WebRTC for browser-to-browser first, then a SIP/RTP gateway for hardware radios. Keep floor control server-side where it already is.
4. **Scale out.** Move `broadcast` behind Redis pub/sub so multiple API nodes share one event bus; make floor control a Redis lock with a TTL.
5. **Harden.** TLS termination, SSO/OIDC and LDAP for users, token revocation, structured logging, metrics and alerting.
6. **Integrate.** CAD, external mapping, vehicle telemetry, push notifications, call recording and retention — each behind the abstraction it already has.
7. **Before any operational use:** independent security review, resilience and failover testing, and a formal safety case. A system like this fails when someone is waiting for an ambulance; it needs to be engineered accordingly.

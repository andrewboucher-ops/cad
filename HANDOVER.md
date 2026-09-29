# HANDOVER — contact routes / Twilio SMS / FreePBX dial / control-room redesign

Written at the end of a long session, 2026-09-29. Read this before touching
anything on these branches. It records what is verified, what is broken, and
what was tried and abandoned — including a wrong turn that wasted most of a
session, so it is not repeated.

**Nothing is deployed. `master` is untouched at `105cb79`.** Every change lives
on a branch. The live service on port 4000 runs `master` and never saw any of
this.

---

## 1. Where everything is

| Location | What |
|---|---|
| **Proxmox host** | `Echelon-Server`, root SSH, `10.8.0.18` seen as last login |
| **CCCS container** | Proxmox LXC **140** (`cccs`) → `pct enter 140` → `/opt/cccs-src` |
| **FreePBX VM** | Proxmox VM **130** (`echelon-pbx17`), `192.168.7.45`, SSH is **key-only** |
| **Repo** | `github.com:andrewboucher-ops/cad`, branch `master` |
| **AMI user** | `control-dial` — created in the FreePBX GUI; permit route now set |

Note: the Proxmox host has **no git and no `/opt/cccs-src`**. Those exist only
inside container 140. Two separate machines; `pct enter 140` is the way in.

---

## 2. Branch state (verified via `git log`, not from memory)

```
9b9315c  feat(sms): wire contact routes into server.js      <- HEAD, pushed
05867f9  feat(sms): contact routes as a registrar
b1090cb  feat(store): persist dial_log
9abbe7a  feat(sms): contact routes — dial, SMS, and the Twilio status webhook
678d7b8  feat(sms): dial_log + supervisor schema, and SMS/PBX env template
20a8fe5  feat(sms): Twilio SMS module — logging-only by default
```

`feat/freepbx-dial` = `34dece0d`, branched **off `feat/twilio-sms`** (stacked —
merging it needs the SMS branch first).

Working tree clean. `server.js.bak` does **not** exist and was never committed
(an earlier claim in-session that it had been committed was wrong).

---

## 3. WHAT WORKS — verified, safe to build on

Everything below is on `feat/twilio-sms` and was checked three ways:
`node --check` → `SYNTAX OK`, `npm test` → **66/66 passing**, and a live smoke
test on port 4010 that returned real JSON.

### `sms.js` — Twilio SMS client
Zero-dependency, built-in `fetch`, matching the house style of `msauth.js` and
`webpush.js`.

- `send({ to, body, label })` → `{ ok, sid, status, error }`. Never throws, so a
  dead SMS cannot break the REST call or audit write beside it (same contract as
  `webpush.sendNotification`).
- **`SMS_LIVE` defaults OFF.** Credentials present is not consent to send. With
  it off, `send()` logs exactly what it *would* have sent and returns a
  synthesised SID — so the call path, audit write and UI are all exercisable
  without a text reaching a phone. Develop against this mode.
- `verifySignature(signature, url, params)` — HMAC-SHA1 over **`url` + sorted
  form params**, per Twilio's spec. NOT the raw body. The raw-body version is
  the classic bug: it passes a naive test and then fails for every request
  Twilio sorts differently.
- `parseStatusCallback(params)` expects a parsed `x-www-form-urlencoded` body,
  not JSON. Twilio sends several statuses per message.
- `normalizeNumber` requires E.164, accepting a bare UK `07…` because that is
  what the personnel record holds.

### `db/schema-dial-log.sql` — schema
Kept as its own file, **not** merged into `db/schema.sql` (that is the Postgres
migration target, not a live migration path). Additive; fold in at cutover.

- `dial_log` — one table for **both** channels, because the columns are
  channel-agnostic. Holds a `tel:` attempt today (outcome NULL — the browser
  reports nothing), a Twilio message with a real delivery outcome, and will
  hold a FreePBX call with answered/no-answer/duration.
- `UNIQUE (provider, provider_ref)` — so successive Twilio callbacks **UPDATE**
  one row instead of appending. Twilio sends `queued → sent → delivered` for one
  message; without this you triple-count one text.
- `to_number` is denormalised **deliberately**: a personnel record's
  `contact_phone` can be corrected later, and the log must show the number
  actually dialled at the time.
- `personnel.supervisor_id` (line management, stable) and
  `shifts.is_duty_supervisor` (operational, per shift) as **two separate
  concepts**, because they answer different questions and can disagree.
  Deliberately NOT derived from `personnel.rank` — that column is free text
  (`'Patrol officer'`), so inferring authority from it would mean a typo or a
  promotion silently changes who a console phones.

### `routes-contact.js` — the routes
**Exported as a registrar, not as routes that run on require:**

```js
module.exports = function registerContactRoutes({
  route, httpError, CONTROL, db, nextId, findPersonnel, logEvent,
  DIAL_RINGS_OPERATOR_FIRST, sms,
}) { ... }
```

**This pattern is the important discovery of the session — see §5.**

Routes:
- `GET  /api/personnel/:id/contact` — number, `phone_valid`, and the resolved
  supervisor with `source: DUTY_SUPERVISOR | LINE_MANAGER`
- `GET  /api/me/extension` / `POST /api/me/extension` — the console's extension
- `POST /api/contact/dial` — records an attempt, **and nothing more**
- `POST /api/contact/sms` — sends via Twilio, records attempt **and** outcome
- `GET  /api/personnel/:id/contact-log` — per-person history, newest first
- `POST /api/sms/status` — Twilio delivery webhook

### `store.js` — persistence
`dial_log` added to `TABLES`, cap 50,000. Contact attempts are an audit surface
— losing them on restart would leave a gap exactly where an incident review
would look.

### `server.js` — the wiring (4 edits, all in `9b9315c`)
1. `const DIAL_RINGS_OPERATOR_FIRST = process.env.DIAL_RINGS_OPERATOR_FIRST !== 'off';` (~line 25)
2. `const sms = require('./sms.js');` (~line 36)
3. `dial_log: [],` in the `db` object (~line 88)
4. after the `/api/shifts/:id/clock-out` route:
   ```js
   require('./routes-contact.js')({ route, httpError, CONTROL, db, nextId, findPersonnel, logEvent, DIAL_RINGS_OPERATOR_FIRST, sms });
   ```

---

## 4. WHAT IS BROKEN OR UNVERIFIED — do not assume it works

### `asterisk.js` on `feat/freepbx-dial` — HAS A CONFIRMED BUG
The AMI login path is wrong. Two dispatch functions are defined and then swapped
with `dispatch = dispatchWithLogin`, but the `socket.on('data')` handler closed
over the **original** binding, so the reassignment does nothing. The login
response falls through to the normal path, finds no pending entry, and is
discarded — **`connect()` can never resolve**; every call hangs to the 5s
timeout.

Fix or rewrite. Do not build on it as-is.

It also carries two assumptions that could not be checked:
- **The dialplan context.** `AMI_DIAL_CONTEXT` defaults to `from-internal`. The
  module rings `Local/<extension>@<context>`, which **must exist** in your
  dialplan. The GuardM8 click-to-dial flow already works, so the right context
  exists — find its name and use it.
- **AMI permissions.** Whether `control-dial` may `Originate` is a
  `manager.conf` permission. It surfaces as a clear error on the first real
  call.

### Untested, listed honestly
1. **Twilio `verifySignature` / `parseStatusCallback` have never seen a real
   webhook.** Written to spec, not verified against one. This is the most likely
   place for a subtle error.
2. **The 66 passing tests are the PRE-EXISTING suite, unchanged.** They prove
   nothing existing broke. They say nothing about whether the new routes work.
   **No test covers the contact routes at all.**
3. **`db/schema-dial-log.sql` is additive DDL. Nothing has applied it.**
4. **The smoke test proved two GETs respond** — that the registrar loaded and
   the routes are live. Nothing more.
5. `/api/personnel/1/contact` returned `phone: null, supervisor: null` in the
   demo seed — correct, because the seed has no `contact_phone` values and no
   `supervisor_id` set. **The supervisor logic is therefore untested by that
   request** — both branches of `supervisorFor` returned null.

---

## 5. WHAT WAS TRIED AND FAILED — read this so it is not repeated

### The `server.js` split — abandoned, do not retry
`server.js` is one 2,956-line / 174 KB file. The plan was to split it into
`src/*` modules. **This cannot be done through the GitHub API**: the file-write
tool replaces whole files and cannot carry 174 KB, and there is no
edit-in-place tool. It failed four separate times in one session.

- Branch `refactor/split-server` exists with three modules pushed
  (`src/bus.js`, `src/config.js`, `src/crypto.js`, plus a `src/state.js`).
  **Treat it as dead.** Delete it.
- Do the split in the container with `sed` if you want it, where a 174 KB file
  moves fine.

**The genuinely useful finding that came out of it** — worth keeping even though
the branch is dead — is the **require cycle**:

```
logEvent (state) -> broadcast (realtime) -> isControlRole (state)
checkAutoJobProgress (state) -> broadcast + publicJob (shapers)
```

A direct `require` each way resolves to a **partially-populated exports object**
and fails at the **FIRST EVENT, not at startup** — the worst kind of failure on
a live dispatch console. The fix is late binding: a `bus.js` that `realtime.js`
registers into, or passing dependencies in as arguments.

### The lesson that actually matters
**Passing routing helpers in as arguments beats requiring them across a cycle.**
That is why `routes-contact.js` works and the split did not. When `server.js`
needs to load new routes, use:

```js
require('./routes-new.js')({ route, httpError, CONTROL, db, nextId, findPersonnel, logEvent, ... });
```

### The heredoc failure — a practical note
Pasting a large multi-line heredoc into interactive SSH **interleaves
characters** and the terminator never lands. It produced a garbled fragment and
inserted truncated code into `server.js`. Recovery was `cp server.js.bak server.js`.

**Use `nano` for edits in the container, or push the file via git and `git pull`.
Do not paste large heredocs into SSH.**

---

## 6. THE UNFINISHED ROADMAP WORK — what was actually asked for

The session opened with a request that is **still not started**:

### Configurable Forms (`docs/ROADMAP.md`, last open "Extends Sites/Patrols" item)
> Forms: trespass advisals, parking citations, vehicle inspections, patient
> care/first-aid reports, safeguarding reports (the latter needs
> restricted-visibility handling given its sensitivity)

**Not started. No branch. No code.** The intended shape, agreed in-session:

- `form_definitions` (name, version, field list as JSONB, scope) +
  `form_submissions` (definition, subject — job/visit/site/personnel, payload
  JSONB, submitted_by, timestamps)
- Field types: text, textarea, number, select, checkbox, date, **signature**, photo
- **Signature capture: YES** — canvas component, confirmed as needed
- **Visibility: `STANDARD` | `RESTRICTED`** on the definition, plus a
  `form_visibility` grant table

**The one hard invariant:** `RESTRICTED` forms must be filtered **on the server,
 in projection** — never hidden in the client. A safeguarding report that reaches
the browser and is merely not rendered has already leaked. Compare how
`publicPersonnel` already gates PII.

### Control-room redesign (`control.html`) — also not started
Redesign as **map-primary**, with a **merged Dispatch panel** (jobs + patrol
visits together), and **zero modals** — the create/assign/message flows become
Detail-panel modes rather than popups.

Note: the last commit on `master` (`105cb79`) already moved job/visit detail out
of modals into the Detail panel, and its own message ends *"Flag it if the intent
was broader."* The intent **was** broader — the remaining modals
(create job, create visit, assign by call sign, send message, push notification
setup) are to go too.

Console requirements requested for this redesign:
- available patrols, clocked-in staff **listed by shift**, incidents requiring
  attention — all visible on the map-primary layout
- clicking a clocked-in officer shows their phone number **and** their
  supervisor's
- click-to-dial and click-to-SMS actions, both logged to the main log

---

## 7. Environment / credentials still needed

```
# Twilio — not yet set anywhere
SMS_LIVE=off                 # keep off until tested against your own phone
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=          # or TWILIO_MESSAGING_SERVICE_SID
SMS_STATUS_CALLBACK_URL=     # MUST be the PUBLIC url — Twilio signs the exact
                             # URL it called, so a proxy that rewrites host or
                             # path makes every callback fail, silently

# FreePBX / Asterisk — not yet set
AMI_HOST=192.168.7.45
AMI_PORT=5038
AMI_USERNAME=control-dial
AMI_SECRET=                  # regenerate: the existing one was screenshotted
AMI_DIAL_CONTEXT=            # UNKNOWN — find it, see §4
DIAL_RINGS_OPERATOR_FIRST=on
```

Secrets belong in `/etc/cccs/cccs.env`, root-only, per `deploy/install.sh`.
If you keep them in the repo, use `.env.sms.example` as the template (already
committed) and never the real file.

---

## 8. Immediate next steps, in order

1. **Get the FreePBX dialplan context.** GUI → *Settings → Config Edit* →
   `extensions_custom.conf`. Find the GuardM8 click-to-dial context and its
   `Originate`/`Dial` structure. Also read `manager.conf` for `control-dial`'s
   `read`/`write` permissions (`write=call` is required).
2. **Fix `asterisk.js`** — the login dispatch bug, then set `AMI_DIAL_CONTEXT`
   to the real context. Test by dialling your own extension before anything
   else.
3. **Write tests for the contact routes.** 66/66 currently proves nothing about
   them. Add cases to `test/cccs.test.js`: dial records an ATTEMPT, SMS in
   dry-run records ATTEMPTED (not QUEUED), the webhook rejects a bad signature,
   and a status callback for an unknown SID returns `matched: false`.
4. **Build the Forms slice** (§6) — the actual original request.
5. **Then** the control-room redesign.

### Safety invariants to preserve
- **Dial can never record an outcome** without a PBX. `outcome` stays
  `ATTEMPTED`; nothing on that path may ever write `ANSWERED`. FreePBX fills it.
- **Dry-run SMS logs as `ATTEMPTED`, not `QUEUED`.** Nothing was sent, so
  logging it as queued would put a fictional delivery into the audit trail.
- **`/api/sms/status` is the only unauthenticated route in the system.** The
  signature is its sole protection; it fails **closed**.
- **`RESTRICTED` forms are filtered server-side**, never client-side.
- This system has a lone-worker welfare path where a missed check-in is "a
  person nobody is coming for". Do not ship unverified changes near it.

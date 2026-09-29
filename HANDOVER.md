# HANDOVER — contact routes / Twilio SMS / FreePBX dial / control-room redesign

## ▶ Current state — read this first (updated 2026-09-29, late)

Everything below the line is the earlier handover, kept for its history and
its lessons. **Where it disagrees with this section, this section wins.**

**Nothing is merged or deployed. `master` is still `105cb79`.** The work is a
stack of branches, each building on the one before:

```
feat/twilio-sms       SMS module, contact routes (earlier session)
  └ feat/freepbx-dial   asterisk.js rewritten + contact-route tests
      └ feat/control-redesign   + feat/forms merged in, + the redesign
feat/forms            (branched from master; also merged into the redesign)
```

Merging `feat/control-redesign` alone brings in all of it. Suite on that
branch: **103/103** (66 original + 12 asterisk + 16 contact + 9 forms).

### Done and verified
1. **FreePBX: reachable and permitted.** From container 140: port 5038 open,
   `control-dial` logs in, `ListCommands` lists `Originate`. The server's own
   `GET /api/contact/pbx-probe` returned `logged_in:true, can_originate:true`.
   Context: `from-internal` (confirmed live for reaching an extension in
   commit a86d2da). The GuardM8 block in extensions_custom.conf was never
   read; only needed if the officer leg turns out to need a custom route.
2. **asterisk.js rewritten.** The "login dispatch swap" bug in §4 below was
   **not real** (disproved against a fake AMI server; see bdf0b2a). The real
   bugs were: an Async Originate reply never carries Uniqueid, so no outcome
   could ever be recorded; `Dial(<number>)` had no channel technology; no
   `/n` on the Local channel, so every answered call would log ~0s. Outcome
   is decided on the `;1` channel's Hangup; operator-leg failures are
   recorded as such. 12 tests against a scripted fake PBX.
3. **Contact-route tests** (16). Found and fixed a blocking bug: every real
   Twilio status callback died with 400 'invalid JSON body' (Twilio posts
   form-encoded). Form bodies are now accepted on `/api/sms/status` only, and
   the signature is checked against `SMS_STATUS_CALLBACK_URL` when set.
4. **Supervisor concepts are settable** — neither was before:
   `PATCH /api/personnel/:id {supervisor_id}` (admin UI: line-manager picker)
   and `is_duty_supervisor` on shifts (rota UI: tick box).
5. **Forms** — server (routes-forms.js, registrar), officer filing with
   signature pad, reports page (forms.html), admin form builder with named
   readers. RESTRICTED enforced in projection; a canary leak test searches
   every response and every raw WebSocket byte other users receive, and was
   proven to fail when the rule is broken. Patient care defaults to
   RESTRICTED (health data). Submissions bypass the offline outbox on
   purpose (see forms-ui.js header).
6. **Control-room redesign** — map-primary, translucent docked panels,
   merged Dispatch panel with a "Needs attendance" filter, On-shift panel
   grouped by shift, zero modals, officer detail with both numbers +
   Dial/SMS. GoldenLayout removed (and with it multi-monitor popouts). The
   map is now optional: a Leaflet CDN failure no longer blanks the console.

### NOT yet verified — honest list
- **A real call has never been placed through asterisk.js.** Next step is
  the morning test (below). The one thing the fake PBX cannot tell us:
  whether `control-dial` has `read=call`. If calls connect but every row
  stays ATTEMPTED, that permission is missing.
- **Twilio has never sent a real webhook here.** Signatures are tested
  against the documented algorithm, i.e. self-consistency only.
- **The redesigned console has only run in headless Chromium** with the map
  tiles blocked. Needs a look on a real control-room screen, both themes.
- Forms UI on a real phone (signature pad on touch, camera capture).
- Nothing near the welfare path changed server-side. The console's
  rendering of welfare/emergency banners was rewritten and tested
  end-to-end (real 30s timer → overdue banner → acknowledge), but still
  deserves a deliberate test on a real device before relying on it.

### Morning test — click-to-dial against the real PBX
Inside container 140, one line at a time (no heredocs over SSH):
```
cd /opt/cccs-src && git fetch origin && git worktree add /tmp/dialtest origin/feat/control-redesign
cd /tmp/dialtest && read -s -p 'AMI secret: ' AMI_SECRET && echo && export AMI_SECRET AMI_HOST=192.168.7.45 AMI_USERNAME=control-dial PORT=4010 PERSISTENCE=off SIMULATION=off TLS_CERT_DIR=/nonexistent AUTH_SECRET=dialtest && (node server.js > /tmp/dialtest.log 2>&1 &) && sleep 2
T=$(curl -s localhost:4010/api/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"admin123"}' | sed 's/.*"token":"\([^"]*\)".*/\1/'); curl -s localhost:4010/api/contact/pbx-probe -H "authorization: Bearer $T"; echo
curl -s -X PATCH localhost:4010/api/personnel/1 -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"contact_phone":"07XXXXXXXXX"}' >/dev/null; echo done
curl -s -X POST localhost:4010/api/contact/dial -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"personnel":1,"extension":"905"}'; echo
curl -s localhost:4010/api/personnel/1/contact-log -H "authorization: Bearer $T"; echo
```
Three calls: answer and talk ~10s; reject on the mobile; let ext 905 ring
out. Expect ANSWERED+duration, BUSY (or NO_ANSWER, network-dependent) and
NO_ANSWER with `OPERATOR_NO_ANSWER`. Clean up after:
`pkill -f /tmp/dialtest/server.js; cd /opt/cccs-src && git worktree remove --force /tmp/dialtest; unset AMI_SECRET`
(then `systemctl status cccs` to confirm the live service is untouched).

### Housekeeping owed
- **Rotate the `control-dial` AMI secret** — it was pasted at a shell prompt
  on 2026-09-29, so it is in container 140's root shell history and in a chat
  transcript. Then `history -c && history -w` in the container.
- `public/log.html` on master has mojibake (`â€”` for `—`); unrelated, untouched.
- `refactor/split-server` is still marked dead below; delete it when convenient.

---


Written at the end of a long session, 2026-09-29, and **corrected the same day**
after the next session tested a claim in it. Read this before touching anything
on these branches. It records what is verified, what is broken, and what was
tried and abandoned — including a wrong turn that wasted most of a session, so
it is not repeated.

> **Correction, 2026-09-29.** An earlier version of this file claimed
> `asterisk.js` had a confirmed login bug in which the `dispatch`
> reassignment did not take effect, so `connect()` could never resolve.
> **That claim was wrong.** It was written from pattern-memory without the
> code being run. A fake AMI server showed correct login resolving in 10 ms
> and a wrong password failing in 4 ms with "Authentication failed" — the
> swap works, because the data handler looks `dispatch` up by name on each
> call and therefore sees the reassignment. Closures capture the binding, not
> the value. The real, smaller problems in `asterisk.js` are listed in §4,
> and the lesson is in §5.

**Nothing is deployed. `master` is untouched at `105cb79`.** Every change lives
on a branch. The live service on port 4000 runs `master` and never saw any of
this.

---

## 1. Where everything is

| Location | What |
|---|---|
| **Proxmox host** | `Echelon-Server`, root SSH |
| **CCCS container** | Proxmox LXC **140** (`cccs`) → `pct enter 140` → `/opt/cccs-src` |
| **FreePBX VM** | Proxmox VM **130** (`echelon-pbx17`), `192.168.7.45`, SSH is **key-only** |
| **Repo** | `github.com:andrewboucher-ops/cad`, default branch `master` |
| **AMI user** | `control-dial` — created in the FreePBX GUI; permit route reported set |

Note: the Proxmox host has **no git and no `/opt/cccs-src`**. Those exist only
inside container 140. Two separate machines; `pct enter 140` is the way in.

**A cloud-hosted session cannot reach any of this.** FreePBX (5038) and its web
GUI are on the LAN. Steps needing the PBX must run from container 140, or have
the config pasted in by hand.

---

## 2. Branch state (verified via `git log`, not from memory)

```
<this commit>  docs: correct a false claim about asterisk.js    <- feat/twilio-sms
91de507        docs: handover note for the Twilio/FreePBX work
9b9315c        feat(sms): wire contact routes into server.js
05867f9        feat(sms): contact routes as a registrar
b1090cb        feat(store): persist dial_log
9abbe7a        feat(sms): contact routes — dial, SMS, and the Twilio status webhook
678d7b8        feat(sms): dial_log + supervisor schema, and SMS/PBX env template
20a8fe5        feat(sms): Twilio SMS module — logging-only by default
```

`feat/freepbx-dial` = `34dece0`, branched **off `feat/twilio-sms`** (stacked —
merging it needs the SMS branch first).

`refactor/split-server` has been deleted, local and remote. **Do not recreate it
— see §5.**

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

### `asterisk.js` on `feat/freepbx-dial` — three REAL problems

The login path works (see the correction above). What is actually wrong:

1. **A dropped socket does not fail in-flight actions.** After login, if the
   connection drops, each pending action sits out its own 10-second timeout
   rather than being rejected immediately. On a dispatch console that is ten
   seconds of a button appearing to do nothing.
2. **The login bookkeeping is accidental.** Tracking the login response via a
   synthetic `'login'` key in the `pending` Map happens to work rather than
   working by design. Tidy it into one clear path — the previous session's
   misreading of this code is itself evidence that it is misleading.
3. **`trackCall` has never seen a real Asterisk event stream.** The
   answered / no-answer / busy cause-code mapping is written from the protocol
   docs and is entirely untested. This is the part most likely to be subtly
   wrong.

It also carries two assumptions that could not be checked:
- **The dialplan context.** `AMI_DIAL_CONTEXT` defaults to `from-internal`. The
  module rings `Local/<extension>@<context>`, which **must exist** in your
  dialplan. The GuardM8 click-to-dial flow already works, so the right context
  exists — find its name and use it. If GuardM8 originates over AMI rather than
  via a custom context, the context is whatever GuardM8 passes as `Context:`,
  which lives in GuardM8's own config, not in `extensions_custom.conf`.
- **AMI permissions.** Whether `control-dial` may `Originate` is a
  `manager.conf` permission (`write=call` or `originate`). It surfaces as a
  clear error on the first real call.

If a call previously appeared to hang, the more likely cause was network or
permissions, not the login path — `control-dial`'s `permit=` not covering
container 140's address, or 5038 unreachable from it. Check from inside the
container:

```bash
pct enter 140
timeout 3 bash -c 'echo > /dev/tcp/192.168.7.45/5038' && echo reachable || echo blocked
```

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
   `supervisor_id` set. **The supervisor logic is therefore untested** — both
   branches of `supervisorFor` returned null. Seed those before testing it.

---

## 5. WHAT WAS TRIED AND FAILED — read this so it is not repeated

### The `server.js` split — abandoned, do not retry
`server.js` is one 2,956-line / 174 KB file. The plan was to split it into
`src/*` modules. **This cannot be done through the GitHub API**: the file-write
tool replaces whole files and cannot carry 174 KB, and there is no
edit-in-place tool. It failed four separate times in one session.

Use `sed` inside container 140 if you want it split, where a 174 KB file moves
fine.

**The genuinely useful finding that came out of it** is the **require cycle**:

```
logEvent (state) -> broadcast (realtime) -> isControlRole (state)
checkAutoJobProgress (state) -> broadcast + publicJob (shapers)
```

A direct `require` each way resolves to a **partially-populated exports object**
and fails at the **FIRST EVENT, not at startup** — the worst kind of failure on
a live dispatch console.

### The lesson that actually matters
**Passing routing helpers in as arguments beats requiring them across a cycle.**
That is why `routes-contact.js` works and the split did not. When `server.js`
needs to load new routes, use:

```js
require('./routes-new.js')({ route, httpError, CONTROL, db, nextId, findPersonnel, logEvent, ... });
```

### Two process lessons worth more than the code

**Do not diagnose from pattern-memory.** This file originally reported an
`asterisk.js` bug — a closure that missed a reassignment — that did not exist.
It was written confidently, from the shape of a common bug, without the code
being run. A five-minute test against a fake AMI server disproved it. On a
system with a welfare path in it, a confident wrong diagnosis is worse than no
diagnosis: it sends the next person to fix something that is not broken and
leaves the real fault in place. **Run it before you claim it.**

**Do not paste large heredocs into interactive SSH.** The shell interleaves
characters and the terminator never lands; it inserted a truncated fragment into
`server.js`. Use `nano`, or push the file via git and `git pull`.

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
`.env.sms.example` (committed) is the template; never commit the real file.

---

## 8. Immediate next steps, in order

1. **Get the FreePBX dialplan context.** GUI → *Settings → Config Edit* →
   `extensions_custom.conf`. Find the GuardM8 click-to-dial block — the
   `[context-name]` header and the `Dial(...)` line. Also read `manager.conf`
   (or `manager_custom.conf`, where FreePBX usually puts GUI-created users) for
   `control-dial`'s `read=` / `write=` (needs `call` or `originate`) and
   `permit=`. If GuardM8 originates over AMI, the context is in GuardM8's own
   config instead. Also check reachability from container 140 (§4).
2. **Then** tidy `asterisk.js` (§4 items 1–2), set `AMI_DIAL_CONTEXT` to the
   real context, and test by dialling an extension — recording the real outcome
   (`ANSWERED` / `NO_ANSWER` / `BUSY` + duration) onto the `dial_log` row. That
   is the whole point of the module.
3. **Write tests for the contact routes.** They currently have none. At minimum:
   dial records an ATTEMPT, SMS in dry-run records ATTEMPTED (not QUEUED), the
   webhook rejects a bad signature, and an unknown SID returns `matched: false`.
   **This does not depend on the PBX and can be done first.**
4. **Build the Forms slice** (§6) — the actual original request.
5. **Then** the control-room redesign (§6).

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

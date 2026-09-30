# Access review — who can act on what, and how you'd know if the wrong person did

**Not a security audit by a qualified third party.** This is a plain
walk-through of the routes that let one person act on another person's
record, done because `docs/ROADMAP.md` named a specific open question:
*"Who can reset an emergency, and how would you know if the wrong person
did?"* Read it as a snapshot of what was checked and fixed on 2026-09-30,
not a standing guarantee — re-run the same questions after any change to
`server.js`'s role gates.

## The question, and the honest answer before this review

**Who can acknowledge or resolve an emergency?** Any `DISPATCHER`,
`SUPERVISOR` or `SYSTEM_ADMIN` — control roles, by design. That part was
already correct and is unchanged.

**How would you know if the wrong one of them did?** Partially. Every
emergency action goes through `logEvent()`, so it's on the audit log with
a timestamp and a human-readable line naming who did it
("EMERGENCY ... RESOLVED BY Controller Hale"). But the emergency record
itself only ever stored *acknowledged_by* — never *resolved_by*. You could
find out who resolved an alarm by reading a log sentence; you couldn't
query it, and `GET /api/emergency` wouldn't show it to you structurally
the way it already showed who acknowledged one. Fixed: `resolved_by` is
now set the same way, on both a manually-raised emergency and an
auto-raised welfare alarm.

## The real finding: a role check with a blind spot

Several routes let someone act on *their own* record — check themselves
in, cancel their own welfare timer, return their own equipment checkout —
while anyone else needs to be a control role. The check written for this,
repeated across six call sites, was:

```js
if (user.role === 'FIELD_USER' && user.personnel_id !== p.id) throw httpError(403, ...);
```

That only restricts `FIELD_USER`. `MDT_USER` — a vehicle terminal login,
not a specific person, with no `personnel_id` of its own — isn't
`FIELD_USER`, so the check never applied to it at all. An MDT terminal
could:

- **Silently clear any officer's overdue welfare alarm** (`POST
  /api/personnel/:id/welfare/check`) — the exact "a person nobody is
  coming for" scenario `docs/PRIVACY.md` and the README's welfare section
  already treat as the most safety-critical thing in this codebase.
- **Cancel any officer's welfare timer outright** (`DELETE
  /api/personnel/:id/welfare`).
- **Start a welfare timer on someone else's behalf** (`POST
  /api/personnel/:id/welfare`) — lower stakes, but still not this
  terminal's business.
- **Return someone else's asset checkout** (`POST
  /api/assets/:id/return`), marking it back in store while it's still
  physically out with them.
- **Clear someone else's callback request** (`POST
  /api/calls/requests/:id/clear`).
- **Read someone else's training record** (`GET
  /api/personnel/:id/training-records`) — the lowest-stakes one, but still
  data that wasn't this terminal's to read.

Fixed by changing all six to check `!isControlRole(user.role)` instead of
`user.role === 'FIELD_USER'` — the same "control roles always can, anyone
else only their own" rule the working `GET /api/messages` route next to
one of them already used correctly. `FIELD_USER` and control behaviour is
identical to before; only `MDT_USER`'s unintended access is what changed.
`test/access-review.test.js` proves each of the six, and greps confirm no
other route repeats the `role === 'FIELD_USER'` pattern.

**Also found alongside it, same review pass:** `POST
/api/messages/:id/read` had no ownership check at all — any authenticated
login could mark any message read, including one addressed to someone
else, producing a false read receipt for the real recipient. Lower
severity (no content is exposed, just a status flag), fixed the same way:
only the actual recipient, or control for a message sent to control.

## Welfare actions now name who acted, not just who it happened to

Before this review, `startWelfare`/`checkInWelfare`/`stopWelfare`'s audit
log entries named the *subject* ("P101 CHECKED IN") but never the actor —
unlike emergency ack/resolve, which always named `user.display_name`. For
a `FIELD_USER` managing their own timer those are the same person, but the
moment control (correctly) checks someone else in, or now that the
`MDT_USER` gap above is closed, "who did this" was invisible even to
someone reading the log by hand. Fixed: all three now include the actor
in both the log line and the structured `data` payload
(`started_by`/`checked_in_by`/`stopped_by`), and a check-in that clears an
open `WELFARE` emergency event now sets that event's `resolved_by` too.

## What was reviewed and deliberately left as-is

**`POST /api/emergency` lets a non-`FIELD_USER` caller name an arbitrary
`body.personnel`.** A `FIELD_USER` or `MDT_USER` raising an emergency
always resolves to their *own* record regardless of what the request
body says — that part can't be spoofed. But a control-role caller (or, as
written, anything that isn't specifically `FIELD_USER`/`MDT_USER` for the
personnel side) can name someone else's `personnel_id`. This is plausibly
intentional — control relaying "officer X says they need help" over the
radio — and restricting it risks adding friction to the one workflow
where friction is least acceptable. Left unchanged; the event is fully
attributed and logged either way, so a false or mistaken report is at
least traceable after the fact. Revisit if it's ever actually misused.

**Who can grant access to a RESTRICTED (safeguarding) report.** Already
correct: `ADMIN`-only, and every grant is itself a named, logged record
(`granted_by`, `user_id`, timestamp) — see `routes-forms.js`'s own header
comment, which already states the principle this whole review is checking
for elsewhere: *"access to a safeguarding report is always a recorded
decision about a named person, never a side effect of having a senior
role."* No changes needed.

**`GET /api/emergency` returns the last 100 events to any authenticated
role, unfiltered.** Not a new exposure — every emergency is already
broadcast live to every connected role for situational awareness, so the
historical list matches what's already visible in real time. Left as-is.

## Re-running this review

Grep for the pattern that caused the main finding, so it can't recur
unnoticed:

```
role === 'FIELD_USER'.*throw httpError\(403
```

If that ever matches again outside a place that's also explicitly checked
against `isControlRole`, the same MDT_USER blind spot has come back.

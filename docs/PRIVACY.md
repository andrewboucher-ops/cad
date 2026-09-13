# Staff privacy — what this system records, and what you owe your officers

**Not legal advice.** I am not a lawyer and this is not a compliance sign-off.
It is a plain description of what the software collects and the questions a UK
employer needs to have answered before switching it on. Have someone qualified
review it, particularly the legitimate interest assessment.

## What is collected about staff

| Data | Kept for | Why |
|---|---|---|
| Location, every few seconds while on shift | 31 days | Dispatching the nearest unit; locating an officer in an emergency |
| Status changes | 1 year | Operational record, client SLA evidence |
| Welfare timers and check-ins | 1 year | Lone-worker safety, insurance |
| Call and message metadata (who, when — no audio) | 180 days | Audit trail |
| Job assignments and outcomes | 2 years | Client reporting, disputes, insurance |
| Emergency and welfare alarms | 1 year | Safety record |

Retention is enforced in code, not by policy alone: a sweep runs every six hours
and deletes anything past its window. `GET /api/retention` shows the current
policy and record counts; `RETAIN_LOCATIONS_DAYS` and friends change it.

Continuous location tracking is the most intrusive thing here, so it is kept for
the shortest time. If you lengthen it, write down why in terms you would be
comfortable saying to the officer being tracked.

## What is not collected

- **No audio is recorded.** Voice passes between devices and is not stored.
  If you later add recording — and clients sometimes ask — that is a materially
  different privacy position and needs its own notice and consent position.
- No microphone access outside an active transmission or call.
- No tracking outside a signed-in shift. Signing out stops it. Officers should be
  told that plainly, and told to sign out on breaks if you are not tracking breaks.

## What you need in place before go-live

1. **Tell staff, in writing, before you switch it on.** Not buried in a handbook
   update. The draft below is a starting point.
2. **A legitimate interest assessment.** You are relying on legitimate interests,
   not consent — consent from an employee is rarely freely given and therefore
   rarely valid. Document: what you need, why less intrusive means will not do,
   and why it is proportionate.
3. **A DPIA.** Systematic monitoring of workers is explicitly the kind of
   processing the ICO expects one for. Do it before deployment.
4. **Update your ROPA** to include this system.
5. **A subject access route.** An officer can ask what you hold on them. Make
   sure someone knows how to answer, and can do it within a month.

The ICO's employment practices guidance on monitoring workers is the thing to
read: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/monitoring-workers/

## Handling requests

**Access** — export their location history, status changes and job assignments.

**Erasure** — `POST /api/radios/:issi/erase-location-history` (admin only) removes
an officer's movement history while leaving the operational job record intact.
The erasure is itself written to the audit log, which is correct: you need to be
able to show it happened.

Note that you can generally refuse erasure of records you need for a legal
obligation or an insurance claim. Movement history usually is not one of those
after a few weeks. The job record often is.

---

## Draft notice to staff

> **Vehicle and radio tracking — what we record**
>
> From [date] our radios and vehicle terminals record location while you are
> signed on shift. This note explains what that means.
>
> **What we record.** Your position while you are signed in, the status you set,
> the jobs you are assigned, welfare check-ins, and a record of calls and
> messages — who and when, not what was said. We do not record audio.
>
> **Why.** To send the nearest unit to an incident, to find you quickly if you
> raise an alarm or miss a welfare check-in, and to show clients what we did at
> their sites. It is not there to monitor how hard you are working, and it will
> not be used for that.
>
> **When it stops.** Signing out stops location recording. You are not tracked
> off shift. [If you are not tracking breaks: You should sign out on your break.]
>
> **How long we keep it.** Location history for 31 days. Job and status records
> for longer, because clients and insurers may ask about them.
>
> **Your rights.** You can ask what we hold about you and we will tell you within
> a month. You can ask us to delete your movement history. You can object to the
> tracking — speak to [name] and we will explain the basis for it and consider
> your objection properly.
>
> **Questions** to [name, email]. If you are not satisfied you can complain to the
> Information Commissioner's Office at ico.org.uk.

---

## The bit worth getting right

Officers accept tracking when it is obviously for their safety, and resent it
when it feels like surveillance. Lead with the welfare timer and the emergency
button, be straight that the location data exists, and be clear that it is not
being used to time their breaks. If it *is* going to be used for performance,
say so — being caught having said otherwise is far worse than saying it upfront.

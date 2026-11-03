# Safeguarding, use of force and incident forms: what they ask and why

This note explains, in plain English, what the three statement forms in CCCS ask for and which UK rules each question is there for. It is a practical checklist written from public guidance. It is **not legal advice**, so have a solicitor or your compliance adviser confirm anything you rely on.

The field lists are in `routes-forms.js` (`SAFEGUARDING_FIELDS`, `USE_OF_FORCE_FIELDS`, `INCIDENT_FIELDS`). A live database's existing forms get the new fields once, on the first start after this change (`ensureStatementCompliance`). Any fields or select options an admin added are kept. Reports filed before the change keep the questions they were filled in against.

## How the forms now behave

- **Detail boxes appear when they're needed.** For example, "Police reference" appears and becomes required once "Police informed" is ticked. The server checks the same rule, so an old app or a direct API call can't skip it.
- **No future times.** The time of an incident can't be set in the future. There's 10 minutes' grace for a phone clock that runs fast.
- **Statement of truth.** All three forms end with a required tick: "This is a true and accurate account, written as soon as I reasonably could". This is the usual shape for a statement that may be used as evidence.
- **Legal-clock alerts.** On the incident report, ticking "may be reportable under RIDDOR", "personal information may have been lost…" or "CQC-regulated service…" pushes control straight away, whatever severity was chosen, and is logged as `form.alert`.
- **Restricted stays restricted.** Safeguarding and use-of-force reports are still RESTRICTED: only the officer who filed it and the named readers can open them, and nothing about them goes into the control-room log.

## Safeguarding report

| Question | Why it's there |
|---|---|
| Type of concern (physical, sexual, financial, neglect, self-neglect, domestic abuse, modern slavery, exploitation/county lines, discriminatory, organisational, Prevent…) | The categories in the Care Act 2014 statutory guidance (ch. 14) and Working Together to Safeguard Children 2023. The local authority will ask. |
| Where it happened | Basic fact any referral needs. |
| What you saw or were told, in their words | Statutory guidance asks for facts and the person's own words, not opinion. The help text also reminds officers never to promise secrecy. |
| What the person wants to happen | "Making Safeguarding Personal" (Care Act guidance): record the adult's wishes even if you have to act anyway. |
| Who is alleged to have caused harm; is it a member of staff or someone in a position of trust | Allegations against staff go to the LADO (children) or the local authority, and that person must not be tipped off. |
| Others at risk | A s42 enquiry considers whether other people are at risk. |
| 999 called + reference | Shows the emergency response and lets the lead follow it up. |
| Safeguarding lead told (name and time) | Shows the concern was escalated the same shift. |
| Referral to the local authority + reference | Records whether a Care Act s42 / Children Act referral was made, or left for the lead to decide. |
| Did they agree to sharing? + why, if shared without agreement | Safeguarding data is special-category data under UK GDPR. DPA 2018 Schedule 1 para 18 and Schedule 8 para 4 allow sharing without consent to protect a child or adult at risk, but the decision and reason should be written down. The ICO's data-sharing code says the same. |

## Use of force report

| Question | Why it's there |
|---|---|
| Location, and your SIA licence number | The SIA can review a licence after a use of force, and the record has to show who it was. |
| Other staff involved (names and SIA numbers) | Same reason, for everyone involved. |
| The threat you saw | Force is lawful only if it's reasonable in the circumstances as you honestly believed them to be (common law; Criminal Law Act 1967 s3; Criminal Justice and Immigration Act 2008 s76). The officer's honest belief has to be written down. |
| What you tried first | De-escalation is central to SIA licence-linked training and to showing force was a last resort. |
| Why the force was necessary and proportionate, and why less wouldn't have worked | This is the legal test. A report without it is hard to defend. |
| Restraint position; if face down, how long and how breathing was watched | Prone restraint carries a known risk of positional asphyxia. SIA physical intervention training covers it. |
| The person appeared to be (under 18, intoxicated, in mental health crisis…) | Vulnerability affects what's proportionate, and may mean a safeguarding report is also needed. |
| Aftercare | Duty of care once force stops, and a common question in complaints and inquests. |
| Grounds for arrest, what they were told, hand-over | A citizen's arrest (PACE s24A) needs reasonable grounds for an indictable offence, and the person must be handed to police as soon as possible. |
| Injury details, police reference, supervisor name | Required once the matching box is ticked. |
| Body-worn video recording | Evidence, and it has to be kept (see retention below). |

## Incident report

| Question | Why it's there |
|---|---|
| More incident types (injury or accident, near miss, violence to staff, data breach, lost property, safeguarding, use of force) | So these can be counted and trended. This also supports the SIA Approved Contractor Scheme's expectation of incident analysis, and HSE's advice to record near misses. |
| Exact location (now required); what you did straight away | Basic facts of any incident record. |
| Someone injured + details | Accident-book duty (Social Security (Claims and Payments) Regulations 1979) and RIDDOR. |
| May be RIDDOR-reportable (alerts) | RIDDOR 2013: deaths, specified injuries, over-7-day incapacity of a worker, a member of the public taken to hospital, and dangerous occurrences must be reported to HSE. A manager decides whether it's reportable. |
| Personal data breach + details (alerts) | UK GDPR Art 33: a breach that risks people's rights must be reported to the ICO within 72 hours of becoming aware. The clock starts when the officer knows. |
| CQC-regulated service (alerts) | Only if Echelon is CQC-registered for an activity such as medical cover or patient transport. Registration Regulation 18 requires notifying CQC without delay of deaths, serious injuries, abuse or allegations, and police incidents. Regulation 20 (duty of candour) may apply. |
| Safeguarding concern / force used | Prompts the separate restricted report, so the sensitive detail isn't kept in a standard report that control can read. |
| Footage preserved | CCTV often overwrites within about 30 days. Evidence needs keeping before then. |
| Client told; SIA licence number | ACS contract-management expectations and accountability. |
| Photo guidance (avoid faces and injuries) | UK GDPR data minimisation (Art 5(1)(c)). |

## Things the forms can't do on their own

These are for you to decide or do. They aren't code changes.

1. **Name the readers.** Give the safeguarding lead (and a deputy) read access to the Safeguarding and Use of force forms in Admin → Forms. Until a reader is named, only the officer who filed a report can see it.
2. **Retention.** Form submissions are currently kept for 6 years (`RETAIN_FORMS_DAYS`, 2190 days). Safeguarding records about children are often kept much longer, commonly until the child turns 25 or more, and some local safeguarding partnerships set their own periods. Agree a period with your safeguarding lead, then set `RETAIN_FORMS_DAYS` or ask for a longer per-form period.
3. **CQC.** The CQC tick only matters if Echelon holds CQC registration. If it doesn't, the box is harmless, but you could remove it in Admin → Forms.
4. **Policies.** The forms support your safeguarding, use-of-force and data-breach policies but don't replace them. Check the policies match these questions, especially who decides on RIDDOR and ICO reports.
5. **Training.** Tell officers about the new questions, especially the "why it was proportionate" box and the statement of truth.

-- ====================================================================
-- Contact attempts — click-to-dial and click-to-SMS from the control room
-- ====================================================================
--
-- Why this is a table and not just an audit_logs row: the two channels have
-- different evidentiary shapes, and collapsing them loses the difference.
--
-- A `tel:` link gives the browser no callback whatsoever. All that can
-- honestly be recorded is that an operator *pressed* dial, and an attempt
-- row must never imply more than that — `outcome` stays NULL for dial
-- attempts recorded this way.
--
-- SMS via Twilio is different: it returns a message SID synchronously and
-- then calls back with delivery state. So one row carries the attempt AND,
-- updated in place as callbacks arrive, the real outcome. Rows are keyed on
-- `provider_ref` (the Twilio SID) so successive callbacks update rather than
-- append — Twilio sends queued -> sent -> delivered for a single message,
-- and appending each would triple-count one text in the log.
--
-- FreePBX/Asterisk, when it is wired up, reports answered/no-answer/busy and
-- a duration against its own unique call id, which fills the same outcome
-- columns. That is why the columns below are channel-agnostic: the schema
-- does not need to change when the dial path moves from a tel: link to a
-- real PBX origination.
CREATE TYPE contact_channel AS ENUM ('DIAL','SMS');
CREATE TYPE contact_outcome AS ENUM ('ATTEMPTED','QUEUED','SENT','DELIVERED','ANSWERED','NO_ANSWER','BUSY','FAILED','UNDELIVERED');

CREATE TABLE dial_log (
  id                BIGSERIAL PRIMARY KEY,
  channel           contact_channel NOT NULL,
  -- Who was being contacted. personnel_id is the person; the number is
  -- stored denormalised because a personnel record's contact_phone can be
  -- corrected later, and the log must show the number that was actually
  -- dialled at the time rather than whatever the record says today.
  personnel_id      BIGINT REFERENCES personnel(id) ON DELETE SET NULL,
  to_number         TEXT NOT NULL,
  from_number       TEXT,
  -- Who pressed the button. Kept separately from the personnel being
  -- contacted; a control-room action is the operator's, not the officer's.
  actor_user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_name        TEXT NOT NULL,
  -- Optional operational context, so a contact attempt can be read against
  -- the incident it related to.
  job_id            BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  site_visit_id     BIGINT REFERENCES site_visits(id) ON DELETE SET NULL,
  body              TEXT,                      -- SMS text, for DIAL rows
  -- Provider correlation. Twilio: the message SID. FreePBX: the unique call
  -- id. Unique so a repeated webhook delivery is an idempotent UPDATE.
  provider          TEXT NOT NULL DEFAULT 'none',   -- 'twilio' | 'freepbx' | 'none'
  provider_ref      TEXT,
  outcome           contact_outcome NOT NULL DEFAULT 'ATTEMPTED',
  error_code        TEXT,                      -- Twilio error code, or PBX cause code
  duration_s        INTEGER,                   -- answered calls only; NULL means not known, not zero
  attempted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at        TIMESTAMPTZ                  -- when a terminal outcome arrived
);
CREATE UNIQUE INDEX dial_log_provider_ref_uniq ON dial_log(provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX dial_log_personnel_idx ON dial_log(personnel_id, attempted_at DESC);
CREATE INDEX dial_log_attempted_idx ON dial_log(attempted_at DESC);

-- ====================================================================
-- Supervisory relationships
-- ====================================================================
--
-- Two distinct concepts, deliberately modelled separately because they
-- answer different questions and can disagree:
--
--   personnel.supervisor_id  — line management. Stable, HR-owned, exists
--                              whether or not anyone is on duty.
--   shifts.is_duty_supervisor — who is supervising THIS shift. Operational,
--                              and it can be nobody.
--
-- A control-room call button wants the duty supervisor, because at 03:00 the
-- line manager is asleep. It falls back to the line manager only when no
-- duty supervisor is rostered — so the button is never dead, but the log
-- always shows which of the two it actually reached.
--
-- Deliberately NOT derived from personnel.rank: that column is free text
-- ('Patrol officer', 'Static guard'), so inferring authority from it would
-- mean a typo or a promotion silently changes who a console phones.
ALTER TABLE personnel ADD COLUMN supervisor_id BIGINT REFERENCES personnel(id) ON DELETE SET NULL;
CREATE INDEX personnel_supervisor_idx ON personnel(supervisor_id);
ALTER TABLE shifts ADD COLUMN is_duty_supervisor BOOLEAN NOT NULL DEFAULT FALSE;
-- At most one duty supervisor per shift window is not expressible as a
-- constraint without a range type; enforced in the shift routes instead.
CREATE INDEX shifts_duty_supervisor_idx ON shifts(is_duty_supervisor) WHERE is_duty_supervisor;

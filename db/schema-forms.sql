-- ====================================================================
-- Configurable forms — trespass advisals, parking citations, vehicle
-- inspections, patient care / first-aid reports, safeguarding reports.
-- ====================================================================
--
-- Kept as its own additive file, like schema-dial-log.sql: db/schema.sql is
-- the Postgres migration target, not a live migration path. Fold in at
-- cutover. The running system holds these as JSON collections (store.js).
--
-- Visibility is the reason this is more than a form builder. A RESTRICTED
-- submission is readable only by its author and by users named in
-- form_grants — never by role. Enforcement lives in the application's
-- projection (routes-forms.js canRead), and if this schema is ever served
-- directly (a reporting tool, a BI connection) the same rule must be
-- re-implemented there, e.g. as a row-level security policy. A view that
-- "just doesn't show" restricted rows to a UI is not enforcement.

CREATE TYPE form_visibility AS ENUM ('STANDARD','RESTRICTED');
CREATE TYPE form_subject    AS ENUM ('JOB','SITE_VISIT','SITE','PERSONNEL','VEHICLE');

CREATE TABLE form_definitions (
  id            BIGSERIAL PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,              -- stable slug, e.g. 'safeguarding'
  name          TEXT NOT NULL,
  description   TEXT,
  version       INTEGER NOT NULL DEFAULT 1,         -- bumped whenever fields change
  visibility    form_visibility NOT NULL DEFAULT 'STANDARD',
  subject_types form_subject[] NOT NULL,
  fields        JSONB NOT NULL,                    -- [{id,label,type,required,options?,help?}]
  active        BOOLEAN NOT NULL DEFAULT TRUE,     -- retired, never deleted: submissions reference it
  created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable once written: a filed report is a record. The definition's
-- fields and visibility are SNAPSHOTTED here, so a report renders as it was
-- filled in after its form is redesigned, and relaxing a form's visibility
-- never loosens reports filed while it was restricted (effective visibility
-- is the stricter of this snapshot and the definition's current setting).
CREATE TABLE form_submissions (
  id                        BIGSERIAL PRIMARY KEY,
  reference                 TEXT NOT NULL UNIQUE,   -- FORM-YYYY-NNNNN
  definition_id             BIGINT NOT NULL REFERENCES form_definitions(id),
  definition_key            TEXT NOT NULL,
  definition_name           TEXT NOT NULL,
  definition_version        INTEGER NOT NULL,
  fields                    JSONB NOT NULL,         -- snapshot
  visibility                form_visibility NOT NULL, -- snapshot
  subject_type              form_subject NOT NULL,
  subject_id                BIGINT NOT NULL,
  subject_label             TEXT NOT NULL,          -- snapshot: survives the job being swept by retention
  values                    JSONB NOT NULL,         -- signature/photo values hold {file_id,...}, not image bytes
  files                     JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_by_user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  submitted_by_name         TEXT NOT NULL,
  submitted_by_personnel_id BIGINT REFERENCES personnel(id) ON DELETE SET NULL,
  submitted_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX form_submissions_subject_idx ON form_submissions(subject_type, subject_id, submitted_at DESC);
CREATE INDEX form_submissions_author_idx  ON form_submissions(submitted_by_user_id, submitted_at DESC);

-- The named people who may read a RESTRICTED form's reports. Per user, not
-- per role, deliberately: access to a safeguarding report is a recorded
-- decision about a named person, never a side effect of a senior role.
CREATE TABLE form_grants (
  id            BIGSERIAL PRIMARY KEY,
  definition_id BIGINT NOT NULL REFERENCES form_definitions(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by    TEXT NOT NULL,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (definition_id, user_id)
);

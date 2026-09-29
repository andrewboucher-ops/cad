-- CCCS — target PostgreSQL schema.
-- The POC runs an in-memory store with exactly these entities and relationships;
-- this file is the migration target for swapping in a real database.

CREATE TYPE job_status        AS ENUM ('CREATED','DISPATCHED','ACKNOWLEDGED','EN_ROUTE','ON_SCENE','TRANSPORTING','COMPLETED','CANCELLED');
CREATE TYPE job_priority      AS ENUM ('RED','AMBER','GREEN','ROUTINE');
CREATE TYPE user_role         AS ENUM ('SYSTEM_ADMIN','DISPATCHER','SUPERVISOR','FIELD_USER','MDT_USER');
CREATE TYPE employment_status AS ENUM ('ACTIVE','LEAVE','TERMINATED');
CREATE TYPE emergency_state   AS ENUM ('ACTIVE','ACKNOWLEDGED','RESOLVED');
CREATE TYPE callback_state    AS ENUM ('PENDING','ANSWERED','CANCELLED');

CREATE TABLE callsigns (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id                    BIGSERIAL PRIMARY KEY,
  registration          TEXT NOT NULL UNIQUE,
  type                  TEXT NOT NULL,
  make                  TEXT,
  model                 TEXT,
  service_due_at        DATE,
  insurance_due_at      DATE,
  mileage               INTEGER,
  condition             TEXT,
  assigned_personnel_id BIGINT,          -- FK added after personnel
  status                TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE | IN_SERVICE | OFF_ROAD
  notes                 TEXT
);

CREATE TABLE mdts (
  id          BIGSERIAL PRIMARY KEY,
  mdt_code    TEXT NOT NULL UNIQUE,
  serial      TEXT NOT NULL UNIQUE,
  callsign_id BIGINT REFERENCES callsigns(id) ON DELETE SET NULL,
  vehicle_id  BIGINT REFERENCES vehicles(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'OFFLINE',            -- OFFLINE | ONLINE, the WS connection state
  duty_status TEXT NOT NULL DEFAULT 'AVAILABLE',           -- AVAILABLE | BUSY | MEAL_BREAK | OUT_OF_SERVICE
  job_id      BIGINT,
  battery     SMALLINT NOT NULL DEFAULT 100,
  network     TEXT,
  operator    TEXT,
  lat         DOUBLE PRECISION,
  lon         DOUBLE PRECISION,
  connected   BOOLEAN NOT NULL DEFAULT FALSE,
  crew        JSONB NOT NULL DEFAULT '[]'::jsonb,          -- [{id, name, signed_in_at}], up to 3
  emergency   BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX mdts_callsign_idx ON mdts(callsign_id);

CREATE TABLE personnel (
  id                 BIGSERIAL PRIMARY KEY,
  employee_no        TEXT UNIQUE,
  name               TEXT NOT NULL,
  rank               TEXT,
  contact_phone      TEXT,
  contact_email      TEXT,
  employment_status  employment_status NOT NULL DEFAULT 'ACTIVE',
  callsign_id        BIGINT REFERENCES callsigns(id) ON DELETE SET NULL,
  user_id            BIGINT,             -- FK added after users; the FIELD_USER login, once they have one
  vehicle_id         BIGINT REFERENCES vehicles(id) ON DELETE SET NULL,
  welfare_interval_s INTEGER,
  welfare_due_at     TIMESTAMPTZ,
  welfare_warned     BOOLEAN NOT NULL DEFAULT FALSE,
  welfare_note       TEXT,
  notes              TEXT
);
CREATE INDEX personnel_callsign_idx ON personnel(callsign_id);

ALTER TABLE vehicles ADD CONSTRAINT vehicles_assigned_personnel_fk FOREIGN KEY (assigned_personnel_id) REFERENCES personnel(id) ON DELETE SET NULL;

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,              -- scrypt; never store plaintext
  role          user_role NOT NULL,
  display_name  TEXT NOT NULL,
  personnel_id  BIGINT REFERENCES personnel(id) ON DELETE SET NULL,
  mdt_id        BIGINT REFERENCES mdts(id) ON DELETE SET NULL,
  email         TEXT UNIQUE,                -- work email; if set, matches Microsoft SSO sign-in to this account
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE personnel ADD CONSTRAINT personnel_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE sites (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  address       TEXT,
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  keyholder     TEXT,
  contact_email TEXT,
  contract      TEXT NOT NULL DEFAULT 'ACTIVE',
  checklist     JSONB NOT NULL DEFAULT '[]'::jsonb          -- on-scene checklist template: [{id, title, instructions}]
);

CREATE TYPE site_visit_status AS ENUM ('SCHEDULED','DISPATCHED','ACKNOWLEDGED','EN_ROUTE','ON_SCENE','COMPLETED','CANCELLED','MISSED');

-- A recurring patrol cadence, e.g. "every 4 hours" (interval_hours) or
-- "Mon/Wed/Fri at 22:00" (days_of_week + time_of_day). Exactly one of those
-- two cadence shapes is set. patrolScheduleTick() in server.js turns a due
-- occurrence into a site_visits row.
CREATE TABLE patrol_schedules (
  id                     BIGSERIAL PRIMARY KEY,
  site_id                BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  label                  TEXT NOT NULL,
  days_of_week           SMALLINT[],          -- 0=Sun..6=Sat, paired with time_of_day
  time_of_day            TEXT,                -- 'HH:MM'
  interval_hours         INTEGER,             -- alternative cadence: every N hours
  duration_expected_min  INTEGER NOT NULL DEFAULT 30,
  active                 BOOLEAN NOT NULL DEFAULT TRUE
);

-- A scheduled patrol visit — the persistent, recurring counterpart to a
-- one-off job. No TRANSPORTING (nobody is carried anywhere); MISSED is a
-- visit the schedule tick created that nobody ever dispatched in time.
-- Assignment is direct fields here rather than a join table like
-- job_assignments, since a visit is never assigned to an MDT.
CREATE TABLE site_visits (
  id                     BIGSERIAL PRIMARY KEY,
  reference              TEXT NOT NULL UNIQUE,
  site_id                BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  schedule_id            BIGINT REFERENCES patrol_schedules(id) ON DELETE SET NULL,
  personnel_id           BIGINT REFERENCES personnel(id) ON DELETE SET NULL,   -- primary assignee
  additional_personnel   BIGINT[] NOT NULL DEFAULT '{}',                        -- team patrols
  status                 site_visit_status NOT NULL DEFAULT 'SCHEDULED',
  scheduled_for          TIMESTAMPTZ NOT NULL,
  dispatched_at          TIMESTAMPTZ,
  acknowledged_at        TIMESTAMPTZ,
  en_route_at            TIMESTAMPTZ,
  on_scene_at            TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,
  missed_at              TIMESTAMPTZ,
  notes                  TEXT,
  checklist              JSONB NOT NULL DEFAULT '[]'::jsonb,   -- instantiated from the site's template, same shape as jobs.checklist
  media                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  report_html            TEXT,
  created_by             BIGINT REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX site_visits_status_idx   ON site_visits(status);
CREATE INDEX site_visits_schedule_idx ON site_visits(schedule_id);

CREATE TABLE jobs (
  id                     BIGSERIAL PRIMARY KEY,
  reference              TEXT NOT NULL UNIQUE,
  incident_type          TEXT NOT NULL,
  priority               job_priority NOT NULL,
  status                 job_status NOT NULL DEFAULT 'CREATED',
  location               TEXT NOT NULL,
  site_id                BIGINT REFERENCES sites(id) ON DELETE SET NULL,
  keyholder              TEXT,
  lat                    DOUBLE PRECISION,
  lon                    DOUBLE PRECISION,
  description            TEXT,
  caller                 TEXT,
  required_resources     SMALLINT NOT NULL DEFAULT 1,
  what3words             TEXT,
  notes                  TEXT,
  checklist              JSONB NOT NULL DEFAULT '[]'::jsonb, -- instantiated from the site's template: [{id, title, instructions, status, notes, completed_by, completed_at}]
  media                  JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{id, url, filename, caption, checklist_item_id, taken_by, taken_at}]
  resolution_report_html TEXT,
  external_source        TEXT,                                -- e.g. 'guardm8'
  external_ref           TEXT,                                -- idempotency key for an external integration's retry
  emergency_id           BIGINT,           -- FK added after emergency_events; set when auto-created from an emergency
  dispatched_at          TIMESTAMPTZ,
  acknowledged_at        TIMESTAMPTZ,
  en_route_at            TIMESTAMPTZ,
  on_scene_at            TIMESTAMPTZ,
  transporting_at        TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  created_by             BIGINT REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_status_idx   ON jobs(status);
CREATE INDEX jobs_priority_idx ON jobs(priority);
CREATE UNIQUE INDEX jobs_external_ref_uniq ON jobs(external_source, external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE mdts ADD CONSTRAINT mdts_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;

CREATE TABLE job_assignments (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  personnel_id    BIGINT REFERENCES personnel(id) ON DELETE CASCADE,
  mdt_id          BIGINT REFERENCES mdts(id) ON DELETE CASCADE,
  callsign_id     BIGINT REFERENCES callsigns(id) ON DELETE SET NULL,
  acknowledged    BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  last_distance_m DOUBLE PRECISION,        -- baseline for checkAutoJobProgress's "getting closer" detection
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (personnel_id IS NOT NULL OR mdt_id IS NOT NULL)
);
CREATE UNIQUE INDEX job_assignment_personnel_uniq ON job_assignments(job_id, personnel_id) WHERE personnel_id IS NOT NULL;
CREATE UNIQUE INDEX job_assignment_mdt_uniq       ON job_assignments(job_id, mdt_id)       WHERE mdt_id IS NOT NULL;

CREATE TABLE messages (
  id                BIGSERIAL PRIMARY KEY,
  body              TEXT NOT NULL,
  from_label        TEXT NOT NULL,
  to_label          TEXT NOT NULL,
  from_personnel_id BIGINT REFERENCES personnel(id) ON DELETE SET NULL,
  from_mdt_id       BIGINT REFERENCES mdts(id) ON DELETE SET NULL,
  to_personnel_id   BIGINT REFERENCES personnel(id) ON DELETE SET NULL,
  to_mdt_id         BIGINT REFERENCES mdts(id) ON DELETE SET NULL,
  state             TEXT NOT NULL DEFAULT 'DELIVERED',  -- DELIVERED | READ
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at           TIMESTAMPTZ
);
CREATE INDEX messages_to_personnel_idx ON messages(to_personnel_id, sent_at DESC);
CREATE INDEX messages_to_mdt_idx       ON messages(to_mdt_id, sent_at DESC);

-- Callback requests: a person on foot asking control to call them back, since
-- there is no PTT/radio channel to request one over any more.
CREATE TABLE call_requests (
  id             BIGSERIAL PRIMARY KEY,
  personnel_id   BIGINT NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  callsign       TEXT,
  priority       BOOLEAN NOT NULL DEFAULT FALSE,
  note           TEXT,
  state          callback_state NOT NULL DEFAULT 'PENDING',
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  escalated_at   TIMESTAMPTZ,
  answered_at    TIMESTAMPTZ,
  answered_by    TEXT,
  cancelled_at   TIMESTAMPTZ
);
CREATE INDEX call_requests_state_idx ON call_requests(state);

CREATE TABLE locations (
  id           BIGSERIAL PRIMARY KEY,
  mdt_id       BIGINT REFERENCES mdts(id) ON DELETE CASCADE,
  personnel_id BIGINT REFERENCES personnel(id) ON DELETE CASCADE,
  lat          DOUBLE PRECISION NOT NULL,
  lon          DOUBLE PRECISION NOT NULL,
  speed        INTEGER,
  heading      INTEGER,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (mdt_id IS NOT NULL OR personnel_id IS NOT NULL)
);
CREATE INDEX locations_mdt_time_idx       ON locations(mdt_id, recorded_at DESC);
CREATE INDEX locations_personnel_time_idx ON locations(personnel_id, recorded_at DESC);

CREATE TABLE emergency_events (
  id              BIGSERIAL PRIMARY KEY,
  kind            TEXT NOT NULL DEFAULT 'EMERGENCY',   -- EMERGENCY | WELFARE
  personnel_id    BIGINT REFERENCES personnel(id) ON DELETE CASCADE,
  mdt_id          BIGINT REFERENCES mdts(id) ON DELETE CASCADE,
  mdt_code        TEXT,
  callsign        TEXT,
  lat             DOUBLE PRECISION,
  lon             DOUBLE PRECISION,
  note            TEXT,
  state           emergency_state NOT NULL DEFAULT 'ACTIVE',
  activated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  resolved_at     TIMESTAMPTZ,
  job_id          BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  CHECK (personnel_id IS NOT NULL OR mdt_id IS NOT NULL)
);
CREATE INDEX emergency_open_idx ON emergency_events(state) WHERE state <> 'RESOLVED';

ALTER TABLE jobs ADD CONSTRAINT jobs_emergency_fk FOREIGN KEY (emergency_id) REFERENCES emergency_events(id) ON DELETE SET NULL;

CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_type_idx ON audit_logs(type, recorded_at DESC);

CREATE TABLE push_subscriptions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);

CREATE TYPE shift_status AS ENUM ('SCHEDULED','CONFIRMED','CLOCKED_IN','CLOCKED_OUT','NO_SHOW','CANCELLED');

CREATE TABLE shifts (
  id             BIGSERIAL PRIMARY KEY,
  personnel_id   BIGINT NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  site_id        BIGINT REFERENCES sites(id) ON DELETE SET NULL,
  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ NOT NULL,
  role_type      TEXT,
  status         shift_status NOT NULL DEFAULT 'SCHEDULED',
  clocked_in_at  TIMESTAMPTZ,
  clocked_out_at TIMESTAMPTZ,
  notes          TEXT,
  created_by     BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX shifts_personnel_idx ON shifts(personnel_id, starts_at);
CREATE INDEX shifts_site_idx      ON shifts(site_id);

CREATE TYPE asset_category AS ENUM ('EQUIPMENT','UNIFORM','KEY','DEVICE','OTHER');
CREATE TYPE asset_status   AS ENUM ('IN_USE','IN_STORE','LOST','RETIRED');

CREATE TABLE assets (
  id              BIGSERIAL PRIMARY KEY,
  tag             TEXT UNIQUE,
  category        asset_category NOT NULL,
  description     TEXT NOT NULL,
  serial_no       TEXT,
  assigned_to     BIGINT REFERENCES personnel(id) ON DELETE SET NULL,
  site_id         BIGINT REFERENCES sites(id) ON DELETE SET NULL,
  status          asset_status NOT NULL DEFAULT 'IN_STORE',
  purchase_date   DATE,
  last_checked_at TIMESTAMPTZ,
  notes           TEXT
);
CREATE INDEX assets_assigned_idx ON assets(assigned_to);
CREATE INDEX assets_category_idx ON assets(category);

-- Per-site shift-handover notes. Append-only: no updated_at/edit path, a
-- deletion is a control correction rather than an edit. author_personnel_id
-- is set when a FIELD_USER writes the note, left null for a control-room
-- author (whose name is still captured in author_name).
CREATE TABLE passdown_logs (
  id                  BIGSERIAL PRIMARY KEY,
  site_id             BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  body                TEXT NOT NULL,
  author_personnel_id BIGINT REFERENCES personnel(id) ON DELETE SET NULL,
  author_name         TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX passdown_logs_site_idx ON passdown_logs(site_id, created_at DESC);

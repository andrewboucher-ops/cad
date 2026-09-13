-- CCCS — target PostgreSQL schema.
-- The POC runs an in-memory store with exactly these entities and relationships;
-- this file is the migration target for swapping in a real database.

CREATE TYPE radio_type    AS ENUM ('HANDHELD','VEHICLE','FIXED','MDT');
CREATE TYPE radio_status  AS ENUM ('OFFLINE','AVAILABLE','BUSY','ON_TASK','EN_ROUTE','ON_SCENE','EMERGENCY','OUT_OF_SERVICE');
CREATE TYPE job_status    AS ENUM ('CREATED','DISPATCHED','ACKNOWLEDGED','EN_ROUTE','ON_SCENE','TRANSPORTING','COMPLETED','CANCELLED');
CREATE TYPE job_priority  AS ENUM ('RED','AMBER','GREEN','ROUTINE');
CREATE TYPE user_role     AS ENUM ('SYSTEM_ADMIN','DISPATCHER','SUPERVISOR','RADIO_USER','MDT_USER');
CREATE TYPE call_kind     AS ENUM ('PRIVATE','GROUP','BROADCAST');
CREATE TYPE call_state    AS ENUM ('RINGING','ACTIVE','ENDED');

CREATE TABLE callsigns (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id           BIGSERIAL PRIMARY KEY,
  registration TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL
);

CREATE TABLE personnel (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  rank         TEXT,
  callsign_id  BIGINT REFERENCES callsigns(id) ON DELETE SET NULL
);
CREATE INDEX personnel_callsign_idx ON personnel(callsign_id);

CREATE TABLE talkgroups (
  id                     BIGSERIAL PRIMARY KEY,
  name                   TEXT NOT NULL UNIQUE,
  description            TEXT,
  floor_holder_radio_id  BIGINT,          -- FK added after radios
  floor_console_user_id  BIGINT,
  floor_since            TIMESTAMPTZ
);

CREATE TABLE radios (
  id               BIGSERIAL PRIMARY KEY,
  issi             TEXT NOT NULL,
  alias            TEXT NOT NULL,
  radio_type       radio_type NOT NULL DEFAULT 'HANDHELD',
  status           radio_status NOT NULL DEFAULT 'OFFLINE',
  callsign_id      BIGINT REFERENCES callsigns(id) ON DELETE SET NULL,
  vehicle_id       BIGINT REFERENCES vehicles(id) ON DELETE SET NULL,
  talkgroup_id     BIGINT REFERENCES talkgroups(id) ON DELETE SET NULL,
  job_id           BIGINT,
  assigned_user_id BIGINT,
  battery          SMALLINT NOT NULL DEFAULT 100,
  signal           TEXT,
  lat              DOUBLE PRECISION,
  lon              DOUBLE PRECISION,
  speed            INTEGER NOT NULL DEFAULT 0,
  heading          INTEGER NOT NULL DEFAULT 0,
  emergency        BOOLEAN NOT NULL DEFAULT FALSE,
  connected        BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen        TIMESTAMPTZ,
  CONSTRAINT radios_issi_unique UNIQUE (issi),      -- ISSI uniquely identifies a radio
  CONSTRAINT radios_issi_format CHECK (issi ~ '^[0-9]{6,15}$')
);
CREATE INDEX radios_callsign_idx  ON radios(callsign_id);
CREATE INDEX radios_talkgroup_idx ON radios(talkgroup_id);
CREATE INDEX radios_status_idx    ON radios(status);

ALTER TABLE talkgroups
  ADD CONSTRAINT talkgroups_floor_fk FOREIGN KEY (floor_holder_radio_id) REFERENCES radios(id) ON DELETE SET NULL;

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,              -- scrypt; never store plaintext
  role          user_role NOT NULL,
  display_name  TEXT NOT NULL,
  radio_id      BIGINT REFERENCES radios(id) ON DELETE SET NULL,
  mdt_id        BIGINT,
  email         TEXT UNIQUE,                -- work email; if set, matches Microsoft SSO sign-in to this account
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mdts (
  id          BIGSERIAL PRIMARY KEY,
  mdt_code    TEXT NOT NULL UNIQUE,
  serial      TEXT NOT NULL UNIQUE,
  callsign_id BIGINT REFERENCES callsigns(id) ON DELETE SET NULL,
  vehicle_id  BIGINT REFERENCES vehicles(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'OFFLINE',
  job_id      BIGINT,
  battery     SMALLINT NOT NULL DEFAULT 100,
  network     TEXT,
  operator    TEXT,
  lat         DOUBLE PRECISION,
  lon         DOUBLE PRECISION,
  connected   BOOLEAN NOT NULL DEFAULT FALSE
);
ALTER TABLE users ADD CONSTRAINT users_mdt_fk FOREIGN KEY (mdt_id) REFERENCES mdts(id) ON DELETE SET NULL;

CREATE TABLE talkgroup_members (
  id           BIGSERIAL PRIMARY KEY,
  talkgroup_id BIGINT NOT NULL REFERENCES talkgroups(id) ON DELETE CASCADE,
  radio_id     BIGINT NOT NULL REFERENCES radios(id) ON DELETE CASCADE,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (talkgroup_id, radio_id)
);

CREATE TABLE jobs (
  id                 BIGSERIAL PRIMARY KEY,
  reference          TEXT NOT NULL UNIQUE,
  incident_type      TEXT NOT NULL,
  priority           job_priority NOT NULL,
  status             job_status NOT NULL DEFAULT 'CREATED',
  location           TEXT NOT NULL,
  lat                DOUBLE PRECISION,
  lon                DOUBLE PRECISION,
  description        TEXT,
  caller             TEXT,
  required_resources SMALLINT NOT NULL DEFAULT 1,
  notes              TEXT,
  created_by         BIGINT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_status_idx   ON jobs(status);
CREATE INDEX jobs_priority_idx ON jobs(priority);

ALTER TABLE radios ADD CONSTRAINT radios_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE mdts   ADD CONSTRAINT mdts_job_fk   FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;

CREATE TABLE job_assignments (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  radio_id        BIGINT REFERENCES radios(id) ON DELETE CASCADE,
  mdt_id          BIGINT REFERENCES mdts(id) ON DELETE CASCADE,
  callsign_id     BIGINT REFERENCES callsigns(id) ON DELETE SET NULL,
  acknowledged    BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (radio_id IS NOT NULL OR mdt_id IS NOT NULL)
);
CREATE UNIQUE INDEX job_assignment_radio_uniq ON job_assignments(job_id, radio_id) WHERE radio_id IS NOT NULL;
CREATE UNIQUE INDEX job_assignment_mdt_uniq   ON job_assignments(job_id, mdt_id)   WHERE mdt_id IS NOT NULL;

CREATE TABLE communications (
  id                BIGSERIAL PRIMARY KEY,
  kind              call_kind NOT NULL,
  state             call_state NOT NULL DEFAULT 'RINGING',
  from_radio_id     BIGINT REFERENCES radios(id) ON DELETE SET NULL,
  from_label        TEXT NOT NULL,
  initiator_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  talkgroup_id      BIGINT REFERENCES talkgroups(id) ON DELETE SET NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at       TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  duration_s        INTEGER,
  end_reason        TEXT
);
CREATE INDEX communications_started_idx ON communications(started_at DESC);

CREATE TABLE communication_participants (
  id               BIGSERIAL PRIMARY KEY,
  communication_id BIGINT NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
  radio_id         BIGINT REFERENCES radios(id) ON DELETE SET NULL,
  role             TEXT NOT NULL,     -- CALLER | CALLEE
  state            TEXT NOT NULL      -- RINGING | CONNECTED | REJECTED
);

CREATE TABLE messages (
  id           BIGSERIAL PRIMARY KEY,
  body         TEXT NOT NULL,
  from_label   TEXT NOT NULL,
  to_label     TEXT NOT NULL,
  from_radio_id BIGINT REFERENCES radios(id) ON DELETE SET NULL,
  from_mdt_id   BIGINT REFERENCES mdts(id) ON DELETE SET NULL,
  to_radio_id   BIGINT REFERENCES radios(id) ON DELETE SET NULL,
  to_mdt_id     BIGINT REFERENCES mdts(id) ON DELETE SET NULL,
  state        TEXT NOT NULL DEFAULT 'DELIVERED',  -- DELIVERED | READ
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ
);
CREATE INDEX messages_to_radio_idx ON messages(to_radio_id, sent_at DESC);

CREATE TABLE locations (
  id       BIGSERIAL PRIMARY KEY,
  radio_id BIGINT NOT NULL REFERENCES radios(id) ON DELETE CASCADE,
  lat      DOUBLE PRECISION NOT NULL,
  lon      DOUBLE PRECISION NOT NULL,
  speed    INTEGER,
  heading  INTEGER,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX locations_radio_time_idx ON locations(radio_id, recorded_at DESC);

CREATE TABLE radio_status_history (
  id          BIGSERIAL PRIMARY KEY,
  radio_id    BIGINT NOT NULL REFERENCES radios(id) ON DELETE CASCADE,
  from_status radio_status,
  to_status   radio_status NOT NULL,
  reason      TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX radio_status_history_idx ON radio_status_history(radio_id, changed_at DESC);

CREATE TABLE emergency_events (
  id              BIGSERIAL PRIMARY KEY,
  radio_id        BIGINT NOT NULL REFERENCES radios(id) ON DELETE CASCADE,
  issi            TEXT NOT NULL,
  callsign        TEXT,
  lat             DOUBLE PRECISION,
  lon             DOUBLE PRECISION,
  state           TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE | ACKNOWLEDGED | RESOLVED
  activated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX emergency_open_idx ON emergency_events(state) WHERE state <> 'RESOLVED';

CREATE TABLE audit_logs (
  id        BIGSERIAL PRIMARY KEY,
  type      TEXT NOT NULL,
  summary   TEXT NOT NULL,
  data      JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_type_idx ON audit_logs(type, recorded_at DESC);

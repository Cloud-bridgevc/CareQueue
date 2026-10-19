-- CareQueue PostgreSQL schema (Amazon RDS for PostgreSQL 16).
-- Multi-tenant by agency_id with row-level security. Mirrors server/store.js.
-- Clients are stored minimally: addresses/access codes live in client_access,
-- readable only by the access-service role, never by the API role directly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE staff_role       AS ENUM ('admin', 'scheduler', 'supervisor', 'auditor', 'caregiver');
CREATE TYPE visit_status     AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled');
CREATE TYPE severity         AS ENUM ('critical', 'high', 'medium', 'low');
CREATE TYPE queue_status     AS ENUM ('open', 'acknowledged', 'resolved');
CREATE TYPE incident_status  AS ENUM ('reported', 'triaged', 'escalated', 'resolved');
CREATE TYPE summary_status   AS ENUM ('pending_review', 'needs_edit', 'approved', 'rejected');

CREATE TABLE agencies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'America/New_York',
  rules         jsonb NOT NULL DEFAULT '{}',          -- overrides of DEFAULT_RULES
  retention     jsonb NOT NULL DEFAULT '{}',          -- days per record class
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL REFERENCES agencies(id),
  idp_subject   text NOT NULL UNIQUE,                 -- Cognito / SAML subject; no passwords stored here
  display_name  text NOT NULL,
  role          staff_role NOT NULL,
  caregiver_id  uuid,                                 -- set for caregiver logins
  active        boolean NOT NULL DEFAULT true
);

CREATE TABLE caregivers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL REFERENCES agencies(id),
  display_name     text NOT NULL,
  role_title       text NOT NULL,
  home_zone        text NOT NULL,
  credentials      text[] NOT NULL DEFAULT '{}',
  languages        text[] NOT NULL DEFAULT '{}',
  max_weekly_hours numeric(5,1),
  status           text NOT NULL DEFAULT 'active',
  phone_e164_enc   bytea,                             -- KMS-encrypted; API returns masked form only
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE caregiver_availability (
  caregiver_id  uuid NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  weekday       smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts        time NOT NULL,
  ends          time NOT NULL CHECK (ends > starts),
  PRIMARY KEY (caregiver_id, weekday, starts)
);

CREATE TABLE caregiver_time_off (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id  uuid NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  period        tstzrange NOT NULL,
  reason        text CHECK (length(reason) <= 80)     -- brief, non-medical
);

CREATE TABLE clients (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id            uuid NOT NULL REFERENCES agencies(id),
  reference            text NOT NULL,                 -- e.g. "1042"
  initials             text NOT NULL,
  zone                 text NOT NULL,
  required_credentials text[] NOT NULL DEFAULT '{}',
  preferred_language   text,
  status               text NOT NULL DEFAULT 'active',
  UNIQUE (agency_id, reference)
);

-- Separated so the scheduling API never reads addresses or access codes.
CREATE TABLE client_access (
  client_id      uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  address_enc    bytea NOT NULL,
  access_notes_enc bytea
);

CREATE TABLE visits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id         uuid NOT NULL REFERENCES agencies(id),
  client_id         uuid NOT NULL REFERENCES clients(id),
  caregiver_id      uuid REFERENCES caregivers(id),
  scheduled         tstzrange NOT NULL,
  service_type      text NOT NULL,
  status            visit_status NOT NULL DEFAULT 'scheduled',
  cancel_reason     text,
  check_in_at       timestamptz,
  check_out_at      timestamptz,
  confirm_method    text,                             -- 'EVV mobile' | 'Telephony' | 'Office (manual)'
  manual_reason     text,
  confirmed_by      uuid REFERENCES staff_users(id),
  timesheet_signed  boolean,
  tasks_documented  boolean,                          -- administrative checklist complete; contents live in EVR/EHR
  mileage_logged    boolean,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visits_caregiver_time ON visits USING gist (caregiver_id, scheduled);
CREATE INDEX visits_agency_time    ON visits (agency_id, lower(scheduled));
-- Optional hard guard against double booking (the rules engine flags; this blocks):
-- ALTER TABLE visits ADD CONSTRAINT no_overlap EXCLUDE USING gist (caregiver_id WITH =, scheduled WITH &&) WHERE (status <> 'cancelled');

CREATE TABLE handover_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          uuid NOT NULL REFERENCES agencies(id),
  author_id          uuid NOT NULL REFERENCES staff_users(id),
  category           text NOT NULL,
  audience           staff_role[] NOT NULL,
  restricted         boolean NOT NULL DEFAULT false,  -- care observations
  requires_follow_up boolean NOT NULL DEFAULT false,
  body               text NOT NULL CHECK (length(body) <= 2000),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE handover_summaries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL REFERENCES agencies(id),
  requested_by     uuid NOT NULL REFERENCES staff_users(id),
  provider         text NOT NULL,                     -- 'bedrock:<model>' | 'local-extractive'
  source_note_ids  uuid[] NOT NULL,
  excluded_note_ids uuid[] NOT NULL DEFAULT '{}',
  draft            text NOT NULL,
  final_text       text,
  flags            text[] NOT NULL DEFAULT '{}',
  status           summary_status NOT NULL DEFAULT 'pending_review',
  reviewed_by      uuid REFERENCES staff_users(id),
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR (reviewed_by IS NOT NULL AND reviewed_by <> requested_by AND final_text IS NOT NULL))
);

CREATE TABLE queue_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL REFERENCES agencies(id),
  dedup_key        text NOT NULL,
  code             text NOT NULL,
  category         text NOT NULL,
  severity         severity NOT NULL,
  title            text NOT NULL,
  detail           text NOT NULL,
  basis            text NOT NULL,
  refs             jsonb NOT NULL DEFAULT '{}',
  status           queue_status NOT NULL DEFAULT 'open',
  assignee_id      uuid REFERENCES staff_users(id),
  condition_active boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  due_at           timestamptz NOT NULL,
  resolved_at      timestamptz,
  resolved_by      uuid REFERENCES staff_users(id),
  resolution       text,
  CHECK (status <> 'resolved' OR (resolution IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE UNIQUE INDEX queue_one_active_per_key ON queue_items (agency_id, dedup_key) WHERE status <> 'resolved';

CREATE TABLE queue_item_events (
  id          bigserial PRIMARY KEY,
  item_id     uuid NOT NULL REFERENCES queue_items(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,                                   -- NULL = system
  action      text NOT NULL,
  note        text
);

CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL REFERENCES agencies(id),
  title            text NOT NULL,
  category         text NOT NULL,
  severity         severity NOT NULL,
  status           incident_status NOT NULL DEFAULT 'reported',
  escalation_level smallint NOT NULL DEFAULT 0,
  visit_id         uuid REFERENCES visits(id),
  reported_by      uuid NOT NULL REFERENCES staff_users(id),
  owner_id         uuid REFERENCES staff_users(id),
  description      text NOT NULL,
  follow_up_due_at timestamptz,
  reported_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);

CREATE TABLE incident_events (
  id          bigserial PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid NOT NULL,
  action      text NOT NULL,
  note        text
);

-- Documents in S3: only metadata here. Objects are SSE-KMS, private, and served via short-lived presigned URLs.
CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL REFERENCES agencies(id),
  s3_key        text NOT NULL,                        -- agency/<agency_id>/<class>/<uuid>
  record_class  text NOT NULL,                        -- 'timesheet' | 'incident_attachment' | 'audit_export'
  linked_entity text, linked_id uuid,
  uploaded_by   uuid REFERENCES staff_users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit log: API role gets INSERT/SELECT only; trigger blocks UPDATE/DELETE.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  agency_id   uuid NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  outcome     text NOT NULL DEFAULT 'success',
  detail      jsonb NOT NULL DEFAULT '{}',
  prev_hash   text NOT NULL,
  hash        text NOT NULL
);
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Sales leads from the public site. Kept separate from operational data.
CREATE TABLE demo_leads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL, email text NOT NULL, agency_name text NOT NULL,
  size_band   text NOT NULL, state text NOT NULL, job_title text NOT NULL,
  message     text,                                   -- never synced to HubSpot
  consent     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crm_outbox (
  id          bigserial PRIMARY KEY,
  lead_id     uuid REFERENCES demo_leads(id),
  payload     jsonb NOT NULL,                         -- allowlisted fields only (integrations/hubspot.js)
  status      text NOT NULL DEFAULT 'pending',        -- pending | sent | blocked | failed
  attempts    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Row-level security: every tenant table is filtered by the agency set on the connection.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_users','caregivers','clients','visits','handover_notes','handover_summaries','queue_items','incidents','documents','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (agency_id = current_setting(''app.agency_id'')::uuid)', t);
  END LOOP;
END $$;

-- Roles
CREATE ROLE carequeue_api NOLOGIN;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO carequeue_api;
REVOKE ALL ON client_access FROM carequeue_api;
REVOKE UPDATE, DELETE ON audit_log FROM carequeue_api;
CREATE ROLE carequeue_retention NOLOGIN;           -- used only by the retention Lambda
GRANT SELECT, DELETE ON handover_notes, handover_summaries, queue_items, queue_item_events, visits, demo_leads, documents TO carequeue_retention;

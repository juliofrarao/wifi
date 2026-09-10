-- Creche Segura — SQLite schema (v2). Applied on startup (idempotent).
-- All ids are UUID v4. Instants are ISO 8601 UTC ("...Z"); civil dates are YYYY-MM-DD.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,              -- detected by magic bytes, never client-supplied
  size       INTEGER NOT NULL,
  path       TEXT NOT NULL,              -- relative to DATA_DIR/uploads, e.g. "<id>.jpg"
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  email                TEXT COLLATE NOCASE,                   -- optional (guardians without e-mail)
  login                TEXT COLLATE NOCASE,                   -- optional short login (guards)
  phone                TEXT,
  role                 TEXT NOT NULL CHECK (role IN ('admin','guard','guardian')),
  password_hash        TEXT,                                  -- NULL until invite accepted
  pin_hash             TEXT,                                  -- guards: quick switch PIN
  photo_file_id        TEXT REFERENCES files(id) ON DELETE SET NULL,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notify_checkin_push  INTEGER NOT NULL DEFAULT 1 CHECK (notify_checkin_push IN (0,1)),
  notify_checkin_email INTEGER NOT NULL DEFAULT 0 CHECK (notify_checkin_email IN (0,1)),
  last_email_error     TEXT,
  password_set_at      TEXT,
  anonymized_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (role = 'guardian' OR email IS NOT NULL OR login IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users(login) WHERE login IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, active);

CREATE TABLE IF NOT EXISTS children (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  birth_date           TEXT,                                  -- YYYY-MM-DD
  class_name           TEXT,
  shift                TEXT CHECK (shift IS NULL OR shift IN ('manha','tarde','integral')),
  gate_alert           TEXT,                                  -- short, guard-visible (red banner)
  notes                TEXT,                                  -- admin only
  photo_file_id        TEXT REFERENCES files(id) ON DELETE SET NULL,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  deactivated_at       TEXT,
  consent_at           TEXT,                                  -- YYYY-MM-DD
  consent_by_name      TEXT,
  consent_relationship TEXT CHECK (consent_relationship IS NULL OR consent_relationship IN ('mae','pai','responsavel_legal')),
  anonymized_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_children_active ON children(active, class_name);

CREATE TABLE IF NOT EXISTS child_guardians (
  id             TEXT PRIMARY KEY,
  child_id       TEXT NOT NULL REFERENCES children(id) ON DELETE RESTRICT,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  relationship   TEXT NOT NULL CHECK (relationship IN ('mae','pai','avo','avoh','tio','tia','irmao','irma','padrasto','madrasta','responsavel_legal','outro')),
  can_pickup     INTEGER NOT NULL DEFAULT 1 CHECK (can_pickup IN (0,1)),
  is_primary     INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  valid_from     TEXT,                                        -- YYYY-MM-DD, NULL = no start
  valid_until    TEXT,                                        -- YYYY-MM-DD, NULL = no expiry
  blocked        INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0,1)),
  blocked_reason TEXT,                                        -- admin only
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_by     TEXT,
  updated_at     TEXT NOT NULL,
  removed_at     TEXT,                                        -- soft removal
  removed_by     TEXT
);
-- One live link per (child, guardian); removed links may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_child_guardians_live ON child_guardians(child_id, user_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_child_guardians_user ON child_guardians(user_id);

CREATE TABLE IF NOT EXISTS pickup_authorizations (
  id                 TEXT PRIMARY KEY,
  child_id           TEXT NOT NULL REFERENCES children(id) ON DELETE RESTRICT,
  person_name        TEXT NOT NULL,
  person_document    TEXT,                                    -- admin only; purged after 12 months
  relationship_label TEXT NOT NULL,
  phone              TEXT,
  valid_from         TEXT NOT NULL,                           -- YYYY-MM-DD
  valid_until        TEXT NOT NULL,                           -- YYYY-MM-DD (inclusive)
  note               TEXT,
  created_by         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL,
  revoked_at         TEXT,
  revoked_by         TEXT
);
CREATE INDEX IF NOT EXISTS idx_pickup_auth_child ON pickup_authorizations(child_id, valid_until);

CREATE TABLE IF NOT EXISTS credentials (
  id         TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('guardian','child')),
  owner_id   TEXT NOT NULL,
  code       TEXT,                                            -- normalized: 8 uppercase chars
  nfc_uid    TEXT,                                            -- normalized: lowercase hex
  label      TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  CHECK (code IS NOT NULL OR nfc_uid IS NOT NULL)
);
-- Only one ACTIVE credential may hold a given code / uid; revoked ones may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_active_code ON credentials(code) WHERE active = 1 AND code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_active_uid ON credentials(nfc_uid) WHERE active = 1 AND nfc_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credentials_owner ON credentials(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS attendance_events (
  id                    TEXT PRIMARY KEY,
  client_id             TEXT UNIQUE,                          -- idempotency key (one per child per confirmation)
  batch_id              TEXT NOT NULL,                        -- one per confirmation (siblings share it)
  child_id              TEXT NOT NULL REFERENCES children(id) ON DELETE RESTRICT,
  child_name            TEXT NOT NULL,                        -- snapshot
  type                  TEXT NOT NULL CHECK (type IN ('checkin','checkout','denied')),
  guardian_id           TEXT REFERENCES users(id) ON DELETE RESTRICT,
  guardian_name         TEXT,                                 -- snapshot
  guardian_relationship TEXT,                                 -- snapshot
  person_name           TEXT,                                 -- unregistered person
  person_document       TEXT,                                 -- admin only; purged after 12 months
  document_checked      INTEGER NOT NULL DEFAULT 0 CHECK (document_checked IN (0,1)),
  authorization_id      TEXT REFERENCES pickup_authorizations(id) ON DELETE RESTRICT,
  authorized_by_name    TEXT,                                 -- snapshot "Maria (mãe)"
  guard_id              TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  guard_name            TEXT NOT NULL,                        -- snapshot
  method                TEXT NOT NULL CHECK (method IN ('nfc','qr','code','search','manual','auto')),
  credential_id         TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
  override              INTEGER NOT NULL DEFAULT 0 CHECK (override IN (0,1)),
  conflict              TEXT CHECK (conflict IS NULL OR conflict IN ('already_present','already_out')),
  queued                INTEGER NOT NULL DEFAULT 0 CHECK (queued IN (0,1)),
  directory_at          TEXT,                                 -- directory generatedAt on the device (queued events)
  note                  TEXT,
  occurred_at           TEXT NOT NULL,                        -- ISO UTC
  created_at            TEXT NOT NULL,
  voided_at             TEXT,
  voided_by             TEXT,
  void_reason           TEXT,
  CHECK (guardian_id IS NOT NULL OR person_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_events_child_time ON attendance_events(child_id, occurred_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_time ON attendance_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_batch ON attendance_events(batch_id);

CREATE TABLE IF NOT EXISTS notifications (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind           TEXT NOT NULL CHECK (kind IN ('checkin','checkout','denied','void','guardian_added','authorization_added','credential_revoked','system')),
  batch_id       TEXT,                                        -- attendance batch (NULL for non-attendance kinds)
  event_id       TEXT REFERENCES attendance_events(id) ON DELETE RESTRICT,
  child_ids      TEXT NOT NULL DEFAULT '[]',                  -- JSON array
  channel        TEXT NOT NULL CHECK (channel IN ('inapp','push','email')),
  status         TEXT NOT NULL CHECK (status IN ('pending','sent','failed','skipped')),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  override       INTEGER NOT NULL DEFAULT 0 CHECK (override IN (0,1)),
  payload_json   TEXT,                                        -- extra data (e.g. html body)
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  dispatch_after TEXT NOT NULL,                               -- ISO UTC; hold window
  read_at        TEXT,
  sent_at        TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_batch ON notifications(user_id, batch_id, channel) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_dispatch ON notifications(status, dispatch_after);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,                                 -- sliding; absolute cap enforced via created_at
  switch_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  created_at      TEXT NOT NULL,
  last_success_at TEXT,
  last_error      TEXT
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, kind);

CREATE TABLE IF NOT EXISTS login_attempts (
  key        TEXT NOT NULL,                                   -- 'id:<identifier>' | 'ip:<ip>' | 'lookup:<sessionId>'
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(key, at);

CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  actor_id     TEXT,
  actor_name   TEXT,
  action       TEXT NOT NULL,                                 -- e.g. 'user.create', 'link.update', 'credential.revoke'
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  details_json TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

CREATE TABLE IF NOT EXISTS gate_heartbeats (
  session_id       TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  queued_count     INTEGER NOT NULL DEFAULT 0,
  oldest_queued_at TEXT,
  app_version      TEXT,
  at               TEXT NOT NULL
);

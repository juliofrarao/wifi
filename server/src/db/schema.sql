-- Creche Segura — SQLite schema. Applied on startup (idempotent).
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  path       TEXT NOT NULL,             -- relative to DATA_DIR/uploads
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  email                TEXT NOT NULL COLLATE NOCASE UNIQUE,
  phone                TEXT,
  role                 TEXT NOT NULL CHECK (role IN ('admin','guard','guardian')),
  password_hash        TEXT,                                  -- NULL until invite accepted
  photo_file_id        TEXT REFERENCES files(id) ON DELETE SET NULL,
  active               INTEGER NOT NULL DEFAULT 1,
  notify_checkin_push  INTEGER NOT NULL DEFAULT 1,
  notify_checkin_email INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS children (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  birth_date    TEXT,                    -- YYYY-MM-DD
  class_name    TEXT,
  notes         TEXT,
  photo_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS child_guardians (
  child_id     TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,
  can_pickup   INTEGER NOT NULL DEFAULT 1,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  valid_until  TEXT,                     -- YYYY-MM-DD, NULL = no expiry
  created_at   TEXT NOT NULL,
  PRIMARY KEY (child_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_child_guardians_user ON child_guardians(user_id);

CREATE TABLE IF NOT EXISTS credentials (
  id         TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('guardian','child')),
  owner_id   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('code','nfc_uid')),
  value      TEXT NOT NULL,              -- normalized: code = uppercase, uid = lowercase hex
  label      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
-- Only one ACTIVE credential may hold a given value; revoked ones may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_active_value ON credentials(kind, value) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_credentials_owner ON credentials(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS attendance_events (
  id              TEXT PRIMARY KEY,
  client_id       TEXT UNIQUE,           -- idempotency key from the guard app
  child_id        TEXT NOT NULL REFERENCES children(id),
  type            TEXT NOT NULL CHECK (type IN ('checkin','checkout')),
  guardian_id     TEXT REFERENCES users(id),
  person_name     TEXT,                  -- unregistered person (override / drop-off)
  person_document TEXT,
  guard_id        TEXT NOT NULL REFERENCES users(id),
  method          TEXT NOT NULL CHECK (method IN ('nfc','qr','code','manual')),
  credential_id   TEXT REFERENCES credentials(id),
  override        INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  occurred_at     TEXT NOT NULL,         -- ISO UTC
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_child_time ON attendance_events(child_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_time ON attendance_events(occurred_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL REFERENCES attendance_events(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('inapp','push','email')),
  status     TEXT NOT NULL CHECK (status IN ('pending','sent','failed','skipped')),
  error      TEXT,
  read_at    TEXT,
  sent_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  key        TEXT NOT NULL,              -- 'email:<email>' or 'ip:<ip>'
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(key, at);

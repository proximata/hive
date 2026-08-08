'use strict'

// Schema and migrations. Migrations are append-only: add a new entry, never
// edit an existing one. `user_version` records how far a database has been
// migrated, so opening an old file upgrades it in place.

const MIGRATIONS = [
  // ---------------------------------------------------------------- 1: core --
  `
  CREATE TABLE events (
    id           TEXT PRIMARY KEY,
    pubkey       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    kind         INTEGER NOT NULL,
    tags         TEXT NOT NULL,
    content      TEXT NOT NULL,
    sig          TEXT NOT NULL,
    channel_id   TEXT,
    received_at  INTEGER NOT NULL,
    deleted_at   INTEGER
  );
  CREATE INDEX idx_events_kind_created  ON events (kind, created_at DESC);
  CREATE INDEX idx_events_pubkey_created ON events (pubkey, created_at DESC);
  CREATE INDEX idx_events_channel_created ON events (channel_id, created_at DESC);
  CREATE INDEX idx_events_channel_kind ON events (channel_id, kind, created_at DESC);

  CREATE TABLE event_tags (
    event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    value      TEXT NOT NULL,
    position   INTEGER NOT NULL
  );
  CREATE INDEX idx_event_tags_lookup ON event_tags (name, value, event_id);
  CREATE INDEX idx_event_tags_event  ON event_tags (event_id);

  -- Search index. bare-sqlite ships without FTS5, so this is a plain inverted
  -- index: portable across every driver and trivially auditable for the
  -- privacy exclusions in SPEC.md §5.4.
  CREATE TABLE event_tokens (
    token      TEXT NOT NULL,
    event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    channel_id TEXT,
    kind       INTEGER NOT NULL
  );
  CREATE INDEX idx_event_tokens_token ON event_tokens (token, event_id);
  CREATE INDEX idx_event_tokens_event ON event_tokens (event_id);

  CREATE TABLE event_mentions (
    pubkey     TEXT NOT NULL,
    event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (pubkey, event_id)
  );
  CREATE INDEX idx_event_mentions_feed ON event_mentions (pubkey, created_at DESC);

  CREATE TABLE thread_metadata (
    root_id       TEXT NOT NULL,
    channel_id    TEXT,
    reply_count   INTEGER NOT NULL DEFAULT 0,
    last_reply_at INTEGER,
    PRIMARY KEY (root_id)
  );

  -- Enforces NIP-16 / NIP-33 replacement. One row per addressable coordinate.
  CREATE TABLE replaceable (
    pubkey   TEXT NOT NULL,
    kind     INTEGER NOT NULL,
    d        TEXT NOT NULL,
    event_id TEXT NOT NULL,
    PRIMARY KEY (pubkey, kind, d)
  );
  `,

  // ------------------------------------------------------------ 2: channels --
  `
  CREATE TABLE channels (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    type               TEXT NOT NULL DEFAULT 'stream',
    visibility         TEXT NOT NULL DEFAULT 'open',
    about              TEXT NOT NULL DEFAULT '',
    topic              TEXT NOT NULL DEFAULT '',
    purpose            TEXT NOT NULL DEFAULT '',
    canvas             TEXT NOT NULL DEFAULT '',
    channel_add_policy TEXT NOT NULL DEFAULT 'anyone',
    created_by         TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    archived_at        INTEGER,
    deleted_at         INTEGER
  );
  CREATE INDEX idx_channels_name ON channels (name);

  CREATE TABLE channel_members (
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    pubkey     TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member',
    added_at   INTEGER NOT NULL,
    removed_at INTEGER,
    PRIMARY KEY (channel_id, pubkey)
  );
  CREATE INDEX idx_channel_members_pubkey ON channel_members (pubkey, removed_at);

  CREATE TABLE users (
    pubkey              TEXT PRIMARY KEY,
    display_name        TEXT,
    avatar              TEXT,
    about               TEXT,
    nip05               TEXT UNIQUE,
    status_text         TEXT,
    status_emoji        TEXT,
    presence            TEXT,
    presence_expires_at INTEGER,
    updated_at          INTEGER NOT NULL
  );

  CREATE TABLE relay_members (
    pubkey   TEXT PRIMARY KEY,
    role     TEXT NOT NULL DEFAULT 'member',
    added_at INTEGER NOT NULL,
    note     TEXT
  );

  CREATE TABLE pubkey_allowlist (
    pubkey   TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL,
    note     TEXT
  );
  `,

  // --------------------------------------------- 3: audit, media, workflows --
  `
  CREATE TABLE audit_log (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    event_id   TEXT,
    kind       INTEGER NOT NULL DEFAULT 0,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    channel_id TEXT,
    metadata   TEXT NOT NULL DEFAULT '{}',
    prev_hash  TEXT NOT NULL,
    hash       TEXT NOT NULL
  );
  CREATE INDEX idx_audit_actor ON audit_log (actor, seq);

  CREATE TABLE media (
    sha256      TEXT PRIMARY KEY,
    size        INTEGER NOT NULL,
    mime        TEXT NOT NULL,
    extension   TEXT NOT NULL DEFAULT '',
    uploaded_by TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE workflows (
    id          TEXT PRIMARY KEY,
    channel_id  TEXT,
    name        TEXT NOT NULL,
    definition  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    webhook_secret TEXT,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_workflows_channel ON workflows (channel_id, status);

  CREATE TABLE workflow_runs (
    id           TEXT PRIMARY KEY,
    workflow_id  TEXT NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'pending',
    trigger      TEXT NOT NULL DEFAULT '{}',
    trace        TEXT NOT NULL DEFAULT '[]',
    resume_step  TEXT,
    error        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_workflow_runs_workflow ON workflow_runs (workflow_id, created_at DESC);

  CREATE TABLE workflow_approvals (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    step_id     TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    approver    TEXT NOT NULL,
    message     TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    note        TEXT,
    expires_at  INTEGER,
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX idx_workflow_approvals_run ON workflow_approvals (run_id, status);
  `
]

function migrate (db) {
  const current = db.prepare('PRAGMA user_version').get().user_version

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version])
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  return MIGRATIONS.length
}

module.exports = { MIGRATIONS, migrate, SCHEMA_VERSION: MIGRATIONS.length }

'use strict'

// Postgres schema and migrations. Append-only, exactly like the SQLite list:
// add an entry, never edit one that has shipped.
//
// Two things differ from `lib/schema.js` beyond the type names:
//
//   * Postgres has no `PRAGMA user_version`, so applied versions are recorded
//     in a `schema_migrations` table.
//   * Search is a `tsvector` + GIN index instead of an `event_tokens` table.
//     The rows are still written only for searchable kinds, so the privacy
//     exclusion in SPEC.md §5.4 stays a write-time property.
//
// Unix timestamps are `BIGINT` rather than `INTEGER`: `int4` runs out in 2038,
// and a store whose whole point is an append-only audit trail should not have a
// cliff in it. `lib/pg/pool.js` registers an `int8` parser so they come back as
// JavaScript numbers, matching what the SQLite driver returns.

const MIGRATIONS = [
  // ---------------------------------------------------------------- 1: core --
  `
  CREATE TABLE events (
    id           TEXT PRIMARY KEY,
    pubkey       TEXT NOT NULL,
    created_at   BIGINT NOT NULL,
    kind         INTEGER NOT NULL,
    tags         TEXT NOT NULL,
    content      TEXT NOT NULL,
    sig          TEXT NOT NULL,
    channel_id   TEXT,
    received_at  BIGINT NOT NULL,
    deleted_at   BIGINT
  );
  CREATE INDEX idx_events_kind_created ON events (kind, created_at DESC);
  CREATE INDEX idx_events_pubkey_created ON events (pubkey, created_at DESC);
  CREATE INDEX idx_events_channel_created ON events (channel_id, created_at DESC);
  CREATE INDEX idx_events_channel_kind ON events (channel_id, kind, created_at DESC);

  -- text_pattern_ops so NIP-01 prefix matching (id LIKE 'abc%') can use an
  -- index; the default collation's opclass cannot serve LIKE on most locales.
  CREATE INDEX idx_events_id_prefix ON events (id text_pattern_ops);
  CREATE INDEX idx_events_pubkey_prefix ON events (pubkey text_pattern_ops);

  CREATE TABLE event_tags (
    event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    value      TEXT NOT NULL,
    position   INTEGER NOT NULL
  );
  CREATE INDEX idx_event_tags_lookup ON event_tags (name, value, event_id);
  CREATE INDEX idx_event_tags_event ON event_tags (event_id);

  -- Postgres FTS. The vector is built with array_to_tsvector from this store's
  -- own tokenizer output, not to_tsvector: the SQLite driver's inverted index
  -- and this one must agree on what a token is, or the same query would return
  -- different results depending on which driver a node happens to run.
  CREATE TABLE event_search (
    event_id TEXT PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
    tsv      TSVECTOR NOT NULL
  );
  CREATE INDEX idx_event_search_tsv ON event_search USING GIN (tsv);

  CREATE TABLE event_mentions (
    pubkey     TEXT NOT NULL,
    event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (pubkey, event_id)
  );
  CREATE INDEX idx_event_mentions_feed ON event_mentions (pubkey, created_at DESC);

  CREATE TABLE thread_metadata (
    root_id       TEXT PRIMARY KEY,
    channel_id    TEXT,
    reply_count   INTEGER NOT NULL DEFAULT 0,
    last_reply_at BIGINT
  );

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
    created_at         BIGINT NOT NULL,
    archived_at        BIGINT,
    deleted_at         BIGINT
  );
  CREATE INDEX idx_channels_name ON channels (name);

  CREATE TABLE channel_members (
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    pubkey     TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member',
    added_at   BIGINT NOT NULL,
    removed_at BIGINT,
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
    presence_expires_at BIGINT,
    updated_at          BIGINT NOT NULL
  );

  CREATE TABLE relay_members (
    pubkey   TEXT PRIMARY KEY,
    role     TEXT NOT NULL DEFAULT 'member',
    added_at BIGINT NOT NULL,
    note     TEXT
  );

  CREATE TABLE pubkey_allowlist (
    pubkey   TEXT PRIMARY KEY,
    added_at BIGINT NOT NULL,
    note     TEXT
  );
  `,

  // --------------------------------------------- 3: audit, media, workflows --
  `
  -- seq is assigned by the writer under an advisory lock rather than by a
  -- sequence: a BIGSERIAL hands out gaps on rollback, and a gap in a hash chain
  -- is indistinguishable from a deleted entry.
  CREATE TABLE audit_log (
    seq        BIGINT PRIMARY KEY,
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
    size        BIGINT NOT NULL,
    mime        TEXT NOT NULL,
    extension   TEXT NOT NULL DEFAULT '',
    uploaded_by TEXT NOT NULL,
    created_at  BIGINT NOT NULL
  );

  CREATE TABLE workflows (
    id             TEXT PRIMARY KEY,
    channel_id     TEXT,
    name           TEXT NOT NULL,
    definition     TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active',
    webhook_secret TEXT,
    created_by     TEXT NOT NULL,
    created_at     BIGINT NOT NULL,
    updated_at     BIGINT NOT NULL
  );
  CREATE INDEX idx_workflows_channel ON workflows (channel_id, status);

  CREATE TABLE workflow_runs (
    id          TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'pending',
    trigger     TEXT NOT NULL DEFAULT '{}',
    trace       TEXT NOT NULL DEFAULT '[]',
    resume_step TEXT,
    error       TEXT,
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL
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
    expires_at  BIGINT,
    created_at  BIGINT NOT NULL,
    resolved_at BIGINT
  );
  CREATE INDEX idx_workflow_approvals_run ON workflow_approvals (run_id, status);
  `
]

// Namespaced so the key cannot collide with an advisory lock some other
// application on the same cluster happens to take.
const MIGRATION_LOCK = 'hive:store:migrate'

/**
 * Bring one database up to the current version.
 *
 * Held under a session-level advisory lock for the whole run, so several relay
 * nodes booting against the same cluster at the same time queue up instead of
 * racing to create the same table. Each migration is its own transaction, and
 * Postgres DDL is transactional, so a failure leaves no half-applied version
 * behind.
 */
async function migrate (client) {
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [MIGRATION_LOCK])
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      '  version INTEGER PRIMARY KEY,' +
      '  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
      ')'
    )

    const { rows } = await client.query('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    const current = Number(rows[0].version)

    for (let version = current; version < MIGRATIONS.length; version++) {
      await client.query('BEGIN')
      try {
        await client.query(MIGRATIONS[version])
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version + 1])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    }

    return MIGRATIONS.length
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATION_LOCK])
  }
}

module.exports = { MIGRATIONS, migrate, MIGRATION_LOCK, SCHEMA_VERSION: MIGRATIONS.length }

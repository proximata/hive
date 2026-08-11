'use strict'

const {
  isEphemeral,
  isAddressable,
  isParameterizedReplaceable,
  isRelaySignedKind,
  isPGatedKind,
  indexableTags,
  dTag,
  referencedPubkeys,
  threadRefs,
  channelId: eventChannelId,
  KIND_AUTH,
  LIMITS
} = require('hive-core')

const { buildQuery, buildCountQuery } = require('./query')
const { tokensForEvent, tokenizeQuery } = require('./search')
const { GENESIS_HASH, entryHash, canonicalJson } = require('./audit')
const { StoreError } = require('./errors')
const { supersedes } = require('./sqlite-store')

const { migrate, SCHEMA_VERSION } = require('./pg/schema')
const { createPool } = require('./pg/pool')
const { toPositional, tsqueryFor } = require('./pg/sql')

// The Postgres driver, for multi-node deployments.
//
// Two deliberate differences from `SqliteStore`, and only two:
//
//   1. Every method is async. `bare-sqlite` is a synchronous, in-process
//      library; a network database is not, and pretending otherwise (a worker
//      thread plus Atomics.wait) would block the event loop on every read and
//      make the connection pool this driver exists for pointless.
//   2. Search uses `tsvector` + GIN rather than an `event_tokens` table.
//
// Everything else — return shapes, null-versus-undefined, ordering, tiebreaks,
// idempotency, soft deletes, the audit chain preimage — is identical, and
// `test/pg/conformance.js` runs one suite against both drivers to keep it that
// way.
//
// Cross-node safety: the two places where a check-then-write could interleave
// between nodes (replaceable-event resolution and the audit chain head) take a
// transaction-scoped advisory lock, which is the cluster-wide equivalent of the
// single writer queue SPEC.md §5.5 describes for SQLite.

function now () {
  return Math.floor(Date.now() / 1000)
}

function rowToEvent (row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: JSON.parse(row.tags),
    content: row.content,
    sig: row.sig
  }
}

function rowToStored (row) {
  if (row === undefined || row === null) return null
  return {
    event: rowToEvent(row),
    channelId: row.channel_id,
    receivedAt: row.received_at,
    deletedAt: row.deleted_at
  }
}

class PostgresStore {
  constructor (opts = {}) {
    this.pool = createPool(opts)
    this.location = opts.connectionString ?? opts.host ?? 'postgres'
    this.maxHistoricalLimit = opts.maxHistoricalLimit ?? LIMITS.MAX_HISTORICAL_LIMIT
    this.feedMaxLimit = opts.feedMaxLimit ?? LIMITS.FEED_MAX_LIMIT
    this.schemaVersion = null
    this.closed = false

    // The client a transaction is currently bound to. Reads and writes inside
    // `transaction()` must run on that one connection or they would not see
    // its uncommitted rows.
    this.tx = null

    // Transactions are serialized per store instance. That mirrors the SQLite
    // driver's `BEGIN IMMEDIATE` and, more importantly, keeps `this.tx` a
    // single slot: two overlapping transactions would otherwise steal each
    // other's connection.
    this.queue = Promise.resolve()
    this.ownsPool = opts.pool === undefined || opts.pool === null
    this.readyPromise = null
  }

  /** Connect and migrate. Idempotent — repeated calls await the first one. */
  async ready () {
    if (this.readyPromise === null) {
      this.readyPromise = this.#migrate()
    }
    await this.readyPromise
    return this
  }

  async #migrate () {
    const client = await this.pool.connect()
    try {
      this.schemaVersion = await migrate(client)
    } finally {
      client.release()
    }
    return this.schemaVersion
  }

  async close () {
    if (this.closed) return
    this.closed = true
    // A pool handed in by the caller belongs to the caller; ending it here
    // would close connections they are still using.
    if (this.ownsPool) await this.pool.end()
  }

  // ------------------------------------------------------------------- sql --

  async #exec (sql, params = []) {
    const target = this.tx ?? this.pool
    return target.query(toPositional(sql), params)
  }

  /** One row, or undefined — matching what `DatabaseSync#get` returns. */
  async #get (sql, params = []) {
    const { rows } = await this.#exec(sql, params)
    return rows[0]
  }

  async #all (sql, params = []) {
    const { rows } = await this.#exec(sql, params)
    return rows
  }

  /**
   * Run `fn` inside a transaction on a dedicated connection.
   *
   * Reentrant: a method that already runs inside a transaction and calls
   * another one joins the outer transaction instead of deadlocking on the
   * queue, so composition works the same way it does on SQLite.
   */
  async transaction (fn) {
    if (this.tx !== null) return fn()

    const run = async () => {
      const client = await this.pool.connect()
      this.tx = client
      try {
        await client.query('BEGIN')
        const result = await fn()
        await client.query('COMMIT')
        return result
      } catch (err) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // Rolling back a transaction the error already aborted is fine.
        }
        throw err
      } finally {
        this.tx = null
        client.release()
      }
    }

    // Chain on the tail without letting a rejection poison the queue for
    // everything after it.
    const previous = this.queue
    let release
    this.queue = new Promise((resolve) => { release = resolve })
    try {
      await previous
      return await run()
    } finally {
      release()
    }
  }

  /**
   * A transaction-scoped advisory lock. Held until COMMIT or ROLLBACK, so a
   * crashed writer cannot leave the cluster wedged.
   */
  async #lock (key) {
    await this.#exec('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key])
  }

  // ---------------------------------------------------------------- events --

  /**
   * Idempotent insert.
   *
   * Returns `{ stored, wasInserted, replaced }`. A known id is a no-op with
   * `wasInserted: false` — the relay turns that into `["OK", id, true,
   * "duplicate:"]`, since a duplicate is a success from the client's side.
   */
  async insertEvent (event, opts = {}) {
    if (event.kind === KIND_AUTH) throw StoreError.authEventForbidden()
    if (isEphemeral(event.kind)) throw StoreError.ephemeralForbidden(event.kind)

    const existing = await this.getStoredEvent(event.id)
    if (existing !== null) return { stored: existing, wasInserted: false, replaced: null }

    const channelId = opts.channelId ?? eventChannelId(event) ?? null
    const receivedAt = opts.receivedAt ?? now()

    return this.transaction(async () => {
      let replaced = null

      if (isAddressable(event.kind)) {
        const d = isParameterizedReplaceable(event.kind) ? dTag(event) : ''

        // Two nodes replacing the same coordinate must not both decide they
        // won. The lock covers the read of `replaceable` through the write.
        await this.#lock(`hive:replaceable:${event.pubkey}:${event.kind}:${d}`)

        const address = await this.#get(
          'SELECT event_id FROM replaceable WHERE pubkey = ? AND kind = ? AND d = ?',
          [event.pubkey, event.kind, d]
        )

        if (address !== undefined) {
          const previous = await this.getEvent(address.event_id)
          if (previous !== null && !supersedes(event, previous)) {
            // The incoming event is older, or ties and loses the id tiebreak.
            return { stored: await this.getStoredEvent(previous.id), wasInserted: false, replaced: null }
          }
          if (previous !== null) {
            await this.#purgeEvent(previous.id)
            replaced = previous.id
          }
        }

        await this.#exec(
          'INSERT INTO replaceable (pubkey, kind, d, event_id) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (pubkey, kind, d) DO UPDATE SET event_id = excluded.event_id',
          [event.pubkey, event.kind, d, event.id]
        )
      }

      await this.#exec(
        'INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, channel_id, received_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          event.id,
          event.pubkey,
          event.created_at,
          event.kind,
          JSON.stringify(event.tags),
          event.content,
          event.sig,
          channelId,
          receivedAt
        ]
      )

      await this.#indexTags(event)
      await this.#indexSearch(event)
      await this.#indexMentions(event)
      await this.#updateThread(event, channelId)

      return {
        stored: { event, channelId, receivedAt, deletedAt: null },
        wasInserted: true,
        replaced
      }
    })
  }

  async #indexTags (event) {
    let position = 0
    for (const [name, value] of indexableTags(event)) {
      await this.#exec(
        'INSERT INTO event_tags (event_id, name, value, position) VALUES (?, ?, ?, ?)',
        [event.id, name, value, position++]
      )
    }
  }

  async #indexSearch (event) {
    // tokensForEvent returns [] for every unsearchable kind, so the privacy
    // exclusion is enforced by not writing a row at all (SPEC.md §5.4).
    const tokens = tokensForEvent(event)
    if (tokens.length === 0) return

    // array_to_tsvector, not to_tsvector: the lexemes are stored exactly as
    // this store's tokenizer produced them, with no stemming or dictionary in
    // between, so a query means the same thing here as it does on SQLite.
    await this.#exec(
      'INSERT INTO event_search (event_id, tsv) VALUES (?, array_to_tsvector(?::text[])) ' +
      'ON CONFLICT (event_id) DO UPDATE SET tsv = excluded.tsv',
      [event.id, tokens]
    )
  }

  async #indexMentions (event) {
    // The feed answers "who talked to me", so it must not fill up with
    // machinery: relay-signed notifications and p-gated envelopes carry `p`
    // tags for routing, not because a human mentioned anyone.
    if (isRelaySignedKind(event.kind) || isPGatedKind(event.kind)) return

    for (const pubkey of new Set(referencedPubkeys(event))) {
      await this.#exec(
        'INSERT INTO event_mentions (pubkey, event_id, created_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT (pubkey, event_id) DO NOTHING',
        [pubkey, event.id, event.created_at]
      )
    }
  }

  async #updateThread (event, channelId) {
    const { root } = threadRefs(event)
    if (root === null) return

    await this.#exec(
      'INSERT INTO thread_metadata (root_id, channel_id, reply_count, last_reply_at) VALUES (?, ?, 1, ?) ' +
      'ON CONFLICT (root_id) DO UPDATE SET reply_count = thread_metadata.reply_count + 1, ' +
      'last_reply_at = excluded.last_reply_at',
      [root, channelId, event.created_at]
    )
  }

  async #purgeEvent (id) {
    await this.#exec('DELETE FROM event_tags WHERE event_id = ?', [id])
    await this.#exec('DELETE FROM event_search WHERE event_id = ?', [id])
    await this.#exec('DELETE FROM event_mentions WHERE event_id = ?', [id])
    await this.#exec('DELETE FROM events WHERE id = ?', [id])
  }

  async getEvent (id) {
    return rowToEvent(await this.#get('SELECT * FROM events WHERE id = ?', [id]))
  }

  async getStoredEvent (id) {
    return rowToStored(await this.#get('SELECT * FROM events WHERE id = ?', [id]))
  }

  /**
   * Query with NIP-01 filters. Each filter runs separately and the results are
   * merged, deduplicated and capped — which is both simpler and faster than one
   * giant OR, because each filter can use its own index.
   */
  async queryEvents (filters, opts = {}) {
    const limit = Math.min(opts.limit ?? this.maxHistoricalLimit, this.maxHistoricalLimit)
    const seen = new Map()

    for (const filter of filters) {
      const query = buildQuery(filter, { limit, includeDeleted: opts.includeDeleted })
      if (query === null) continue // a filter that matches nothing

      for (const row of await this.#all(query.sql, query.params)) {
        if (!seen.has(row.id)) seen.set(row.id, rowToStored(row))
      }
    }

    return [...seen.values()]
      .sort((a, b) => b.event.created_at - a.event.created_at || (a.event.id < b.event.id ? -1 : 1))
      .slice(0, limit)
  }

  async countEvents (filters, opts = {}) {
    // Deduplicated across filters, so overlapping filters do not double count.
    const ids = new Set()
    for (const filter of filters) {
      const query = buildCountQuery(filter, opts)
      if (query === null) continue
      const sql = query.sql.replace('SELECT COUNT(*) AS count', 'SELECT e.id')
      for (const row of await this.#all(sql, query.params)) ids.add(row.id)
    }
    return ids.size
  }

  /** Soft-delete. The row stays so the audit chain keeps referring to it. */
  async deleteEvent (id, opts = {}) {
    const stored = await this.getStoredEvent(id)
    if (stored === null) return false

    return this.transaction(async () => {
      await this.#exec('UPDATE events SET deleted_at = ? WHERE id = ?', [opts.at ?? now(), id])
      await this.#exec('DELETE FROM event_search WHERE event_id = ?', [id])
      return true
    })
  }

  // ---------------------------------------------------------------- search --

  /**
   * Candidate search hits, ranked by how many query tokens matched and then by
   * recency.
   *
   * Access control is NOT applied here: the relay re-authorizes every hit
   * before delivering it. Keeping that separation means the store can never be
   * the thing that accidentally decides someone may read an event.
   */
  async search (query, opts = {}) {
    const tokens = tokenizeQuery(query)
    if (tokens.length === 0) return []

    const limit = Math.min(opts.limit ?? this.maxHistoricalLimit, this.maxHistoricalLimit)
    const params = [tsqueryFor(tokens)]

    // `@@` against a GIN-indexed tsvector, with every token required — the same
    // AND semantics the SQLite driver gets from `HAVING matched = ?`.
    let sql =
      'SELECT s.event_id AS id, e.created_at AS created_at ' +
      'FROM event_search s JOIN events e ON e.id = s.event_id ' +
      'WHERE s.tsv @@ ?::tsquery AND e.deleted_at IS NULL'

    if (Array.isArray(opts.kinds) && opts.kinds.length > 0) {
      sql += ' AND e.kind = ANY(?::int[])'
      params.push(opts.kinds)
    }
    if (Array.isArray(opts.channelIds) && opts.channelIds.length > 0) {
      sql += ' AND e.channel_id = ANY(?::text[])'
      params.push(opts.channelIds)
    }
    if (typeof opts.author === 'string') {
      sql += ' AND e.pubkey = ?'
      params.push(opts.author)
    }
    if (Number.isInteger(opts.since)) {
      sql += ' AND e.created_at >= ?'
      params.push(opts.since)
    }

    sql += ' ORDER BY e.created_at DESC LIMIT ?'
    params.push(limit)

    const rows = await this.#all(sql, params)
    const hits = []
    for (const row of rows) {
      // Every token is required, so every hit matched all of them — the same
      // score the SQLite driver reports.
      hits.push({ ...(await this.getStoredEvent(row.id)), score: tokens.length })
    }
    return hits
  }

  // -------------------------------------------------------------- channels --

  async createChannel (channel) {
    const record = {
      id: channel.id,
      name: channel.name,
      type: channel.type ?? 'stream',
      visibility: channel.visibility ?? 'open',
      about: channel.about ?? '',
      topic: channel.topic ?? '',
      purpose: channel.purpose ?? '',
      canvas: channel.canvas ?? '',
      channel_add_policy: channel.channelAddPolicy ?? 'anyone',
      created_by: channel.createdBy,
      created_at: channel.createdAt ?? now()
    }

    return this.transaction(async () => {
      await this.#exec(
        'INSERT INTO channels (id, name, type, visibility, about, topic, purpose, canvas, ' +
        'channel_add_policy, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          record.id, record.name, record.type, record.visibility, record.about, record.topic,
          record.purpose, record.canvas, record.channel_add_policy, record.created_by, record.created_at
        ]
      )

      await this.#exec(
        'INSERT INTO channel_members (channel_id, pubkey, role, added_at) VALUES (?, ?, ?, ?)',
        [record.id, record.created_by, 'owner', record.created_at]
      )

      return this.getChannel(record.id)
    })
  }

  async getChannel (id) {
    const row = await this.#get('SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL', [id])
    return row === undefined ? null : channelFromRow(row)
  }

  async listChannels (opts = {}) {
    let sql = 'SELECT * FROM channels WHERE deleted_at IS NULL'
    const params = []

    if (opts.includeArchived !== true) sql += ' AND archived_at IS NULL'
    if (typeof opts.pubkey === 'string') {
      // Everything the caller can see: open channels plus private ones they
      // are a current member of.
      sql +=
        " AND (visibility = 'open' OR EXISTS (SELECT 1 FROM channel_members m " +
        'WHERE m.channel_id = channels.id AND m.pubkey = ? AND m.removed_at IS NULL))'
      params.push(opts.pubkey)
    }
    sql += ' ORDER BY created_at ASC'

    return (await this.#all(sql, params)).map(channelFromRow)
  }

  async updateChannel (id, patch) {
    const allowed = ['name', 'about', 'topic', 'purpose', 'canvas', 'visibility', 'channel_add_policy']
    const sets = []
    const params = []

    for (const [key, value] of Object.entries(patch)) {
      const column = key === 'channelAddPolicy' ? 'channel_add_policy' : key
      if (!allowed.includes(column)) continue
      sets.push(`${column} = ?`)
      params.push(value)
    }
    if (sets.length === 0) return this.getChannel(id)

    params.push(id)
    await this.#exec(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, params)
    return this.getChannel(id)
  }

  async archiveChannel (id, archived = true) {
    await this.#exec('UPDATE channels SET archived_at = ? WHERE id = ?', [archived ? now() : null, id])
    return (await this.#get('SELECT id FROM channels WHERE id = ?', [id])) !== undefined
  }

  async deleteChannel (id) {
    await this.#exec('UPDATE channels SET deleted_at = ? WHERE id = ?', [now(), id])
    return true
  }

  // --------------------------------------------------------------- members --

  /**
   * Add or re-add a member. Runs inside a transaction so the "is the caller
   * allowed" check the relay performs cannot race with a concurrent removal.
   */
  async addMember (channelId, pubkey, role = 'member') {
    return this.transaction(async () => {
      await this.#exec(
        'INSERT INTO channel_members (channel_id, pubkey, role, added_at, removed_at) VALUES (?, ?, ?, ?, NULL) ' +
        'ON CONFLICT (channel_id, pubkey) DO UPDATE SET removed_at = NULL, role = excluded.role',
        [channelId, pubkey, role, now()]
      )
      return this.getMember(channelId, pubkey)
    })
  }

  async removeMember (channelId, pubkey) {
    return this.transaction(async () => {
      const member = await this.getMember(channelId, pubkey)
      if (member === null) return false

      if (member.role === 'owner' && (await this.countOwners(channelId)) <= 1) {
        throw StoreError.conflict('cannot remove the last owner of a channel')
      }

      // Soft delete: re-adding reverses it and history stays intact.
      await this.#exec(
        'UPDATE channel_members SET removed_at = ? WHERE channel_id = ? AND pubkey = ?',
        [now(), channelId, pubkey]
      )
      return true
    })
  }

  async setMemberRole (channelId, pubkey, role) {
    return this.transaction(async () => {
      const member = await this.getMember(channelId, pubkey)
      if (member === null) throw StoreError.notFound('member')
      if (member.role === 'owner' && role !== 'owner' && (await this.countOwners(channelId)) <= 1) {
        throw StoreError.conflict('cannot demote the last owner of a channel')
      }
      await this.#exec(
        'UPDATE channel_members SET role = ? WHERE channel_id = ? AND pubkey = ?',
        [role, channelId, pubkey]
      )
      return this.getMember(channelId, pubkey)
    })
  }

  async getMember (channelId, pubkey) {
    const row = await this.#get(
      'SELECT * FROM channel_members WHERE channel_id = ? AND pubkey = ? AND removed_at IS NULL',
      [channelId, pubkey]
    )
    return row === undefined
      ? null
      : { channelId: row.channel_id, pubkey: row.pubkey, role: row.role, addedAt: row.added_at }
  }

  async listMembers (channelId) {
    return (await this.#all(
      'SELECT * FROM channel_members WHERE channel_id = ? AND removed_at IS NULL ORDER BY added_at ASC',
      [channelId]
    )).map((row) => ({ channelId: row.channel_id, pubkey: row.pubkey, role: row.role, addedAt: row.added_at }))
  }

  async countOwners (channelId) {
    const row = await this.#get(
      "SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ? AND role = 'owner' AND removed_at IS NULL",
      [channelId]
    )
    return Number(row.n)
  }

  async isMember (channelId, pubkey) {
    return (await this.getMember(channelId, pubkey)) !== null
  }

  /** Channels this pubkey may read: every open channel plus their private ones. */
  async accessibleChannelIds (pubkey) {
    const rows = await this.#all(
      "SELECT id FROM channels WHERE deleted_at IS NULL AND (visibility = 'open' " +
      'OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = channels.id ' +
      'AND m.pubkey = ? AND m.removed_at IS NULL))',
      [pubkey]
    )
    return new Set(rows.map((row) => row.id))
  }

  // ----------------------------------------------------------------- users --

  async upsertUser (pubkey, profile) {
    const existing = await this.getUser(pubkey)
    const merged = { ...(existing ?? {}), ...profile }

    await this.#exec(
      'INSERT INTO users (pubkey, display_name, avatar, about, nip05, status_text, status_emoji, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (pubkey) DO UPDATE SET ' +
      'display_name = excluded.display_name, avatar = excluded.avatar, about = excluded.about, ' +
      'nip05 = excluded.nip05, status_text = excluded.status_text, status_emoji = excluded.status_emoji, ' +
      'updated_at = excluded.updated_at',
      [
        pubkey,
        merged.displayName ?? null,
        merged.avatar ?? null,
        merged.about ?? null,
        merged.nip05 ?? null,
        merged.statusText ?? null,
        merged.statusEmoji ?? null,
        now()
      ]
    )

    return this.getUser(pubkey)
  }

  async getUser (pubkey) {
    const row = await this.#get('SELECT * FROM users WHERE pubkey = ?', [pubkey])
    if (row === undefined) return null

    const expired = row.presence_expires_at !== null && row.presence_expires_at < now()
    return {
      pubkey: row.pubkey,
      displayName: row.display_name,
      avatar: row.avatar,
      about: row.about,
      nip05: row.nip05,
      statusText: row.status_text,
      statusEmoji: row.status_emoji,
      presence: expired ? 'offline' : (row.presence ?? 'offline'),
      updatedAt: row.updated_at
    }
  }

  /** Presence expires rather than being cleared, so a missed heartbeat cannot flap. */
  async setPresence (pubkey, status, ttl = LIMITS.PRESENCE_TTL_S) {
    const expires = status === 'offline' ? null : now() + ttl
    const value = status === 'offline' ? null : status.slice(0, 128)

    await this.#exec(
      'INSERT INTO users (pubkey, presence, presence_expires_at, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (pubkey) DO UPDATE SET presence = excluded.presence, ' +
      'presence_expires_at = excluded.presence_expires_at, updated_at = excluded.updated_at',
      [pubkey, value, expires, now()]
    )
  }

  async getPresence (pubkey) {
    const row = await this.#get('SELECT presence, presence_expires_at FROM users WHERE pubkey = ?', [pubkey])
    if (row === undefined || row.presence === null) return 'offline'
    if (row.presence_expires_at !== null && row.presence_expires_at < now()) return 'offline'
    return row.presence
  }

  // ------------------------------------------------------ relay membership --

  async addRelayMember (pubkey, role = 'member', note = null) {
    await this.#exec(
      'INSERT INTO relay_members (pubkey, role, added_at, note) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (pubkey) DO UPDATE SET role = excluded.role',
      [pubkey, role, now(), note]
    )
    return this.getRelayMember(pubkey)
  }

  async removeRelayMember (pubkey) {
    const { rowCount } = await this.#exec('DELETE FROM relay_members WHERE pubkey = ?', [pubkey])
    return rowCount > 0
  }

  async getRelayMember (pubkey) {
    const row = await this.#get('SELECT * FROM relay_members WHERE pubkey = ?', [pubkey])
    return row === undefined ? null : { pubkey: row.pubkey, role: row.role, addedAt: row.added_at }
  }

  async listRelayMembers () {
    return (await this.#all('SELECT * FROM relay_members ORDER BY added_at ASC'))
      .map((row) => ({ pubkey: row.pubkey, role: row.role, addedAt: row.added_at }))
  }

  async addAllowedPubkey (pubkey, note = null) {
    await this.#exec(
      'INSERT INTO pubkey_allowlist (pubkey, added_at, note) VALUES (?, ?, ?) ON CONFLICT (pubkey) DO NOTHING',
      [pubkey, now(), note]
    )
  }

  async isPubkeyAllowed (pubkey) {
    return (await this.#get('SELECT 1 AS ok FROM pubkey_allowlist WHERE pubkey = ?', [pubkey])) !== undefined
  }

  // ----------------------------------------------------------------- media --

  async putMedia (record) {
    await this.#exec(
      'INSERT INTO media (sha256, size, mime, extension, uploaded_by, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING',
      [record.sha256, record.size, record.mime, record.extension ?? '', record.uploadedBy, now()]
    )
    return this.getMedia(record.sha256)
  }

  async getMedia (sha256) {
    const row = await this.#get('SELECT * FROM media WHERE sha256 = ?', [sha256])
    return row === undefined
      ? null
      : {
          sha256: row.sha256,
          size: row.size,
          mime: row.mime,
          extension: row.extension,
          uploadedBy: row.uploaded_by,
          createdAt: row.created_at
        }
  }

  // ----------------------------------------------------------------- audit --

  /**
   * Append one entry. The advisory lock is held to COMMIT, so two nodes cannot
   * read the same head and fork the chain — the cluster-wide replacement for
   * SQLite's single writer queue.
   */
  async appendAudit (entry) {
    return this.transaction(async () => {
      await this.#lock('hive:audit_log')

      const head = await this.#get('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1')
      const prevHash = head === undefined ? GENESIS_HASH : head.hash

      const next = (await this.#get('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM audit_log')).seq
      const record = {
        seq: next,
        ts: entry.ts ?? new Date().toISOString(),
        event_id: entry.eventId ?? null,
        kind: entry.kind ?? 0,
        actor: entry.actor ?? '',
        action: entry.action,
        channel_id: entry.channelId ?? null,
        metadata: entry.metadata ?? {},
        prev_hash: prevHash
      }
      const hash = entryHash(record)

      await this.#exec(
        'INSERT INTO audit_log (seq, ts, event_id, kind, actor, action, channel_id, metadata, prev_hash, hash) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          record.seq, record.ts, record.event_id, record.kind, record.actor, record.action,
          record.channel_id, canonicalJson(record.metadata), record.prev_hash, hash
        ]
      )

      return { ...record, hash }
    })
  }

  async listAudit (opts = {}) {
    const limit = Math.min(opts.limit ?? 100, this.feedMaxLimit)
    return (await this.#all('SELECT * FROM audit_log ORDER BY seq ASC LIMIT ?', [limit])).map(auditFromRow)
  }

  /**
   * Walk the whole chain recomputing hashes. Returns `{ ok, entries, brokenAt }`
   * — `brokenAt` is the first sequence number whose stored hash disagrees with
   * its recomputed one, which is also the earliest possible tamper point.
   */
  async verifyAuditChain () {
    const rows = await this.#all('SELECT * FROM audit_log ORDER BY seq ASC')
    let prevHash = GENESIS_HASH

    for (const row of rows) {
      const record = {
        seq: row.seq,
        ts: row.ts,
        event_id: row.event_id,
        kind: row.kind,
        actor: row.actor,
        action: row.action,
        channel_id: row.channel_id,
        metadata: JSON.parse(row.metadata),
        prev_hash: row.prev_hash
      }

      if (row.prev_hash !== prevHash) {
        return { ok: false, entries: rows.length, brokenAt: row.seq, reason: 'prev_hash does not match the previous entry' }
      }
      if (entryHash(record) !== row.hash) {
        return { ok: false, entries: rows.length, brokenAt: row.seq, reason: 'entry hash does not match its contents' }
      }
      prevHash = row.hash
    }

    return { ok: true, entries: rows.length, brokenAt: null, reason: null }
  }

  // ------------------------------------------------------------------ feed --

  /** Events mentioning this pubkey, newest first. */
  async queryMentions (pubkey, opts = {}) {
    const limit = Math.min(opts.limit ?? this.feedMaxLimit, this.feedMaxLimit)
    return (await this.#all(
      'SELECT e.* FROM events e INNER JOIN event_mentions m ON m.event_id = e.id ' +
      'WHERE m.pubkey = ? AND e.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT ?',
      [pubkey, limit]
    )).map(rowToStored)
  }

  async getThread (rootId, opts = {}) {
    const limit = Math.min(opts.limit ?? this.maxHistoricalLimit, this.maxHistoricalLimit)
    const root = await this.getStoredEvent(rootId)
    const replies = (await this.#all(
      'SELECT e.* FROM events e INNER JOIN event_tags t ON t.event_id = e.id ' +
      "WHERE t.name = 'e' AND t.value = ? AND e.deleted_at IS NULL AND e.id != ? " +
      'ORDER BY e.created_at ASC LIMIT ?',
      [rootId, rootId, limit]
    )).map(rowToStored)

    return { root, replies }
  }
}

function channelFromRow (row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    visibility: row.visibility,
    about: row.about,
    topic: row.topic,
    purpose: row.purpose,
    canvas: row.canvas,
    channelAddPolicy: row.channel_add_policy,
    createdBy: row.created_by,
    createdAt: row.created_at,
    archivedAt: row.archived_at
  }
}

function auditFromRow (row) {
  return {
    seq: row.seq,
    ts: row.ts,
    eventId: row.event_id,
    kind: row.kind,
    actor: row.actor,
    action: row.action,
    channelId: row.channel_id,
    metadata: JSON.parse(row.metadata),
    prevHash: row.prev_hash,
    hash: row.hash
  }
}

module.exports = { PostgresStore, SCHEMA_VERSION }

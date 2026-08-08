'use strict'

const {
  isEphemeral,
  isAddressable,
  isParameterizedReplaceable,
  isSearchable,
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

const { migrate, SCHEMA_VERSION } = require('./schema')
const { buildQuery, buildCountQuery } = require('./query')
const { tokensForEvent, tokenizeQuery } = require('./search')
const { GENESIS_HASH, entryHash, canonicalJson } = require('./audit')
const { StoreError } = require('./errors')

// bare-sqlite and node:sqlite expose the same DatabaseSync API, so the store is
// identical on both runtimes and only the import differs. The mapping lives in
// this package's `imports` field rather than in a try/catch, because the worker
// is statically bundled: a runtime fallback would be resolved at bundle time
// and fail on whichever runtime is not present.
const { DatabaseSync } = require('#sqlite')

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

class SqliteStore {
  constructor (location = ':memory:', opts = {}) {
    this.location = location
    this.db = new DatabaseSync(location, { enableForeignKeyConstraints: true })

    // A file-backed database benefits from WAL; :memory: silently stays in
    // memory mode, which is why the result is not asserted on.
    if (location !== ':memory:') {
      try {
        this.db.exec('PRAGMA journal_mode = WAL')
      } catch {
        // A read-only filesystem or an unsupported build: not fatal.
      }
    }
    this.db.exec('PRAGMA synchronous = NORMAL')

    this.schemaVersion = migrate(this.db)
    this.maxHistoricalLimit = opts.maxHistoricalLimit ?? LIMITS.MAX_HISTORICAL_LIMIT
    this.feedMaxLimit = opts.feedMaxLimit ?? LIMITS.FEED_MAX_LIMIT
    this.closed = false
  }

  close () {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  transaction (fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Rolling back a transaction the error already aborted is fine.
      }
      throw err
    }
  }

  // ---------------------------------------------------------------- events --

  /**
   * Idempotent insert.
   *
   * Returns `{ stored, wasInserted, replaced }`. A known id is a no-op with
   * `wasInserted: false` — the relay turns that into `["OK", id, true,
   * "duplicate:"]`, since a duplicate is a success from the client's side.
   */
  insertEvent (event, opts = {}) {
    if (event.kind === KIND_AUTH) throw StoreError.authEventForbidden()
    if (isEphemeral(event.kind)) throw StoreError.ephemeralForbidden(event.kind)

    const existing = this.getStoredEvent(event.id)
    if (existing !== null) return { stored: existing, wasInserted: false, replaced: null }

    const channelId = opts.channelId ?? eventChannelId(event) ?? null
    const receivedAt = opts.receivedAt ?? now()

    return this.transaction(() => {
      let replaced = null

      if (isAddressable(event.kind)) {
        const d = isParameterizedReplaceable(event.kind) ? dTag(event) : ''
        const address = this.db
          .prepare('SELECT event_id FROM replaceable WHERE pubkey = ? AND kind = ? AND d = ?')
          .get(event.pubkey, event.kind, d)

        if (address !== undefined) {
          const previous = this.getEvent(address.event_id)
          if (previous !== null && !supersedes(event, previous)) {
            // The incoming event is older, or ties and loses the id tiebreak.
            return { stored: this.getStoredEvent(previous.id), wasInserted: false, replaced: null }
          }
          if (previous !== null) {
            this.#purgeEvent(previous.id)
            replaced = previous.id
          }
        }

        this.db
          .prepare(
            'INSERT INTO replaceable (pubkey, kind, d, event_id) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT (pubkey, kind, d) DO UPDATE SET event_id = excluded.event_id'
          )
          .run(event.pubkey, event.kind, d, event.id)
      }

      this.db
        .prepare(
          'INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, channel_id, received_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          event.id,
          event.pubkey,
          event.created_at,
          event.kind,
          JSON.stringify(event.tags),
          event.content,
          event.sig,
          channelId,
          receivedAt
        )

      this.#indexTags(event)
      this.#indexSearch(event, channelId)
      this.#indexMentions(event)
      this.#updateThread(event, channelId)

      return {
        stored: { event, channelId, receivedAt, deletedAt: null },
        wasInserted: true,
        replaced
      }
    })
  }

  #indexTags (event) {
    const insert = this.db.prepare(
      'INSERT INTO event_tags (event_id, name, value, position) VALUES (?, ?, ?, ?)'
    )
    let position = 0
    for (const [name, value] of indexableTags(event)) {
      insert.run(event.id, name, value, position++)
    }
  }

  #indexSearch (event, channelId) {
    // tokensForEvent returns [] for every unsearchable kind, so the privacy
    // exclusion is enforced by not writing rows at all (SPEC.md §5.4).
    const tokens = tokensForEvent(event)
    if (tokens.length === 0) return

    const insert = this.db.prepare(
      'INSERT INTO event_tokens (token, event_id, channel_id, kind) VALUES (?, ?, ?, ?)'
    )
    for (const token of tokens) insert.run(token, event.id, channelId, event.kind)
  }

  #indexMentions (event) {
    // The feed answers "who talked to me", so it must not fill up with
    // machinery: relay-signed notifications and p-gated envelopes carry `p`
    // tags for routing, not because a human mentioned anyone.
    if (isRelaySignedKind(event.kind) || isPGatedKind(event.kind)) return

    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO event_mentions (pubkey, event_id, created_at) VALUES (?, ?, ?)'
    )
    for (const pubkey of new Set(referencedPubkeys(event))) {
      insert.run(pubkey, event.id, event.created_at)
    }
  }

  #updateThread (event, channelId) {
    const { root } = threadRefs(event)
    if (root === null) return

    this.db
      .prepare(
        'INSERT INTO thread_metadata (root_id, channel_id, reply_count, last_reply_at) VALUES (?, ?, 1, ?) ' +
        'ON CONFLICT (root_id) DO UPDATE SET reply_count = reply_count + 1, last_reply_at = excluded.last_reply_at'
      )
      .run(root, channelId, event.created_at)
  }

  #purgeEvent (id) {
    this.db.prepare('DELETE FROM event_tags WHERE event_id = ?').run(id)
    this.db.prepare('DELETE FROM event_tokens WHERE event_id = ?').run(id)
    this.db.prepare('DELETE FROM event_mentions WHERE event_id = ?').run(id)
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id)
  }

  getEvent (id) {
    return rowToEvent(this.db.prepare('SELECT * FROM events WHERE id = ?').get(id))
  }

  getStoredEvent (id) {
    return rowToStored(this.db.prepare('SELECT * FROM events WHERE id = ?').get(id))
  }

  /**
   * Query with NIP-01 filters. Each filter runs separately and the results are
   * merged, deduplicated and capped — which is both simpler and faster than one
   * giant OR, because each filter can use its own index.
   */
  queryEvents (filters, opts = {}) {
    const limit = Math.min(opts.limit ?? this.maxHistoricalLimit, this.maxHistoricalLimit)
    const seen = new Map()

    for (const filter of filters) {
      const query = buildQuery(filter, { limit, includeDeleted: opts.includeDeleted })
      if (query === null) continue // a filter that matches nothing

      for (const row of this.db.prepare(query.sql).all(...query.params)) {
        if (!seen.has(row.id)) seen.set(row.id, rowToStored(row))
      }
    }

    return [...seen.values()]
      .sort((a, b) => b.event.created_at - a.event.created_at || (a.event.id < b.event.id ? -1 : 1))
      .slice(0, limit)
  }

  countEvents (filters, opts = {}) {
    // Deduplicated across filters, so overlapping filters do not double count.
    const ids = new Set()
    for (const filter of filters) {
      const query = buildCountQuery(filter, opts)
      if (query === null) continue
      const sql = query.sql.replace('SELECT COUNT(*) AS count', 'SELECT e.id')
      for (const row of this.db.prepare(sql).all(...query.params)) ids.add(row.id)
    }
    return ids.size
  }

  /** Soft-delete. The row stays so the audit chain keeps referring to it. */
  deleteEvent (id, opts = {}) {
    const stored = this.getStoredEvent(id)
    if (stored === null) return false

    return this.transaction(() => {
      this.db.prepare('UPDATE events SET deleted_at = ? WHERE id = ?').run(opts.at ?? now(), id)
      this.db.prepare('DELETE FROM event_tokens WHERE event_id = ?').run(id)
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
  search (query, opts = {}) {
    const tokens = tokenizeQuery(query)
    if (tokens.length === 0) return []

    const limit = Math.min(opts.limit ?? this.maxHistoricalLimit, this.maxHistoricalLimit)
    const params = [...tokens]

    let sql =
      'SELECT t.event_id AS id, COUNT(DISTINCT t.token) AS matched, e.created_at AS created_at ' +
      'FROM event_tokens t JOIN events e ON e.id = t.event_id ' +
      `WHERE t.token IN (${tokens.map(() => '?').join(',')}) AND e.deleted_at IS NULL`

    if (Array.isArray(opts.kinds) && opts.kinds.length > 0) {
      sql += ` AND e.kind IN (${opts.kinds.map(() => '?').join(',')})`
      params.push(...opts.kinds)
    }
    if (Array.isArray(opts.channelIds) && opts.channelIds.length > 0) {
      sql += ` AND e.channel_id IN (${opts.channelIds.map(() => '?').join(',')})`
      params.push(...opts.channelIds)
    }
    if (typeof opts.author === 'string') {
      sql += ' AND e.pubkey = ?'
      params.push(opts.author)
    }
    if (Number.isInteger(opts.since)) {
      sql += ' AND e.created_at >= ?'
      params.push(opts.since)
    }

    // Every query token must be present, so this is an AND search, not an OR.
    sql += ' GROUP BY t.event_id HAVING matched = ? ORDER BY matched DESC, e.created_at DESC LIMIT ?'
    params.push(tokens.length, limit)

    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...this.getStoredEvent(row.id), score: row.matched }))
  }

  // -------------------------------------------------------------- channels --

  createChannel (channel) {
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

    return this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO channels (id, name, type, visibility, about, topic, purpose, canvas, ' +
          'channel_add_policy, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          record.id, record.name, record.type, record.visibility, record.about, record.topic,
          record.purpose, record.canvas, record.channel_add_policy, record.created_by, record.created_at
        )

      this.db
        .prepare('INSERT INTO channel_members (channel_id, pubkey, role, added_at) VALUES (?, ?, ?, ?)')
        .run(record.id, record.created_by, 'owner', record.created_at)

      return this.getChannel(record.id)
    })
  }

  getChannel (id) {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL').get(id)
    return row === undefined ? null : channelFromRow(row)
  }

  listChannels (opts = {}) {
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

    return this.db.prepare(sql).all(...params).map(channelFromRow)
  }

  updateChannel (id, patch) {
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
    this.db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return this.getChannel(id)
  }

  archiveChannel (id, archived = true) {
    this.db.prepare('UPDATE channels SET archived_at = ? WHERE id = ?').run(archived ? now() : null, id)
    return this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) !== undefined
  }

  deleteChannel (id) {
    this.db.prepare('UPDATE channels SET deleted_at = ? WHERE id = ?').run(now(), id)
    return true
  }

  // --------------------------------------------------------------- members --

  /**
   * Add or re-add a member. Runs inside a transaction so the "is the caller
   * allowed" check the relay performs cannot race with a concurrent removal.
   */
  addMember (channelId, pubkey, role = 'member') {
    return this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO channel_members (channel_id, pubkey, role, added_at, removed_at) VALUES (?, ?, ?, ?, NULL) ' +
          'ON CONFLICT (channel_id, pubkey) DO UPDATE SET removed_at = NULL, role = excluded.role'
        )
        .run(channelId, pubkey, role, now())
      return this.getMember(channelId, pubkey)
    })
  }

  removeMember (channelId, pubkey) {
    return this.transaction(() => {
      const member = this.getMember(channelId, pubkey)
      if (member === null) return false

      if (member.role === 'owner' && this.countOwners(channelId) <= 1) {
        throw StoreError.conflict('cannot remove the last owner of a channel')
      }

      // Soft delete: re-adding reverses it and history stays intact.
      this.db
        .prepare('UPDATE channel_members SET removed_at = ? WHERE channel_id = ? AND pubkey = ?')
        .run(now(), channelId, pubkey)
      return true
    })
  }

  setMemberRole (channelId, pubkey, role) {
    return this.transaction(() => {
      const member = this.getMember(channelId, pubkey)
      if (member === null) throw StoreError.notFound('member')
      if (member.role === 'owner' && role !== 'owner' && this.countOwners(channelId) <= 1) {
        throw StoreError.conflict('cannot demote the last owner of a channel')
      }
      this.db
        .prepare('UPDATE channel_members SET role = ? WHERE channel_id = ? AND pubkey = ?')
        .run(role, channelId, pubkey)
      return this.getMember(channelId, pubkey)
    })
  }

  getMember (channelId, pubkey) {
    const row = this.db
      .prepare('SELECT * FROM channel_members WHERE channel_id = ? AND pubkey = ? AND removed_at IS NULL')
      .get(channelId, pubkey)
    return row === undefined ? null : { channelId: row.channel_id, pubkey: row.pubkey, role: row.role, addedAt: row.added_at }
  }

  listMembers (channelId) {
    return this.db
      .prepare('SELECT * FROM channel_members WHERE channel_id = ? AND removed_at IS NULL ORDER BY added_at ASC')
      .all(channelId)
      .map((row) => ({ channelId: row.channel_id, pubkey: row.pubkey, role: row.role, addedAt: row.added_at }))
  }

  countOwners (channelId) {
    return this.db
      .prepare("SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ? AND role = 'owner' AND removed_at IS NULL")
      .get(channelId).n
  }

  isMember (channelId, pubkey) {
    return this.getMember(channelId, pubkey) !== null
  }

  /** Channels this pubkey may read: every open channel plus their private ones. */
  accessibleChannelIds (pubkey) {
    const rows = this.db
      .prepare(
        "SELECT id FROM channels WHERE deleted_at IS NULL AND (visibility = 'open' " +
        'OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = channels.id ' +
        'AND m.pubkey = ? AND m.removed_at IS NULL))'
      )
      .all(pubkey)
    return new Set(rows.map((row) => row.id))
  }

  // ----------------------------------------------------------------- users --

  upsertUser (pubkey, profile) {
    const existing = this.getUser(pubkey)
    const merged = { ...(existing ?? {}), ...profile }

    this.db
      .prepare(
        'INSERT INTO users (pubkey, display_name, avatar, about, nip05, status_text, status_emoji, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (pubkey) DO UPDATE SET ' +
        'display_name = excluded.display_name, avatar = excluded.avatar, about = excluded.about, ' +
        'nip05 = excluded.nip05, status_text = excluded.status_text, status_emoji = excluded.status_emoji, ' +
        'updated_at = excluded.updated_at'
      )
      .run(
        pubkey,
        merged.displayName ?? null,
        merged.avatar ?? null,
        merged.about ?? null,
        merged.nip05 ?? null,
        merged.statusText ?? null,
        merged.statusEmoji ?? null,
        now()
      )

    return this.getUser(pubkey)
  }

  getUser (pubkey) {
    const row = this.db.prepare('SELECT * FROM users WHERE pubkey = ?').get(pubkey)
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
  setPresence (pubkey, status, ttl = LIMITS.PRESENCE_TTL_S) {
    const expires = status === 'offline' ? null : now() + ttl
    const value = status === 'offline' ? null : status.slice(0, 128)

    this.db
      .prepare(
        'INSERT INTO users (pubkey, presence, presence_expires_at, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (pubkey) DO UPDATE SET presence = excluded.presence, ' +
        'presence_expires_at = excluded.presence_expires_at, updated_at = excluded.updated_at'
      )
      .run(pubkey, value, expires, now())
  }

  getPresence (pubkey) {
    const row = this.db.prepare('SELECT presence, presence_expires_at FROM users WHERE pubkey = ?').get(pubkey)
    if (row === undefined || row.presence === null) return 'offline'
    if (row.presence_expires_at !== null && row.presence_expires_at < now()) return 'offline'
    return row.presence
  }

  // ------------------------------------------------------ relay membership --

  addRelayMember (pubkey, role = 'member', note = null) {
    this.db
      .prepare(
        'INSERT INTO relay_members (pubkey, role, added_at, note) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (pubkey) DO UPDATE SET role = excluded.role'
      )
      .run(pubkey, role, now(), note)
    return this.getRelayMember(pubkey)
  }

  removeRelayMember (pubkey) {
    return this.db.prepare('DELETE FROM relay_members WHERE pubkey = ?').run(pubkey).changes > 0
  }

  getRelayMember (pubkey) {
    const row = this.db.prepare('SELECT * FROM relay_members WHERE pubkey = ?').get(pubkey)
    return row === undefined ? null : { pubkey: row.pubkey, role: row.role, addedAt: row.added_at }
  }

  listRelayMembers () {
    return this.db
      .prepare('SELECT * FROM relay_members ORDER BY added_at ASC')
      .all()
      .map((row) => ({ pubkey: row.pubkey, role: row.role, addedAt: row.added_at }))
  }

  addAllowedPubkey (pubkey, note = null) {
    this.db
      .prepare('INSERT OR IGNORE INTO pubkey_allowlist (pubkey, added_at, note) VALUES (?, ?, ?)')
      .run(pubkey, now(), note)
  }

  isPubkeyAllowed (pubkey) {
    return this.db.prepare('SELECT 1 AS ok FROM pubkey_allowlist WHERE pubkey = ?').get(pubkey) !== undefined
  }

  // ----------------------------------------------------------------- media --

  putMedia (record) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO media (sha256, size, mime, extension, uploaded_by, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(record.sha256, record.size, record.mime, record.extension ?? '', record.uploadedBy, now())
    return this.getMedia(record.sha256)
  }

  getMedia (sha256) {
    const row = this.db.prepare('SELECT * FROM media WHERE sha256 = ?').get(sha256)
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
   * Append one entry. Serialized by the surrounding IMMEDIATE transaction, so
   * two concurrent appends cannot read the same head and fork the chain.
   */
  appendAudit (entry) {
    return this.transaction(() => {
      const head = this.db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get()
      const prevHash = head === undefined ? GENESIS_HASH : head.hash

      const next = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM audit_log').get().seq
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

      this.db
        .prepare(
          'INSERT INTO audit_log (seq, ts, event_id, kind, actor, action, channel_id, metadata, prev_hash, hash) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          record.seq, record.ts, record.event_id, record.kind, record.actor, record.action,
          record.channel_id, canonicalJson(record.metadata), record.prev_hash, hash
        )

      return { ...record, hash }
    })
  }

  listAudit (opts = {}) {
    const limit = Math.min(opts.limit ?? 100, this.feedMaxLimit)
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY seq ASC LIMIT ?')
      .all(limit)
      .map(auditFromRow)
  }

  /**
   * Walk the whole chain recomputing hashes. Returns `{ ok, entries, brokenAt }`
   * — `brokenAt` is the first sequence number whose stored hash disagrees with
   * its recomputed one, which is also the earliest possible tamper point.
   */
  verifyAuditChain () {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all()
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
  queryMentions (pubkey, opts = {}) {
    const limit = Math.min(opts.limit ?? this.feedMaxLimit, this.feedMaxLimit)
    return this.db
      .prepare(
        'SELECT e.* FROM events e INNER JOIN event_mentions m ON m.event_id = e.id ' +
        'WHERE m.pubkey = ? AND e.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT ?'
      )
      .all(pubkey, limit)
      .map(rowToStored)
  }

  getThread (rootId, opts = {}) {
    const limit = Math.min(opts.limit ?? this.maxHistoricalLimit, this.maxHistoricalLimit)
    const root = this.getStoredEvent(rootId)
    const replies = this.db
      .prepare(
        'SELECT e.* FROM events e INNER JOIN event_tags t ON t.event_id = e.id ' +
        "WHERE t.name = 'e' AND t.value = ? AND e.deleted_at IS NULL AND e.id != ? " +
        'ORDER BY e.created_at ASC LIMIT ?'
      )
      .all(rootId, rootId, limit)
      .map(rowToStored)

    return { root, replies }
  }
}

/** NIP-01 replacement: newer wins; on a tie the lexicographically lowest id is kept. */
function supersedes (incoming, existing) {
  if (incoming.created_at !== existing.created_at) return incoming.created_at > existing.created_at
  return incoming.id < existing.id
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

module.exports = { SqliteStore, SCHEMA_VERSION, supersedes }

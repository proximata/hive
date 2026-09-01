'use strict'

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')
const b4a = require('b4a')

const { sha256, LIMITS } = require('hive-core')
const { TokenBucket } = require('hive-auth')

// Relay-to-relay replication: one hypercore per relay, merged on ingest.
//
// Each relay appends every event it accepted from a CLIENT to its own core,
// joins a shared Hyperswarm topic, and tails every peer's core through the
// same validate-then-store path a WebSocket EVENT takes. SQLite stays the
// store, not a projection: ingest calls the ordinary pipeline, which is
// idempotent by event id, so FTS5 and every filter query are untouched.
//
// There is no autobase and no linearization, because there is no ordering
// problem for ORDINARY events: an event id is the sha256 of its serialized
// form (hive-core lib/event.js) and replaceable conflicts resolve by created_at
// with an id tiebreak (hive-store lib/sqlite-store.js). Those merge
// commutatively, so a writer set, a quorum and an authorised-writer ceremony
// would all be machinery for a problem Hive does not have.
//
// It is NOT a CRDT everywhere, and the two exceptions are worth naming rather
// than discovering:
//
//   - COMMAND KINDS have side effects, and a side effect is only commutative
//     if it is a pure function of the signed event. Channel creation was not:
//     it minted a random uuid, so the same create event produced a different
//     channel id on each relay and every later message was 'unknown channel'
//     on the peer. Fixed at handlers.js `uuidFrom`. Any NEW command handler
//     that derives state from something other than the event — a clock, a
//     random source, this relay's own store — reintroduces the same fork.
//   - RELAY-SIGNED KINDS cannot cross at all. `_validateIngest` rejects them
//     unless signed by the ingesting relay's own key, which is the rule that
//     stops a peer forging membership on our behalf. So group metadata,
//     membership notifications, system messages and thread summaries are
//     per-relay and are regenerated locally by each relay's own handlers when
//     the CLIENT-signed command that caused them replicates.
//
// WHAT A PEER IS TRUSTED FOR: nothing. Every replicated event is verified
// here exactly as a client's would be, and every ingest rule (membership,
// relay-signed kinds, clock drift) is applied by THIS relay against its own
// state. What replication does inherit is VOLUME and RELEVANCE: relay A sees
// whatever B's own limiter let through, because a signature proves authorship
// and says nothing about how much of it there is. That is what the ingest cap
// below is for.
//
// LIMITS AT THIS DESIGN POINT, named rather than discovered later:
//   - Storage is unbounded: every relay ends up holding everything from
//     everyone. Fine at 3 nodes. The trigger for selective replication is the
//     first relay that wants a subset — a channel allowlist or a kind filter
//     applied while tailing — not a size threshold.
//   - Propagation is direct only. A relay does NOT re-append a peer's events
//     to its own core, so an event reaches exactly the relays connected to its
//     origin. That keeps trust one hop deep and storage linear; the trigger to
//     revisit is the first non-full-mesh topology.
//   - A relay that enables replication with history already in SQLite
//     publishes only what it accepts FROM THEN ON: the core starts empty and
//     is not backfilled.
//   - Three nodes on one VM share a failure domain. This buys convergence, and
//     specifically not availability.
//   - A rejected block is never retried. A channel message whose create event
//     has not arrived yet — possible when the two came from DIFFERENT peer
//     feeds, since ordering only holds within one feed — is dropped for good;
//     the reader has no cursor to rewind. The trigger to build a retry queue
//     is the first deployment where the same author writes to two relays.

/** Bytes of one core block we are willing to parse as an event. */
const MAX_BLOCK_BYTES = LIMITS.MAX_FRAME_BYTES

/**
 * Events per second accepted from ONE peer feed.
 *
 * The relay's own limiter is per-pubkey at the EVENT path and replication
 * ingest deliberately does not use it: a peer replaying a year of history is
 * legitimate traffic from thousands of pubkeys, and dropping it would leave
 * the two stores permanently divergent. So the cap here paces rather than
 * drops — the feed is durable and ordered, so pausing loses nothing — and it
 * is per feed rather than per author, because the feed is what an operator
 * chose to trust.
 */
const DEFAULT_INGEST_EVENTS_PER_SECOND = 200

// Pinned so both sides derive the same core key from one public key. Corestore
// would otherwise supply its own default manifest version, and a bump in a
// future corestore would silently move every relay's core to a new key.
const MANIFEST_VERSION = 1

/** The hypercore a relay writes, addressed by its replication public key. */
function manifestFor (publicKey) {
  return { version: MANIFEST_VERSION, signers: [{ publicKey: b4a.from(publicKey) }] }
}

/**
 * Derive the replication identity from the relay's Nostr secret.
 *
 * Namespaced away from `hive:swarm:v1` (transports/swarm.js), so the key a
 * relay replicates with is not the key clients dial: turning replication on
 * must not hand peers a second name for the client-facing endpoint.
 *
 * ponytail: this ONE keypair is both the Hyperswarm identity and the
 * hypercore's signer, which is what makes peer discovery free — the core key
 * is derived from `connection.remotePublicKey`, so there is no announcement
 * protocol at all. Upgrade path if the keys ever have to differ (rotation, or
 * more than one core per relay): a Protomux channel on the same stream
 * carrying the core key, which is the only piece this shortcut replaces.
 */
function replicationKeyPair (nostrSecretKey) {
  const secret = typeof nostrSecretKey === 'string' ? b4a.from(nostrSecretKey, 'hex') : nostrSecretKey
  return DHT.keyPair(b4a.from(sha256(b4a.concat([b4a.from('hive:replication:v1'), b4a.from(secret)]))))
}

/**
 * The swarm topic for a replication group.
 *
 * Hashed with a namespace rather than used raw, so `--replicate hive` on the
 * public DHT does not join whatever else picked that word.
 */
function replicationTopic (name) {
  return b4a.from(sha256(b4a.from('hive:replication:topic:v1:' + name)))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class ReplicationTransport {
  constructor (relay, opts = {}) {
    if (typeof opts.storageDir !== 'string' && opts.corestore === undefined) {
      throw new Error('replication needs a storageDir')
    }

    this.relay = relay
    this.keyPair = opts.keyPair ?? replicationKeyPair(relay.secretKey)
    this.publicKey = b4a.toString(this.keyPair.publicKey, 'hex')
    this.topic = typeof opts.topic === 'string' ? replicationTopic(opts.topic) : (opts.topic ?? null)
    this.bootstrap = opts.bootstrap

    this.corestore = opts.corestore ?? new Corestore(opts.storageDir)
    this.ownsCorestore = opts.corestore === undefined
    this.swarm = opts.swarm ?? null
    this.ownsSwarm = opts.swarm === undefined

    this.maxEventsPerSecond = opts.maxEventsPerSecond ?? DEFAULT_INGEST_EVENTS_PER_SECOND
    this.local = null
    this.peers = new Map()
    this.closing = false
    this.stats = { appended: 0, ingested: 0, duplicates: 0, rejected: 0 }

    // Events currently being written to SQLite by the ingest path. The relay
    // emits 'event' for them too, and without this a replicated event would
    // land in our own core and be re-published as if we had accepted it.
    this._ingesting = new Set()
    this._appends = Promise.resolve()
    this._onevent = (event) => this._append(event)
  }

  /** The pear-style link a peer needs to fetch this relay's feed. */
  get link () {
    return 'hyper://' + this.publicKey
  }

  async listen () {
    await this.corestore.ready()

    this.local = this.corestore.get({ keyPair: this.keyPair, manifest: manifestFor(this.keyPair.publicKey) })
    await this.local.ready()
    if (!this.local.writable) throw new Error('replication core is not writable')

    this.relay.on('event', this._onevent)

    if (this.topic !== null) {
      if (this.swarm === null) {
        this.swarm = new Hyperswarm({ keyPair: this.keyPair, bootstrap: this.bootstrap })
      }
      this.swarm.on('connection', (connection) => this.attach(connection, connection.remotePublicKey))
      await this.swarm.join(this.topic, { server: true, client: true }).flushed()
    }

    return this.publicKey
  }

  /**
   * Replicate over one already-established stream.
   *
   * Split out from the swarm handler so tests can wire two relays over a pipe
   * without a DHT, and so a future transport can hand a stream in.
   */
  attach (stream, remotePublicKey) {
    if (this.closing) return
    this.corestore.replicate(stream)
    if (remotePublicKey !== undefined && remotePublicKey !== null) {
      this.follow(remotePublicKey).catch((err) => this.relay.emit('error', err))
    }
  }

  /** Tail one peer's core, ingesting every block through the normal pipeline. */
  async follow (publicKey) {
    const hex = typeof publicKey === 'string' ? publicKey : b4a.toString(publicKey, 'hex')
    // A relay dialing itself would ingest its own writes back through the
    // pipeline; harmless but pure waste.
    if (hex === this.publicKey || this.peers.has(hex) || this.closing) return

    const core = this.corestore.get({ manifest: manifestFor(b4a.from(hex, 'hex')) })
    await core.ready()

    // Always from block 0. A peer can replay its whole history at any time, on
    // any restart, and that must be cheap rather than merely tolerated: a known
    // id costs one indexed lookup in insertEvent and nothing else. Persisting a
    // cursor would buy little — hypercore does not re-download blocks it has —
    // and would be one more piece of state to get wrong.
    const stream = core.createReadStream({ live: true, start: 0 })
    const bucket = new TokenBucket(this.maxEventsPerSecond, this.maxEventsPerSecond, Date.now())
    const peer = { core, stream }
    this.peers.set(hex, peer)

    this._drain(stream, bucket, hex).catch((err) => this.relay.emit('error', err))
  }

  async _drain (stream, bucket, hex) {
    try {
      for await (const block of stream) {
        if (this.closing) return
        while (!bucket.take(1, Date.now())) await sleep(1000 / this.maxEventsPerSecond)
        await this._ingest(block, hex)
      }
    } catch (err) {
      // A live read stream ends by being destroyed — on close, or when the peer
      // goes. That is the normal exit from this loop and not an error.
      if (this.closing || err.code === 'STREAM_DESTROYED') return
      throw err
    }
  }

  async _ingest (block, hex) {
    if (block.byteLength > MAX_BLOCK_BYTES) {
      this.stats.rejected++
      return
    }

    let event
    try {
      event = JSON.parse(b4a.toString(block))
    } catch {
      this.stats.rejected++
      return
    }
    if (event === null || typeof event !== 'object' || typeof event.id !== 'string') {
      this.stats.rejected++
      return
    }

    // An id we already hold, answered BEFORE the pipeline rather than by it.
    //
    // A peer replays its whole feed on every reconnect, and the pipeline's own
    // duplicate check is step 8 — after step 5 verifies the signature. Without
    // this line a re-read of a 100k-event history schnorr-verifies 100k events
    // to discard all of them, which is the cost the `follow()` comment claims
    // is 'one indexed lookup and nothing else'. Now it is.
    //
    // Safe because an event id IS the hash of its content (hive-core
    // lib/event.js): a block whose id we hold either carries the bytes we
    // already validated, or carries different bytes under a stolen id, and in
    // that case this path stores nothing at all rather than trusting it.
    if (this.relay.store.getEvent(event.id) !== null) {
      this.stats.duplicates++
      return
    }

    this._ingesting.add(event.id)
    try {
      const result = await this.relay.ingestFromPeer(event)
      if (!result.accepted) this.stats.rejected++
      else if (result.reason.startsWith('duplicate')) this.stats.duplicates++
      else this.stats.ingested++
    } catch (err) {
      this.stats.rejected++
      this.relay.emit('error', err)
    } finally {
      this._ingesting.delete(event.id)
    }
  }

  /** Append one locally accepted event to our own core, in arrival order. */
  _append (event) {
    if (this.closing || this.local === null) return
    if (this._ingesting.has(event.id)) return

    this._appends = this._appends
      .then(() => this.local.append(b4a.from(JSON.stringify(event))))
      .then(() => { this.stats.appended++ })
      .catch((err) => this.relay.emit('error', err))
    return this._appends
  }

  /** Resolves once every append queued so far has hit the core. */
  flush () {
    return this._appends
  }

  async close () {
    this.closing = true
    this.relay.removeListener('event', this._onevent)

    for (const { stream } of this.peers.values()) {
      try {
        stream.destroy()
      } catch {}
    }
    this.peers.clear()

    try {
      await this._appends
    } catch {}

    if (this.swarm !== null && this.ownsSwarm) await this.swarm.destroy()
    if (this.ownsCorestore) await this.corestore.close()
  }
}

module.exports = {
  ReplicationTransport,
  replicationKeyPair,
  replicationTopic,
  manifestFor,
  DEFAULT_INGEST_EVENTS_PER_SECOND,
  MANIFEST_VERSION
}

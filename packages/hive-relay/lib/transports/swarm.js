'use strict'

const DHT = require('hyperdht')
const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')

const { sha256, fromHex, toHex, LIMITS } = require('hive-core')
const { Transport, TransportClient } = require('./transport')

// The Pears half of reachability.
//
// The relay listens with HyperDHT on a keypair derived from its Nostr secret
// key, so one secret names both identities. Clients dial `hyper://<dht public
// key>`: the DHT finds the relay and holepunches a Noise-encrypted stream, so
// the relay needs no open port, DNS name or certificate. The relay is addressed
// by key, which is what HyperDHT servers are for, so this transport does not
// use Hyperswarm's topic discovery. Relay-to-relay replication does (see
// replication.js).
//
// Frames travel on a Protomux channel named PROTOCOL, one message per Nostr
// frame, so the same stream can carry other protocols later. The Noise
// handshake authenticates the transport. NIP-42 still authenticates the Nostr
// identity on top. Both claims are required.

/** Protomux protocol name. Bump the suffix when the framing changes. */
const PROTOCOL = 'hive/nostr/1'

/** Derive the DHT keypair from the Nostr secret so one key names both. */
function swarmKeyPair (nostrSecretKey) {
  const secret = typeof nostrSecretKey === 'string' ? fromHex(nostrSecretKey) : nostrSecretKey
  const seed = sha256(b4a.concat([b4a.from('hive:swarm:v1'), b4a.from(secret)]))
  return DHT.keyPair(b4a.from(seed))
}

function decodeAddress (address) {
  const key = typeof address === 'string'
    ? fromHex(address.replace(/^hyper:\/\//, ''))
    : address
  return b4a.from(key)
}

class SwarmTransport extends Transport {
  /**
   * @param {import('../relay').Relay} relay
   * @param {object} [opts]
   * @param {object} [opts.keyPair]  DHT keypair. Defaults to one derived from the relay secret.
   * @param {object} [opts.dht]  An existing HyperDHT node. When omitted the transport creates and destroys its own.
   * @param {Array} [opts.bootstrap]  Bootstrap nodes for a node the transport creates.
   */
  constructor (relay, opts = {}) {
    super(relay, opts)

    this.keyPair = opts.keyPair ?? swarmKeyPair(relay.secretKey)
    this.publicKey = toHex(this.keyPair.publicKey)
    this.dht = opts.dht ?? new DHT({ bootstrap: opts.bootstrap })
    this.ownsDht = opts.dht === undefined
    this.server = null
    this.streams = new Set()
  }

  get link () {
    return 'hyper://' + this.publicKey
  }

  describe () {
    return { publicKey: this.publicKey }
  }

  async listen () {
    this.server = this.dht.createServer((stream) => this._onstream(stream))
    await this.server.listen(this.keyPair)

    this.relay.swarmKey = this.publicKey
    return this.publicKey
  }

  async close () {
    // Stop taking new peers before dropping the ones we have.
    if (this.server !== null) {
      await this.server.close()
      this.server = null
    }

    for (const stream of [...this.streams]) stream.destroy()
    this.streams.clear()

    if (this.ownsDht) await this.dht.destroy()
  }

  _onstream (stream) {
    this.streams.add(stream)

    // An error is always followed by 'close', which is where cleanup happens.
    // Without a listener it would be thrown as an uncaught exception.
    stream.on('error', () => {})
    stream.on('close', () => this.streams.delete(stream))

    // Open our side of the channel only when the peer asks for it, so a peer
    // that speaks some other protocol never reaches the relay.
    Protomux.from(stream).pair({ protocol: PROTOCOL }, () => this._onchannel(stream))
  }

  _onchannel (stream) {
    let session = null

    const channel = Protomux.from(stream).createChannel({
      protocol: PROTOCOL,
      onopen: () => {
        session = this.accept({
          // Always reports success. The stream buffers writes beyond its
          // high-water mark, and the relay drops a peer after three false
          // returns in a row, which would disconnect any client that reads a
          // long history. Slow-peer detection needs the relay to wait for
          // 'drain' instead.
          send: (frame) => {
            frames.send(frame)
            return true
          },
          close: () => {
            channel.close()
            stream.end()
          },
          remote: toHex(stream.remotePublicKey ?? b4a.alloc(32))
        })
      },
      onclose: () => session?.closed()
    })

    // null when the peer opened this protocol twice on one stream.
    if (channel === null) return

    const frames = channel.addMessage({
      encoding: c.string,
      onmessage: (frame) => {
        if (session === null) return

        if (b4a.byteLength(frame) > LIMITS.MAX_FRAME_BYTES) {
          session.fail(new Error(`frame exceeds ${LIMITS.MAX_FRAME_BYTES} bytes`))
          stream.destroy()
          return
        }
        session.receive(frame)
      }
    })

    channel.open()
  }
}

/**
 * Client side: dial a relay by its DHT public key (`hyper://<hex>` or raw
 * bytes) and open the same Protomux channel.
 *
 * `connect` rejects when the relay cannot be reached. After it resolves, a
 * lost connection is reported through `onclose`. One client can `connect`
 * again after that, which reuses its DHT node; `close` also destroys the node
 * when the client created it.
 */
class SwarmClient extends TransportClient {
  /**
   * @param {object} [opts]
   * @param {object} [opts.dht]  An existing HyperDHT node to dial from.
   * @param {Array} [opts.bootstrap]  Bootstrap nodes for a node the client creates.
   * @param {object} [opts.keyPair]  Identity to present to the relay. Defaults to the node's own.
   */
  constructor (opts = {}) {
    super(opts)

    this.dht = opts.dht ?? new DHT({ bootstrap: opts.bootstrap })
    this.ownsDht = opts.dht === undefined
    this.stream = null
    this.frames = null
  }

  async connect (address, { onframe, onclose } = {}) {
    this._disconnect()

    const stream = this.dht.connect(decodeAddress(address), { keyPair: this.opts.keyPair })

    // Kept so a failed dial can say why. The 'close' that follows an error is
    // what ends the channel, so this listener only has to exist and remember.
    let failure = null
    stream.on('error', (err) => { failure = err })

    let live = false
    const channel = Protomux.from(stream).createChannel({
      protocol: PROTOCOL,
      onclose: () => {
        stream.destroy()
        if (this.stream === stream) this._forget()
        if (live) onclose?.(failure ?? undefined)
      }
    })

    if (channel === null) throw new Error('the connection closed before it opened')

    const frames = channel.addMessage({
      encoding: c.string,
      onmessage: (frame) => {
        if (b4a.byteLength(frame) > LIMITS.MAX_FRAME_BYTES) {
          stream.destroy()
          return
        }
        onframe?.(frame)
      }
    })

    channel.open()

    if (!(await channel.fullyOpened())) {
      stream.destroy()
      throw failure ?? new Error('the relay closed the connection before the handshake finished')
    }

    live = true
    this.stream = stream
    this.frames = frames
  }

  send (frame) {
    return this.frames.send(frame)
  }

  async close () {
    this._disconnect()
    if (this.ownsDht) await this.dht.destroy()
  }

  _disconnect () {
    if (this.stream === null) return
    this.stream.destroy()
    this._forget()
  }

  _forget () {
    this.stream = null
    this.frames = null
  }
}

module.exports = { SwarmTransport, SwarmClient, swarmKeyPair, PROTOCOL }

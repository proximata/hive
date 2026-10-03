'use strict'

const DHT = require('hyperdht')
const b4a = require('b4a')

const { sha256, fromHex, toHex, LIMITS } = require('hive-core')
const { Transport, TransportClient } = require('./transport')

// The Pears half of reachability.
//
// The relay listens on a HyperDHT keypair derived from its Nostr secret key, so
// one secret names both identities. Clients dial `hyper://<dht public key>`: the
// DHT finds the relay and holepunches a Noise-encrypted stream, so the relay
// needs no open port, DNS name or certificate. Frames are the same JSON the
// WebSocket transport carries, length-prefixed over that stream, which is why
// the protocol test suite runs unchanged over both.
//
// The Noise handshake authenticates the *transport*. NIP-42 still authenticates
// the *Nostr identity* on top: two different claims, both required.

const FRAME_HEADER_BYTES = 4

/** Derive the DHT keypair from the Nostr secret so one key names both. */
function swarmKeyPair (nostrSecretKey) {
  const secret = typeof nostrSecretKey === 'string' ? fromHex(nostrSecretKey) : nostrSecretKey
  const seed = sha256(b4a.concat([b4a.from('hive:swarm:v1'), b4a.from(secret)]))
  return DHT.keyPair(b4a.from(seed))
}

/** Length-prefixed framing over a raw duplex stream. */
class FrameReader {
  constructor (onframe, onerror) {
    this.buffer = b4a.alloc(0)
    this.onframe = onframe
    this.onerror = onerror
  }

  push (chunk) {
    this.buffer = b4a.concat([this.buffer, chunk])

    while (this.buffer.byteLength >= FRAME_HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(0)
      if (length > LIMITS.MAX_FRAME_BYTES) {
        this.onerror(new Error(`frame exceeds ${LIMITS.MAX_FRAME_BYTES} bytes`))
        return
      }
      if (this.buffer.byteLength < FRAME_HEADER_BYTES + length) return

      const frame = this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)
      this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + length)
      this.onframe(b4a.toString(frame))
    }
  }
}

function encodeFrame (text) {
  const payload = b4a.from(text, 'utf8')
  const header = b4a.alloc(FRAME_HEADER_BYTES)
  header.writeUInt32BE(payload.byteLength, 0)
  return b4a.concat([header, payload])
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
    for (const stream of [...this.streams]) {
      try {
        stream.destroy()
      } catch {}
    }
    this.streams.clear()

    if (this.server !== null) await this.server.close()
    if (this.ownsDht) await this.dht.destroy()
  }

  _onstream (stream) {
    this.streams.add(stream)

    const session = this.accept({
      send: (frame) => {
        stream.write(encodeFrame(frame))
        return true
      },
      close: () => stream.end(),
      remote: toHex(stream.remotePublicKey ?? b4a.alloc(32))
    })

    if (session === null) {
      stream.end()
      this.streams.delete(stream)
      return
    }

    const reader = new FrameReader(
      (frame) => session.receive(frame),
      (err) => {
        session.fail(err)
        stream.destroy()
      }
    )

    stream.on('data', (chunk) => reader.push(chunk))

    const done = () => {
      this.streams.delete(stream)
      session.closed()
    }
    stream.on('close', done)
    stream.on('end', done)
    stream.on('error', done)
  }
}

/** Client side: dial a relay by its DHT public key (`hyper://<hex>` or raw bytes) and speak the same framing. */
class SwarmClient extends TransportClient {
  constructor (opts = {}) {
    super(opts)

    this.dht = opts.dht ?? new DHT({ bootstrap: opts.bootstrap })
    this.ownsDht = opts.dht === undefined
    this.stream = null
  }

  async connect (address, { onframe, onclose } = {}) {
    const key = typeof address === 'string'
      ? fromHex(address.replace(/^hyper:\/\//, ''))
      : address

    const stream = this.dht.connect(b4a.from(key))
    // An error is always followed by 'close', which is where cleanup happens.
    // Without a listener the relay dropping this peer (a reset) would be thrown
    // as an uncaught exception.
    stream.on('error', () => {})
    await stream.opened

    const reader = new FrameReader(
      (frame) => onframe?.(frame),
      () => stream.destroy()
    )
    stream.on('data', (chunk) => reader.push(chunk))
    stream.on('close', () => onclose?.())

    this.stream = stream
  }

  send (frame) {
    this.stream.write(encodeFrame(frame))
  }

  async close () {
    if (this.stream !== null) {
      this.stream.destroy()
      this.stream = null
    }
    if (this.ownsDht) await this.dht.destroy()
  }
}

module.exports = { SwarmTransport, SwarmClient, swarmKeyPair, encodeFrame, FrameReader }

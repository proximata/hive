'use strict'

const b4a = require('b4a')

const { LIMITS } = require('hive-core')
const { Transport, TransportClient } = require('./transport')

// An in-process transport: a relay and its clients in one runtime, no sockets.
// It is the smallest complete implementation of the transport contract, so it
// doubles as the worked example in docs/transports.md and as the fixture for
// tests that need a relay without a network.
//
// Servers register under a name in a module-level table; a client dials
// `loopback://<name>`. Frames are delivered on a later turn of the event loop,
// the way a socket would deliver them, so code written against this transport
// sees the same ordering it would see against a real one.

/** @type {Map<string, LoopbackTransport>} */
const listening = new Map()

const later = (fn) => setImmediate(fn)

class LoopbackTransport extends Transport {
  /**
   * @param {import('../relay').Relay} relay
   * @param {object} [opts]
   * @param {string} [opts.name]  Name clients dial. Defaults to one derived from the relay key.
   */
  constructor (relay, opts = {}) {
    super(relay, opts)

    this.name = opts.name ?? 'relay-' + relay.pubkey.slice(0, 8)
    this.links = new Set()
  }

  get link () {
    return 'loopback://' + this.name
  }

  async listen () {
    if (listening.has(this.name)) throw new Error(`a loopback transport is already listening as "${this.name}"`)
    listening.set(this.name, this)
    return this.link
  }

  async close () {
    if (listening.get(this.name) === this) listening.delete(this.name)
    for (const link of [...this.links]) link.end()
  }

  /**
   * Called by a client that dials this transport. Returns the client's handle
   * on the new link.
   */
  _dial ({ onframe, onclose }) {
    let ended = false
    let session = null

    const link = {
      // Server to client.
      push: (frame) => {
        if (ended) return false
        later(() => { if (!ended) onframe?.(frame) })
        return true
      },

      // Client to server.
      send: (frame) => {
        later(() => {
          if (ended || session === null) return
          if (b4a.byteLength(frame) > LIMITS.MAX_FRAME_BYTES) {
            session.fail(new Error(`frame exceeds ${LIMITS.MAX_FRAME_BYTES} bytes`))
            link.end()
            return
          }
          session.receive(frame)
        })
      },

      end: () => {
        if (ended) return
        ended = true
        this.links.delete(link)
        later(() => onclose?.())
        session?.closed()
      }
    }

    this.links.add(link)

    session = this.accept({
      send: (frame) => link.push(frame),
      close: () => link.end()
    })

    return link
  }
}

/** Client side: dial `loopback://<name>`. */
class LoopbackClient extends TransportClient {
  constructor (opts = {}) {
    super(opts)
    this.link = null
  }

  async connect (address, { onframe, onclose } = {}) {
    const name = address.replace(/^loopback:\/\//, '')
    const server = listening.get(name)
    if (server === undefined) throw new Error(`no loopback transport is listening as "${name}"`)

    this.link?.end()
    this.link = server._dial({ onframe, onclose })
  }

  send (frame) {
    this.link.send(frame)
    return true
  }

  async close () {
    this.link?.end()
    this.link = null
  }
}

module.exports = { LoopbackTransport, LoopbackClient }

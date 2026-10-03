'use strict'

/**
 * The contract between the relay and a transport.
 *
 * A transport has two halves.
 *
 * Server half (`Transport`, below): listens for peers and hands each one to the
 * relay as a `Connection`. It owns everything wire-specific: framing,
 * encryption, backpressure, peer identity.
 *
 * Client half (`TransportClient`, below): dials a relay at an address and
 * exchanges text frames. Agents and the test client use it, so they do not
 * care which transport reaches the relay.
 *
 * Both halves move whole text frames. A frame is one NIP-01 message
 * (`["EVENT", ...]`, `["REQ", ...]`, ...) as a JSON string; the relay parses it.
 * Identity is not a transport concern: Nostr identity comes from NIP-42 on top
 * of whatever the transport provides. A transport may derive its own wire key
 * from `relay.secretKey` (the swarm and replication transports do), but never
 * signs events.
 *
 * A transport that connects relays to each other instead of clients to a relay
 * (replication) shares the lifecycle half of this class (`link`, `listen`,
 * `close`, `describe`) and never calls `accept`: its peers are not Nostr
 * clients and have no `Connection`. It registers without a client half and
 * without schemes.
 *
 * See docs/transports.md for a walkthrough.
 */

/**
 * A peer as the transport sees it, passed to `Transport#accept`.
 *
 * @typedef {object} Peer
 * @property {(frame: string) => boolean} send  Write one frame. Return false
 *   when the transport is backed up; three false returns in a row make the
 *   relay drop the connection.
 * @property {(reason?: string) => void} close  Close the underlying link.
 * @property {string | null} [remote]  Transport-level identity of the peer,
 *   for example its public key. Informational.
 * @property {string | null} [url]  The address the peer dialed. NIP-42 binds
 *   the AUTH event to this, so it must be what the client puts in its `relay`
 *   tag. Defaults to `this.link`.
 */

/**
 * What `accept` returns: the transport's handle on one admitted peer.
 *
 * @typedef {object} Session
 * @property {import('../relay').Connection} connection
 * @property {(frame: string) => Promise<void>} receive  Feed one inbound frame.
 * @property {(reason?: string) => void} closed  The link went away.
 * @property {(err: Error) => void} fail  The link broke or the peer misbehaved.
 *   Reports `connection-error` on the relay and closes the connection.
 */

class Transport {
  /**
   * @param {import('../relay').Relay} relay
   * @param {object} [opts]  Transport-specific options.
   */
  constructor (relay, opts = {}) {
    this.relay = relay
    this.opts = opts
  }

  /** Address clients dial, e.g. `ws://127.0.0.1:3000` or `hyper://<pubkey>`. */
  get link () {
    throw new Error(`${this.constructor.name} must implement link`)
  }

  /** Extra facts to show an operator once listening, for example a port. */
  describe () {
    return {}
  }

  /** Start accepting peers. Resolves once clients can connect. */
  async listen () {
    throw new Error(`${this.constructor.name} must implement listen()`)
  }

  /** Close every peer and stop listening. Resolves when nothing is left open. */
  async close () {
    throw new Error(`${this.constructor.name} must implement close()`)
  }

  /**
   * Admit a peer. Returns a `Session`, or null when the relay refused it
   * (at capacity); in that case `peer.close` has already been called.
   *
   * @param {Peer} peer
   * @returns {Session | null}
   */
  accept (peer) {
    const { send, close, remote = null, url = null } = peer
    const connection = this.relay.connect({ send, close, remote, url: url ?? this.link })
    if (connection === null) return null

    return {
      connection,
      receive: (frame) => Promise.resolve(connection.message(frame))
        .catch((err) => { this.relay.emit('error', err) }),
      closed: (reason = 'transport closed') => connection.close(reason),
      fail: (err) => {
        this.relay.emit('connection-error', err, connection)
        connection.close(err.message)
      }
    }
  }
}

/**
 * Client half of a transport. One instance holds at most one live connection;
 * `connect` may be called again after the previous connection closed.
 */
class TransportClient {
  /** @param {object} [opts]  Transport-specific options, for example `bootstrap`. */
  constructor (opts = {}) {
    this.opts = opts
  }

  /**
   * Dial `address` and start delivering frames.
   *
   * @param {string} address
   * @param {object} [handlers]
   * @param {(frame: string) => void} [handlers.onframe]  One inbound frame.
   * @param {(err?: Error) => void} [handlers.onclose]  The connection ended.
   * @param {(err: Error) => void} [handlers.onerror]  A socket-level error.
   *   Transports that always follow an error with a close may leave it unused.
   */
  async connect (address, handlers = {}) {
    throw new Error(`${this.constructor.name} must implement connect()`)
  }

  /** Send one frame on the live connection. */
  send (frame) {
    throw new Error(`${this.constructor.name} must implement send()`)
  }

  /** End the connection and release everything this client owns. */
  async close () {
    throw new Error(`${this.constructor.name} must implement close()`)
  }
}

module.exports = { Transport, TransportClient }

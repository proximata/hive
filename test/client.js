'use strict'

const ws = require('bare-ws')

const { buildAuthEvent } = require('hive-auth')
const { parseRelayMessage } = require('hive-relay').protocol
const { SwarmClient } = require('hive-relay/lib/transports/swarm')

// A minimal relay client used by the test suites. It buffers every relay
// message so a test can assert on ordering (EVENT… then EOSE) rather than
// racing it, and it speaks either transport behind one API — which is how the
// same protocol suite runs twice.

const DEFAULT_TIMEOUT = 5000

class TestClient {
  constructor () {
    this.messages = []
    this.waiters = []
    this.challenge = null
    this.closed = false
    this._send = null
    this._close = null
  }

  static async openWebSocket ({ port, host = '127.0.0.1' }) {
    const client = new TestClient()
    const socket = new ws.Socket({ port, host })

    socket.on('data', (data) => client._receive(data.toString()))
    socket.on('close', () => { client.closed = true })
    socket.on('error', () => { client.closed = true })

    client._send = (frame) => socket.write(frame)
    client._close = () => socket.end()

    await client.waitFor((m) => m.type === 'AUTH')
    return client
  }

  static async openSwarm ({ publicKey, bootstrap }) {
    const client = new TestClient()
    const swarm = new SwarmClient({ bootstrap })

    await swarm.connect(publicKey, {
      onframe: (frame) => client._receive(frame),
      onclose: () => { client.closed = true }
    })

    client._send = (frame) => swarm.send(frame)
    client._close = () => swarm.close()

    await client.waitFor((m) => m.type === 'AUTH')
    return client
  }

  _receive (raw) {
    let message
    try {
      message = parseRelayMessage(raw)
    } catch {
      return
    }

    if (message.type === 'AUTH') this.challenge = message.challenge
    this.messages.push(message)

    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        clearTimeout(waiter.timer)
        message.consumed = true
        waiter.resolve(message)
        break
      }
    }
  }

  /**
   * Resolve with the first unconsumed message matching `predicate`, past or
   * future. Matches are marked consumed so that publishing the same event twice
   * waits for the second OK rather than re-reading the first.
   */
  waitFor (predicate, timeout = DEFAULT_TIMEOUT) {
    const existing = this.messages.find((m) => !m.consumed && predicate(m))
    if (existing !== undefined) {
      existing.consumed = true
      return Promise.resolve(existing)
    }

    return new Promise((resolve, reject) => {
      const waiter = { predicate: (m) => !m.consumed && predicate(m), resolve }
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error('timed out waiting for a relay message; received: ' +
          JSON.stringify(this.messages.map((m) => m.type))))
      }, timeout)
      this.waiters.push(waiter)
    })
  }

  send (message) {
    this._send(JSON.stringify(message))
  }

  /** Complete the NIP-42 handshake. Resolves to the relay's OK message. */
  async authenticate (identity, { relayUrl, created_at: createdAt } = {}) {
    const event = buildAuthEvent({
      challenge: this.challenge,
      relayUrl: relayUrl ?? 'ws://127.0.0.1',
      secretKey: identity.secretKey,
      created_at: createdAt
    })

    this.send(['AUTH', event])
    return this.waitFor((m) => m.type === 'OK' && m.id === event.id)
  }

  async publish (event) {
    this.send(['EVENT', event])
    return this.waitFor((m) => m.type === 'OK' && m.id === event.id)
  }

  /**
   * Subscribe and collect the historical batch. Resolves once EOSE arrives, or
   * immediately with `{ closed }` if the relay refused the subscription.
   */
  async subscribe (subId, ...filters) {
    const before = this.messages.length
    this.send(['REQ', subId, ...filters])

    const message = await this.waitFor(
      (m) => (m.type === 'EOSE' || m.type === 'CLOSED') && m.subId === subId
    )
    if (message.type === 'CLOSED') return { closed: message.reason, events: [] }

    const historical = this.messages
      .slice(before)
      .filter((m) => m.type === 'EVENT' && m.subId === subId)

    // Consumed here so a later nextEvent() waits for a genuinely live event
    // rather than replaying the historical batch.
    for (const m of historical) m.consumed = true

    return { closed: null, events: historical.map((m) => m.event) }
  }

  async count (subId, ...filters) {
    this.send(['COUNT', subId, ...filters])
    const message = await this.waitFor((m) => (m.type === 'COUNT' || m.type === 'CLOSED') && m.subId === subId)
    return message.type === 'CLOSED' ? { closed: message.reason, count: null } : { closed: null, count: message.count }
  }

  close (subId) {
    this.send(['CLOSE', subId])
  }

  /** Wait for a live EVENT delivered on this subscription after `subscribe`. */
  async nextEvent (subId, timeout) {
    const message = await this.waitFor(
      (m) => m.type === 'EVENT' && m.subId === subId && !m.consumed,
      timeout
    )
    message.consumed = true
    return message.event
  }

  received (type) {
    return this.messages.filter((m) => m.type === type)
  }

  async destroy () {
    this.closed = true
    for (const waiter of this.waiters) clearTimeout(waiter.timer)
    this.waiters = []
    try {
      await this._close?.()
    } catch {}
  }
}

module.exports = { TestClient }

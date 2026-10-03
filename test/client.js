'use strict'

const { buildAuthEvent } = require('hive-auth')
const { protocol, transports } = require('hive-relay')

// A minimal relay client used by the test suites. It buffers every relay
// message so a test can assert on ordering (EVENT then EOSE) rather than
// racing it. It dials through the transport registry, so the same suites can
// run against any registered transport.

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

  /**
   * Dial `address` through the transport registry and wait for the NIP-42
   * challenge. `opts` go to the transport client (for example `bootstrap`).
   */
  static async open (address, opts = {}) {
    const client = new TestClient()
    const transport = transports.createClient(address, opts)

    await transport.connect(address, {
      onframe: (frame) => client._receive(frame),
      onclose: () => { client.closed = true }
    })

    client._send = (frame) => transport.send(frame)
    client._close = () => transport.close()

    await client.waitFor((m) => m.type === 'AUTH')
    return client
  }

  static openWebSocket ({ port, host = '127.0.0.1' }) {
    return TestClient.open(`ws://${host}:${port}`)
  }

  static openSwarm ({ publicKey, bootstrap }) {
    return TestClient.open('hyper://' + publicKey, { bootstrap })
  }

  _receive (raw) {
    let message
    try {
      message = protocol.parseRelayMessage(raw)
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

'use strict'

const EventEmitter = require('bare-events')
const ws = require('bare-ws')

const { buildAuthEvent } = require('hive-auth')
const { protocol } = require('hive-relay')
const { SwarmClient } = require('hive-relay/lib/transports/swarm')

/**
 * A relay connection for agents: NIP-42 handshake, subscriptions, publishing,
 * and reconnect. Speaks either transport — `ws://host:port` or
 * `hyper://<relay pubkey>` — behind one API, because an agent should not care
 * how it reached its workspace.
 */
class RelayConnection extends EventEmitter {
  constructor ({ url, secretKey, bootstrap = null, reconnect = true }) {
    super()

    this.url = url
    this.secretKey = secretKey
    this.bootstrap = bootstrap
    this.reconnect = reconnect

    this.socket = null
    this.swarm = null
    this.challenge = null
    this.authenticated = false
    this.closed = false
    this.pending = new Map() // event id -> resolver awaiting its OK
    this.subscriptions = new Map() // subId -> filters, replayed on reconnect
    this.backoff = 500
  }

  get isSwarm () {
    return this.url.startsWith('hyper://')
  }

  async connect () {
    if (this.isSwarm) {
      this.swarm = new SwarmClient({ bootstrap: this.bootstrap })
      await this.swarm.connect(this.url, {
        onframe: (frame) => this._onframe(frame),
        onclose: () => this._ondisconnect()
      })
      this._write = (frame) => this.swarm.send(frame)
    } else {
      const target = new URL(this.url.replace(/^ws/, 'http'))
      const socket = new ws.Socket({ host: target.hostname, port: Number(target.port) || 80 })

      socket.on('data', (data) => this._onframe(data.toString()))
      socket.on('close', () => this._ondisconnect())
      socket.on('error', (err) => this._onerror(err))

      this.socket = socket
      this._write = (frame) => socket.write(frame)
    }

    await this._authenticate()

    // Replay subscriptions so a reconnect is invisible to the caller.
    for (const [subId, filters] of this.subscriptions) {
      this._write(JSON.stringify(['REQ', subId, ...filters]))
    }

    this.backoff = 500
    this.emit('connected')
    return this
  }

  _authenticate () {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the NIP-42 challenge')), 15000)

      this.once('challenge', () => {
        const event = buildAuthEvent({
          challenge: this.challenge,
          relayUrl: this.url,
          secretKey: this.secretKey
        })

        this.pending.set(event.id, (ok) => {
          clearTimeout(timer)
          if (ok.accepted) {
            this.authenticated = true
            resolve()
          } else {
            reject(new Error('authentication rejected: ' + ok.reason))
          }
        })

        this._write(JSON.stringify(['AUTH', event]))
      })
    })
  }

  _onframe (raw) {
    let message
    try {
      message = protocol.parseRelayMessage(raw)
    } catch {
      return
    }

    switch (message.type) {
      case 'AUTH':
        this.challenge = message.challenge
        this.emit('challenge', message.challenge)
        break

      case 'OK': {
        const resolver = this.pending.get(message.id)
        if (resolver !== undefined) {
          this.pending.delete(message.id)
          resolver(message)
        }
        break
      }

      case 'EVENT':
        this.emit('event', message.event, message.subId)
        break

      case 'EOSE':
        this.emit('eose', message.subId)
        break

      case 'CLOSED':
        this.subscriptions.delete(message.subId)
        this.emit('closed-subscription', message.subId, message.reason)
        break

      case 'NOTICE':
        this.emit('notice', message.message)
        break
    }
  }

  /**
   * A relay that goes away is a disconnect, not a fault. Losing the socket is
   * the normal end of every connection — during shutdown, on a relay restart,
   * or when a laptop closes — and the reconnect loop already handles it.
   * Reporting it as an error would make every clean teardown look like a
   * failure, so only genuinely unexpected errors are raised.
   */
  _onerror (err) {
    const expected = err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ENOTCONN'
    if (this.closed || expected) {
      this._ondisconnect()
      return
    }
    this.emit('error', err)
  }

  _ondisconnect () {
    if (this.authenticated === false && this.closed) return // already torn down
    this.authenticated = false
    this.emit('disconnected')

    if (this.closed || !this.reconnect) return

    // Exponential backoff to 30s. A relay that is down should not be hammered,
    // and an agent that reconnects instantly on every blip is worse than one
    // that waits.
    setTimeout(() => {
      if (this.closed) return
      this.connect().catch((err) => this.emit('error', err))
    }, this.backoff)
    this.backoff = Math.min(this.backoff * 2, 30000)
  }

  publish (event, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(event.id)
        reject(new Error('timed out waiting for OK'))
      }, timeout)

      this.pending.set(event.id, (ok) => {
        clearTimeout(timer)
        resolve(ok)
      })
      this._write(JSON.stringify(['EVENT', event]))
    })
  }

  subscribe (subId, ...filters) {
    this.subscriptions.set(subId, filters)
    this._write(JSON.stringify(['REQ', subId, ...filters]))
  }

  unsubscribe (subId) {
    this.subscriptions.delete(subId)
    this._write(JSON.stringify(['CLOSE', subId]))
  }

  async close () {
    this.closed = true
    try {
      if (this.socket !== null) this.socket.end()
      if (this.swarm !== null) await this.swarm.close()
    } catch {
      // Already gone.
    }
  }
}

module.exports = { RelayConnection }

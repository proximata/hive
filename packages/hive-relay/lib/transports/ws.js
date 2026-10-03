'use strict'

const http = require('bare-http1')
const ws = require('bare-ws')
const b4a = require('b4a')

const { LIMITS } = require('hive-core')
const { createRestRouter } = require('../rest')
const { Transport, TransportClient } = require('./transport')

/**
 * WebSocket and HTTP on one port.
 *
 * bare-ws accepts an existing server, so the HTTP router and the WebSocket
 * upgrade share a listener. That lets a client use `http://host` and
 * `ws://host` interchangeably, as Buzz does.
 */
class WebSocketTransport extends Transport {
  constructor (relay, opts = {}) {
    super(relay, opts)

    this.port = opts.port ?? 3000
    // Loopback unless the caller says otherwise. Every path that widens this
    // starts at an explicit --host; see packages/hive-relay/lib/bind.js.
    this.host = opts.host ?? '127.0.0.1'
    // The origin clients reach, when it differs from the bind address because
    // a TLS proxy terminates in front. NIP-98 binds signatures to the full
    // request URL, so relay.url has to be the public one or nothing verifies.
    this.publicUrl = opts.publicUrl ?? null
    this.mediaStore = opts.mediaStore ?? null

    this.router = createRestRouter(relay, {
      mediaStore: this.mediaStore,
      publicDir: opts.publicDir ?? null
    })
    this.server = http.createServer((req, res) => this._onrequest(req, res))
    this.wss = new ws.Server({ server: this.server }, (socket) => this._onconnection(socket))
    this.sockets = new Set()
  }

  get link () {
    return this.relay.url
  }

  listen () {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject)
      this.server.listen(this.port, this.host, () => {
        const address = this.server.address()
        this.port = address.port
        this.relay.url = this.publicUrl ?? `ws://${this.host}:${this.port}`
        resolve(address)
      })
    })
  }

  close () {
    for (const socket of [...this.sockets]) {
      try {
        socket.destroy()
      } catch {}
    }
    this.sockets.clear()

    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  address () {
    return this.server.address()
  }

  /** The URL that was actually bound (the port the OS picked for port 0, or the public origin). */
  describe () {
    return { url: this.relay.url.replace(/^ws/, 'http'), host: this.host, port: this.port }
  }

  _onconnection (socket) {
    this.sockets.add(socket)

    const session = this.accept({
      send: (frame) => {
        socket.write(frame)
        return true
      },
      close: () => socket.end()
    })

    if (session === null) {
      socket.end()
      this.sockets.delete(socket)
      return
    }

    socket.on('data', (data) => {
      if (data.byteLength > LIMITS.MAX_FRAME_BYTES) {
        session.connection.send(JSON.stringify(['NOTICE', 'invalid: frame too large']))
        session.closed('frame too large')
        return
      }
      session.receive(b4a.toString(data))
    })

    const done = () => {
      this.sockets.delete(socket)
      session.closed()
    }
    socket.on('close', done)
    socket.on('end', done)
    socket.on('error', done)
  }

  async _onrequest (req, res) {
    try {
      await this.router(req, res)
    } catch (err) {
      // Guarded: EventEmitter rethrows an 'error' with no listener, so an
      // unhandled request error used to take the whole process down before the
      // 500 was ever written. One malformed request must not be a kill switch.
      if (this.relay.listenerCount('error') > 0) this.relay.emit('error', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal', message: err.message }))
      }
    }
  }
}

/**
 * Client side: a WebSocket to `ws://host:port` (or `http://host:port`).
 *
 * `connect` returns without waiting for the socket to open. A refused
 * connection arrives through `onerror` (or `onclose` when none is given), the
 * same way a dropped one does, so callers have one path for both.
 */
class WebSocketClient extends TransportClient {
  constructor (opts = {}) {
    super(opts)
    this.socket = null
  }

  async connect (address, { onframe, onclose, onerror } = {}) {
    const target = new URL(address.replace(/^ws/, 'http'))
    const socket = new ws.Socket({ host: target.hostname, port: Number(target.port) || 80 })

    socket.on('data', (data) => onframe?.(data.toString()))
    socket.on('close', () => onclose?.())
    socket.on('error', (err) => (onerror ?? onclose)?.(err))

    this.socket = socket
  }

  send (frame) {
    this.socket.write(frame)
  }

  async close () {
    if (this.socket !== null) {
      this.socket.end()
      this.socket = null
    }
  }
}

module.exports = { WebSocketTransport, WebSocketClient }

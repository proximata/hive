'use strict'

const http = require('bare-http1')
const ws = require('bare-ws')
const b4a = require('b4a')

const { LIMITS } = require('hive-core')
const { createRestRouter } = require('../rest')

/**
 * WebSocket + HTTP on one port.
 *
 * bare-ws accepts an existing server, so the HTTP router and the WebSocket
 * upgrade share a listener — which is what lets a client use `http://host` and
 * `ws://host` interchangeably, exactly as Buzz does.
 */
class WebSocketTransport {
  constructor (relay, opts = {}) {
    this.relay = relay
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

  _onconnection (socket) {
    this.sockets.add(socket)

    const connection = this.relay.connect({
      send: (frame) => {
        socket.write(frame)
        return true
      },
      close: () => socket.end(),
      url: this.relay.url
    })

    if (connection === null) {
      socket.end()
      this.sockets.delete(socket)
      return
    }

    socket.on('data', (data) => {
      if (data.byteLength > LIMITS.MAX_FRAME_BYTES) {
        connection.send(JSON.stringify(['NOTICE', 'invalid: frame too large']))
        connection.close('frame too large')
        return
      }
      Promise.resolve(connection.message(b4a.toString(data))).catch((err) => this.relay.emit('error', err))
    })

    const done = () => {
      this.sockets.delete(socket)
      connection.close('transport closed')
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

module.exports = { WebSocketTransport }

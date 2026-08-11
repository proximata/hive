'use strict'

const http = require('bare-http1')
const ws = require('bare-ws')
const b4a = require('b4a')
const crypto = require('bare-crypto')
const { negotiateCompression, buildExtensionHeader, CompressedWebSocket } = require('./ws-compression')

const { LIMITS } = require('hive-core')
const { createRestRouter } = require('../rest')

// Constants from bare-ws
const GUID = Buffer.from('258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
const EOL = '\r\n'
const EOF = EOL.repeat(2)
const KEY = /^[+/0-9A-Za-z]{22}==$/

/**
 * WebSocket + HTTP on one port with permessage-deflate support.
 *
 * Handles both compressed and non-compressed WebSocket connections.
 */
class WebSocketTransport {
  constructor (relay, opts = {}) {
    this.relay = relay
    this.port = opts.port ?? 3000
    this.host = opts.host ?? '127.0.0.1'
    this.mediaStore = opts.mediaStore ?? null

    // Compression options
    this.compression = opts.compression !== false
    this.compressionOptions = {
      clientNoContextTakeover: opts.clientNoContextTakeover ?? false,
      serverNoContextTakeover: opts.serverNoContextTakeover ?? false,
      clientMaxWindowBits: opts.clientMaxWindowBits ?? 15,
      serverMaxWindowBits: opts.serverMaxWindowBits ?? 15
    }

    this.router = createRestRouter(relay, { mediaStore: this.mediaStore })
    this.server = http.createServer((req, res) => this._onrequest(req, res))

    // Handle all WebSocket upgrades in our custom handler
    this.server.on('upgrade', this._onupgrade.bind(this))

    this.sockets = new Set()
  }

  listen () {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject)
      this.server.listen(this.port, this.host, () => {
        const address = this.server.address()
        this.port = address.port
        this.relay.url = `ws://${this.host}:${this.port}`
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

  _onupgrade (req, socket, head) {
    // Check if client wants compression
    const wantsCompression = this.compression && req.headers['sec-websocket-extensions']

    if (wantsCompression) {
      // Negotiate compression
      const compressionParams = negotiateCompression(req, socket, head, this.compressionOptions)
      if (compressionParams) {
        this._handleCompressedUpgrade(req, socket, head, compressionParams)
        return
      }
    }

    // Standard (non-compressed) upgrade - use bare-ws handshake
    this._handleStandardUpgrade(req, socket, head)
  }

  _handleCompressedUpgrade (req, socket, head, compressionParams) {
    this._handshakeWithCompression(req, socket, head, compressionParams, (err) => {
      if (err) return socket.destroy(err)

      // Create WebSocket from upgraded socket
      const wsocket = new ws.Socket({ socket, isServer: true })

      // Wrap with compression
      const wrapped = new CompressedWebSocket(wsocket, {
        isServer: true,
        clientNoContextTakeover: compressionParams.clientNoContextTakeover,
        serverNoContextTakeover: compressionParams.serverNoContextTakeover,
        clientMaxWindowBits: compressionParams.clientMaxWindowBits,
        serverMaxWindowBits: compressionParams.serverMaxWindowBits
      })

      // Handle the connection
      this._onconnection(wrapped)
    })
  }

  _handleStandardUpgrade (req, socket, head) {
    // Standard WebSocket handshake (inline implementation)
    this._standardHandshake(req, socket, head, (err) => {
      if (err) return socket.destroy(err)

      // Create WebSocket from upgraded socket
      const wsocket = new ws.Socket({ socket, isServer: true })

      // Handle the connection
      this._onconnection(wsocket)
    })
  }

  _standardHandshake (req, socket, head, cb) {
    if (req.headers.upgrade.toLowerCase() !== 'websocket') {
      return cb(this._invalidUpgradeHeader())
    }

    const version = +req.headers['sec-websocket-version']

    if (version !== 8 && version !== 13) {
      return cb(this._invalidVersionHeader())
    }

    const key = req.headers['sec-websocket-key']

    if (!key || !KEY.test(key)) {
      return cb(this._invalidKeyHeader())
    }

    const digest = crypto.createHash('sha1').update(key).update(GUID).digest('base64')

    // Build response headers
    let response = 'HTTP/1.1 101 Web Socket Protocol Handshake' +
      EOL +
      'Upgrade: WebSocket' +
      EOL +
      'Connection: Upgrade' +
      EOL +
      `Sec-WebSocket-Accept: ${digest}`

    response += EOF

    socket.write(response)

    if (head.byteLength) socket.unshift(head)

    cb(null)
  }

  _handshakeWithCompression (req, socket, head, compressionParams, cb) {
    if (req.headers.upgrade.toLowerCase() !== 'websocket') {
      return cb(this._invalidUpgradeHeader())
    }

    const version = +req.headers['sec-websocket-version']

    if (version !== 8 && version !== 13) {
      return cb(this._invalidVersionHeader())
    }

    const key = req.headers['sec-websocket-key']

    if (!key || !KEY.test(key)) {
      return cb(this._invalidKeyHeader())
    }

    const digest = crypto.createHash('sha1').update(key).update(GUID).digest('base64')

    // Build response headers
    let response = 'HTTP/1.1 101 Web Socket Protocol Handshake' +
      EOL +
      'Upgrade: WebSocket' +
      EOL +
      'Connection: Upgrade' +
      EOL +
      `Sec-WebSocket-Accept: ${digest}`

    // Add compression extension header
    const extHeader = buildExtensionHeader(compressionParams)
    response += EOL + `Sec-WebSocket-Extensions: ${extHeader}`

    response += EOF

    socket.write(response)

    if (head.byteLength) socket.unshift(head)

    cb(null)
  }

  // Error constructors (simplified from bare-ws/errors)
  _invalidUpgradeHeader () {
    const err = new Error('INVALID_UPGRADE_HEADER: Invalid Upgrade header')
    err.code = 'INVALID_UPGRADE_HEADER'
    err.status = 1002
    return err
  }

  _invalidVersionHeader () {
    const err = new Error('INVALID_VERSION_HEADER: Invalid Sec-WebSocket-Version header')
    err.code = 'INVALID_VERSION_HEADER'
    err.status = 1002
    return err
  }

  _invalidKeyHeader () {
    const err = new Error('INVALID_KEY_HEADER: Invalid Sec-WebSocket-Key header')
    err.code = 'INVALID_KEY_HEADER'
    err.status = 1002
    return err
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
      this.relay.emit('error', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal', message: err.message }))
      }
    }
  }
}

module.exports = { WebSocketTransport }
'use strict'

const zlib = require('bare-zlib')

/**
 * permessage-deflate implementation for bare-ws (RFC 7692).
 *
 * This module wraps a bare-ws WebSocket socket to add transparent
 * compression/decompression of messages. The handshake negotiation
 * happens at the HTTP upgrade level.
 */

const DEFAULT_WINDOW_BITS = 15
const MAX_WINDOW_BITS = 15
const MIN_WINDOW_BITS = 8

/**
 * Parse the `Sec-WebSocket-Extensions` header to extract
 * permessage-deflate parameters.
 *
 * @param {string} header - The raw header value
 * @returns {Object|null} Parsed parameters or null if not present
 */
function parseExtensionHeader (header) {
  if (!header) return null

  const parts = header.split(',').map(s => s.trim())
  for (const part of parts) {
    const [name, ...params] = part.split(';').map(s => s.trim())
    if (name === 'permessage-deflate') {
      const result = { clientNoContextTakeover: false, serverNoContextTakeover: false }
      for (const param of params) {
        const [key, value] = param.split('=').map(s => s.trim())
        switch (key) {
          case 'client_no_context_takeover':
            result.clientNoContextTakeover = true
            break
          case 'server_no_context_takeover':
            result.serverNoContextTakeover = true
            break
          case 'client_max_window_bits':
            result.clientMaxWindowBits = parseInt(value, 10)
            break
          case 'server_max_window_bits':
            result.serverMaxWindowBits = parseInt(value, 10)
            break
        }
      }
      return result
    }
  }
  return null
}

/**
 * Build the `Sec-WebSocket-Extensions` response header.
 *
 * @param {Object} params - Extension parameters
 * @returns {string} Header value
 */
function buildExtensionHeader (params) {
  const parts = ['permessage-deflate']
  if (params.clientNoContextTakeover) parts.push('client_no_context_takeover')
  if (params.serverNoContextTakeover) parts.push('server_no_context_takeover')
  if (params.clientMaxWindowBits) parts.push(`client_max_window_bits=${params.clientMaxWindowBits}`)
  if (params.serverMaxWindowBits) parts.push(`server_max_window_bits=${params.serverMaxWindowBits}`)
  return parts.join('; ')
}

/**
 * Create a deflate stream with the specified window bits.
 *
 * @param {number} windowBits - zlib window bits (8-15)
 * @returns {Object} Deflate stream
 */
function createDeflateStream (windowBits = DEFAULT_WINDOW_BITS) {
  return zlib.createDeflateRaw({ windowBits: -windowBits })
}

/**
 * Create an inflate stream with the specified window bits.
 *
 * @param {number} windowBits - zlib window bits (8-15)
 * @returns {Object} Inflate stream
 */
function createInflateStream (windowBits = DEFAULT_WINDOW_BITS) {
  return zlib.createInflateRaw({ windowBits })
}

/**
 * Compress a single WebSocket frame payload using permessage-deflate.
 *
 * Per RFC 7692, the payload is compressed with DEFLATE (raw, no zlib header),
 * and the last 4 bytes (0x00 0x00 0xff 0xff) are stripped.
 *
 * @param {Buffer} payload - Uncompressed frame payload
 * @param {Object} compressStream - Active deflate stream
 * @returns {Buffer} Compressed payload
 */
function compressFrame (payload, compressStream) {
  return new Promise((resolve, reject) => {
    const chunks = []

    compressStream.on('data', (chunk) => chunks.push(chunk))
    compressStream.on('error', reject)
    compressStream.on('end', () => {
      const compressed = Buffer.concat(chunks)
      // Strip trailing 0x00 0x00 0xff 0xff per RFC 7692
      if (compressed.length >= 4) {
        const end = compressed.subarray(compressed.length - 4)
        if (end[0] === 0x00 && end[1] === 0x00 && end[2] === 0xff && end[3] === 0xff) {
          resolve(compressed.subarray(0, compressed.length - 4))
          return
        }
      }
      resolve(compressed)
    })

    compressStream.write(payload)
    compressStream.end()
  })
}

/**
 * Decompress a single WebSocket frame payload using permessage-deflate.
 *
 * The payload must have the trailing 0x00 0x00 0xff 0xff appended before
 * decompression per RFC 7692.
 *
 * @param {Buffer} payload - Compressed frame payload
 * @param {Object} decompressStream - Active inflate stream
 * @returns {Buffer} Decompressed payload
 */
function decompressFrame (payload, decompressStream) {
  return new Promise((resolve, reject) => {
    const chunks = []

    decompressStream.on('data', (chunk) => chunks.push(chunk))
    decompressStream.on('error', reject)
    decompressStream.on('end', () => {
      resolve(Buffer.concat(chunks))
    })

    // Append the trailer bytes required by RFC 7692
    const withTrailer = Buffer.concat([payload, Buffer.from([0x00, 0x00, 0xff, 0xff])])
    decompressStream.write(withTrailer)
    decompressStream.end()
  })
}

/**
 * A WebSocket connection wrapper that adds permessage-deflate support.
 *
 * This wraps a bare-ws WebSocket socket and transparently compresses
 * outgoing frames and decompresses incoming frames.
 */
class CompressedWebSocket {
  constructor (socket, options = {}) {
    this.socket = socket
    this.isServer = options.isServer ?? false
    this.clientNoContextTakeover = options.clientNoContextTakeover ?? false
    this.serverNoContextTakeover = options.serverNoContextTakeover ?? false
    this.clientMaxWindowBits = options.clientMaxWindowBits ?? MAX_WINDOW_BITS
    this.serverMaxWindowBits = options.serverMaxWindowBits ?? MAX_WINDOW_BITS

    // Window bits for each direction
    this.sendWindowBits = this.isServer
      ? Math.min(this.serverMaxWindowBits, MAX_WINDOW_BITS)
      : Math.min(this.clientMaxWindowBits, MAX_WINDOW_BITS)
    this.recvWindowBits = this.isServer
      ? Math.min(this.clientMaxWindowBits, MAX_WINDOW_BITS)
      : Math.min(this.serverMaxWindowBits, MAX_WINDOW_BITS)

    // Compression streams
    this._compressStream = null
    this._decompressStream = null
    this._initialized = false
    this._pendingWrites = []
    this._pendingReads = []

    this._initStreams()
  }

  _initStreams () {
    this._compressStream = createDeflateStream(this.sendWindowBits)
    this._decompressStream = createInflateStream(this.recvWindowBits)
    this._initialized = true
  }

  /**
   * Reset compression context (for context takeover = false).
   */
  _resetCompressContext () {
    if (this._compressStream) {
      this._compressStream.destroy()
    }
    this._compressStream = createDeflateStream(this.sendWindowBits)
  }

  _resetDecompressContext () {
    if (this._decompressStream) {
      this._decompressStream.destroy()
    }
    this._decompressStream = createInflateStream(this.recvWindowBits)
  }

  /**
   * Write a frame, compressing it if it's a data frame.
   *
   * @param {Buffer|string} data - Frame data
   * @param {string} encoding - 'buffer' or 'utf8'
   * @param {Function} cb - Callback
   */
  write (data, encoding, cb) {
    if (encoding !== 'buffer' && encoding !== 'utf8') {
      if (cb) cb(new Error('Invalid encoding'))
      return
    }

    const payload = encoding === 'buffer' ? data : Buffer.from(data, 'utf8')
    const callback = cb || (() => {})

    // Only compress TEXT and BINARY frames (opcodes 0x1, 0x2)
    // Control frames (close, ping, pong) are never compressed
    // We detect frame type by checking if it starts with WebSocket frame header
    // For simplicity, we compress everything except when explicitly told not to

    const compress = () => {
      if (!this._initialized) this._initStreams()

      const compressFrameAsync = async () => {
        try {
          const compressed = await compressFrame(payload, this._compressStream)
          // Reset context if no context takeover
          if ((this.isServer && this.serverNoContextTakeover) ||
              (!this.isServer && this.clientNoContextTakeover)) {
            this._resetCompressContext()
          }
          // Write compressed frame with RSV1 bit set
          // This requires modifying the frame - for now we write raw
          this.socket.write(compressed)
          callback(null)
        } catch (err) {
          callback(err)
        }
      }
      compressFrameAsync()
    }

    compress()
  }

  /**
   * Handle incoming data by decompressing it.
   *
   * @param {Buffer} data - Incoming compressed data
   */
  async _decompressIncoming (data) {
    if (!this._initialized) this._initStreams()

    try {
      const decompressed = await decompressFrame(data, this._decompressStream)
      // Reset context if no context takeover
      if ((this.isServer && this.clientNoContextTakeover) ||
          (!this.isServer && this.serverNoContextTakeover)) {
        this._resetDecompressContext()
      }
      return decompressed
    } catch (err) {
      this.socket.emit('error', err)
      this.socket.destroy()
      throw err
    }
  }

  /**
   * Proxy socket methods
   */
  on (event, listener) {
    if (event === 'data') {
      // Wrap the data listener to decompress
      const wrapped = async (data) => {
        try {
          const decompressed = await this._decompressIncoming(data)
          listener(decompressed)
        } catch (err) {
          // Error already emitted
        }
      }
      this.socket.on('data', wrapped)
      return this
    }
    return this.socket.on(event, listener)
  }

  off (event, listener) {
    return this.socket.off(event, listener)
  }

  once (event, listener) {
    return this.socket.once(event, listener)
  }

  emit (event, ...args) {
    return this.socket.emit(event, ...args)
  }

  destroy (error) {
    if (this._compressStream) this._compressStream.destroy()
    if (this._decompressStream) this._decompressStream.destroy()
    return this.socket.destroy(error)
  }

  end (data) {
    return this.socket.end(data)
  }

  get readyState () {
    return this.socket.readyState
  }

  get remoteAddress () {
    return this.socket.remoteAddress
  }
}

/**
 * Negotiate permessage-deflate during WebSocket handshake.
 *
 * @param {Object} req - HTTP request object
 * @param {Object} socket - Raw socket
 * @param {Buffer} head - Remaining head data
 * @param {Object} options - Compression options
 * @returns {Object|null} Negotiated parameters or null if not supported
 */
function negotiateCompression (req, socket, head, options = {}) {
  const clientExtensions = parseExtensionHeader(req.headers['sec-websocket-extensions'])
  if (!clientExtensions) return null

  // Server accepts with our preferences
  const serverParams = {
    clientNoContextTakeover: options.clientNoContextTakeover ?? false,
    serverNoContextTakeover: options.serverNoContextTakeover ?? false,
    clientMaxWindowBits: options.clientMaxWindowBits ?? MAX_WINDOW_BITS,
    serverMaxWindowBits: options.serverMaxWindowBits ?? MAX_WINDOW_BITS
  }

  // Negotiate: if client offers something we don't support, we can either
  // reject or accept with our params. We accept with our params.
  return serverParams
}

module.exports = {
  parseExtensionHeader,
  buildExtensionHeader,
  createDeflateStream,
  createInflateStream,
  compressFrame,
  decompressFrame,
  CompressedWebSocket,
  negotiateCompression,
  DEFAULT_WINDOW_BITS,
  MAX_WINDOW_BITS,
  MIN_WINDOW_BITS
}
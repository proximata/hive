'use strict'

const http = require('bare-http1')
const b4a = require('b4a')

const { buildNip98Header } = require('hive-auth')

const { CliError } = require('./errors')

/**
 * HTTP client for the relay. Every request is signed with NIP-98, so there is
 * no session to establish and no token to store — an agent needs only its key.
 */
class RelayClient {
  constructor ({ url, secretKey }) {
    this.url = url.replace(/\/+$/, '')
    this.secretKey = secretKey
  }

  async request (method, path, { body = null, query = null, raw = false, contentType = null } = {}) {
    const target = new URL(this.url + path)
    if (query !== null) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue
        if (Array.isArray(value)) {
          for (const item of value) target.searchParams.append(key, item)
        } else {
          target.searchParams.set(key, value)
        }
      }
    }

    // Raw bodies (media uploads) go over the wire untouched; everything else
    // is JSON. Either way the payload is hashed into the NIP-98 `payload` tag,
    // so a body swapped in flight invalidates the signature.
    const payload = body === null ? null : (raw ? body : JSON.stringify(body))
    const headers = {
      Authorization: buildNip98Header({
        url: target.href,
        method,
        secretKey: this.secretKey,
        body: payload
      })
    }
    if (payload !== null) headers['Content-Type'] = contentType ?? (raw ? 'application/octet-stream' : 'application/json')

    const response = await send(target, method, headers, payload)

    if (response.status === 401 || response.status === 403) {
      throw new CliError('auth', response.json?.message ?? 'authentication failed')
    }
    if (response.status === 409) {
      throw new CliError('conflict', response.json?.message ?? 'write conflict')
    }
    if (response.status >= 400) {
      throw new CliError(
        response.status >= 500 ? 'other' : 'user',
        response.json?.message ?? `relay returned ${response.status}`
      )
    }

    return response.json
  }

  get (path, query) {
    return this.request('GET', path, { query })
  }

  /** Submit a signed event through the relay's NIP-01 HTTP bridge. */
  async publish (event) {
    const result = await this.request('POST', '/events', { body: event })
    if (result.accepted !== true) {
      throw new CliError(result.message?.startsWith('restricted:') ? 'auth' : 'user', result.message)
    }
    return result
  }

  query (filters) {
    return this.request('POST', '/query', { body: Array.isArray(filters) ? filters : [filters] })
  }

  count (filters) {
    return this.request('POST', '/count', { body: Array.isArray(filters) ? filters : [filters] })
  }
}

function send (target, method, headers, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: Number(target.port) || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers: payload === null ? headers : { ...headers, 'Content-Length': b4a.byteLength(payload) }
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = b4a.toString(b4a.concat(chunks))
          let json = null
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode, text, json })
        })
      }
    )

    req.on('error', (err) => reject(new CliError('network', err.message)))
    if (payload !== null) req.write(payload)
    req.end()
  })
}

module.exports = { RelayClient }

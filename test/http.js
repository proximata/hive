'use strict'

const http = require('bare-http1')
const b4a = require('b4a')

// Bare has no global fetch, so tests use this. It is also what hive-cli's HTTP
// client is built on, which means the tests exercise the same request shape the
// CLI produces.

function request (url, { method = 'GET', headers = {}, body = null } = {}) {
  const target = new URL(url)

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: Number(target.port) || 80,
        path: target.pathname + target.search,
        method,
        headers: body === null
          ? headers
          : { 'Content-Length': b4a.byteLength(body), ...headers }
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
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
      }
    )

    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

module.exports = { request }

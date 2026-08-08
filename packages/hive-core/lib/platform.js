'use strict'

// Bare is deliberately minimal: it ships neither the WHATWG encoding globals nor
// the WebCrypto namespace. @noble/hashes reaches for TextEncoder at module scope
// and crypto.getRandomValues on first key generation, so both have to exist
// before any @noble module is required.
//
// Require this module first from anywhere that touches crypto.
//
// The imports below are STATIC and resolved through this package's `imports`
// map. They used to be try/catch `require`s, which worked when running from
// source but silently broke the standalone binary: bare-build traverses the
// module graph ahead of time, cannot see a require inside a catch block, and so
// omitted bare-encoding from the bundle. The binary then died on launch with
// "no TextEncoder/TextDecoder available on this runtime". Keep these static.

const encoding = require('#encoding')
const crypto = require('#crypto')

if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = encoding.TextEncoder
if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = encoding.TextDecoder

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
  if (typeof globalThis.crypto === 'undefined') globalThis.crypto = {}

  globalThis.crypto.getRandomValues = function getRandomValues (view) {
    const bytes = crypto.randomBytes(view.byteLength)
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes)
    return view
  }
}

module.exports = { encoding, crypto }

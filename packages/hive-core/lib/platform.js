'use strict'

// Bare is deliberately minimal: it ships neither the WHATWG encoding globals nor
// the WebCrypto namespace. @noble/hashes reaches for TextEncoder at module scope
// and crypto.getRandomValues on first key generation, so both have to exist
// before any @noble module is required. On Node both are already globals and
// every branch below is a no-op.
//
// Require this module first from anywhere that touches crypto.

function tryRequire (name) {
  try {
    return require(name)
  } catch {
    return null
  }
}

if (typeof globalThis.TextEncoder === 'undefined' || typeof globalThis.TextDecoder === 'undefined') {
  const encoding = tryRequire('bare-encoding')
  if (encoding === null) throw new Error('no TextEncoder/TextDecoder available on this runtime')
  if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = encoding.TextEncoder
  if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = encoding.TextDecoder
}

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
  const crypto = tryRequire('bare-crypto') || tryRequire('crypto')
  if (crypto === null) throw new Error('no CSPRNG available on this runtime')

  if (typeof globalThis.crypto === 'undefined') globalThis.crypto = {}
  globalThis.crypto.getRandomValues = function getRandomValues (view) {
    const bytes = crypto.randomBytes(view.byteLength)
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes)
    return view
  }
}

module.exports = { tryRequire }

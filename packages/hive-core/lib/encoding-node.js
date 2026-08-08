'use strict'

// Node already has these as globals; this exists only so the `#encoding`
// imports condition has something to resolve to off Bare.
module.exports = {
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder
}

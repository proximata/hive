'use strict'

const core = require('hive-core')

let counter = 0

/** A deterministic-ish identity for tests. */
function identity (label = 'test') {
  const secretKey = core.generateSecretKey()
  return {
    label,
    secretKey,
    secretKeyHex: core.toHex(secretKey),
    pubkey: core.getPublicKey(secretKey)
  }
}

function sign (identity, template) {
  return core.finalizeEvent(
    { created_at: Math.floor(Date.now() / 1000), ...template },
    identity.secretKey
  )
}

/** A channel message with a valid `h` tag. */
function message (identity, channelId, content, extraTags = []) {
  return sign(identity, {
    kind: core.KIND_STREAM_MESSAGE,
    tags: [['h', channelId], ...extraTags],
    content
  })
}

function uuid () {
  const bytes = core.fromHex(core.toHex(core.sha256(Buffer.from(`uuid-${counter++}-${Date.now()}`))))
  const hex = core.toHex(bytes)
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)
  ].join('-')
}

module.exports = { identity, sign, message, uuid }

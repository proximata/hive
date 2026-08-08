'use strict'

const b4a = require('b4a')
const { sha256, toHex } = require('hive-core')

// Tamper-evident append-only log. Each entry's hash covers the previous entry's
// hash, so editing any row invalidates that row and every row after it. The
// chain is only worth anything if the preimage is byte-reproducible, hence the
// fixed field order and the sorted-key JSON below.

const GENESIS_HASH = '0'.repeat(64)

const ACTIONS = [
  'EventCreated',
  'EventDeleted',
  'ChannelCreated',
  'ChannelUpdated',
  'ChannelDeleted',
  'MemberAdded',
  'MemberRemoved',
  'AuthSuccess',
  'AuthFailure',
  'RateLimitExceeded'
]

/** Deterministic JSON: keys sorted at every level, so the hash is reproducible. */
function canonicalJson (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'

  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

function uint64BE (n) {
  const buf = b4a.alloc(8)
  const big = BigInt(n)
  for (let i = 7; i >= 0; i--) buf[i] = Number((big >> BigInt((7 - i) * 8)) & 0xffn)
  return buf
}

function uint32BE (n) {
  const buf = b4a.alloc(4)
  buf[0] = (n >>> 24) & 0xff
  buf[1] = (n >>> 16) & 0xff
  buf[2] = (n >>> 8) & 0xff
  buf[3] = n & 0xff
  return buf
}

/**
 * The hash preimage, in a fixed order. A channel id contributes 16 bytes — its
 * UTF-8 bytes truncated or zero-padded — so a present and an absent channel can
 * never collide.
 */
function entryHash (entry) {
  const channel = b4a.alloc(16)
  if (entry.channel_id) b4a.from(String(entry.channel_id), 'utf8').copy(channel, 0, 0, 16)

  const preimage = b4a.concat([
    uint64BE(entry.seq),
    b4a.from(entry.ts, 'utf8'),
    b4a.from(entry.event_id ?? '', 'utf8'),
    uint32BE(entry.kind ?? 0),
    b4a.from(entry.actor ?? '', 'utf8'),
    b4a.from(entry.action, 'utf8'),
    channel,
    b4a.from(canonicalJson(entry.metadata ?? {}), 'utf8'),
    b4a.from(entry.prev_hash, 'utf8')
  ])

  return toHex(sha256(preimage))
}

module.exports = { GENESIS_HASH, ACTIONS, canonicalJson, entryHash }

'use strict'

require('./platform')

const b4a = require('b4a')
const { sha256 } = require('@noble/hashes/sha2.js')

const { signHash, verifyHash, toHex } = require('./event')

// NIP-OA owner attestation.
//
// An owner authorizes an agent key to act without impersonating it. The
// distinction matters: NIP-26 delegation assigns the event to the delegator,
// which is exactly wrong for agent provenance. Here the event stays authored by
// `event.pubkey` and the tag is authorization *evidence* — a reusable
// capability that may appear on many events whose conditions hold.

const DOMAIN = 'nostr:agent-auth:'

/** The signing preimage: SHA256("nostr:agent-auth:" ‖ agentPubkey ‖ ":" ‖ conditions). */
function attestationHash (agentPubkey, conditions) {
  return toHex(sha256(b4a.from(DOMAIN + agentPubkey + ':' + conditions, 'utf8')))
}

/** Owner side: mint the tag an agent will attach to its events. */
function createAttestation ({ ownerSecretKey, ownerPubkey, agentPubkey, conditions = '' }) {
  const sig = signHash(attestationHash(agentPubkey, conditions), ownerSecretKey)
  return ['auth', ownerPubkey, conditions, sig]
}

/**
 * Verify an event's attestation.
 *
 * Returns `{ ok, owner, conditions, reason }`. An event with no `auth` tag is
 * `ok: false` with `reason: 'absent'` — not an error, just unattested. More
 * than one tag is treated as having none at all, per NIP-OA.
 */
function verifyAttestation (event, { now } = {}) {
  const tags = event.tags.filter((tag) => tag[0] === 'auth')

  if (tags.length === 0) return { ok: false, owner: null, conditions: null, reason: 'absent' }
  if (tags.length > 1) {
    return { ok: false, owner: null, conditions: null, reason: 'more than one auth tag' }
  }

  const tag = tags[0]
  if (tag.length !== 4) {
    return { ok: false, owner: null, conditions: null, reason: 'auth tag must have exactly four elements' }
  }

  const [, owner, conditions, sig] = tag
  if (!/^[0-9a-f]{64}$/.test(owner)) {
    return { ok: false, owner: null, conditions: null, reason: 'owner pubkey must be 64 lowercase hex characters' }
  }
  if (!/^[0-9a-f]{128}$/.test(sig)) {
    return { ok: false, owner: null, conditions: null, reason: 'signature must be 128 lowercase hex characters' }
  }

  if (!verifyHash(attestationHash(event.pubkey, conditions), sig, owner)) {
    return { ok: false, owner: null, conditions: null, reason: 'invalid attestation signature' }
  }

  const conditionCheck = checkConditions(conditions, event, now)
  if (conditionCheck !== null) {
    return { ok: false, owner, conditions, reason: conditionCheck }
  }

  return { ok: true, owner, conditions, reason: null }
}

/**
 * Evaluate the `&`-separated condition clauses. Unknown clauses fail closed:
 * an attestation whose restrictions this implementation does not understand
 * must not be treated as unrestricted.
 */
function checkConditions (conditions, event, now) {
  if (conditions === '') return null
  const at = now ?? Math.floor(Date.now() / 1000)

  for (const clause of conditions.split('&')) {
    const trimmed = clause.trim()
    if (trimmed === '') continue

    let match = /^kind=(\d+)$/.exec(trimmed)
    if (match !== null) {
      if (event.kind !== Number(match[1])) return `condition not met: ${trimmed}`
      continue
    }

    match = /^created_at<(\d+)$/.exec(trimmed)
    if (match !== null) {
      if (!(event.created_at < Number(match[1])) || !(at < Number(match[1]))) {
        return `condition not met: ${trimmed}`
      }
      continue
    }

    match = /^created_at>(\d+)$/.exec(trimmed)
    if (match !== null) {
      if (!(event.created_at > Number(match[1]))) return `condition not met: ${trimmed}`
      continue
    }

    return `unsupported condition: ${trimmed}`
  }

  return null
}

module.exports = { DOMAIN, attestationHash, createAttestation, verifyAttestation, checkConditions }

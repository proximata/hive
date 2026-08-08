'use strict'

const { isPGatedKind, isResultGatedKind } = require('./kinds')

const TAG_FILTER = /^#([a-zA-Z])$/

function matchesPrefix (candidates, value) {
  for (const candidate of candidates) {
    if (value === candidate) return true
    if (candidate.length < value.length && value.startsWith(candidate)) return true
  }
  return false
}

/**
 * Does one filter match this event? AND across every constraint present.
 *
 * NIP-01 edge case carried over from Buzz: `kinds: []` means "match nothing",
 * NOT "match everything". An absent `kinds` field means match all kinds.
 */
function filterMatches (filter, event) {
  if (filter.ids !== undefined) {
    if (!Array.isArray(filter.ids) || !matchesPrefix(filter.ids, event.id)) return false
  }

  if (filter.authors !== undefined) {
    if (!Array.isArray(filter.authors) || !matchesPrefix(filter.authors, event.pubkey)) return false
  }

  if (filter.kinds !== undefined) {
    if (!Array.isArray(filter.kinds) || !filter.kinds.includes(event.kind)) return false
  }

  if (filter.since !== undefined && event.created_at < filter.since) return false
  if (filter.until !== undefined && event.created_at > filter.until) return false

  for (const key of Object.keys(filter)) {
    const match = TAG_FILTER.exec(key)
    if (match === null) continue

    const name = match[1]
    const wanted = filter[key]
    if (!Array.isArray(wanted)) return false
    if (wanted.length === 0) return false

    let found = false
    for (const tag of event.tags) {
      if (tag[0] === name && wanted.includes(tag[1])) {
        found = true
        break
      }
    }
    if (!found) return false
  }

  return true
}

/** OR across filters, AND within each. An empty filter list matches nothing. */
function filtersMatch (filters, event) {
  for (const filter of filters) {
    if (filterMatches(filter, event)) return true
  }
  return false
}

/** The single-letter tag values a filter constrains, e.g. tagValues(f, 'h'). */
function tagValues (filter, name) {
  const values = filter['#' + name]
  return Array.isArray(values) ? values : null
}

/**
 * Could this filter match an event of a gated kind? Used to decide whether the
 * #p authorization check applies. A filter with no `kinds` constraint can match
 * anything, so it counts.
 */
function filterCanMatchKinds (filter, kinds) {
  if (filter.kinds === undefined) return true
  if (!Array.isArray(filter.kinds)) return false
  return filter.kinds.some((k) => kinds.includes(k))
}

function filterCanMatchPGated (filter) {
  if (filter.kinds === undefined) return true
  return filter.kinds.some(isPGatedKind)
}

function filterCanMatchResultGated (filter) {
  if (filter.kinds === undefined) return true
  return filter.kinds.some(isResultGatedKind)
}

/**
 * A broad REQ that can match p-gated kinds is only allowed when its `#p` filter
 * is present and every value equals the reader's own pubkey. Without this a
 * client could subscribe to other people's DMs and membership changes.
 *
 * Two exemptions, both because this check is defence in depth rather than the
 * enforcement (the per-event gate is):
 *
 *  - filters naming specific `ids`, which are point lookups rather than
 *    eavesdropping, and which every client uses to resolve a reply target;
 *  - channel-scoped filters, handled by the caller.
 *
 * Returns null when authorized, otherwise the CLOSED reason string.
 */
function checkPGatedAuthorization (filters, pubkey) {
  for (const filter of filters) {
    if (Array.isArray(filter.ids) && filter.ids.length > 0) continue
    if (!filterCanMatchPGated(filter)) continue

    const p = tagValues(filter, 'p')
    if (p === null || p.length === 0) {
      return 'restricted: p-gated events require #p matching your pubkey'
    }
    for (const value of p) {
      if (value !== pubkey) {
        return 'restricted: p-gated events require #p matching your pubkey'
      }
    }
  }
  return null
}

/** Normalize a client-supplied filter, dropping unknown keys and bad types. */
function normalizeFilter (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null

  const filter = {}
  if (Array.isArray(raw.ids)) filter.ids = raw.ids.filter((v) => typeof v === 'string')
  if (Array.isArray(raw.authors)) filter.authors = raw.authors.filter((v) => typeof v === 'string')
  if (Array.isArray(raw.kinds)) filter.kinds = raw.kinds.filter((v) => Number.isInteger(v))
  if (Number.isInteger(raw.since)) filter.since = raw.since
  if (Number.isInteger(raw.until)) filter.until = raw.until
  if (Number.isInteger(raw.limit) && raw.limit >= 0) filter.limit = raw.limit
  if (typeof raw.search === 'string') filter.search = raw.search

  for (const key of Object.keys(raw)) {
    if (TAG_FILTER.test(key) && Array.isArray(raw[key])) {
      filter[key] = raw[key].filter((v) => typeof v === 'string')
    }
  }

  return filter
}

module.exports = {
  filterMatches,
  filtersMatch,
  tagValues,
  filterCanMatchKinds,
  filterCanMatchPGated,
  filterCanMatchResultGated,
  checkPGatedAuthorization,
  normalizeFilter
}

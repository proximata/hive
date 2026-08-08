'use strict'

const { isSearchable } = require('hive-core')

// Search is a plain inverted index rather than FTS5, because bare-sqlite is
// compiled without the FTS5 extension. The trade-off is deliberate and cheap:
// this tokenizer is a dozen lines, works identically on every SQL driver, and
// makes the privacy exclusion a write-time property that no query path can
// circumvent.

const MAX_TOKENS_PER_EVENT = 512
const MIN_TOKEN_LENGTH = 2
const MAX_TOKEN_LENGTH = 64

// Deliberately tiny. An aggressive stopword list hurts recall on technical
// chat, where "in", "it" and "for" are often part of the thing being searched.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its',
  'new', 'now', 'old', 'see', 'two', 'who', 'did', 'yes', 'this', 'that',
  'with', 'from', 'they', 'been', 'have', 'were', 'said', 'each', 'which',
  'their', 'will', 'about', 'would', 'there', 'them'
])

/** Lowercase, split on non-alphanumerics, drop stopwords and out-of-range tokens. */
function tokenize (text) {
  if (typeof text !== 'string' || text.length === 0) return []

  const seen = new Set()
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH || raw.length > MAX_TOKEN_LENGTH) continue
    if (STOPWORDS.has(raw)) continue
    seen.add(raw)
    if (seen.size >= MAX_TOKENS_PER_EVENT) break
  }
  return [...seen]
}

/**
 * Tokens to index for an event, or [] when the event must never be searchable.
 *
 * The exclusion happens here, at write time. Filtering at query time would
 * leave the rows present and one missing WHERE clause away from leaking.
 */
function tokensForEvent (event) {
  if (!isSearchable(event.kind)) return []
  return tokenize(event.content)
}

/** Tokens a query should be matched on. Every token must be present in a hit. */
function tokenizeQuery (query) {
  return tokenize(query)
}

module.exports = { tokenize, tokensForEvent, tokenizeQuery, STOPWORDS, MIN_TOKEN_LENGTH }

'use strict'

// SQLite and Postgres disagree about how a bound parameter is spelled, and
// about very little else that this store uses. Translating `?` to `$n` here
// means `lib/query.js` stays the single source of truth for NIP-01 filter
// translation instead of being forked per driver — the filter semantics are
// the part that is easy to get subtly wrong, so it should exist once.

/**
 * Rewrite `?` placeholders as `$1`, `$2`, ... Placeholders inside string
 * literals are left alone; `standard_conforming_strings` is on by default in
 * Postgres, so a backslash inside a literal is an ordinary character and the
 * only thing that closes a literal is a quote.
 */
function toPositional (sql) {
  let out = ''
  let index = 0
  let inString = false

  for (const character of sql) {
    if (inString) {
      out += character
      if (character === "'") inString = false
      continue
    }
    if (character === "'") {
      inString = true
      out += character
      continue
    }
    if (character === '?') {
      out += '$' + ++index
      continue
    }
    out += character
  }

  return out
}

/**
 * A tsquery that matches only documents containing every token.
 *
 * The tokens are quoted and cast rather than passed through `to_tsquery`'s
 * parser: `array_to_tsvector` on the write side stores this store's own
 * tokenizer output verbatim, so the read side must not re-parse, stem or
 * normalize anything either. `foo_bar` has to stay one lexeme on both sides.
 */
function tsqueryFor (tokens) {
  // Tokens come out of `lib/search.js` as /[a-z0-9_]+/, so there is nothing to
  // escape; assert it rather than trust it, because a future tokenizer change
  // must not quietly turn into SQL injection.
  for (const token of tokens) {
    if (!/^[a-z0-9_]+$/.test(token)) throw new Error(`refusing to build a tsquery from ${JSON.stringify(token)}`)
  }
  return tokens.map((token) => `'${token}'`).join(' & ')
}

module.exports = { toPositional, tsqueryFor }

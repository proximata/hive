'use strict'

const HEX_ID_LENGTH = 64

/**
 * Translate one NIP-01 filter into SQL against the `events` table (aliased `e`).
 *
 * Exact-length hex values compare with `=` so they use the index; shorter ones
 * are prefixes and become `LIKE 'prefix%'` (NIP-01 prefix matching).
 */
function buildFilterSql (filter, params) {
  const clauses = []

  if (filter.ids !== undefined) {
    if (filter.ids.length === 0) return null
    clauses.push('(' + filter.ids.map((id) => {
      if (id.length === HEX_ID_LENGTH) {
        params.push(id)
        return 'e.id = ?'
      }
      params.push(escapeLike(id) + '%')
      return "e.id LIKE ? ESCAPE '\\'"
    }).join(' OR ') + ')')
  }

  if (filter.authors !== undefined) {
    if (filter.authors.length === 0) return null
    clauses.push('(' + filter.authors.map((author) => {
      if (author.length === HEX_ID_LENGTH) {
        params.push(author)
        return 'e.pubkey = ?'
      }
      params.push(escapeLike(author) + '%')
      return "e.pubkey LIKE ? ESCAPE '\\'"
    }).join(' OR ') + ')')
  }

  // NIP-01 edge case: an explicit empty `kinds` array matches nothing.
  if (filter.kinds !== undefined) {
    if (filter.kinds.length === 0) return null
    clauses.push(`e.kind IN (${filter.kinds.map(() => '?').join(',')})`)
    params.push(...filter.kinds)
  }

  if (filter.since !== undefined) {
    clauses.push('e.created_at >= ?')
    params.push(filter.since)
  }

  if (filter.until !== undefined) {
    clauses.push('e.created_at <= ?')
    params.push(filter.until)
  }

  for (const key of Object.keys(filter)) {
    const match = /^#([a-zA-Z])$/.exec(key)
    if (match === null) continue

    const values = filter[key]
    if (!Array.isArray(values) || values.length === 0) return null

    clauses.push(
      `EXISTS (SELECT 1 FROM event_tags t WHERE t.event_id = e.id AND t.name = ? ` +
      `AND t.value IN (${values.map(() => '?').join(',')}))`
    )
    params.push(match[1], ...values)
  }

  return clauses.length === 0 ? '1 = 1' : clauses.join(' AND ')
}

function escapeLike (value) {
  return value.replace(/[\\%_]/g, (c) => '\\' + c)
}

/**
 * Full SELECT for one filter. Ordering is `created_at DESC, id ASC` — the id
 * tiebreak keeps pagination stable when many events share a timestamp.
 */
function buildQuery (filter, { limit, includeDeleted = false } = {}) {
  const params = []
  const where = buildFilterSql(filter, params)
  if (where === null) return null

  let sql = `SELECT e.* FROM events e WHERE ${where}`
  if (!includeDeleted) sql += ' AND e.deleted_at IS NULL'
  sql += ' ORDER BY e.created_at DESC, e.id ASC'

  const effective = Math.min(filter.limit ?? limit ?? 500, limit ?? 500)
  sql += ' LIMIT ?'
  params.push(effective)

  return { sql, params }
}

function buildCountQuery (filter, { includeDeleted = false } = {}) {
  const params = []
  const where = buildFilterSql(filter, params)
  if (where === null) return null

  let sql = `SELECT COUNT(*) AS count FROM events e WHERE ${where}`
  if (!includeDeleted) sql += ' AND e.deleted_at IS NULL'

  return { sql, params }
}

module.exports = { buildFilterSql, buildQuery, buildCountQuery, escapeLike }

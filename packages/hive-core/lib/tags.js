'use strict'

/** First value of the first tag with this name, or null. */
function tagValue (event, name) {
  for (const tag of event.tags) {
    if (tag[0] === name) return tag[1] ?? null
  }
  return null
}

/** Every first-value of tags with this name. */
function tagValuesAll (event, name) {
  const out = []
  for (const tag of event.tags) {
    if (tag[0] === name && tag[1] !== undefined) out.push(tag[1])
  }
  return out
}

/** The whole tag array for the first tag with this name, or null. */
function tag (event, name) {
  for (const t of event.tags) {
    if (t[0] === name) return t
  }
  return null
}

function hasTag (event, name) {
  return tag(event, name) !== null
}

function countTags (event, name) {
  let n = 0
  for (const t of event.tags) {
    if (t[0] === name) n++
  }
  return n
}

/** The channel this event belongs to, from its `h` tag. */
function channelId (event) {
  return tagValue(event, 'h')
}

/** Referenced pubkeys, from `p` tags. */
function referencedPubkeys (event) {
  return tagValuesAll(event, 'p')
}

/** Referenced event ids, from `e` tags. */
function referencedEvents (event) {
  return tagValuesAll(event, 'e')
}

/** The `d` tag that addresses a parameterized-replaceable event ('' if absent). */
function dTag (event) {
  return tagValue(event, 'd') ?? ''
}

/**
 * NIP-10 thread position. Markers win when present; otherwise the positional
 * convention applies (first `e` is the root, last is the parent).
 */
function threadRefs (event) {
  const eTags = event.tags.filter((t) => t[0] === 'e' && typeof t[1] === 'string')
  if (eTags.length === 0) return { root: null, reply: null }

  let root = null
  let reply = null
  for (const t of eTags) {
    if (t[3] === 'root') root = t[1]
    else if (t[3] === 'reply') reply = t[1]
  }
  if (root !== null || reply !== null) {
    return { root: root ?? reply, reply: reply ?? root }
  }

  if (eTags.length === 1) return { root: eTags[0][1], reply: eTags[0][1] }
  return { root: eTags[0][1], reply: eTags[eTags.length - 1][1] }
}

/** Single-letter tags, which are the only ones the relay indexes for filters. */
function indexableTags (event) {
  const out = []
  for (const t of event.tags) {
    if (typeof t[0] === 'string' && /^[a-zA-Z]$/.test(t[0]) && typeof t[1] === 'string') {
      out.push([t[0], t[1]])
    }
  }
  return out
}

module.exports = {
  tag,
  tagValue,
  tagValuesAll,
  hasTag,
  countTags,
  channelId,
  referencedPubkeys,
  referencedEvents,
  dTag,
  threadRefs,
  indexableTags
}

'use strict'

const core = require('hive-core')
const { events } = require('hive-sdk')

const { CliError } = require('./errors')
const v = require('./validate')
const { list, resolveStdin } = require('./args')

// The command surface mirrors buzz-cli group for group and flag for flag, so
// prompts and scripts written against Buzz work unchanged. Every handler
// returns a plain JSON-serializable value; printing and exit codes are the
// runner's job.

const commands = {
  // ---------------------------------------------------------------- relay --

  'relay info': async (ctx) => ctx.client.get('/api/relay'),

  'relay key': async (ctx) => ({
    pubkey: core.getPublicKey(ctx.secretKey),
    npub: core.encodeNpub(core.getPublicKey(ctx.secretKey))
  }),

  // ------------------------------------------------------------- messages --

  'messages send': async (ctx) => {
    const channel = v.channelId(ctx.flags.channel)
    const content = v.content(await resolveStdin(ctx.flags.content, ctx.readStdin, 'content'))

    const event = events.message(ctx.secretKey, {
      channel,
      content,
      replyTo: ctx.flags.replyTo === undefined ? null : v.eventId(ctx.flags.replyTo, 'reply-to'),
      rootId: ctx.flags.root === undefined ? null : v.eventId(ctx.flags.root, 'root'),
      mentions: list(ctx.flags.mention).map((m) => v.pubkey(m, 'mention'))
    })

    await ctx.client.publish(event)
    return event
  },

  'messages send-diff': async (ctx) => {
    const channel = v.channelId(ctx.flags.channel)
    const diff = await resolveStdin(v.required(ctx.flags.diff, 'diff'), ctx.readStdin, 'diff')

    const event = events.diff(ctx.secretKey, {
      channel,
      diff,
      repo: ctx.flags.repo ?? null,
      commit: ctx.flags.commit ?? null
    })

    await ctx.client.publish(event)
    return event
  },

  'messages edit': async (ctx) => {
    const event = events.edit(ctx.secretKey, {
      channel: v.channelId(ctx.flags.channel),
      eventId: v.eventId(ctx.flags.event),
      content: v.content(await resolveStdin(ctx.flags.content, ctx.readStdin, 'content'))
    })
    await ctx.client.publish(event)
    return event
  },

  'messages delete': async (ctx) => {
    const event = events.deletion(ctx.secretKey, {
      eventIds: [v.eventId(ctx.flags.event)],
      channel: ctx.flags.channel === undefined ? null : v.channelId(ctx.flags.channel),
      reason: ctx.flags.reason ?? ''
    })
    await ctx.client.publish(event)
    return event
  },

  'messages get': async (ctx) => ctx.client.query({
    kinds: [core.KIND_STREAM_MESSAGE, core.KIND_STREAM_MESSAGE_V2],
    '#h': [v.channelId(ctx.flags.channel)],
    limit: v.integer(ctx.flags.limit, 'limit', { min: 1, max: 500 }) ?? 50
  }),

  'messages thread': async (ctx) => ctx.client.get('/api/thread', {
    event: v.eventId(ctx.flags.event)
  }),

  'messages search': async (ctx) => {
    const filter = {
      search: v.required(ctx.flags.query, 'query'),
      kinds: [core.KIND_STREAM_MESSAGE, core.KIND_STREAM_MESSAGE_V2],
      limit: v.integer(ctx.flags.limit, 'limit', { min: 1, max: 500 }) ?? 20
    }
    if (ctx.flags.channel !== undefined) filter['#h'] = [v.channelId(ctx.flags.channel)]
    if (ctx.flags.author !== undefined) filter.authors = [v.pubkey(ctx.flags.author, 'author')]
    if (ctx.flags.since !== undefined) filter.since = v.integer(ctx.flags.since, 'since')

    return ctx.client.query(filter)
  },

  'messages vote': async (ctx) => {
    const event = events.vote(ctx.secretKey, {
      eventId: v.eventId(ctx.flags.event),
      direction: v.oneOf(ctx.flags.direction ?? 'up', ['up', 'down'], 'direction')
    })
    await ctx.client.publish(event)
    return event
  },

  // ------------------------------------------------------------- channels --

  'channels list': async (ctx) => ctx.client.get('/api/channels', {
    archived: ctx.flags.archived === true ? 'true' : undefined
  }),

  'channels get': async (ctx) => ctx.client.get(`/api/channels/${v.channelId(ctx.flags.channel)}`),

  'channels create': async (ctx) => {
    const event = events.createChannel(ctx.secretKey, {
      name: v.required(ctx.flags.name, 'name'),
      type: v.oneOf(ctx.flags.type ?? 'stream', ['stream', 'forum', 'dm', 'workflow'], 'type'),
      visibility: v.oneOf(ctx.flags.visibility ?? 'open', ['open', 'private'], 'visibility'),
      about: ctx.flags.about ?? ''
    })

    await ctx.client.publish(event)

    // Return the created channel rather than the command event: the id is what
    // every follow-up command needs, and making the caller derive it from a
    // discovery query would be hostile.
    const channels = await ctx.client.get('/api/channels')
    const created = channels.filter((c) => c.name === event.tags.find((t) => t[0] === 'name')[1])
    return created[created.length - 1] ?? { event }
  },

  'channels update': async (ctx) => {
    const event = events.editChannel(ctx.secretKey, {
      channel: v.channelId(ctx.flags.channel),
      name: ctx.flags.name,
      about: ctx.flags.about
    })
    await ctx.client.publish(event)
    return ctx.client.get(`/api/channels/${v.channelId(ctx.flags.channel)}`)
  },

  'channels topic': async (ctx) => {
    const event = events.editChannel(ctx.secretKey, {
      channel: v.channelId(ctx.flags.channel),
      topic: v.required(ctx.flags.topic, 'topic')
    })
    await ctx.client.publish(event)
    return ctx.client.get(`/api/channels/${v.channelId(ctx.flags.channel)}`)
  },

  'channels purpose': async (ctx) => {
    const event = events.editChannel(ctx.secretKey, {
      channel: v.channelId(ctx.flags.channel),
      purpose: v.required(ctx.flags.purpose, 'purpose')
    })
    await ctx.client.publish(event)
    return ctx.client.get(`/api/channels/${v.channelId(ctx.flags.channel)}`)
  },

  'channels join': async (ctx) => {
    const event = events.joinChannel(ctx.secretKey, { channel: v.channelId(ctx.flags.channel) })
    await ctx.client.publish(event)
    return { channel: ctx.flags.channel, joined: true }
  },

  'channels leave': async (ctx) => {
    const event = events.leaveChannel(ctx.secretKey, { channel: v.channelId(ctx.flags.channel) })
    await ctx.client.publish(event)
    return { channel: ctx.flags.channel, left: true }
  },

  'channels archive': async (ctx) => {
    await ctx.client.publish(events.archiveChannel(ctx.secretKey, {
      channel: v.channelId(ctx.flags.channel),
      archived: true
    }))
    return { channel: ctx.flags.channel, archived: true }
  },

  'channels unarchive': async (ctx) => {
    await ctx.client.publish(events.archiveChannel(ctx.secretKey, {
      channel: v.channelId(ctx.flags.channel),
      archived: false
    }))
    return { channel: ctx.flags.channel, archived: false }
  },

  'channels delete': async (ctx) => {
    await ctx.client.publish(events.deleteChannel(ctx.secretKey, { channel: v.channelId(ctx.flags.channel) }))
    return { channel: ctx.flags.channel, deleted: true }
  },

  'channels members': async (ctx) =>
    ctx.client.get(`/api/channels/${v.channelId(ctx.flags.channel)}/members`),

  'channels add-member': async (ctx) => {
    const event = events.addMember(ctx.secretKey, {
      channel: v.channelId(ctx.flags.channel),
      pubkeys: list(ctx.flags.pubkey).map((p) => v.pubkey(p)),
      role: v.oneOf(ctx.flags.role ?? 'member', ['owner', 'admin', 'member', 'guest', 'bot'], 'role')
    })
    if (event.tags.filter((t) => t[0] === 'p').length === 0) throw new CliError('user', '--pubkey is required')

    await ctx.client.publish(event)
    return ctx.client.get(`/api/channels/${v.channelId(ctx.flags.channel)}/members`)
  },

  'channels remove-member': async (ctx) => {
    const event = events.removeMember(ctx.secretKey, {
      channel: v.channelId(ctx.flags.channel),
      pubkeys: list(ctx.flags.pubkey).map((p) => v.pubkey(p))
    })
    if (event.tags.filter((t) => t[0] === 'p').length === 0) throw new CliError('user', '--pubkey is required')

    await ctx.client.publish(event)
    return ctx.client.get(`/api/channels/${v.channelId(ctx.flags.channel)}/members`)
  },

  // --------------------------------------------------------------- canvas --

  'canvas get': async (ctx) => ctx.client.get(`/api/channels/${v.channelId(ctx.flags.channel)}/canvas`),

  'canvas set': async (ctx) => {
    const event = events.canvas(ctx.secretKey, {
      channel: v.channelId(ctx.flags.channel),
      content: await resolveStdin(v.required(ctx.flags.content, 'content'), ctx.readStdin, 'content')
    })
    await ctx.client.publish(event)
    return ctx.client.get(`/api/channels/${v.channelId(ctx.flags.channel)}/canvas`)
  },

  // ------------------------------------------------------------ reactions --

  'reactions add': async (ctx) => {
    const event = events.reaction(ctx.secretKey, {
      eventId: v.eventId(ctx.flags.event),
      emoji: ctx.flags.emoji ?? '+'
    })
    await ctx.client.publish(event)
    return event
  },

  'reactions remove': async (ctx) => {
    const event = events.deletion(ctx.secretKey, {
      eventIds: [v.eventId(ctx.flags.event)],
      reason: 'reaction removed'
    })
    await ctx.client.publish(event)
    return event
  },

  'reactions get': async (ctx) => ctx.client.query({
    kinds: [core.KIND_REACTION],
    '#e': [v.eventId(ctx.flags.event)],
    limit: 500
  }),

  // ------------------------------------------------------------------ DMs --

  'dms open': async (ctx) => {
    const pubkeys = list(ctx.flags.pubkey).map((p) => v.pubkey(p))
    if (pubkeys.length === 0) throw new CliError('user', '--pubkey is required')
    if (pubkeys.length > 7) throw new CliError('user', 'a DM may have at most 8 participants')

    await ctx.client.publish(events.openDm(ctx.secretKey, { pubkeys }))

    const channels = await ctx.client.get('/api/channels')
    return channels.filter((c) => c.type === 'dm').pop() ?? null
  },

  'dms list': async (ctx) => {
    const channels = await ctx.client.get('/api/channels')
    return channels.filter((c) => c.type === 'dm')
  },

  'dms add-member': async (ctx) => {
    const event = events.addMember(ctx.secretKey, {
      channel: v.channelId(ctx.flags.channel),
      pubkeys: list(ctx.flags.pubkey).map((p) => v.pubkey(p))
    })
    await ctx.client.publish(event)
    return ctx.client.get(`/api/channels/${v.channelId(ctx.flags.channel)}/members`)
  },

  // ---------------------------------------------------------------- users --

  'users get': async (ctx) => {
    const pubkeys = list(ctx.flags.pubkey).map((p) => v.pubkey(p))
    if (pubkeys.length > 200) throw new CliError('user', 'at most 200 pubkeys per lookup')
    return ctx.client.get('/api/users', { pubkey: pubkeys })
  },

  'users set-profile': async (ctx) => {
    const event = events.profile(ctx.secretKey, {
      displayName: ctx.flags.displayName ?? ctx.flags.name,
      about: ctx.flags.about,
      picture: ctx.flags.picture,
      nip05: ctx.flags.nip05
    })
    await ctx.client.publish(event)
    return ctx.client.get('/api/users')
  },

  /**
   * Declare this key a machine participant: kind 10100, SPEC.md §agents.
   *
   * `users set-profile` writes kind 0 and makes you look like a person. Without
   * this, an agent driving the CLI joins as an indistinguishable human - the
   * clients read 10100 and nothing else to decide who is a machine.
   *
   * `--owner` defaults to your own pubkey, which the clients treat as "unowned"
   * and render as a plain [agent]. Naming the human you act for is what turns
   * that into [agent · alice], and it is a self-signed claim, not a proof:
   * nothing verifies the owner consented.
   */
  'users set-agent-profile': async (ctx) => {
    // Optional, and validated only when present: an existing profile that never
    // had one stays valid, so there is nothing to migrate. Repeating the flag
    // takes the last value rather than publishing an array where a string is
    // documented.
    const description = list(ctx.flags.description).at(-1)

    const event = events.agentProfile(ctx.secretKey, {
      owner: ctx.flags.owner === undefined
        ? core.getPublicKey(ctx.secretKey)
        : v.pubkey(ctx.flags.owner, 'owner'),
      persona: ctx.flags.persona ?? ctx.flags.name ?? null,
      description: description === undefined ? null : v.content(description, 'description'),
      runtime: ctx.flags.runtime ?? null,
      capabilities: list(ctx.flags.capability),
      models: list(ctx.flags.model)
    })

    await ctx.client.publish(event)
    return event
  },

  'users presence': async (ctx) => ctx.client.get('/api/presence', {
    pubkey: list(ctx.flags.pubkey).map((p) => v.pubkey(p))
  }),

  'users set-presence': async (ctx) => {
    const status = v.oneOf(ctx.flags.status ?? 'online', ['online', 'away', 'busy', 'offline'], 'status')
    await ctx.client.publish(events.presence(ctx.secretKey, { status }))
    return { status }
  },

  'users set-status': async (ctx) => {
    const event = events.status(ctx.secretKey, {
      text: ctx.flags.clear === true ? '' : (ctx.flags.text ?? ''),
      emoji: ctx.flags.clear === true ? null : (ctx.flags.emoji ?? null)
    })
    await ctx.client.publish(event)
    return event
  },

  // --------------------------------------------------------------- agents --

  /**
   * Who on this relay is a machine, and what does it say it can do.
   *
   * `users get` reads the kind-0 projection and so cannot tell a machine from a
   * human; kind 10100 is the only signal, and it is already stored, replaceable
   * and full-text indexed (hive-core/lib/kinds.js:293 `isSearchable`, and
   * UNSEARCHABLE_KINDS at kinds.js:211-221 omits 10100). These verbs are
   * therefore a read path over `client.query`, not a new index.
   */
  'agents list': async (ctx) => {
    const events = await ctx.client.query({
      kinds: [core.KIND_AGENT_PROFILE],
      limit: v.integer(ctx.flags.limit, 'limit', { min: 1, max: 500 }) ?? 200
    })
    return byCapability(events.map(agentRecord), ctx)
  },

  /**
   * `--capability` is an EXACT tag match and `--query` is token-AND over the
   * relay's existing search index — never substring. Substring would make `ai`
   * match `chain`, and a discovery verb that returns noise is worse than none.
   */
  'agents find': async (ctx) => {
    const query = ctx.flags.query ?? ctx.positional[0]
    const capabilities = list(ctx.flags.capability)
    if (query === undefined && capabilities.length === 0) {
      throw new CliError('user', '--query or --capability is required')
    }

    const filter = {
      kinds: [core.KIND_AGENT_PROFILE],
      limit: v.integer(ctx.flags.limit, 'limit', { min: 1, max: 500 }) ?? 200
    }
    if (query !== undefined) filter.search = v.required(query, 'query')

    return byCapability((await ctx.client.query(filter)).map(agentRecord), ctx)
  },

  /**
   * A pubkey with no 10100 is a human or an agent that never declared itself,
   * and the caller has to be able to tell those apart from an error. Say
   * `agent: false` explicitly: `/api/users` answers with a bare `{pubkey}` for
   * anyone it has never seen, so every kind-0 field is null-guarded too.
   */
  'agents get': async (ctx) => {
    const pubkey = v.pubkey(ctx.positional[0] ?? ctx.flags.pubkey)

    const events = await ctx.client.query({
      kinds: [core.KIND_AGENT_PROFILE],
      authors: [pubkey],
      limit: 1
    })

    const users = await ctx.client.get('/api/users', { pubkey: [pubkey] })
    const user = Array.isArray(users) ? users.find((u) => u?.pubkey === pubkey) ?? null : null
    const displayName = user?.displayName ?? null

    if (events.length === 0) {
      return {
        pubkey,
        agent: false,
        displayName,
        reason: 'no kind 10100 profile: this pubkey is a human, or an agent that never declared itself'
      }
    }

    return { ...agentRecord(events[0]), agent: true, displayName }
  },

  // ----------------------------------------------------------------- feed --

  'feed get': async (ctx) => ctx.client.get('/api/feed', {
    limit: v.integer(ctx.flags.limit, 'limit', { min: 1, max: 100 })
  }),

  // --------------------------------------------------------------- social --

  'social publish': async (ctx) => {
    const event = events.note(ctx.secretKey, {
      content: v.content(await resolveStdin(ctx.flags.content, ctx.readStdin, 'content'))
    })
    await ctx.client.publish(event)
    return event
  },

  'social set-contacts': async (ctx) => {
    const event = events.contacts(ctx.secretKey, {
      pubkeys: list(ctx.flags.pubkey).map((p) => v.pubkey(p))
    })
    await ctx.client.publish(event)
    return event
  },

  'social event': async (ctx) => {
    const results = await ctx.client.query({ ids: [v.eventId(ctx.flags.event)] })
    if (results.length === 0) throw new CliError('user', 'event not found')
    return results[0]
  },

  'social notes': async (ctx) => ctx.client.query({
    kinds: [core.KIND_TEXT_NOTE],
    authors: [v.pubkey(ctx.flags.pubkey)],
    limit: v.integer(ctx.flags.limit, 'limit', { min: 1, max: 500 }) ?? 20
  }),

  'social contacts': async (ctx) => ctx.client.query({
    kinds: [core.KIND_CONTACT_LIST],
    authors: [v.pubkey(ctx.flags.pubkey)]
  }),

  // ---------------------------------------------------------------- repos --

  'repos create': async (ctx) => {
    const event = events.repoAnnouncement(ctx.secretKey, {
      id: v.required(ctx.flags.id, 'id'),
      name: ctx.flags.name ?? ctx.flags.id,
      description: ctx.flags.description ?? '',
      clone: list(ctx.flags.clone),
      web: list(ctx.flags.web)
    })
    await ctx.client.publish(event)
    return event
  },

  'repos get': async (ctx) => {
    const results = await ctx.client.query({
      kinds: [core.KIND_GIT_REPO_ANNOUNCEMENT],
      '#d': [v.required(ctx.flags.id, 'id')]
    })
    if (results.length === 0) throw new CliError('user', 'repository announcement not found')
    return results[0]
  },

  'repos list': async (ctx) => ctx.client.query({
    kinds: [core.KIND_GIT_REPO_ANNOUNCEMENT],
    limit: 500
  }),

  // ------------------------------------------------------------ workflows --

  'workflows list': async (ctx) => {
    const filter = { kinds: [core.KIND_WORKFLOW_DEF], limit: 500 }
    if (ctx.flags.channel !== undefined) filter['#h'] = [v.channelId(ctx.flags.channel)]
    return ctx.client.query(filter)
  },

  'workflows get': async (ctx) => {
    const results = await ctx.client.query({
      kinds: [core.KIND_WORKFLOW_DEF],
      '#d': [v.required(ctx.flags.workflow, 'workflow')]
    })
    if (results.length === 0) throw new CliError('user', 'workflow not found')
    return results[0]
  },

  'workflows create': async (ctx) => {
    const raw = await resolveStdin(v.required(ctx.flags.definition, 'definition'), ctx.readStdin, 'definition')
    const { parseWorkflow } = require('hive-workflow')

    const definition = parseWorkflow(raw)
    const event = events.workflowDefinition(ctx.secretKey, {
      id: ctx.flags.id ?? definition.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      channel: ctx.flags.channel === undefined ? null : v.channelId(ctx.flags.channel),
      name: definition.name,
      definition
    })

    await ctx.client.publish(event)
    return event
  },

  'workflows update': async (ctx) => commands['workflows create'](ctx),

  'workflows delete': async (ctx) => {
    const target = await commands['workflows get'](ctx)
    const event = events.deletion(ctx.secretKey, { eventIds: [target.id], reason: 'workflow deleted' })
    await ctx.client.publish(event)
    return { workflow: ctx.flags.workflow, deleted: true }
  },

  'workflows trigger': async (ctx) => {
    const event = events.workflowTrigger(ctx.secretKey, {
      workflowId: v.required(ctx.flags.workflow, 'workflow'),
      channel: ctx.flags.channel === undefined ? null : v.channelId(ctx.flags.channel)
    })
    await ctx.client.publish(event)
    return event
  },

  'workflows runs': async (ctx) => ctx.client.get('/api/workflow-runs', {
    workflow: ctx.flags.workflow,
    limit: v.integer(ctx.flags.limit, 'limit', { min: 1, max: 100 })
  }),

  'workflows approve': async (ctx) => {
    const event = events.approval(ctx.secretKey, {
      token: v.required(ctx.flags.token, 'token'),
      approved: ctx.flags.approved !== 'false' && ctx.flags.approved !== false,
      note: ctx.flags.note ?? ''
    })
    await ctx.client.publish(event)
    return event
  },

  // --------------------------------------------------------------- upload --

  'upload file': async (ctx) => {
    const fs = require('bare-fs')
    const path = v.required(ctx.flags.path, 'path')

    let body
    try {
      body = fs.readFileSync(path)
    } catch (err) {
      throw new CliError('user', `cannot read ${path}: ${err.message}`)
    }

    return ctx.client.request('PUT', '/media/upload', { body, raw: true })
  },

  // ------------------------------------------------------------------ mem --

  'mem ls': async (ctx) => ctx.client.query({
    kinds: [core.KIND_AGENT_ENGRAM],
    authors: [core.getPublicKey(ctx.secretKey)],
    limit: 500
  }),

  'mem get': async (ctx) => {
    const slug = v.required(ctx.positional[0] ?? ctx.flags.slug, 'slug')
    const results = await ctx.client.query({
      kinds: [core.KIND_AGENT_ENGRAM],
      authors: [core.getPublicKey(ctx.secretKey)],
      '#d': [slug]
    })
    if (results.length === 0) throw new CliError('user', `no memory at ${slug}`)
    return results[0]
  },

  'mem hash': async (ctx) => {
    const entry = await commands['mem get'](ctx)
    return { slug: ctx.positional[0], hash: core.toHex(core.sha256(Buffer.from(entry.content))) }
  },

  'mem set': async (ctx) => {
    const slug = v.required(ctx.positional[0] ?? ctx.flags.slug, 'slug')
    const value = await resolveStdin(
      ctx.positional[1] ?? v.required(ctx.flags.value, 'value'),
      ctx.readStdin,
      'value'
    )

    const event = core.finalizeEvent(
      {
        kind: core.KIND_AGENT_ENGRAM,
        created_at: await nextTimestamp(ctx, core.KIND_AGENT_ENGRAM, slug),
        tags: [['d', slug]],
        content: value
      },
      ctx.secretKey
    )
    await ctx.client.publish(event)
    return event
  },

  'mem rm': async (ctx) => {
    const entry = await commands['mem get'](ctx)
    const event = events.deletion(ctx.secretKey, { eventIds: [entry.id], reason: 'tombstone' })
    await ctx.client.publish(event)
    return { slug: ctx.positional[0], deleted: true }
  },

  // ---------------------------------------------------------------- audit --

  'audit verify': async (ctx) => {
    const result = await ctx.client.get('/api/audit', { limit: 1 })
    // Verifying the chain is a full scan plus a hash per row, so the relay
    // answers it only for the operator key and returns null to everyone else.
    // Say so, rather than printing `null` and looking like an intact chain.
    if (result.verification === null) {
      throw new CliError('user', 'audit verify is operator-only; run it with the relay key')
    }
    return result.verification
  },

  'audit list': async (ctx) => {
    const result = await ctx.client.get('/api/audit', {
      limit: v.integer(ctx.flags.limit, 'limit', { min: 1, max: 100 })
    })
    return result.entries
  }
}

/**
 * Normalize a kind-10100 event into the record the agent verbs print.
 *
 * `owner` is a SELF-SIGNED claim: the agent names a human, and nothing checks
 * the human agreed — hive-core/lib/attestation.js `verifyAttestation` has no
 * non-test caller. So the field is named `ownerClaimed` and travels next to
 * `ownerVerified: false`, in the JSON shape itself, because a consuming agent
 * reads the shape and not this comment.
 */
function agentRecord (event) {
  let content = {}
  try {
    const parsed = JSON.parse(event.content)
    if (parsed !== null && typeof parsed === 'object') content = parsed
  } catch {
    // A profile with unparseable content is still a declaration of machine-hood.
  }

  const owner = typeof content.owner === 'string' ? content.owner : null

  return {
    pubkey: event.pubkey,
    persona: strOrNull(content.persona),
    description: strOrNull(content.description),
    runtime: strOrNull(content.runtime),
    capabilities: strings(content.capabilities),
    models: strings(content.models),
    // Self-owned is the same as unowned: it is what the harness writes when no
    // owner was configured, and reporting it would invent a relationship.
    ownerClaimed: owner === event.pubkey ? null : owner,
    ownerVerified: false,
    eventId: event.id,
    updatedAt: event.created_at
  }
}

function strOrNull (value) {
  return typeof value === 'string' ? value : null
}

function strings (value) {
  return Array.isArray(value) ? value.filter((s) => typeof s === 'string') : []
}

/** Exact, case-folded tag match. Every requested capability must be present. */
function byCapability (records, ctx) {
  const wanted = list(ctx.flags.capability).map((c) => String(c).toLowerCase())
  if (wanted.length === 0) return records

  return records.filter((r) => {
    const have = r.capabilities.map((c) => c.toLowerCase())
    return wanted.every((w) => have.includes(w))
  })
}

/**
 * A `created_at` that is guaranteed to supersede the current head of an
 * addressable coordinate.
 *
 * NIP-01 timestamps have second resolution and ties are broken by the *lowest*
 * event id, so writing the same slug twice within one second can silently keep
 * the older value — "set it, then set it again" would appear to do nothing.
 * Bumping past the existing head makes the write land. Buzz solves the same
 * problem the same way for its membership roster.
 */
async function nextTimestamp (ctx, kind, dTag) {
  const now = Math.floor(Date.now() / 1000)

  try {
    const existing = await ctx.client.query({
      kinds: [kind],
      authors: [core.getPublicKey(ctx.secretKey)],
      '#d': [dTag],
      limit: 1
    })
    if (existing.length === 0) return now
    return Math.max(now, existing[0].created_at + 1)
  } catch {
    // If the lookup fails the write still goes out with the current time; a
    // failed read must not block a write.
    return now
  }
}

module.exports = { commands, nextTimestamp }

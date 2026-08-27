'use strict'

const core = require('hive-core')

// Typed event builders shared by the CLI and the agent harness. Having one
// place that knows which tags a kind requires is what keeps the two from
// drifting — and from each inventing their own slightly-wrong tag shapes.

function build (secretKey, kind, tags, content) {
  return core.finalizeEvent({ kind, tags, content }, secretKey)
}

const events = {
  // ------------------------------------------------------------- messages --

  // `extraTags` exists so callers can attach a tag this builder has no opinion
  // about — the agent harness's hop counter is the first — without rebuilding
  // the h/e/p shape by hand and drifting from it.
  message (secretKey, { channel, content, replyTo = null, rootId = null, mentions = [], extraTags = [] }) {
    const tags = [['h', channel]]

    if (replyTo !== null) {
      // NIP-10 marked form: the root stays addressable even in deep threads.
      if (rootId !== null && rootId !== replyTo) tags.push(['e', rootId, '', 'root'])
      tags.push(['e', replyTo, '', rootId === null || rootId === replyTo ? 'root' : 'reply'])
    }
    for (const pubkey of mentions) tags.push(['p', pubkey])
    for (const tag of extraTags) tags.push(tag)

    return build(secretKey, core.KIND_STREAM_MESSAGE, tags, content)
  },

  edit (secretKey, { channel, eventId, content }) {
    return build(secretKey, core.KIND_STREAM_MESSAGE_EDIT, [['h', channel], ['e', eventId]], content)
  },

  deletion (secretKey, { eventIds, channel = null, reason = '' }) {
    const tags = eventIds.map((id) => ['e', id])
    if (channel !== null) tags.push(['h', channel])
    return build(secretKey, core.KIND_DELETION, tags, reason)
  },

  diff (secretKey, { channel, diff, repo = null, commit = null }) {
    const tags = [['h', channel]]
    if (repo !== null) tags.push(['repo', repo])
    if (commit !== null) tags.push(['commit', commit])
    return build(secretKey, core.KIND_STREAM_MESSAGE_DIFF, tags, diff)
  },

  reaction (secretKey, { eventId, emoji = '+', channel = null }) {
    const tags = [['e', eventId]]
    // The relay derives the channel from the target anyway; the tag is a hint
    // for clients that index locally.
    if (channel !== null) tags.push(['h', channel])
    return build(secretKey, core.KIND_REACTION, tags, emoji)
  },

  vote (secretKey, { eventId, direction }) {
    return build(secretKey, core.KIND_FORUM_VOTE, [['e', eventId]], direction === 'down' ? '-' : '+')
  },

  // ------------------------------------------------------------- channels --

  createChannel (secretKey, { name, type = 'stream', visibility = 'open', about = '' }) {
    const tags = [['name', name], ['visibility', visibility], ['channel_type', type]]
    if (about) tags.push(['about', about])
    return build(secretKey, core.KIND_NIP29_CREATE_GROUP, tags, '')
  },

  editChannel (secretKey, { channel, ...fields }) {
    const tags = [['h', channel]]
    for (const field of ['name', 'about', 'topic', 'purpose']) {
      if (fields[field] !== undefined) tags.push([field, fields[field]])
    }
    return build(secretKey, core.KIND_NIP29_EDIT_METADATA, tags, '')
  },

  joinChannel (secretKey, { channel }) {
    return build(secretKey, core.KIND_NIP29_JOIN_REQUEST, [['h', channel]], '')
  },

  leaveChannel (secretKey, { channel }) {
    return build(secretKey, core.KIND_NIP29_LEAVE_REQUEST, [['h', channel]], '')
  },

  addMember (secretKey, { channel, pubkeys, role = 'member' }) {
    return build(
      secretKey,
      core.KIND_NIP29_PUT_USER,
      [['h', channel], ...pubkeys.map((p) => ['p', p]), ['role', role]],
      ''
    )
  },

  removeMember (secretKey, { channel, pubkeys }) {
    return build(secretKey, core.KIND_NIP29_REMOVE_USER, [['h', channel], ...pubkeys.map((p) => ['p', p])], '')
  },

  deleteChannel (secretKey, { channel }) {
    return build(secretKey, core.KIND_NIP29_DELETE_GROUP, [['h', channel]], '')
  },

  archiveChannel (secretKey, { channel, archived = true }) {
    const kind = archived ? core.KIND_IA_ARCHIVE_REQUEST : core.KIND_IA_UNARCHIVE_REQUEST
    return build(secretKey, kind, [['h', channel]], '')
  },

  adminDelete (secretKey, { channel, eventId, reason = '' }) {
    return build(secretKey, core.KIND_NIP29_DELETE_EVENT, [['h', channel], ['e', eventId]], reason)
  },

  canvas (secretKey, { channel, content }) {
    return build(secretKey, core.KIND_CANVAS, [['h', channel]], content)
  },

  // ------------------------------------------------------------------ DMs --

  openDm (secretKey, { pubkeys }) {
    return build(secretKey, core.KIND_DM_OPEN, pubkeys.map((p) => ['p', p]), '')
  },

  giftWrap (secretKey, { to, payload }) {
    return build(secretKey, core.KIND_GIFT_WRAP, [['p', to]], payload)
  },

  // ---------------------------------------------------------------- users --

  profile (secretKey, { displayName, about, picture, nip05 }) {
    return build(secretKey, core.KIND_PROFILE, [], JSON.stringify({
      display_name: displayName,
      about,
      picture,
      nip05
    }))
  },

  presence (secretKey, { status }) {
    return build(secretKey, core.KIND_PRESENCE_UPDATE, [], status)
  },

  typing (secretKey, { channel }) {
    return build(secretKey, core.KIND_TYPING_INDICATOR, [['h', channel]], '')
  },

  status (secretKey, { text = '', emoji = null }) {
    const tags = [['d', 'general']]
    if (emoji !== null) tags.push(['emoji', emoji])
    return build(secretKey, core.KIND_USER_STATUS, tags, text)
  },

  contacts (secretKey, { pubkeys }) {
    return build(secretKey, core.KIND_CONTACT_LIST, pubkeys.map((p) => ['p', p]), '')
  },

  note (secretKey, { content }) {
    return build(secretKey, core.KIND_TEXT_NOTE, [], content)
  },

  // --------------------------------------------------------------- agents --

  agentProfile (secretKey, { owner, persona = null, runtime = null, capabilities = [], models = [], delegation = null, sdkVersion = null }) {
    return build(secretKey, core.KIND_AGENT_PROFILE, [['p', owner]], JSON.stringify({
      owner,
      persona,
      runtime,
      sdk_version: sdkVersion,
      capabilities,
      models,
      delegation
    }))
  },

  persona (secretKey, { slug, displayName, systemPrompt = null, avatarUrl = null, runtime = null, model = null, provider = null, namePool = [], shared = false }) {
    const tags = [['d', slug], ['alt', 'agent persona definition']]
    if (shared) tags.push(['shared', 'true'])

    return build(secretKey, core.KIND_PERSONA, tags, JSON.stringify({
      display_name: displayName,
      system_prompt: systemPrompt,
      avatar_url: avatarUrl,
      runtime,
      model,
      provider,
      name_pool: namePool
    }))
  },

  managedAgent (secretKey, { agentPubkey, persona, displayName }) {
    // Public projection only — never secrets, env vars or runtime config.
    return build(secretKey, core.KIND_MANAGED_AGENT, [['d', agentPubkey], ['p', agentPubkey]], JSON.stringify({
      agent: agentPubkey,
      persona,
      display_name: displayName
    }))
  },

  jobRequest (secretKey, { channel, agent, prompt, jobId, extraTags = [] }) {
    return build(
      secretKey,
      core.KIND_JOB_REQUEST,
      [['h', channel], ['p', agent], ['d', jobId], ...extraTags],
      prompt
    )
  },

  /**
   * An agent's own memory: kind 30174, addressed by slug.
   *
   * Parameterized-replaceable, so writing the same slug twice replaces rather
   * than appends, and `{ kinds: [30174], authors: [agent], '#d': [slug] }`
   * reads it back. `hive-cli`'s `mem set` builds the same shape by hand; this
   * is that shape in the one place that is supposed to know it.
   *
   * ⚠ Content is PLAINTEXT on the relay. SPEC §7.4 wants NIP-44 to the owner
   * with a blinded `d`; nothing implements that yet, so never put anything
   * private in here.
   */
  engram (secretKey, { slug, content }) {
    return build(secretKey, core.KIND_AGENT_ENGRAM, [['d', slug]], content)
  },

  jobEvent (secretKey, kind, { channel, jobId, requester, content = '' }) {
    const tags = [['d', jobId], ['p', requester]]
    if (channel !== null && channel !== undefined) tags.push(['h', channel])
    return build(secretKey, kind, tags, content)
  },

  turnMetric (secretKey, { owner, jobId, metrics }) {
    // p-gated and encrypted to the owner in production; the tag shape is what
    // the relay enforces on.
    return build(secretKey, core.KIND_AGENT_TURN_METRIC, [['p', owner], ['d', jobId]], JSON.stringify(metrics))
  },

  // ------------------------------------------------------------------ git --

  repoAnnouncement (secretKey, { id, name, description = '', clone = [], web = [] }) {
    const tags = [['d', id], ['name', name]]
    if (clone.length > 0) tags.push(['clone', ...clone])
    if (web.length > 0) tags.push(['web', ...web])
    return build(secretKey, core.KIND_GIT_REPO_ANNOUNCEMENT, tags, description)
  },

  patch (secretKey, { repo, diff, commit = null, channel = null }) {
    const tags = [['a', `${core.KIND_GIT_REPO_ANNOUNCEMENT}:${repo}`]]
    if (commit !== null) tags.push(['commit', commit])
    if (channel !== null) tags.push(['h', channel])
    return build(secretKey, core.KIND_GIT_PATCH, tags, diff)
  },

  // ------------------------------------------------------------ workflows --

  workflowDefinition (secretKey, { id, channel, name, definition }) {
    const tags = [['d', id], ['name', name]]
    if (channel !== null && channel !== undefined) tags.push(['h', channel])
    return build(secretKey, core.KIND_WORKFLOW_DEF, tags, JSON.stringify(definition))
  },

  workflowTrigger (secretKey, { workflowId, channel = null }) {
    const tags = [['d', workflowId]]
    if (channel !== null) tags.push(['h', channel])
    return build(secretKey, core.KIND_WORKFLOW_TRIGGER, tags, '')
  },

  approval (secretKey, { token, approved, note = '' }) {
    const kind = approved ? core.KIND_APPROVAL_GRANT : core.KIND_APPROVAL_DENY
    return build(secretKey, kind, [['token', token]], note)
  },

  // ------------------------------------------------------------- huddles --

  huddleEvent (secretKey, kind, { channel, content = '' }) {
    return build(secretKey, kind, [['h', channel]], content)
  }
}

module.exports = { events, build }

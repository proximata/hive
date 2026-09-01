'use strict'

const b4a = require('b4a')

const {
  sha256,
  toHex,
  tagValue,
  tagValuesAll,
  channelId: eventChannelId,
  referencedEvents,
  KIND_NIP29_CREATE_GROUP,
  KIND_NIP29_PUT_USER,
  KIND_NIP29_REMOVE_USER,
  KIND_NIP29_EDIT_METADATA,
  KIND_NIP29_DELETE_EVENT,
  KIND_NIP29_DELETE_GROUP,
  KIND_NIP29_JOIN_REQUEST,
  KIND_NIP29_LEAVE_REQUEST,
  KIND_NIP29_GROUP_METADATA,
  KIND_NIP29_GROUP_ADMINS,
  KIND_NIP29_GROUP_MEMBERS,
  KIND_MEMBER_ADDED_NOTIFICATION,
  KIND_MEMBER_REMOVED_NOTIFICATION,
  KIND_CANVAS,
  KIND_PROFILE,
  KIND_IA_ARCHIVE_REQUEST,
  KIND_IA_UNARCHIVE_REQUEST,
  KIND_DM_OPEN,
  KIND_DELETION
} = require('hive-core')

// NIP-29 command kinds. Each handler is a pair:
//
//   authorize(relay, event, ctx) -> reason | null   runs BEFORE the event is
//                                                   stored, so a rejected
//                                                   command leaves no trace
//   apply(relay, event, ctx)                        runs AFTER, so the log
//                                                   explains every state change
//
// The authorization rules are Buzz's, verbatim — see SPEC.md §2.2.

class RejectError extends Error {
  constructor (reason) {
    super(reason)
    this.name = 'RejectError'
    this.reason = reason
    this.isReject = true
  }
}

const ROLE_RANK = { owner: 3, admin: 2, member: 1, guest: 0, bot: 1 }

function roleOf (relay, channelId, pubkey) {
  return relay.store.getMember(channelId, pubkey)?.role ?? null
}

function isAtLeast (relay, channelId, pubkey, role) {
  const actual = roleOf(relay, channelId, pubkey)
  if (actual === null) return false
  return (ROLE_RANK[actual] ?? 0) >= (ROLE_RANK[role] ?? 0)
}

function requireChannel (relay, event) {
  const id = eventChannelId(event)
  if (id === null) return { channel: null, reason: 'invalid: channel-scoped events must include an h tag' }

  const channel = relay.store.getChannel(id)
  if (channel === null) return { channel: null, reason: 'invalid: unknown channel' }
  return { channel, reason: null }
}

function uuidv4 () {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return formatUuid(bytes)
}

/**
 * A v4-shaped uuid derived from a string, so the SAME input always yields the
 * SAME id — on this relay, on a peer relay, and after a restart.
 *
 * This exists because a channel id must be a function of the signed create
 * event and not of whoever happened to apply it first. `events.createChannel`
 * (hive-sdk index.js) sends no `h` tag, so before this the relay minted a
 * random uuid in `apply`; replicate that one event to a second relay and each
 * side invents a different id for the same channel, after which every message
 * tagged with one relay's id is rejected by the other as `invalid: unknown
 * channel`. The DM path already derives its id for exactly this reason — see
 * `dmChannelId` — this makes group creation agree with it.
 */
function uuidFrom (seed) {
  return formatUuid(b4a.from(sha256(b4a.from(seed))).subarray(0, 16))
}

/** 16 bytes -> the canonical 8-4-4-4-12 form, with the v4 variant bits set. */
function formatUuid (bytes) {
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

// ------------------------------------------------------ relay-signed events --

/**
 * Publish the NIP-29 discovery triple for a channel. These are signed by the
 * relay, not by any client, which is what makes them trustworthy: they say what
 * the relay believes the membership to be.
 */
function publishDiscovery (relay, channel) {
  const members = relay.store.listMembers(channel.id)

  const metadataTags = [
    ['d', channel.id],
    ['name', channel.name],
    // `closed` is always emitted per NIP-29 convention: Hive channels have
    // explicit membership. It describes the membership model, not read access
    // — an open channel is still readable by non-members.
    ['closed']
  ]
  if (channel.about) metadataTags.push(['about', channel.about])
  if (channel.visibility === 'private') metadataTags.push(['private'])
  if (channel.type === 'dm') metadataTags.push(['hidden'])

  const metadata = relay.signAsRelay({
    kind: KIND_NIP29_GROUP_METADATA,
    tags: metadataTags,
    content: ''
  })

  const admins = relay.signAsRelay({
    kind: KIND_NIP29_GROUP_ADMINS,
    tags: [
      ['d', channel.id],
      ...members.filter((m) => m.role === 'owner' || m.role === 'admin').map((m) => ['p', m.pubkey, m.role])
    ],
    content: ''
  })

  const memberList = relay.signAsRelay({
    kind: KIND_NIP29_GROUP_MEMBERS,
    tags: [['d', channel.id], ...members.map((m) => ['p', m.pubkey])],
    content: ''
  })

  for (const event of [metadata, admins, memberList]) {
    relay.store.insertEvent(event, { channelId: channel.id })
    relay.broadcast(event, channel.id)
  }

  return { metadata, admins, members: memberList }
}

/**
 * Membership notifications are community-global and p-gated, so an agent can
 * subscribe to "channels I was added to" without knowing any channel id in
 * advance.
 */
function publishMembershipNotification (relay, kind, channelId, pubkey) {
  const event = relay.signAsRelay({
    kind,
    tags: [['p', pubkey], ['h', channelId]],
    content: ''
  })

  // Stored community-global (channelId null) so a global #p subscription can
  // receive it — a channel-scoped store would hide it behind the very
  // membership it is announcing.
  relay.store.insertEvent(event, { channelId: null })
  relay.broadcast(event, null)
  return event
}

// ------------------------------------------------------------- 9007 create --

const createGroup = {
  authorize (relay, event) {
    const name = tagValue(event, 'name')
    if (name === null || name.length === 0) return 'invalid: group creation requires a name tag'
    if (name.length > 128) return 'invalid: group name is too long'

    const visibility = tagValue(event, 'visibility') ?? 'open'
    if (!['open', 'private'].includes(visibility)) return 'invalid: visibility must be open or private'

    const type = tagValue(event, 'channel_type') ?? 'stream'
    if (!['stream', 'forum', 'dm', 'workflow'].includes(type)) return 'invalid: unknown channel_type'

    return null
  },

  apply (relay, event) {
    const channel = relay.store.createChannel({
      // Derived from the event id, never random: two relays applying the same
      // replicated create event must reach the same channel id or every later
      // message in that channel is 'unknown channel' on one of them.
      id: tagValue(event, 'h') ?? uuidFrom(event.id),
      name: tagValue(event, 'name'),
      type: tagValue(event, 'channel_type') ?? 'stream',
      visibility: tagValue(event, 'visibility') ?? 'open',
      about: tagValue(event, 'about') ?? '',
      createdBy: event.pubkey
    })

    relay._audit({
      action: 'ChannelCreated',
      actor: event.pubkey,
      eventId: event.id,
      kind: event.kind,
      channelId: channel.id,
      metadata: { name: channel.name, visibility: channel.visibility }
    })

    publishDiscovery(relay, channel)
    publishMembershipNotification(relay, KIND_MEMBER_ADDED_NOTIFICATION, channel.id, event.pubkey)
    relay.emit('channel-created', channel)
    return channel
  }
}

// ---------------------------------------------------------- 9000 put user --

// Every p tag costs an addMember, an audit row and a relay schnorr signature,
// synchronously, and ~900 of them fit in one 64 KB frame. Rejected over the
// line rather than truncated: a client told "accepted" while 836 of its 900
// invitations were dropped has been lied to.
const MAX_PUT_USER_TARGETS = 64

// A p tag that is not a pubkey is a row in channel_members that no key can
// ever match, so it can only ever be garbage.
const PUBKEY_HEX = /^[0-9a-f]{64}$/

const putUser = {
  authorize (relay, event) {
    const { channel, reason } = requireChannel(relay, event)
    if (reason !== null) return reason

    const targets = tagValuesAll(event, 'p')
    if (targets.length === 0) return 'invalid: put-user requires at least one p tag'
    if (targets.length > MAX_PUT_USER_TARGETS) {
      return `invalid: at most ${MAX_PUT_USER_TARGETS} p tags per put-user`
    }
    for (const target of targets) {
      if (!PUBKEY_HEX.test(target)) return 'invalid: every p tag must be a 64-character hex pubkey'
    }

    const selfAdd = targets.length === 1 && targets[0] === event.pubkey

    if (channel.visibility === 'private') {
      // Private channels: only owners and admins may add anyone, including
      // someone adding themselves.
      if (!isAtLeast(relay, channel.id, event.pubkey, 'admin')) {
        return 'restricted: only owners and admins may add members to a private channel'
      }
      return null
    }

    // Open channels: the add policy governs, except that self-add bypasses it.
    if (!selfAdd) {
      if (channel.channelAddPolicy === 'nobody') return 'restricted: this channel does not accept new members'
      if (channel.channelAddPolicy === 'owner_only' && !isAtLeast(relay, channel.id, event.pubkey, 'owner')) {
        return 'restricted: only the owner may add members to this channel'
      }
      if (!relay.store.isMember(channel.id, event.pubkey)) {
        return 'restricted: not a channel member'
      }
    }

    return null
  },

  apply (relay, event) {
    const channelId = eventChannelId(event)
    const role = tagValue(event, 'role') ?? 'member'

    for (const target of tagValuesAll(event, 'p')) {
      relay.store.addMember(channelId, target, ['owner', 'admin', 'member', 'guest', 'bot'].includes(role) ? role : 'member')
      relay._audit({
        action: 'MemberAdded',
        actor: event.pubkey,
        eventId: event.id,
        kind: event.kind,
        channelId,
        metadata: { target, role }
      })
      publishMembershipNotification(relay, KIND_MEMBER_ADDED_NOTIFICATION, channelId, target)
    }

    publishDiscovery(relay, relay.store.getChannel(channelId))
  }
}

// ------------------------------------------------------- 9001 remove user --

const removeUser = {
  authorize (relay, event) {
    const { channel, reason } = requireChannel(relay, event)
    if (reason !== null) return reason

    const targets = tagValuesAll(event, 'p')
    if (targets.length === 0) return 'invalid: remove-user requires at least one p tag'

    const selfRemove = targets.length === 1 && targets[0] === event.pubkey
    if (!selfRemove && !isAtLeast(relay, channel.id, event.pubkey, 'admin')) {
      return 'restricted: only owners and admins may remove other members'
    }

    for (const target of targets) {
      const role = roleOf(relay, channel.id, target)
      if (role === 'owner' && relay.store.countOwners(channel.id) <= 1) {
        return 'restricted: cannot remove the last owner of a channel'
      }
    }

    return null
  },

  apply (relay, event) {
    const channelId = eventChannelId(event)

    for (const target of tagValuesAll(event, 'p')) {
      relay.store.removeMember(channelId, target)
      relay._audit({
        action: 'MemberRemoved',
        actor: event.pubkey,
        eventId: event.id,
        kind: event.kind,
        channelId,
        metadata: { target }
      })
      publishMembershipNotification(relay, KIND_MEMBER_REMOVED_NOTIFICATION, channelId, target)
    }

    publishDiscovery(relay, relay.store.getChannel(channelId))
  }
}

// --------------------------------------------------- 9002 edit metadata --

const EDIT_FIELDS = ['name', 'about', 'topic', 'purpose']

const editMetadata = {
  authorize (relay, event) {
    const { channel, reason } = requireChannel(relay, event)
    if (reason !== null) return reason

    const present = EDIT_FIELDS.filter((field) => tagValue(event, field) !== null)
    if (present.length === 0) return 'invalid: nothing to edit'

    // name/about are governance; topic/purpose are day-to-day and any member
    // may set them. That split is Buzz's and it is a good one.
    const privileged = present.some((field) => field === 'name' || field === 'about')
    if (privileged && !isAtLeast(relay, channel.id, event.pubkey, 'admin')) {
      return 'restricted: only owners and admins may change the name or description'
    }
    if (!relay.store.isMember(channel.id, event.pubkey)) {
      return 'restricted: not a channel member'
    }

    return null
  },

  apply (relay, event) {
    const channelId = eventChannelId(event)
    const patch = {}
    for (const field of EDIT_FIELDS) {
      const value = tagValue(event, field)
      if (value !== null) patch[field] = value
    }

    const channel = relay.store.updateChannel(channelId, patch)
    relay._audit({
      action: 'ChannelUpdated',
      actor: event.pubkey,
      eventId: event.id,
      kind: event.kind,
      channelId,
      metadata: patch
    })

    if (patch.name !== undefined || patch.about !== undefined) publishDiscovery(relay, channel)
  }
}

// ------------------------------------------------------ 9005 delete event --

const deleteEvent = {
  authorize (relay, event) {
    const targets = referencedEvents(event)
    if (targets.length === 0) return 'invalid: delete requires an e tag'

    for (const targetId of targets) {
      const target = relay.store.getStoredEvent(targetId)
      if (target === null) return 'invalid: target event not found'

      // The author may always delete their own; otherwise it takes admin, and
      // only within the same channel.
      if (target.event.pubkey === event.pubkey) continue

      const channelId = target.channelId
      if (channelId === null || channelId !== eventChannelId(event)) {
        return 'restricted: target event is not in this channel'
      }
      if (!isAtLeast(relay, channelId, event.pubkey, 'admin')) {
        return 'restricted: only owners and admins may delete other members\' events'
      }
    }

    return null
  },

  apply (relay, event) {
    for (const targetId of referencedEvents(event)) {
      relay.store.deleteEvent(targetId)
      relay._audit({
        action: 'EventDeleted',
        actor: event.pubkey,
        eventId: targetId,
        kind: event.kind,
        channelId: eventChannelId(event),
        metadata: {}
      })
    }
  }
}

// ------------------------------------------------------- 5 NIP-09 deletion --

// Kind 5 is validated in the ingest rules (self-authored only, target must
// exist); this applies the soft delete. Without it a deletion would be stored
// and fanned out while the deleted message stayed readable.
const nip09Deletion = {
  apply (relay, event) {
    for (const targetId of referencedEvents(event)) {
      const target = relay.store.getStoredEvent(targetId)
      if (target === null) continue

      relay.store.deleteEvent(targetId)
      relay._audit({
        action: 'EventDeleted',
        actor: event.pubkey,
        eventId: targetId,
        kind: event.kind,
        channelId: target.channelId,
        metadata: { reason: event.content }
      })
    }
  }
}

// ------------------------------------------------------ 9008 delete group --

const deleteGroup = {
  authorize (relay, event) {
    const { channel, reason } = requireChannel(relay, event)
    if (reason !== null) return reason
    if (!isAtLeast(relay, channel.id, event.pubkey, 'owner')) {
      return 'restricted: only the owner may delete a channel'
    }
    return null
  },

  apply (relay, event) {
    const channelId = eventChannelId(event)
    relay.store.deleteChannel(channelId)
    relay._audit({
      action: 'ChannelDeleted',
      actor: event.pubkey,
      eventId: event.id,
      kind: event.kind,
      channelId,
      metadata: {}
    })
    relay.emit('channel-deleted', channelId)
  }
}

// -------------------------------------------------------------- 9021 join --

const joinRequest = {
  authorize (relay, event) {
    const { channel, reason } = requireChannel(relay, event)
    if (reason !== null) return reason
    if (channel.visibility !== 'open') {
      return 'restricted: this channel does not accept join requests'
    }
    return null
  },

  apply (relay, event) {
    const channelId = eventChannelId(event)
    relay.store.addMember(channelId, event.pubkey)
    relay._audit({
      action: 'MemberAdded',
      actor: event.pubkey,
      eventId: event.id,
      kind: event.kind,
      channelId,
      metadata: { target: event.pubkey, via: 'join-request' }
    })
    publishMembershipNotification(relay, KIND_MEMBER_ADDED_NOTIFICATION, channelId, event.pubkey)
    publishDiscovery(relay, relay.store.getChannel(channelId))
  }
}

// ------------------------------------------------------------- 9022 leave --

const leaveRequest = {
  authorize (relay, event) {
    const { channel, reason } = requireChannel(relay, event)
    if (reason !== null) return reason
    if (!relay.store.isMember(channel.id, event.pubkey)) return 'invalid: not a member of this channel'
    if (roleOf(relay, channel.id, event.pubkey) === 'owner' && relay.store.countOwners(channel.id) <= 1) {
      return 'restricted: the last owner cannot leave a channel'
    }
    return null
  },

  apply (relay, event) {
    const channelId = eventChannelId(event)
    relay.store.removeMember(channelId, event.pubkey)
    relay._audit({
      action: 'MemberRemoved',
      actor: event.pubkey,
      eventId: event.id,
      kind: event.kind,
      channelId,
      metadata: { target: event.pubkey, via: 'leave-request' }
    })
    publishMembershipNotification(relay, KIND_MEMBER_REMOVED_NOTIFICATION, channelId, event.pubkey)
    publishDiscovery(relay, relay.store.getChannel(channelId))
  }
}

// ------------------------------------------------------------ archive/unarchive --

const archiveRequest = (archived) => ({
  authorize (relay, event) {
    const { channel, reason } = requireChannel(relay, event)
    if (reason !== null) return reason
    if (!isAtLeast(relay, channel.id, event.pubkey, 'admin')) {
      return 'restricted: only owners and admins may archive a channel'
    }
    return null
  },

  apply (relay, event) {
    const channelId = eventChannelId(event)
    relay.store.archiveChannel(channelId, archived)
    relay._audit({
      action: 'ChannelUpdated',
      actor: event.pubkey,
      eventId: event.id,
      kind: event.kind,
      channelId,
      metadata: { archived }
    })
  }
})

// ------------------------------------------------------------ 40100 canvas --

const canvas = {
  authorize (relay, event) {
    const { channel, reason } = requireChannel(relay, event)
    if (reason !== null) return reason
    if (!relay.store.isMember(channel.id, event.pubkey)) return 'restricted: not a channel member'
    return null
  },

  apply (relay, event) {
    relay.store.updateChannel(eventChannelId(event), { canvas: event.content })
  }
}

// --------------------------------------------------------- 41010 DM open --

const dmOpen = {
  authorize (relay, event) {
    const participants = new Set([event.pubkey, ...tagValuesAll(event, 'p')])
    if (participants.size < 2) return 'invalid: a DM needs at least one other participant'
    if (participants.size > 8) return 'invalid: a DM may have at most 8 participants'
    return null
  },

  apply (relay, event) {
    const participants = [...new Set([event.pubkey, ...tagValuesAll(event, 'p')])].sort()

    // A DM is a private channel with a deterministic id, so opening the same
    // conversation twice converges instead of forking.
    const id = dmChannelId(participants)
    let channel = relay.store.getChannel(id)

    if (channel === null) {
      channel = relay.store.createChannel({
        id,
        name: participants.map((p) => p.slice(0, 8)).join(', '),
        type: 'dm',
        visibility: 'private',
        createdBy: event.pubkey
      })
      for (const participant of participants) {
        if (participant !== event.pubkey) relay.store.addMember(id, participant)
      }

      relay._audit({
        action: 'ChannelCreated',
        actor: event.pubkey,
        eventId: event.id,
        kind: event.kind,
        channelId: id,
        metadata: { type: 'dm', participants: participants.length }
      })
    }

    // Discovery carries the `hidden` tag so clients list DMs separately from
    // channels; membership notifications let each participant find it without
    // knowing the id in advance.
    publishDiscovery(relay, relay.store.getChannel(id))
    for (const participant of participants) {
      publishMembershipNotification(relay, KIND_MEMBER_ADDED_NOTIFICATION, id, participant)
    }

    return channel
  }
}

/** Deterministic UUID-shaped id from the sorted participant set. */
function dmChannelId (participants) {
  const digest = toHex(sha256(b4a.from('hive:dm:v1:' + participants.join(':'))))
  return [
    digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)
  ].join('-')
}

// ----------------------------------------------------------- 0 profile sync --

const profile = {
  apply (relay, event) {
    let metadata = {}
    try {
      metadata = JSON.parse(event.content)
    } catch {
      return // A malformed profile is stored as an event but syncs nothing.
    }

    relay.store.upsertUser(event.pubkey, {
      displayName: metadata.display_name ?? metadata.name ?? null,
      avatar: metadata.picture ?? null,
      about: metadata.about ?? null,
      // A NIP-05 handle is only meaningful on this relay's own domain, so an
      // off-domain claim is dropped rather than trusted.
      nip05: typeof metadata.nip05 === 'string' && metadata.nip05.endsWith(relayDomain(relay))
        ? metadata.nip05
        : null
    })
  }
}

function relayDomain (relay) {
  try {
    return new URL(relay.url.replace(/^ws/, 'http')).host
  } catch {
    return ''
  }
}

const commandHandlers = new Map([
  [KIND_DELETION, nip09Deletion],
  [KIND_NIP29_CREATE_GROUP, createGroup],
  [KIND_NIP29_PUT_USER, putUser],
  [KIND_NIP29_REMOVE_USER, removeUser],
  [KIND_NIP29_EDIT_METADATA, editMetadata],
  [KIND_NIP29_DELETE_EVENT, deleteEvent],
  [KIND_NIP29_DELETE_GROUP, deleteGroup],
  [KIND_NIP29_JOIN_REQUEST, joinRequest],
  [KIND_NIP29_LEAVE_REQUEST, leaveRequest],
  [KIND_IA_ARCHIVE_REQUEST, archiveRequest(true)],
  [KIND_IA_UNARCHIVE_REQUEST, archiveRequest(false)],
  [KIND_DM_OPEN, dmOpen],
  [KIND_CANVAS, canvas],
  [KIND_PROFILE, profile]
])

module.exports = {
  commandHandlers,
  dmChannelId,
  publishDiscovery,
  publishMembershipNotification,
  RejectError,
  uuidv4,
  uuidFrom,
  isAtLeast,
  roleOf,
  MAX_PUT_USER_TARGETS
}

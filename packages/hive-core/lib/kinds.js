'use strict'

// The kind registry. Numbers are Block/Buzz's and are frozen: they are the
// interop contract, so a Buzz client or agent can talk to a Hive relay.
// See SPEC.md §2.2. Source of truth upstream: crates/buzz-core/src/kind.rs.

// ---------------------------------------------------------------- standard --

const KIND_PROFILE = 0
const KIND_TEXT_NOTE = 1
const KIND_CONTACT_LIST = 3
const KIND_DELETION = 5
const KIND_REACTION = 7
const KIND_CHANNEL_METADATA = 41
const KIND_GIFT_WRAP = 1059
const KIND_FILE_METADATA = 1063
const KIND_REPORT = 1984

const KIND_MUTE_LIST = 10000
const KIND_PIN_LIST = 10001
const KIND_NIP65_RELAY_LIST_METADATA = 10002
const KIND_BOOKMARK_LIST = 10003
const KIND_EMOJI_LIST = 10030

const KIND_AUTH = 22242
const KIND_BLOSSOM_AUTH = 24242
const KIND_NOSTR_IDENTITY_BINDING = 24243
const KIND_HTTP_AUTH = 27235

const KIND_FOLLOW_SET = 30000
const KIND_BOOKMARK_SET = 30003
const KIND_LONG_FORM = 30023
const KIND_EMOJI_SET = 30030
const KIND_READ_STATE = 30078
const KIND_USER_STATUS = 30315

// ------------------------------------------------------------ NIP-29 groups --

const KIND_STREAM_MESSAGE = 9
const KIND_NIP29_PUT_USER = 9000
const KIND_NIP29_REMOVE_USER = 9001
const KIND_NIP29_EDIT_METADATA = 9002
const KIND_NIP29_DELETE_EVENT = 9005
const KIND_NIP29_CREATE_GROUP = 9007
const KIND_NIP29_DELETE_GROUP = 9008
const KIND_NIP29_CREATE_INVITE = 9009
const KIND_NIP29_JOIN_REQUEST = 9021
const KIND_NIP29_LEAVE_REQUEST = 9022

const KIND_NIP29_GROUP_METADATA = 39000
const KIND_NIP29_GROUP_ADMINS = 39001
const KIND_NIP29_GROUP_MEMBERS = 39002
const KIND_NIP29_GROUP_ROLES = 39003
const KIND_THREAD_SUMMARY = 39005
const KIND_WINDOW_BOUNDS = 39006

// ------------------------------------------------------------- moderation --

const KIND_MODERATION_BAN = 9040
const KIND_MODERATION_UNBAN = 9041
const KIND_MODERATION_TIMEOUT = 9042
const KIND_MODERATION_UNTIMEOUT = 9043
const KIND_MODERATION_RESOLVE_REPORT = 9044

// -------------------------------------------------- NIP-43 relay membership --

const KIND_NIP43_MEMBER_ADDED = 8000
const KIND_NIP43_MEMBER_REMOVED = 8001
const KIND_NIP43_ADD_MEMBER = 9030
const KIND_NIP43_REMOVE_MEMBER = 9031
const KIND_NIP43_CHANGE_ROLE = 9032
const KIND_NIP43_SET_WORKSPACE_PROFILE = 9033
const KIND_NIP43_MEMBERSHIP_LIST = 13534
const KIND_NIP43_LEAVE_REQUEST = 28936

// --------------------------------------------------------- instant archive --

const KIND_IA_ARCHIVE_REQUEST = 9035
const KIND_IA_UNARCHIVE_REQUEST = 9036
const KIND_IA_ARCHIVED = 8002
const KIND_IA_UNARCHIVED = 8003
const KIND_IA_ARCHIVED_LIST = 13535

// ------------------------------------------------------------------ agents --

const KIND_AGENT_PROFILE = 10100
const KIND_AGENT_ENGRAM = 30174
const KIND_PERSONA = 30175
const KIND_TEAM = 30176
const KIND_MANAGED_AGENT = 30177
const KIND_TEAM_CATALOG = 30178
const KIND_PRIVATE_MANAGED_AGENT = 30179
const KIND_EVENT_REMINDER = 30300
const KIND_PUSH_LEASE = 30350

// --------------------------------------------------------------- ephemeral --

const KIND_PRESENCE_UPDATE = 20001
const KIND_TYPING_INDICATOR = 20002
const KIND_PAIRING = 24134
const KIND_AGENT_OBSERVER_FRAME = 24200
const KIND_HUDDLE_REACTION = 24810

// -------------------------------------------------------------- Hive custom --

const KIND_STREAM_MESSAGE_V2 = 40002
const KIND_STREAM_MESSAGE_EDIT = 40003
const KIND_STREAM_MESSAGE_PINNED = 40004
const KIND_STREAM_MESSAGE_BOOKMARKED = 40005
const KIND_STREAM_MESSAGE_SCHEDULED = 40006
const KIND_STREAM_REMINDER = 40007
const KIND_STREAM_MESSAGE_DIFF = 40008
const KIND_SYSTEM_MESSAGE = 40099
const KIND_CANVAS = 40100
const KIND_CHANNEL_SUMMARY = 40901
const KIND_PRESENCE_SNAPSHOT = 40902

const KIND_DM_CREATED = 41001
const KIND_DM_OPEN = 41010
const KIND_DM_ADD_MEMBER = 41011
const KIND_DM_HIDE = 41012

const KIND_PRODUCT_FEEDBACK = 42000

const KIND_JOB_REQUEST = 43001
const KIND_JOB_ACCEPTED = 43002
const KIND_JOB_PROGRESS = 43003
const KIND_JOB_RESULT = 43004
const KIND_JOB_CANCEL = 43005
const KIND_JOB_ERROR = 43006

const KIND_MEMBER_ADDED_NOTIFICATION = 44100
const KIND_MEMBER_REMOVED_NOTIFICATION = 44101
const KIND_AGENT_TURN_METRIC = 44200

const KIND_FORUM_POST = 45001
const KIND_FORUM_VOTE = 45002
const KIND_FORUM_COMMENT = 45003

const KIND_WORKFLOW_TRIGGERED = 46001
const KIND_WORKFLOW_STEP_STARTED = 46002
const KIND_WORKFLOW_STEP_COMPLETED = 46003
const KIND_WORKFLOW_STEP_FAILED = 46004
const KIND_WORKFLOW_COMPLETED = 46005
const KIND_WORKFLOW_FAILED = 46006
const KIND_WORKFLOW_CANCELLED = 46007
const KIND_WORKFLOW_APPROVAL_REQUESTED = 46010
const KIND_WORKFLOW_APPROVAL_GRANTED = 46011
const KIND_WORKFLOW_APPROVAL_DENIED = 46012
const KIND_WORKFLOW_TRIGGER = 46020
const KIND_APPROVAL_GRANT = 46030
const KIND_APPROVAL_DENY = 46031

const KIND_AUDIT_ENTRY = 48001

const KIND_HUDDLE_STARTED = 48100
const KIND_HUDDLE_PARTICIPANT_JOINED = 48101
const KIND_HUDDLE_PARTICIPANT_LEFT = 48102
const KIND_HUDDLE_ENDED = 48103
const KIND_HUDDLE_GUIDELINES = 48106

const KIND_MEDIA_UPLOAD = 49001

const KIND_WORKFLOW_DEF = 30620
const KIND_PROJECT = 30621
const KIND_DM_VISIBILITY = 30622

// -------------------------------------------------------------- git NIP-34 --

const KIND_GIT_PATCH = 1617
const KIND_GIT_PULL_REQUEST = 1618
const KIND_GIT_PR_UPDATE = 1619
const KIND_GIT_ISSUE = 1621
const KIND_GIT_STATUS_OPEN = 1630
const KIND_GIT_STATUS_MERGED = 1631
const KIND_GIT_STATUS_CLOSED = 1632
const KIND_GIT_STATUS_DRAFT = 1633
const KIND_GIT_REPO_ANNOUNCEMENT = 30617
const KIND_GIT_REPO_STATE = 30618

// ------------------------------------------------------------ access classes --

// Only the author may learn these exist — not their count, tags, content, or
// search hits. See SPEC.md §2.3.
const AUTHOR_ONLY_KINDS = [
  KIND_EVENT_REMINDER,
  KIND_PUSH_LEASE,
  KIND_PRIVATE_MANAGED_AGENT
]

// Readable only by a pubkey named in the event's #p tag. A REQ that can match
// any of these is closed unless its #p filter is exactly the reader's pubkey.
const P_GATED_KINDS = [
  KIND_AGENT_OBSERVER_FRAME,
  KIND_MEMBER_ADDED_NOTIFICATION,
  KIND_MEMBER_REMOVED_NOTIFICATION,
  KIND_GIFT_WRAP,
  KIND_DM_VISIBILITY,
  KIND_AGENT_TURN_METRIC
]

// Even a reader who knows the id must match #p — closes the kindless {ids:[…]}
// read path for events whose existence must not leak.
const RESULT_GATED_KINDS = [KIND_DM_VISIBILITY, KIND_AGENT_TURN_METRIC]

// Author-only unless the event carries exactly ["shared","true"].
const SHARED_GATED_KINDS = [KIND_PERSONA, KIND_TEAM_CATALOG]

// Never written to the search index (SPEC.md §5.4). Every persistent p-gated or
// author-only kind, plus the ephemeral ones for completeness.
const UNSEARCHABLE_KINDS = [
  KIND_GIFT_WRAP,
  KIND_EVENT_REMINDER,
  KIND_DM_VISIBILITY,
  KIND_AGENT_TURN_METRIC,
  KIND_AGENT_OBSERVER_FRAME,
  KIND_MEMBER_ADDED_NOTIFICATION,
  KIND_MEMBER_REMOVED_NOTIFICATION,
  KIND_PUSH_LEASE,
  KIND_PRIVATE_MANAGED_AGENT
]

// Workflow execution kinds never re-trigger workflows (loop prevention).
const WORKFLOW_EXECUTION_KINDS = [
  KIND_WORKFLOW_TRIGGERED,
  KIND_WORKFLOW_STEP_STARTED,
  KIND_WORKFLOW_STEP_COMPLETED,
  KIND_WORKFLOW_STEP_FAILED,
  KIND_WORKFLOW_COMPLETED,
  KIND_WORKFLOW_FAILED,
  KIND_WORKFLOW_CANCELLED,
  KIND_WORKFLOW_APPROVAL_REQUESTED,
  KIND_WORKFLOW_APPROVAL_GRANTED,
  KIND_WORKFLOW_APPROVAL_DENIED
]

// Relay-signed only: a client submitting one of these is rejected at ingest.
const RELAY_SIGNED_KINDS = [
  KIND_NIP29_GROUP_METADATA,
  KIND_NIP29_GROUP_ADMINS,
  KIND_NIP29_GROUP_MEMBERS,
  KIND_NIP29_GROUP_ROLES,
  KIND_MEMBER_ADDED_NOTIFICATION,
  KIND_MEMBER_REMOVED_NOTIFICATION,
  KIND_NIP43_MEMBERSHIP_LIST,
  KIND_NIP43_MEMBER_ADDED,
  KIND_NIP43_MEMBER_REMOVED,
  KIND_SYSTEM_MESSAGE,
  KIND_THREAD_SUMMARY
]

// Kinds that must carry an h tag naming their channel.
const CHANNEL_REQUIRED_KINDS = [KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_V2]

// ------------------------------------------------------------ range helpers --

function isReplaceable (kind) {
  return kind >= 10000 && kind < 20000
}

function isEphemeral (kind) {
  return kind >= 20000 && kind < 30000
}

function isParameterizedReplaceable (kind) {
  return kind >= 30000 && kind < 40000
}

function isRegular (kind) {
  return kind < 10000 || (kind >= 40000 && kind < 50000)
}

function isAddressable (kind) {
  return isReplaceable(kind) || isParameterizedReplaceable(kind)
}

function isAuthorOnlyKind (kind) {
  return AUTHOR_ONLY_KINDS.includes(kind)
}

function isPGatedKind (kind) {
  return P_GATED_KINDS.includes(kind)
}

function isResultGatedKind (kind) {
  return RESULT_GATED_KINDS.includes(kind)
}

function isSharedGatedKind (kind) {
  return SHARED_GATED_KINDS.includes(kind)
}

function isSearchable (kind) {
  return !UNSEARCHABLE_KINDS.includes(kind) && !isEphemeral(kind)
}

function isRelaySignedKind (kind) {
  return RELAY_SIGNED_KINDS.includes(kind)
}

function requiresChannel (kind) {
  return CHANNEL_REQUIRED_KINDS.includes(kind)
}

/**
 * True when the event carries exactly one `["shared", "true"]` tag.
 *
 * Kind-agnostic and fails closed on any non-exact shape: a three-element
 * `["shared","true","x"]` is NOT shared, and neither is `["shared","yes"]`.
 * Ingest enforces the same shape, so a stored event either has no shared tag or
 * exactly one well-formed one — but this helper does not rely on that.
 */
function eventIsShared (event) {
  let count = 0
  for (const tag of event.tags) {
    if (tag[0] !== 'shared') continue
    if (tag.length !== 2 || tag[1] !== 'true') return false
    count++
  }
  return count === 1
}

/**
 * True when the event must be withheld from this reader under the
 * author-only-unless-shared model. All three conditions must hold: the kind is
 * shared-gated, the reader is not the author, and the event is not shared.
 */
function isUnsharedGatedEvent (event, requesterPubkey) {
  if (!isSharedGatedKind(event.kind)) return false
  if (event.pubkey === requesterPubkey) return false
  return !eventIsShared(event)
}

const constants = {
  KIND_PROFILE,
  KIND_TEXT_NOTE,
  KIND_CONTACT_LIST,
  KIND_DELETION,
  KIND_REACTION,
  KIND_STREAM_MESSAGE,
  KIND_CHANNEL_METADATA,
  KIND_GIFT_WRAP,
  KIND_FILE_METADATA,
  KIND_REPORT,
  KIND_GIT_PATCH,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_PR_UPDATE,
  KIND_GIT_ISSUE,
  KIND_GIT_STATUS_OPEN,
  KIND_GIT_STATUS_MERGED,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
  KIND_NIP43_MEMBER_ADDED,
  KIND_NIP43_MEMBER_REMOVED,
  KIND_IA_ARCHIVED,
  KIND_IA_UNARCHIVED,
  KIND_NIP29_PUT_USER,
  KIND_NIP29_REMOVE_USER,
  KIND_NIP29_EDIT_METADATA,
  KIND_NIP29_DELETE_EVENT,
  KIND_NIP29_CREATE_GROUP,
  KIND_NIP29_DELETE_GROUP,
  KIND_NIP29_CREATE_INVITE,
  KIND_NIP29_JOIN_REQUEST,
  KIND_NIP29_LEAVE_REQUEST,
  KIND_NIP43_ADD_MEMBER,
  KIND_NIP43_REMOVE_MEMBER,
  KIND_NIP43_CHANGE_ROLE,
  KIND_NIP43_SET_WORKSPACE_PROFILE,
  KIND_IA_ARCHIVE_REQUEST,
  KIND_IA_UNARCHIVE_REQUEST,
  KIND_MODERATION_BAN,
  KIND_MODERATION_UNBAN,
  KIND_MODERATION_TIMEOUT,
  KIND_MODERATION_UNTIMEOUT,
  KIND_MODERATION_RESOLVE_REPORT,
  KIND_MUTE_LIST,
  KIND_PIN_LIST,
  KIND_NIP65_RELAY_LIST_METADATA,
  KIND_BOOKMARK_LIST,
  KIND_EMOJI_LIST,
  KIND_AGENT_PROFILE,
  KIND_NIP43_MEMBERSHIP_LIST,
  KIND_IA_ARCHIVED_LIST,
  KIND_PRESENCE_UPDATE,
  KIND_TYPING_INDICATOR,
  KIND_AUTH,
  KIND_PAIRING,
  KIND_AGENT_OBSERVER_FRAME,
  KIND_BLOSSOM_AUTH,
  KIND_NOSTR_IDENTITY_BINDING,
  KIND_HUDDLE_REACTION,
  KIND_HTTP_AUTH,
  KIND_NIP43_LEAVE_REQUEST,
  KIND_FOLLOW_SET,
  KIND_BOOKMARK_SET,
  KIND_LONG_FORM,
  KIND_EMOJI_SET,
  KIND_READ_STATE,
  KIND_AGENT_ENGRAM,
  KIND_PERSONA,
  KIND_TEAM,
  KIND_MANAGED_AGENT,
  KIND_TEAM_CATALOG,
  KIND_PRIVATE_MANAGED_AGENT,
  KIND_EVENT_REMINDER,
  KIND_USER_STATUS,
  KIND_PUSH_LEASE,
  KIND_GIT_REPO_ANNOUNCEMENT,
  KIND_GIT_REPO_STATE,
  KIND_WORKFLOW_DEF,
  KIND_PROJECT,
  KIND_DM_VISIBILITY,
  KIND_NIP29_GROUP_METADATA,
  KIND_NIP29_GROUP_ADMINS,
  KIND_NIP29_GROUP_MEMBERS,
  KIND_NIP29_GROUP_ROLES,
  KIND_THREAD_SUMMARY,
  KIND_WINDOW_BOUNDS,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_STREAM_MESSAGE_PINNED,
  KIND_STREAM_MESSAGE_BOOKMARKED,
  KIND_STREAM_MESSAGE_SCHEDULED,
  KIND_STREAM_REMINDER,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  KIND_CANVAS,
  KIND_CHANNEL_SUMMARY,
  KIND_PRESENCE_SNAPSHOT,
  KIND_DM_CREATED,
  KIND_DM_OPEN,
  KIND_DM_ADD_MEMBER,
  KIND_DM_HIDE,
  KIND_PRODUCT_FEEDBACK,
  KIND_JOB_REQUEST,
  KIND_JOB_ACCEPTED,
  KIND_JOB_PROGRESS,
  KIND_JOB_RESULT,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_MEMBER_ADDED_NOTIFICATION,
  KIND_MEMBER_REMOVED_NOTIFICATION,
  KIND_AGENT_TURN_METRIC,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
  KIND_FORUM_COMMENT,
  KIND_WORKFLOW_TRIGGERED,
  KIND_WORKFLOW_STEP_STARTED,
  KIND_WORKFLOW_STEP_COMPLETED,
  KIND_WORKFLOW_STEP_FAILED,
  KIND_WORKFLOW_COMPLETED,
  KIND_WORKFLOW_FAILED,
  KIND_WORKFLOW_CANCELLED,
  KIND_WORKFLOW_APPROVAL_REQUESTED,
  KIND_WORKFLOW_APPROVAL_GRANTED,
  KIND_WORKFLOW_APPROVAL_DENIED,
  KIND_WORKFLOW_TRIGGER,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_DENY,
  KIND_AUDIT_ENTRY,
  KIND_HUDDLE_STARTED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_GUIDELINES,
  KIND_MEDIA_UPLOAD
}

// Every kind the relay knows about, minus KIND_AUTH which is never stored.
const ALL_KINDS = Object.values(constants)
  .filter((k) => k !== KIND_AUTH)
  .sort((a, b) => a - b)

module.exports = {
  ...constants,
  ALL_KINDS,
  AUTHOR_ONLY_KINDS,
  P_GATED_KINDS,
  RESULT_GATED_KINDS,
  SHARED_GATED_KINDS,
  UNSEARCHABLE_KINDS,
  WORKFLOW_EXECUTION_KINDS,
  RELAY_SIGNED_KINDS,
  CHANNEL_REQUIRED_KINDS,
  isReplaceable,
  isEphemeral,
  isParameterizedReplaceable,
  isRegular,
  isAddressable,
  isAuthorOnlyKind,
  isPGatedKind,
  isResultGatedKind,
  isSharedGatedKind,
  isSearchable,
  isRelaySignedKind,
  requiresChannel,
  eventIsShared,
  isUnsharedGatedEvent
}

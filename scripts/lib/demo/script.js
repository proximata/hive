'use strict'

const core = require('hive-core')
const { events } = require('hive-sdk')
const { run: runCli, RelayClient } = require('hive-cli')
const { Agent, MockProvider, RelayConnection } = require('hive-agent')

// The declarative demo script.
//
// Every scene drives the product the way its user would — the CLI for people,
// the agent harness for agents, a plain relay client for the handful of kinds
// the CLI has no verb for — and then asserts against what the relay actually
// did. `run` narrates and paces; `assert` is what --demo turns into an exit
// code, so it must check relay state, never the narration.

const CHANNELS = { engineering: 'engineering', design: 'design' }

// Ids discovered in one scene and needed by the next. Keyed by world so two
// worlds in the same process can never see each other's channels.
const scratch = new WeakMap()

function memo (world) {
  let entry = scratch.get(world)
  if (entry === undefined) {
    entry = { startedAt: Date.now() }
    scratch.set(world, entry)
  }
  return entry
}

function expect (condition, message) {
  if (!condition) throw new Error(message)
}

/** Poll until the predicate returns something truthy, or give up and return null. */
async function waitUntil (predicate, { timeout = 8000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/** True when this world hosts its own relay, rather than attaching to one. */
function hosted (world) {
  return world.relay !== null && world.relay !== undefined &&
    world.store !== null && world.store !== undefined
}

function warn (world, text) {
  world.state.notices.push({ text, level: 'warn' })
  while (world.state.notices.length > 20) world.state.notices.shift()
  return text
}

/**
 * Record that a scene could not run its real check against an attached relay:
 * a warning in the UI, and a reason the scene can hand back from assert().
 */
function degrade (ctx, what) {
  const text = `${what} needs the hosted relay; attached to ${ctx.world.url}`
  ctx.ui.say(text)
  return { degraded: warn(ctx.world, text) }
}

/**
 * What an assert returns when it could not run its real check here. Asserting
 * on the degrade notice instead would only prove that degrade() had just
 * pushed it, so the runner is told the truth — this scene was not verified —
 * and reports SKIP rather than PASS.
 */
function skip (record) {
  return { skipped: record.degraded }
}

/** The same HTTP client the CLI uses, for kinds the CLI has no verb for. */
function client (world, actor) {
  return new RelayClient({ url: world.url, secretKey: actor.secretKey })
}

function wsUrl (url) {
  return url.replace(/^http/, 'ws')
}

function short (value) {
  return typeof value === 'string' ? value.slice(0, 12) : String(value)
}

/** Run a command that is expected to be refused, and report how it was refused. */
async function refuse (world, actor, argv) {
  const result = await runCli(argv, {
    env: { HIVE_RELAY_URL: world.url, HIVE_PRIVATE_KEY: actor.secretKeyHex }
  })
  let error = null
  try {
    error = JSON.parse(result.stderr)
  } catch {}

  // An access-policy rejection over REST is answered to the caller and nowhere
  // else: no event was created, so nothing reaches 'handler-error' and nothing
  // is audited. The caller is the only witness, which is why the admin pane
  // reads refusals from state.rejections as well as from the event flow.
  if (result.exitCode !== 0) {
    world.state.rejections = (world.state.rejections ?? []).concat({
      actor: actor.name,
      action: argv.slice(0, 2).join(' '),
      reason: error?.message ?? result.stderr.trim()
    }).slice(-20)
  }

  return { exitCode: result.exitCode, error, stdout: result.stdout }
}

/** Idempotent so an admin-only run still has the channels the user scenes made. */
async function ensureChannel (world, actor, name, about) {
  const listed = await world.cli(actor, ['channels', 'list'])
  const existing = listed.find((channel) => channel.name === name)
  if (existing !== undefined) return existing

  return world.cli(actor, [
    'channels', 'create', '--name', name, '--visibility', 'open', '--about', about
  ])
}

async function engineering (world) {
  const m = memo(world)
  if (m.engineering === undefined) {
    m.engineering = await ensureChannel(world, world.actors.admin, CHANNELS.engineering, 'builds, incidents, deploys')
  }
  return m.engineering
}

/** The relay's own audit row for an event, or null when there is no local store. */
function auditRowFor (world, eventId) {
  if (!hosted(world)) return null
  const row = world.store.db
    .prepare('SELECT * FROM audit_log WHERE event_id = ? ORDER BY seq DESC LIMIT 1')
    .get(eventId)
  return row === undefined ? null : row
}

/** SQLite insertion order — the storage engine's own record of what arrived first. */
function storageOrder (world, ids) {
  return ids.map((id) => {
    const row = world.store.db.prepare('SELECT rowid AS seq FROM events WHERE id = ?').get(id)
    return row === undefined ? -1 : row.seq
  })
}

function increasing (values) {
  return values.every((value, index) => index === 0 || value > values[index - 1])
}

function monotonic (values) {
  return increasing(values) || increasing([...values].reverse())
}

/** Where each id landed in the live projection the panes render from. */
function positionsIn (list, ids) {
  return ids.map((id) => list.findIndex((entry) => entry.id === id))
}

const scenes = [
  // ------------------------------------------------------------------ user --

  {
    id: 'connect',
    mode: 'user',
    title: 'Connect',
    caption: 'NIP-42: the relay challenges, the client signs, nothing else is trusted',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const { alice } = world.actors

      ui.focus('relay')
      ui.say(`alice dials ${world.url}`)
      await ui.pause(500)

      // connect() is the whole handshake: the relay's challenge arrives on
      // accept, the client signs a kind 22242 over it, and the OK comes back.
      const connection = new RelayConnection({
        url: wsUrl(world.url),
        secretKey: alice.secretKey,
        reconnect: false
      })
      await connection.connect()
      m.connection = connection

      ui.say(`challenge signed as ${short(alice.npub)} - AUTH accepted`)
      await ui.pause(700)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)
      const { alice } = world.actors

      expect(m.connection.authenticated === true, 'the client never saw an accepted AUTH')

      if (hosted(world)) {
        const live = [...world.relay.connections.values()]
        expect(
          live.some((c) => c.authState === 'authenticated' && c.pubkey === alice.pubkey),
          'the relay has no authenticated connection for alice'
        )
      }
    }
  },

  {
    id: 'channels',
    mode: 'user',
    title: 'Channels',
    caption: 'two channels, created over the CLI — kind 9007, then discovery',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)

      ui.focus('channels')
      ui.say('hive channels create --name engineering --visibility open')
      m.engineering = await ensureChannel(world, world.actors.admin, CHANNELS.engineering, 'builds, incidents, deploys')
      await ui.pause(500)

      ui.say('hive channels create --name design --visibility open')
      m.design = await ensureChannel(world, world.actors.admin, CHANNELS.design, 'mocks and reviews')
      ui.select('channel', m.engineering.id)
      await ui.pause(600)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)

      const listed = await world.cli(world.actors.admin, ['channels', 'list'])
      const names = listed.map((channel) => channel.name)
      for (const name of [CHANNELS.engineering, CHANNELS.design]) {
        expect(names.includes(name), `#${name} is not in the relay's channel list`)
      }
      expect(m.engineering.id !== m.design.id, 'both creates returned the same channel')

      const projected = await waitUntil(() =>
        world.state.channels.filter((c) => names.includes(c.name)).length >= 2)
      expect(projected !== null, 'the channels never reached world.state')
    }
  },

  {
    id: 'join',
    mode: 'user',
    title: 'Join',
    caption: 'a join request is a signed event, and the roster is what the relay says it is',

    async run (ctx) {
      const { world, ui } = ctx
      const channel = await engineering(world)

      ui.focus('members')
      ui.select('channel', channel.id)

      ui.say(`alice: hive channels join --channel ${short(channel.id)}`)
      await world.cli(world.actors.alice, ['channels', 'join', '--channel', channel.id])
      await ui.pause(450)

      ui.say(`bob:   hive channels join --channel ${short(channel.id)}`)
      await world.cli(world.actors.bob, ['channels', 'join', '--channel', channel.id])
      await ui.pause(600)
    },

    async assert (ctx) {
      const { world } = ctx
      const channel = await engineering(world)
      const { alice, bob } = world.actors

      const members = await world.cli(world.actors.admin, ['channels', 'members', '--channel', channel.id])
      const roster = members.map((member) => member.pubkey)
      expect(roster.includes(alice.pubkey), 'alice is not a member after joining')
      expect(roster.includes(bob.pubkey), 'bob is not a member after joining')

      const projected = await waitUntil(() => {
        const live = (world.state.members[channel.id] ?? []).map((member) => member.pubkey)
        return live.includes(alice.pubkey) && live.includes(bob.pubkey)
      })
      expect(projected !== null, 'the roster never reached world.state')
    }
  },

  {
    id: 'converse',
    mode: 'user',
    title: 'Converse',
    caption: 'two people and one agent in the same channel, on the same protocol',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const channel = await engineering(world)
      const { alice, bob, honey } = world.actors

      ui.focus('messages')
      ui.select('channel', channel.id)

      // The agent joins as a member first: it discovers its channels from the
      // membership notifications the relay publishes, not from a config file.
      await world.cli(world.actors.admin, [
        'channels', 'add-member', '--channel', channel.id, '--pubkey', honey.pubkey, '--role', 'bot'
      ])
      if (world.agent === null) await world.startAgent()
      await ui.pause(400)

      const said = []
      ui.say('alice: relay build 42 is green on the swarm transport')
      said.push(await world.cli(alice, [
        'messages', 'send', '--channel', channel.id,
        '--content', 'relay build 42 is green on the swarm transport'
      ]))
      await ui.pause(500)

      ui.say('bob: nice - I will take the flaky reconnect test')
      said.push(await world.cli(bob, [
        'messages', 'send', '--channel', channel.id,
        '--content', 'nice, I will take the flaky reconnect test'
      ]))
      await ui.pause(500)

      // Published through the agent's own connection, so this is the harness
      // speaking rather than the CLI wearing the agent's key.
      ui.say('honey: mention me and I answer in this channel')
      const hello = events.message(honey.secretKey, {
        channel: channel.id,
        content: 'honey here - mention me and I answer in this channel'
      })
      if (world.agent !== null) await world.agent.connection.publish(hello)
      else await client(world, honey).publish(hello)
      said.push(hello)

      m.said = said.map((event) => event.id)
      await ui.pause(700)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)
      const channel = await engineering(world)

      const stored = await world.cli(world.actors.alice, ['messages', 'get', '--channel', channel.id])
      const ids = stored.map((event) => event.id)
      for (const id of m.said) expect(ids.includes(id), `message ${short(id)} is not in the channel`)

      // The rest of this assert is about arrival order, and only a hosted world
      // has it: attached, the projection is a REST poll ordered by created_at,
      // so three messages inside the same second come back in whatever order
      // the query felt like.
      if (!hosted(world)) return skip(degrade(ctx, 'checking the projection against the arrival order'))

      expect(increasing(storageOrder(world, m.said)), 'the relay stored the three messages out of order')

      const projected = await waitUntil(() => {
        const positions = positionsIn(world.state.messages[channel.id] ?? [], m.said)
        return positions.every((index) => index >= 0) && monotonic(positions)
      })
      expect(projected !== null, 'the projection lost or reordered the three messages')
    }
  },

  {
    id: 'search',
    mode: 'user',
    title: 'Search',
    caption: 'NIP-50 over an inverted index: whole tokens only, so "deployment" is not "deploy"',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const channel = await engineering(world)
      const { alice, bob } = world.actors

      ui.focus('messages')
      ui.say('seeding two messages that say "deploy", and one that only says "deployment"')

      const hit1 = await world.cli(alice, [
        'messages', 'send', '--channel', channel.id, '--content', 'who owns the deploy key for staging?'
      ])
      const hit2 = await world.cli(bob, [
        'messages', 'send', '--channel', channel.id, '--content', 'I will deploy build 42 after lunch'
      ])
      const miss = await world.cli(alice, [
        'messages', 'send', '--channel', channel.id, '--content', 'deployment runbook lives in the canvas'
      ])

      m.search = { expected: [hit1.id, hit2.id].sort(), miss: miss.id }
      await ui.pause(600)

      ui.say('hive messages search --query deploy')
      m.search.hits = await world.cli(alice, [
        'messages', 'search', '--query', 'deploy', '--channel', channel.id
      ])
      await ui.pause(700)
    },

    async assert (ctx) {
      const m = memo(ctx.world)
      const found = m.search.hits.map((event) => event.id).sort()

      expect(
        found.length === m.search.expected.length && found.every((id, i) => id === m.search.expected[i]),
        `search returned ${found.length} hit(s), expected exactly the two seeded matches`
      )
      expect(!found.includes(m.search.miss), '"deployment" matched a search for "deploy"')
    }
  },

  {
    id: 'react',
    mode: 'user',
    title: 'React',
    caption: 'a reaction is a kind 7 event whose channel comes from its target, never from the client',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const target = m.said[1]

      ui.focus('messages')
      ui.select('message', target)
      ui.say(`hive reactions add --event ${short(target)} --emoji :tada:`)

      m.reaction = await world.cli(world.actors.alice, [
        'reactions', 'add', '--event', target, '--emoji', ':tada:'
      ])
      await ui.pause(700)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)
      const channel = await engineering(world)
      const target = m.said[1]

      const reactions = await world.cli(world.actors.bob, ['reactions', 'get', '--event', target])
      const mine = reactions.filter((event) => event.id === m.reaction.id)
      expect(mine.length === 1, 'the reaction was not stored against its target')
      expect(mine[0].kind === core.KIND_REACTION, `stored as kind ${mine[0].kind}, expected 7`)
      expect(mine[0].content === ':tada:', 'the stored reaction lost its emoji')

      // Reaction counts are projected from the relay's event stream, which only
      // a hosted world taps; the attached poll has no verb that returns them.
      if (!hosted(world)) return skip(degrade(ctx, 'counting the reaction onto the projected message'))

      const counted = await waitUntil(() => {
        const message = (world.state.messages[channel.id] ?? []).find((entry) => entry.id === target)
        return message !== undefined && (message.reactions?.[':tada:'] ?? 0) >= 1
      })
      expect(counted !== null, 'the reaction was never counted onto the message')
    }
  },

  {
    id: 'dm',
    mode: 'user',
    title: 'Direct message',
    caption: 'NIP-17: the relay routes the wrap by its p tag and never sees inside it',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const { alice, bob, carol } = world.actors

      ui.focus('dms')
      ui.say(`hive dms open --pubkey ${short(bob.pubkey)}`)
      m.dm = await world.cli(alice, ['dms', 'open', '--pubkey', bob.pubkey])
      await ui.pause(500)

      // Sealing is the client's job (NIP-44) and deliberately not the relay's,
      // so the demo publishes an opaque blob rather than pretending to encrypt.
      const payload = core.toHex(core.sha256(Buffer.from(`seal:${alice.pubkey}:${bob.pubkey}:lunch?`)))
      const wrap = events.giftWrap(alice.secretKey, { to: bob.pubkey, payload })

      ui.say('publishing a kind 1059 gift wrap addressed to bob')
      await client(world, alice).publish(wrap)
      m.wrap = wrap
      m.wrapPayload = payload

      ui.say(`carol is not in the p tag: the same lookup returns nothing for ${short(carol.npub)}`)
      await ui.pause(700)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)
      const { bob, carol } = world.actors

      expect(m.dm !== null && m.dm.type === 'dm', 'dms open did not return a dm channel')

      const forBob = await client(world, bob).query({ ids: [m.wrap.id] })
      expect(forBob.length === 1, 'the addressee cannot read the wrap')
      expect(forBob[0].kind === core.KIND_GIFT_WRAP, `stored as kind ${forBob[0].kind}, expected 1059`)
      expect(forBob[0].content === m.wrapPayload, 'the relay altered the wrapped payload')

      const forCarol = await client(world, carol).query({ ids: [m.wrap.id] })
      expect(forCarol.length === 0, 'a gift wrap leaked to someone outside its p tag')
    }
  },

  {
    id: 'mention',
    mode: 'user',
    title: 'Mention',
    caption: 'the agent answers mentions only — everything else in the channel is context',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const channel = await engineering(world)
      const { alice, honey } = world.actors

      ui.focus('messages')
      if (world.agent === null) await world.startAgent()

      ui.say('alice: @honey what changed in build 42?')
      m.mention = await world.cli(alice, [
        'messages', 'send', '--channel', channel.id,
        '--content', 'honey, what changed in build 42?', '--mention', honey.pubkey
      ])

      ui.say('the agent takes its turn on the mock provider...')
      m.reply = await waitUntil(async () => {
        const thread = await world.cli(alice, ['messages', 'thread', '--event', m.mention.id])
        return thread.replies.find((event) => event.pubkey === honey.pubkey) ?? false
      }, { timeout: 15000, interval: 100 })

      if (m.reply !== null) ui.say(`honey: ${m.reply.content.split('\n')[0].slice(0, 60)}`)
      await ui.pause(700)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)
      const { honey } = world.actors

      expect(m.reply !== null, 'the agent never replied to the mention')
      expect(m.reply.pubkey === honey.pubkey, 'the reply is not from the agent')
      expect(core.verifyEvent(m.reply).ok === true, 'the agent reply does not verify')
      expect(
        core.referencedEvents(m.reply).includes(m.mention.id),
        'the reply does not reference the mention it answers'
      )
    }
  },

  // ----------------------------------------------------------------- admin --

  {
    id: 'dashboard',
    mode: 'admin',
    title: 'Dashboard',
    caption: 'everything the operator sees comes from /api/relay and the live event stream',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)

      ui.focus('relay')

      // The dashboard is only honest if something is actually connected. An
      // admin-only run never opened a session, and a session opened eight
      // scenes ago has spent most of them idle, which no websocket survives —
      // so the state of the socket decides, not whether the object exists.
      if (m.connection === undefined || m.connection === null || m.connection.authenticated !== true) {
        if (m.connection !== undefined && m.connection !== null) await m.connection.close()
        m.connection = new RelayConnection({
          url: wsUrl(world.url),
          secretKey: world.actors.admin.secretKey,
          reconnect: false
        })
        await m.connection.connect()
      }

      ui.say('hive relay info')
      m.info = await world.cli(world.actors.admin, ['relay', 'info'])
      await ui.pause(400)

      const series = []
      for (let i = 0; i < 5; i++) {
        world.metrics.sample()
        series.push(world.metrics.eventsPerSecond())
        ui.say(`connections ${world.metrics.connections()}  subs ${world.metrics.subscriptions()}  ev/s ${series[i]}`)
        await ui.pause(200)
      }
      m.series = series
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)

      expect(m.info.connections >= 1, `/api/relay reports ${m.info.connections} connections, expected at least 1`)
      expect(m.info.supported_nips.includes(42), 'the relay does not advertise NIP-42')
      expect(m.series.length > 0, 'the ev/s series is empty')
      expect(
        m.series.every((value) => Number.isFinite(value) && value >= 0),
        `the ev/s series is not a series of numbers: ${m.series.join(', ')}`
      )
      expect(world.metrics.connections() >= 1, 'the metrics collector sees no connections')
    }
  },

  {
    id: 'admin-channels',
    mode: 'admin',
    title: 'Channel admin',
    caption: 'archive a channel, and delete someone else\'s message as an admin (kind 9005)',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const { admin } = world.actors

      ui.focus('channels')

      if (m.design === undefined) {
        m.design = await ensureChannel(world, admin, CHANNELS.design, 'mocks and reviews')
      }
      ui.say(`hive channels archive --channel ${short(m.design.id)}`)
      await world.cli(admin, ['channels', 'archive', '--channel', m.design.id])
      await ui.pause(500)

      const channel = await engineering(world)
      if (m.search === undefined) {
        const seed = await world.cli(world.actors.alice, [
          'messages', 'send', '--channel', channel.id, '--content', 'deployment runbook lives in the canvas'
        ])
        m.search = { miss: seed.id }
      }

      ui.select('channel', channel.id)
      ui.say(`admin deletes ${short(m.search.miss)} - kind 9005, not the author's own kind 5`)
      m.adminDelete = events.adminDelete(admin.secretKey, {
        channel: channel.id,
        eventId: m.search.miss,
        reason: 'superseded by the canvas'
      })
      await client(world, admin).publish(m.adminDelete)
      await ui.pause(700)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)
      const channel = await engineering(world)
      const { admin } = world.actors

      const open = (await world.cli(admin, ['channels', 'list'])).map((c) => c.id)
      expect(!open.includes(m.design.id), 'the archived channel is still in the default listing')

      const all = (await world.cli(admin, ['channels', 'list', '--archived'])).map((c) => c.id)
      expect(all.includes(m.design.id), 'the archived channel vanished instead of being archived')

      const messages = await world.cli(admin, ['messages', 'get', '--channel', channel.id])
      expect(
        !messages.some((event) => event.id === m.search.miss),
        'the admin-deleted message is still readable in the channel'
      )

      const row = auditRowFor(world, m.search.miss)
      if (row !== null) expect(row.action === 'EventDeleted', `the audit log recorded ${row.action}`)
    }
  },

  {
    id: 'access',
    mode: 'admin',
    title: 'Access policy',
    caption: 'requireRelayMembership on: the gate is AccessPolicy.check, consulted on every request',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const channel = await engineering(world)
      const { admin, alice, bob, carol, honey } = world.actors

      ui.focus('members')

      if (!hosted(world)) {
        m.access = degrade(ctx, 'toggling the relay access policy')
        return
      }

      ui.say('policy off: carol is a stranger and can still post to an open channel')
      await world.cli(carol, [
        'messages', 'send', '--channel', channel.id, '--content', 'carol here, just passing through'
      ])
      await ui.pause(600)

      // Everyone who must keep working is enrolled BEFORE the switch: the
      // policy is relay-wide, so flipping it first would lock out the demo.
      for (const actor of [admin, alice, bob, honey, carol]) {
        world.store.addRelayMember(actor.pubkey, actor === admin ? 'admin' : 'member')
      }
      world.relay.policy.requireRelayMembership = true

      ui.say('requireRelayMembership = true, and carol is on the roster')
      const accepted = await world.cli(carol, [
        'messages', 'send', '--channel', channel.id, '--content', 'still in, still allowed'
      ]).then(() => true, () => false)
      await ui.pause(600)

      ui.say(`removeRelayMember(${short(carol.npub)})`)
      world.store.removeRelayMember(carol.pubkey)
      await ui.pause(400)

      ui.say('her very next publish never reaches the pipeline')
      const rejected = await refuse(world, carol, [
        'messages', 'send', '--channel', channel.id, '--content', 'let me back in'
      ])
      ui.say(`exit ${rejected.exitCode}: ${rejected.error?.message ?? 'no error body'}`)

      m.access = { accepted, rejected }
      await ui.pause(800)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)
      const channel = await engineering(world)
      const { carol } = world.actors

      if (m.access.degraded !== undefined) return skip(m.access)

      expect(m.access.accepted === true, 'carol could not publish while she was a relay member')
      expect(m.access.rejected.exitCode === 3, `the removed member exited ${m.access.rejected.exitCode}, expected 3 (auth)`)
      expect(
        /auth-required/.test(m.access.rejected.error?.message ?? ''),
        `the rejection said "${m.access.rejected.error?.message}", expected auth-required`
      )
      expect(m.access.rejected.stdout === '', 'a rejected publish still printed a result')

      // Re-check live rather than trusting what run() recorded.
      expect(world.relay.policy.requireRelayMembership === true, 'the policy switched itself back off')
      expect(world.store.getRelayMember(carol.pubkey) === null, 'carol is still on the relay roster')

      const again = await refuse(world, carol, [
        'messages', 'send', '--channel', channel.id, '--content', 'one more try'
      ])
      expect(again.exitCode === 3, `a repeat attempt exited ${again.exitCode}, expected 3`)
    }
  },

  {
    id: 'moderation',
    mode: 'admin',
    title: 'Moderation',
    caption: 'recorded - enforcement deferred (see README status matrix)',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const channel = await engineering(world)
      const { admin, carol } = world.actors

      ui.focus('flow')
      ui.say('signing a kind 9040 ban against carol')

      // There is no ban builder in the SDK on purpose: the kind is recorded but
      // nothing enforces it yet, so the event is built here rather than being
      // given a first-class API that would imply more than the relay does.
      m.ban = core.finalizeEvent({
        kind: core.KIND_MODERATION_BAN,
        tags: [['h', channel.id], ['p', carol.pubkey]],
        content: 'repeated off-topic posting'
      }, admin.secretKey)

      await client(world, admin).publish(m.ban)
      await ui.pause(500)

      ui.say('stored, signed and chained into the audit log')
      ui.say('recorded - enforcement deferred (see README status matrix)')
      await ui.pause(900)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)
      const { admin } = world.actors

      const stored = await client(world, admin).query({ ids: [m.ban.id] })
      expect(stored.length === 1, 'the ban event was not stored')
      expect(stored[0].kind === core.KIND_MODERATION_BAN, `stored as kind ${stored[0].kind}, expected 9040`)
      expect(core.verifyEvent(stored[0]).ok === true, 'the stored ban does not verify')

      if (!hosted(world)) return skip(degrade(ctx, 'reading the audit row for the ban'))

      const row = auditRowFor(world, m.ban.id)
      expect(row !== null, 'the ban is not in the audit log')
      expect(row.action === 'EventCreated', `the audit log recorded ${row.action}`)
      expect(row.kind === core.KIND_MODERATION_BAN, 'the audit row has the wrong kind')
    }
  },

  {
    id: 'audit',
    mode: 'admin',
    title: 'Audit chain',
    caption: 'every entry hashes its predecessor, so one edited row breaks the whole chain',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const { admin } = world.actors

      ui.focus('audit')
      ui.say('hive audit verify')
      const green = await world.cli(admin, ['audit', 'verify'])
      ui.say(`ok=${green.ok} over ${green.entries} entries`)
      await ui.pause(600)

      if (!hosted(world)) {
        m.audit = { green, ...degrade(ctx, 'tampering with a stored audit row') }
        return
      }

      // The second row, so the break is inside the chain rather than at its
      // head. A store with fewer than two entries has nothing to tamper with.
      const victim = world.store.db
        .prepare('SELECT seq, actor FROM audit_log ORDER BY seq ASC LIMIT 1 OFFSET 1')
        .get()
      expect(victim !== undefined, 'the audit chain is too short to tamper with')

      let broken = null
      try {
        ui.say(`UPDATE audit_log SET actor = 'tampered' WHERE seq = ${victim.seq}`)
        world.store.db.prepare("UPDATE audit_log SET actor = 'tampered' WHERE seq = ?").run(victim.seq)
        broken = await world.cli(admin, ['audit', 'verify'])
        ui.say(`ok=${broken.ok}, detected at entry ${broken.brokenAt}`)
        await ui.pause(800)
      } finally {
        // Put the row back whatever happened in between: later scenes append to
        // this chain, and a demo that leaves its own audit log broken spends
        // every later frame reporting a break it caused itself.
        world.store.db.prepare('UPDATE audit_log SET actor = ? WHERE seq = ?').run(victim.actor, victim.seq)
      }

      const restored = await world.cli(admin, ['audit', 'verify'])
      ui.say(`row restored, ok=${restored.ok}`)

      m.audit = { green, broken, restored, victim }
      await ui.pause(600)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)

      expect(m.audit.green.ok === true, 'the chain did not verify before tampering')
      expect(m.audit.green.entries > 0, 'the audit chain is empty')

      if (m.audit.degraded !== undefined) return skip(m.audit)

      expect(m.audit.broken.ok === false, 'an edited row did not break the chain')
      expect(m.audit.broken.brokenAt === m.audit.victim.seq,
        `detected at ${m.audit.broken.brokenAt}, tampered at ${m.audit.victim.seq}`)
      expect(m.audit.restored.ok === true, 'the chain stayed broken after the row was restored')
    }
  },

  {
    id: 'workflows',
    mode: 'admin',
    title: 'Workflows',
    caption: 'an approval gate suspends the run; the grant resumes it from the step after',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const channel = await engineering(world)
      const { admin } = world.actors

      ui.focus('workflows')

      const definition = [
        'name: Guarded Release',
        'trigger:',
        '  on: message_posted',
        '  filter: "str_contains(trigger_text, \'ship the release\')"',
        'steps:',
        '  - id: gate',
        '    action: request_approval',
        '    from: "{{author}}"',
        '    message: "Ship release 42 to production?"',
        '  - id: announce',
        '    action: send_message',
        '    text: "release 42 shipped, approved by {{author}}"'
      ].join('\n')

      ui.say('hive workflows create --id release-gate')
      await world.cli(admin, [
        'workflows', 'create', '--id', 'release-gate', '--channel', channel.id, '--definition', definition
      ])
      await ui.pause(500)

      ui.say('hive workflows trigger --workflow release-gate')
      await world.cli(admin, ['workflows', 'trigger', '--workflow', 'release-gate', '--channel', channel.id])

      m.run = await waitUntil(async () => {
        const runs = await world.cli(admin, ['workflows', 'runs', '--workflow', 'release-gate'])
        return runs.find((entry) => entry.status === 'waiting_approval') ?? false
      })
      expect(m.run !== null, 'the run never reached waiting_approval')

      ui.select('run', m.run.id)
      ui.say(`run ${short(m.run.id)} is waiting_approval - the token is stored hashed`)
      await ui.pause(700)

      // The token travels in the kind 46010 request event, which is exactly how
      // a real approver's client would find it.
      const requests = await client(world, admin).query({
        kinds: [core.KIND_WORKFLOW_APPROVAL_REQUESTED], '#h': [channel.id], limit: 20
      })
      const request = requests.find((event) => core.tagValue(event, 'd') === m.run.id)
      expect(request !== undefined, 'no approval request event was published for the run')

      ui.say('hive workflows approve --token ' + short(request.content))
      await world.cli(admin, ['workflows', 'approve', '--token', request.content])

      m.completed = await waitUntil(async () => {
        const runs = await world.cli(admin, ['workflows', 'runs', '--workflow', 'release-gate'])
        const entry = runs.find((run) => run.id === m.run.id)
        return entry !== undefined && entry.status === 'completed' ? entry : false
      })
      m.approvalRequest = request
      await ui.pause(700)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)
      const channel = await engineering(world)
      const { admin } = world.actors

      expect(m.run.status === 'waiting_approval', `the gated run was ${m.run.status} before approval`)
      expect(m.completed !== null, 'the run never completed after the approval')
      expect(m.completed.status === 'completed', `the run ended as ${m.completed.status}`)

      // The gated step must have run only after the grant.
      const messages = await world.cli(admin, ['messages', 'get', '--channel', channel.id, '--limit', '100'])
      const announced = messages.filter((event) => event.content.startsWith('release 42 shipped'))
      expect(announced.length === 1, `the gated step produced ${announced.length} announcements, expected 1`)

      if (hosted(world)) {
        const stored = world.store.db.prepare('SELECT token_hash FROM workflow_approvals WHERE run_id = ?').get(m.run.id)
        expect(stored !== undefined, 'no approval row was written for the run')
        expect(stored.token_hash !== m.approvalRequest.content, 'the approval token was stored in the clear')
      }
    }
  },

  {
    id: 'personas',
    mode: 'admin',
    title: 'Personas',
    caption: 'a persona is data (kind 30175); an agent instantiated from it announces itself (kind 10100)',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const { admin } = world.actors

      ui.focus('personas')

      const persona = events.persona(admin.secretKey, {
        slug: 'scribe',
        displayName: 'Scribe',
        systemPrompt: 'You keep the incident timeline.',
        runtime: 'mock',
        model: 'mock-1',
        shared: true
      })
      ui.say('publishing kind 30175 persona "scribe"')
      await client(world, admin).publish(persona)
      ui.select('persona', 'scribe')
      await ui.pause(600)

      // Instantiated from what the relay stored, not from the local object —
      // otherwise this proves nothing about the persona having been published.
      const [fetched] = await client(world, admin).query({
        kinds: [core.KIND_PERSONA], '#d': ['scribe'], limit: 1
      })
      expect(fetched !== undefined, 'the persona was not readable back from the relay')

      const content = JSON.parse(fetched.content)
      const secretKey = core.generateSecretKey()
      const pubkey = core.getPublicKey(secretKey)

      // The access policy from the previous scene is still live, so a new agent
      // has to be enrolled before it can authenticate at all.
      if (hosted(world) && world.relay.policy.requireRelayMembership) {
        world.store.addRelayMember(pubkey, 'bot')
        ui.say('the access policy is still on, so the new agent is enrolled first')
      }

      ui.say(`starting an agent as ${short(pubkey)} from the stored persona`)
      const connection = new RelayConnection({ url: wsUrl(world.url), secretKey, reconnect: false })
      await connection.connect()

      const agent = new Agent({
        secretKey,
        owner: admin.pubkey,
        persona: { slug: core.tagValue(fetched, 'd'), ...content },
        provider: new MockProvider({ systemPrompt: content.system_prompt }),
        connection
      })
      await agent.start()
      await ui.pause(400)

      // Stopped here: the point is the profile it published, not a long-lived
      // process the rest of the demo has to carry. stop() closes the socket.
      await agent.stop()

      m.persona = { event: persona, agent: pubkey }
      await ui.pause(600)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)
      const { admin } = world.actors

      const [persona] = await client(world, admin).query({
        kinds: [core.KIND_PERSONA], '#d': ['scribe'], limit: 1
      })
      expect(persona !== undefined, 'the persona is not stored')
      expect(persona.id === m.persona.event.id, 'a different persona event is stored under that slug')

      const profiles = await client(world, admin).query({
        kinds: [core.KIND_AGENT_PROFILE], authors: [m.persona.agent], limit: 5
      })
      expect(profiles.length === 1, `the instantiated agent published ${profiles.length} kind 10100 profiles`)

      const profile = JSON.parse(profiles[0].content)
      expect(profile.persona === 'scribe', `the profile names persona "${profile.persona}", expected scribe`)
      expect(profile.owner === admin.pubkey, 'the agent profile does not name its owner')
      expect(profile.capabilities.length > 0, 'the agent announced no capabilities')
    }
  },

  {
    id: 'health',
    mode: 'admin',
    title: 'Health',
    caption: 'what the relay is made of: events by kind, media, the swarm key, uptime',

    async run (ctx) {
      const { world, ui } = ctx
      const m = memo(world)
      const { admin } = world.actors

      ui.focus('relay')
      const info = await world.cli(admin, ['relay', 'info'])

      const health = {
        swarm: info.swarm ?? world.swarmKey ?? null,
        connections: info.connections,
        subscriptions: info.subscriptions,
        uptimeMs: Date.now() - m.startedAt,
        kinds: [],
        events: 0,
        payloadBytes: 0,
        media: { count: 0, bytes: 0 }
      }

      if (hosted(world)) {
        health.kinds = world.store.db
          .prepare('SELECT kind, COUNT(*) AS n FROM events WHERE deleted_at IS NULL GROUP BY kind ORDER BY n DESC')
          .all()
        health.events = health.kinds.reduce((total, row) => total + row.n, 0)
        health.payloadBytes = world.store.db
          .prepare('SELECT COALESCE(SUM(LENGTH(content) + LENGTH(tags)), 0) AS bytes FROM events')
          .get().bytes
        health.media = world.store.db
          .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM media')
          .get()
      } else {
        degrade(ctx, 'counting events by kind')
      }

      for (const row of health.kinds.slice(0, 6)) {
        ui.say(`kind ${row.kind}: ${row.n}`)
        await ui.pause(120)
      }
      ui.say(`${health.events} events, ${health.payloadBytes} bytes of payload, ${health.media.count} blob(s)`)
      await ui.pause(300)

      if (health.swarm === null) {
        warn(world, 'no swarm key: this relay is not reachable over the DHT')
        ui.say('no swarm key - this relay is not reachable over the DHT')
      } else {
        ui.say(`hyper://${health.swarm}`)
      }
      ui.say(`up ${Math.round(health.uptimeMs / 1000)}s, ${health.connections} connection(s)`)

      // The session opened in the first scene is the last thing to go.
      if (m.connection !== undefined && m.connection !== null) {
        await m.connection.close()
        m.connection = null
      }

      m.health = health
      await ui.pause(800)
    },

    async assert (ctx) {
      const { world } = ctx
      const m = memo(world)

      expect(Number.isInteger(m.health.connections), '/api/relay did not report a connection count')
      expect(m.health.uptimeMs > 0, 'the world reports no uptime')

      if (m.health.swarm === null) {
        expect(
          world.state.notices.some((n) => n.level === 'warn' && /swarm/.test(n.text)),
          'the swarm key is missing and nothing warned about it'
        )
      } else {
        expect(/^[0-9a-f]{64}$/.test(m.health.swarm), `"${m.health.swarm}" is not a swarm key`)
      }

      if (hosted(world)) {
        expect(m.health.events > 0, 'the store holds no events')
        expect(m.health.kinds.length >= 5, `only ${m.health.kinds.length} distinct kinds were stored`)
        expect(m.health.payloadBytes > 0, 'the store reports an empty payload')
      }
    }
  }
]

module.exports = { scenes }

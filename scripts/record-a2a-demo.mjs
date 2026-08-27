#!/usr/bin/env node
//
// Record docs/demo-a2a.gif + docs/demo-a2a.mp4: two humans talking THROUGH
// their own agents, filmed in the real web client against a real relay.
//
//   node scripts/record-a2a-demo.mjs
//
//   alice ──ask──▶ honey ──▶ scout ──deliver──▶ bob
//   alice ◀─────── honey ◀── scout ◀──answer── bob
//
// This is the SCENE. The camera is scripts/lib/record/engine.mjs, shared with
// scripts/record-web-demo.mjs — which films the opposite claim (one workspace
// at 40 ev/s) and is therefore a separate script rather than a flag on this
// one. Everything the two still agree about lives in the engine.
//
// WHAT IS REAL, WHICH IS ALL OF IT BAR THE CAPTION
//
// A relay is started on a scratch storage dir. scripts/demo-web-seed.js `a2a`
// furnishes the room over the wire — three humans, three agents, one each, and
// a backdated transcript, all before the camera opens. Headless Chrome loads
// the page that relay serves. Then scripts/demo-delegation.js runs REAL Agent
// harnesses on real sockets: honey classifies alice's request, writes a
// kind-30174 engram, and addresses its reply at scout — a third party, not at
// whoever spoke to it — and scout does the same on the way to bob. Every row in
// the transcript and every line in the EVENT FLOW pane is a signed Nostr event
// the relay accepted. Nothing is injected into the DOM, no row is drawn, and
// no timing is simulated.
//
// The ONE thing this script adds to the page is a two-line caption band under
// the banner: a title for the beat and a chain diagram of who is holding the
// message. It is a subtitle over a real recording, not a re-enactment, and it
// is driven BY the page — each beat fires when its message actually appears in
// the transcript, so a caption cannot claim something the UI has not shown.
//
// The flow is paced by `chunk=`, which sets the provider's inter-chunk delay.
// That changes the CLOCK only: the content of every event is byte-identical to
// the unpaced run that `npm run demo:delegation` asserts 26/26 against.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertPortFree, background, createLog, killAll, launchChrome, prepareFrames,
  renderGif, renderMp4, run, runToEnd, sleep, startCapture, waitForHttp,
  waitForLine, writeConcatList
} from './lib/record/engine.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_GIF = path.join(REPO, 'docs', 'demo-a2a.gif')
const OUT_MP4 = path.join(REPO, 'docs', 'demo-a2a.mp4')

// A different port and a different CDP port from record-web-demo.mjs on
// purpose: the two takes are sometimes rendered back to back and a leftover
// relay from the other one must not be filmable by this one.
const RELAY_PORT = 8932
const CDP_PORT = 9334
const WIDTH = 1280
const HEIGHT = 720
const FPS = 12

// Pacing. The chain is six messages and each one has to be READ, so the
// provider streams its reply slowly enough that a turn takes visible seconds:
// ~13 chunks x CHUNK ms is roughly how long each agent appears to think, which
// is also how long its 43002/43003/30174 events sit legibly in the flow pane
// before the reply lands. PACE is the gap between the delivery to bob and bob
// answering — a human reading and replying.
const CHUNK = 260
const PACE = 3400
// Long enough to cover the last beat and the outro. The agents stay connected
// and the status bar keeps counting them, because "an agent is sitting in this
// room" is a claim the closing frame should still be making.
const HOLD = 10000

const WORK = path.join(os.tmpdir(), 'hive-a2a-demo')
const FRAMES = path.join(WORK, 'frames')
const STORAGE = path.join(WORK, 'storage')
const PROFILE = path.join(WORK, 'chrome-profile')

const log = createLog('record')

// ------------------------------------------------------------- captions --

// The caption band, installed once into the served page.
//
// Colours come from tokens.css — var(--agent) is the same violet the client
// already paints an agent's name in, var(--accent) the same aqua it uses for
// the selected channel — so the chain and the UI under it agree about what an
// agent looks like without this file declaring a single hex.
const INSTALL_CAPTION = `(() => {
  const NODES = [
    { name: 'alice', role: 'human', owner: null },
    { name: 'honey', role: 'agent', owner: 'alice' },
    { name: 'scout', role: 'agent', owner: 'bob' },
    { name: 'bob', role: 'human', owner: null }
  ]

  const css = document.createElement('style')
  css.textContent = [
    '#demo-caption{flex:none;padding:0.3rem 1ch 0.4rem;border-block-end:1px solid var(--muted)}',
    '#demo-caption p{margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#demo-title{font-weight:700;color:var(--accent)}',
    '#demo-chain{color:var(--muted)}',
    '#demo-chain .node{color:var(--fg)}',
    '#demo-chain .node[data-role=agent]{color:var(--agent)}',
    '#demo-chain .own{color:var(--muted)}',
    '#demo-chain .arrow{padding:0 1ch}',
    '#demo-chain .arrow[data-on="1"],#demo-chain .node[data-on="1"]{color:var(--accent);font-weight:700}',
    '#demo-chain .node[data-on="1"] .own{color:var(--accent)}'
  ].join('')
  document.head.append(css)

  const box = document.createElement('div')
  box.id = 'demo-caption'
  const title = document.createElement('p')
  title.id = 'demo-title'
  const chain = document.createElement('p')
  chain.id = 'demo-chain'
  box.append(title, chain)
  document.getElementById('banner').after(box)

  window.__cap = (text, from, to) => {
    title.textContent = text
    chain.replaceChildren()
    const back = from !== null && to < from
    NODES.forEach((node, i) => {
      if (i > 0) {
        const arrow = document.createElement('span')
        arrow.className = 'arrow'
        arrow.dataset.on = from !== null && Math.min(from, to) === i - 1 ? '1' : '0'
        arrow.textContent = back ? '\u25c0\u2500\u2500' : '\u2500\u2500\u25b6'
        chain.append(arrow)
      }
      const span = document.createElement('span')
      span.className = 'node'
      span.dataset.role = node.role
      span.dataset.on = i === to ? '1' : '0'
      span.append(node.name)
      if (node.owner !== null) {
        const own = document.createElement('span')
        own.className = 'own'
        own.textContent = ' [agent \u00b7 ' + node.owner + ']'
        span.append(own)
      }
      chain.append(span)
    })
    return text
  }
  return 'installed'
})()`

/**
 * The beats, each one keyed to text that has to be ON SCREEN before its caption
 * is allowed to claim it.
 *
 * `marker` is a fragment of the message that beat is about, matched against the
 * transcript's own textContent. `then` is a second caption shown a beat later
 * to name the work the next agent is doing WHILE it does it — the flow pane is
 * filling with that agent's 43002/43003/30174 at exactly that moment.
 */
const BEATS = [
  {
    marker: 'the release train is blocked',
    title: '1 · alice asks HER agent — she never addresses bob',
    from: 0,
    to: 1,
    then: {
      after: 1500,
      title: 'honey classifies it high, stores a kind-30174 engram, decides where it goes',
      from: null,
      to: 1
    }
  },
  {
    marker: '@scout',
    title: '2 · agent to agent — honey hands it to scout as a kind-43001 job request',
    from: 1,
    to: 2,
    then: {
      after: 1500,
      title: 'scout triages what it was handed — its own summary, its own record',
      from: null,
      to: 2
    }
  },
  {
    marker: '@bob',
    title: "3 · scout delivers to bob — bob's own agent, in the same room",
    from: 2,
    to: 3
  },
  {
    marker: 'tell alice build 42',
    title: '4 · bob answers HIS agent — he never addresses alice either',
    from: 3,
    to: 2,
    then: {
      after: 1500,
      title: 'scout condenses the answer and hands it back',
      from: null,
      to: 2
    }
  },
  {
    marker: '@honey',
    title: '5 · the return leg, agent to agent',
    from: 2,
    to: 1
  },
  {
    marker: '@alice',
    title: '6 · alice gets her answer, carried the whole way by the two agents',
    from: 1,
    to: 0
  }
]

/**
 * Fire each caption when the message it describes appears in the transcript.
 *
 * Polled rather than pushed: a MutationObserver would need a callback channel
 * back over CDP, and 8 Hz of one tiny `textContent.includes` is cheaper than
 * that is to get right. A follow-up caption is cancelled if the next beat beats
 * it to the punch, so the band can never describe the wrong hop.
 */
async function driveCaptions (cdp, beats, { timeoutMs = 90000 } = {}) {
  const caption = (text, from, to) =>
    cdp.eval(`window.__cap(${JSON.stringify(text)}, ${from === null ? 'null' : from}, ${to === null ? 'null' : to})`)

  const probe = `(() => {
    const text = document.getElementById('transcript').textContent
    return ${JSON.stringify(beats.map((b) => b.marker))}.map((m) => text.includes(m))
  })()`

  const deadline = Date.now() + timeoutMs
  let next = 0
  let pending = null

  while (next < beats.length) {
    if (Date.now() > deadline) {
      throw new Error(`beat ${next + 1} (${JSON.stringify(beats[next].marker)}) never reached the transcript`)
    }
    const seen = await cdp.eval(probe)
    if (Array.isArray(seen) && seen[next] === true) {
      const beat = beats[next]
      if (pending !== null) clearTimeout(pending)
      pending = null
      log(`beat ${next + 1}: ${beat.title}`)
      await caption(beat.title, beat.from, beat.to)
      if (beat.then !== undefined) {
        pending = setTimeout(() => {
          caption(beat.then.title, beat.then.from, beat.then.to).catch(() => {})
        }, beat.then.after)
      }
      next++
      continue
    }
    await sleep(120)
  }
  if (pending !== null) clearTimeout(pending)
}

// ------------------------------------------------------------------ main --

async function main () {
  await fs.rm(WORK, { recursive: true, force: true })
  await fs.mkdir(FRAMES, { recursive: true })
  await fs.mkdir(STORAGE, { recursive: true })

  await assertPortFree(RELAY_PORT)

  log('starting the relay')
  const relay = run('node', [
    'scripts/bare.js', 'bin.mjs', 'relay',
    '--port', String(RELAY_PORT),
    '--storage', STORAGE,
    '--web-dir', 'packages/hive-web/public',
    '--no-updates', '--no-swarm'
  ], { cwd: REPO })
  relay.stdout.on('data', (chunk) => process.stdout.write(`  relay: ${chunk}`))
  relay.stderr.on('data', (chunk) => process.stdout.write(`  relay!: ${chunk}`))

  // The relay dying mid-take is the one failure that does not look like one:
  // the page keeps its last render, the frames keep arriving, and the result is
  // a demo of a frozen client. Fail on it explicitly.
  let relayDied = false
  relay.on('exit', () => { relayDied = true })
  const checkRelay = () => {
    if (relayDied) throw new Error('the relay exited mid-recording (another process on this machine may have killed it)')
  }

  await waitForHttp(`http://127.0.0.1:${RELAY_PORT}/health`)
  log('relay ready')

  // Furnished BEFORE the camera and before the browser. Two reasons: no panel
  // may be empty in frame one, and the client resolves kind-10100 exactly once
  // at boot — an agent profile that lands after that renders as another human
  // for the whole take, which would delete the ownership this demo is about.
  log('seeding the room')
  await runToEnd('node', [
    'scripts/bare.js', 'scripts/demo-web-seed.js', String(RELAY_PORT), 'a2a'
  ], 'seed', { cwd: REPO })

  log('launching chrome')
  const { cdp } = await launchChrome({
    port: CDP_PORT,
    width: WIDTH,
    height: HEIGHT,
    profile: PROFILE,
    background: { r: 0x27, g: 0x28, b: 0x22 } // the palette's own --bg
  })

  // ---- capture ----------------------------------------------------------
  const camera = startCapture(cdp, { dir: FRAMES, fps: FPS })
  const frames = camera.frames
  const t0 = Date.now()

  const at = async (seconds, what, fn) => {
    const wait = t0 + seconds * 1000 - Date.now()
    if (wait > 0) await sleep(wait)
    checkRelay()
    log(`t+${seconds}s ${what}`)
    return fn()
  }

  const caption = (text, from = null, to = null) =>
    cdp.eval(`window.__cap(${JSON.stringify(text)}, ${from === null ? 'null' : from}, ${to === null ? 'null' : to})`)

  // A real click on the channel's own button, through the page's own handler.
  const openChannel = (name) => cdp.eval(`(() => {
    const button = [...document.querySelectorAll('#channels button')]
      .find((b) => b.textContent.includes('${name}'))
    if (button === undefined) return 'no #${name} in the channel list'
    button.click()
    return null
  })()`).then((problem) => { if (problem !== null) throw new Error(problem) })

  // ---- the demo ---------------------------------------------------------

  await at(0.4, 'open the page', () => cdp.send('Page.navigate', { url: `http://127.0.0.1:${RELAY_PORT}/` }))

  await at(1.8, 'install the caption band', async () => {
    const installed = await cdp.eval(INSTALL_CAPTION)
    if (installed !== 'installed') throw new Error(`the caption band did not install: ${installed}`)
    await caption('humans and agents in the same room, on one relay, on one signed log')
  })

  // Boots into #design, so this is a real navigation.
  await at(3.6, 'select #engineering', () => openChannel('engineering'))

  await at(5.6, 'name the cast', () =>
    caption('every member owns an agent — the kind-10100 profile says whose: honey is alice\u2019s, scout is bob\u2019s'))

  // The agents come up here, on real sockets, and publish their own profiles.
  // Started as a background child because its beats ARE the demo: the caption
  // driver below watches the page for each one rather than trusting a timer.
  const delegation = await at(8.0, 'start the agents and run the delegation', async () => {
    await caption('alice is about to ask her agent for something only bob knows')
    return background('node', [
      'scripts/bare.js', 'scripts/demo-delegation.js', String(RELAY_PORT), 'run',
      `chunk=${CHUNK}`, `pace=${PACE}`, `hold=${HOLD}`, 'quiet=1'
    ], 'a2a', { cwd: REPO })
  })

  await driveCaptions(cdp, BEATS)
  checkRelay()

  // The last caption is the payoff and the transcript row under it is the
  // whole point, so it is held rather than cut to the outro on the beat.
  await sleep(3800)
  log('outro')
  await caption('human \u2192 agent \u2192 agent \u2192 human — no new event kind, every hop signed and on the log')
  await sleep(4600)

  await camera.stop()

  checkRelay()
  await waitForLine(delegation, 'scout → honey → alice', 'a2a', 20000)
  if (delegation.err.includes('refused')) throw new Error(`the relay refused events during the take:\n${delegation.err}`)

  const png = await prepareFrames(frames, WORK)
  log(`colour type ${png.colour === 6 ? 'RGBA' : 'RGB'}: dropped ${png.head} pre-navigation frames, normalised ${png.normalised} of ${frames.length}`)

  const seconds = (frames[frames.length - 1].at - frames[0].at) / 1000
  log(`${frames.length} frames over ${seconds.toFixed(1)}s, ${camera.dropped} dropped`)
  if (camera.dropped > frames.length / 10) throw new Error(`${camera.dropped} dropped frames: the browser was not answering`)

  // ---- what the last frame has to be able to prove -----------------------
  //
  // These are the demo's CLAIMS, read back off the page it filmed. A take that
  // rendered beautifully but lost the ownership suffix, or that never got the
  // job events into the flow pane, is a take that says something untrue.
  const state = await cdp.eval(`JSON.stringify({
    error: document.getElementById('error').hidden ? null : document.getElementById('error').textContent,
    channel: document.getElementById('channel-title').textContent,
    channels: document.querySelectorAll('#channels button').length,
    messages: document.querySelectorAll('#transcript li.row').length,
    agentTurns: document.querySelectorAll('#transcript li[data-turn="agent"]').length,
    transcript: document.getElementById('transcript').textContent,
    members: document.querySelectorAll('#members li.row').length,
    agentMembers: document.querySelectorAll('#members li[data-turn="agent"]').length,
    memberText: document.getElementById('members').textContent,
    flow: document.querySelectorAll('#flow li').length,
    flowText: document.getElementById('flow').textContent,
    status: document.getElementById('statusbar').textContent
  })`)
  const final = JSON.parse(state)
  log('final page state', JSON.stringify({ ...final, transcript: undefined, memberText: undefined, flowText: undefined }))

  const problems = []
  if (final.error !== null) problems.push(`the page reported an error: ${final.error}`)
  if (final.channel !== '#engineering') problems.push(`ended on ${final.channel}, not #engineering`)
  if (final.channels < 4) problems.push(`only ${final.channels} channels in the list`)
  if (final.members < 6) problems.push(`only ${final.members} members — the cast is not all on screen`)
  if (final.agentMembers !== 3) problems.push(`${final.agentMembers} agents in the member list, expected 3`)
  if (final.agentTurns < 4) problems.push(`only ${final.agentTurns} agent turns in the transcript, expected 4`)

  // Ownership, the claim this whole demo exists to make, in the members panel.
  for (const pair of ['honey', 'agent · alice', 'scout', 'agent · bob', 'forge', 'agent · cass']) {
    if (!final.memberText.includes(pair)) problems.push(`the members panel never showed ${JSON.stringify(pair)}`)
  }

  // Every hop of the chain, in the transcript, in the client's own words.
  for (const beat of BEATS) {
    if (!final.transcript.includes(beat.marker)) problems.push(`the transcript is missing ${JSON.stringify(beat.marker)}`)
  }

  // And the middle being work rather than a pipe: the job lifecycle and the
  // engram have to be visible in the EVENT FLOW pane, not merely on the relay.
  for (const kind of ['43001', '43002', '43003', '43004', '30174']) {
    if (!final.flowText.includes(kind)) problems.push(`kind ${kind} never appeared in the event flow pane`)
  }
  if (/\b0 conn\b/.test(final.status)) problems.push(`the status bar reads 0 conn: ${final.status}`)
  if (/\b0 subs\b/.test(final.status)) problems.push(`the status bar reads 0 subs: ${final.status}`)

  if (problems.length > 0) throw new Error('the recording is not usable:\n- ' + problems.join('\n- '))
  log(`status bar at the last frame: ${final.status}`)

  // ---- assemble ---------------------------------------------------------
  //
  // Unlike the load take, this scene mostly HOLDS STILL: two caption lines and
  // one or two transcript rows change between frames, so the GIF's palette and
  // its rectangle diffs have something to work with and the whole take fits in
  // an embeddable file. Duration is still the only real lever if it does not —
  // see the note in record-web-demo.mjs.
  const list = path.join(WORK, 'frames.txt')
  const palette = path.join(WORK, 'palette.png')
  await writeConcatList(frames, list, { fps: FPS })

  log('rendering the mp4')
  await renderMp4(list, OUT_MP4, { fps: FPS })

  log('rendering the gif')
  await renderGif(list, OUT_GIF, { fps: FPS, colors: 64, palettePath: palette })

  for (const out of [OUT_MP4, OUT_GIF]) {
    log(path.relative(REPO, out), `${((await fs.stat(out)).size / 1e6).toFixed(1)} MB`)
  }
}

try {
  await main()
} finally {
  killAll()
}

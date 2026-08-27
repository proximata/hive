#!/usr/bin/env node
//
// Record docs/demo-web.gif + docs/demo-web.mp4: the real web client, in a real
// browser, against a real relay, under LOAD.
//
//   node scripts/record-web-demo.mjs
//
// Nothing here is re-enacted. A relay is started on a scratch storage dir, the
// room is seeded over the wire by scripts/demo-web-seed.js, headless Chrome
// loads the page the relay serves, and every frame is a screenshot of that
// page. The messages that land mid-recording are published by a separate
// process while the camera runs, so the event flow pane is filming arrivals.
//
// The workspace is filmed at 18 humans and 6 agents across 6 channels, a
// backdated transcript that is already full in the first frame, and then a
// sustained stream at LOAD_RATE ev/s for as long as the camera runs. Every one
// of those events is a real signed Nostr event that went through the relay's
// ingest path; nothing is injected into the DOM and no rate is simulated. If
// the relay or its rate limiter cannot hold the rate, the seeder says so on
// stdout and this script fails the take rather than shipping a demo that
// overstates throughput.
//
// This file is the SCENE. The camera — process tree, CDP, capture loop, PNG
// colour-type normalisation, ffmpeg flags — is scripts/lib/record/engine.mjs,
// shared with scripts/record-a2a-demo.mjs.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertPortFree, background, createLog, killAll, launchChrome, prepareFrames,
  pressEnter, renderGif, renderMp4, run, sleep, startCapture, type,
  waitForHttp, waitForLine, writeConcatList
} from './lib/record/engine.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_GIF = path.join(REPO, 'docs', 'demo-web.gif')
const OUT_MP4 = path.join(REPO, 'docs', 'demo-web.mp4')

const RELAY_PORT = 8931
const CDP_PORT = 9333
const WIDTH = 1280
const HEIGHT = 720
const FPS = 12

// The load the demo films. RATE is what the seeder targets; SECONDS overruns
// the camera so the stream never thins out inside the take, and BACKFILL is the
// history that has to be on screen in frame one.
//
// The ceiling is not the relay (measured: 931 accepted ev/s across 25
// identities) but the per-pubkey token bucket workers/main.js configures at the
// `human` tier. 24 identities refill at 12 ev/s and hold 60 burst tokens each,
// so 40 ev/s is financed out of burst and is affordable for ~36s after a 220
// event backfill. The seeder prints that budget and warns if the take is longer
// than the pot; keep RATE x SECONDS under it rather than raising the relay's
// limit, because the demo should film the relay as it is configured to run.
const LOAD_RATE = 40
const LOAD_SECONDS = 33
const LOAD_BACKFILL = 220

// The seconds of the take the GIF loops over — both channel switches. Why the
// GIF is not the whole take is at the assemble step.
const GIF_WINDOW = [10.0, 17.0]

const WORK = path.join(os.tmpdir(), 'hive-web-demo')
const FRAMES = path.join(WORK, 'frames')
const STORAGE = path.join(WORK, 'storage')
const PROFILE = path.join(WORK, 'chrome-profile')

const log = createLog('record')

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

  // Backfill and live stream, one process. Started BEFORE the browser and
  // before t0: the transcript, the members list and the flow pane all have to
  // be full in the very first frame, so the camera waits for the room to be
  // furnished rather than filming it filling up.
  log('seeding the workspace under load')
  const load = background('node', [
    'scripts/bare.js', 'scripts/demo-web-seed.js', String(RELAY_PORT), 'load',
    `rate=${LOAD_RATE}`, `seconds=${LOAD_SECONDS}`, `backfill=${LOAD_BACKFILL}`
  ], 'load', { cwd: REPO })
  await waitForLine(load, '[load] backfill complete:', 'load')
  log('backfill complete; the live stream is now running')

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
    await fn()
  }

  // ---- the demo ---------------------------------------------------------
  // Every step below is a real interaction with the served page. Nothing is
  // drawn, nothing is faked, and the relay is answering all of it.

  // A real click on the channel's own button, dispatched through the page's own
  // handler. Fails loudly rather than silently filming the wrong room.
  const openChannel = (name) => cdp.eval(`(() => {
    const button = [...document.querySelectorAll('#channels button')]
      .find((b) => b.textContent.includes('${name}'))
    if (button === undefined) return 'no #${name} in the channel list'
    button.click()
    return null
  })()`).then((problem) => { if (problem !== null) throw new Error(problem) })

  await at(0.4, 'open the page', () => cdp.send('Page.navigate', { url: `http://127.0.0.1:${RELAY_PORT}/` }))

  // Boots into #design (created first, so it sorts first) and it is ALREADY a
  // room with a past: the clicks below are real navigations between channels
  // that are each independently live, not a walk through empty panels.
  await at(5.0, 'select #engineering', () => openChannel('engineering'))

  await at(10.5, 'select #incidents — the unselected rooms are moving too', () => openChannel('incidents'))

  await at(15.0, 'back to #engineering', () => openChannel('engineering'))

  await at(19.0, 'compose from the browser', async () => {
    await cdp.eval("document.getElementById('compose-input').focus()")
    await type(cdp, 'who is on call tonight?')
    await sleep(400)
    await pressEnter(cdp)
  })

  // The rest of the take is the stream: humans and agents answering, the flow
  // pane scrolling, the counters moving. Nothing to drive.
  await at(30.0, 'stop', () => camera.stop())

  checkRelay()

  // What the load actually was, in the seeder's own words. The camera stopped
  // before the stream did, so this is a moment away.
  await waitForLine(load, '[load] live done:', 'load', 20000)
  const achieved = load.out.match(/\[load\] live done: .*/)?.[0]
  log(achieved)
  if (load.err.includes('REFUSED')) throw new Error(`the relay refused events during the take:\n${load.err}`)
  // The take may only claim a rate it actually sustained. `starved` on its own
  // is not that failure — a beat whose first channel had no identity with a
  // token moves to another channel and still publishes, which is what a busy
  // workspace looks like. The rate the seeder measured is the thing to check,
  // and `not sent` is the count of beats that produced nothing at all.
  const rate = Number(achieved?.match(/= ([\d.]+) ev\/s achieved/)?.[1] ?? 0)
  const missed = Number(load.out.match(/\[load\] SATURATED: (\d+) beats produced no event/)?.[1] ?? 0)
  if (rate < LOAD_RATE * 0.9) {
    throw new Error(`the stream held only ${rate} ev/s of ${LOAD_RATE} targeted; the tail of this take is thinner than it claims`)
  }
  if (missed > LOAD_RATE * LOAD_SECONDS * 0.02) {
    throw new Error(`${missed} beats produced no event: the rate-limit budget ran out inside the take`)
  }

  const png = await prepareFrames(frames, WORK)
  log(`colour type ${png.colour === 6 ? 'RGBA' : 'RGB'}: dropped ${png.head} pre-navigation frames, normalised ${png.normalised} of ${frames.length}`)

  const seconds = (frames[frames.length - 1].at - frames[0].at) / 1000
  log(`${frames.length} frames over ${seconds.toFixed(1)}s, ${camera.dropped} dropped`)
  if (camera.dropped > frames.length / 10) throw new Error(`${camera.dropped} dropped frames: the browser was not answering`)

  // A blank or error page would still produce frames, so check the DOM said
  // what the demo claims before spending a minute in ffmpeg.
  const state = await cdp.eval(`JSON.stringify({
    error: document.getElementById('error').hidden ? null : document.getElementById('error').textContent,
    channel: document.getElementById('channel-title').textContent,
    channels: document.querySelectorAll('#channels button').length,
    messages: document.querySelectorAll('#transcript li.row').length,
    agents: document.querySelectorAll('#transcript li[data-turn="agent"]').length,
    flow: document.querySelectorAll('#flow li').length,
    members: document.querySelectorAll('#members li.row').length,
    agentMembers: document.querySelectorAll('#members li[data-turn="agent"]').length,
    status: document.getElementById('statusbar').textContent
  })`)
  log('final page state', state)

  // Thresholds are the DEMO's claims, not smoke-test minimums: this take is
  // supposed to show a busy workspace, so a panel that is merely non-empty is a
  // failed take. Each number below is roughly half of what a healthy run
  // measures, so it fails on a real regression and not on jitter.
  const final = JSON.parse(state)
  const problems = []
  if (final.error !== null) problems.push(`the page reported an error: ${final.error}`)
  if (final.channel !== '#engineering') problems.push(`ended on ${final.channel}, not #engineering`)
  if (final.channels < 6) problems.push(`only ${final.channels} channels in the list`)
  if (final.messages < 60) problems.push(`only ${final.messages} messages in the transcript — the centre panel will not be full`)
  if (final.agents < 4) problems.push(`only ${final.agents} agent turns in the transcript`)
  if (final.flow < 100) problems.push(`only ${final.flow} events in the flow pane`)
  if (final.members < 18) problems.push(`only ${final.members} members`)
  if (final.agentMembers < 3) problems.push(`only ${final.agentMembers} agents in the member list`)
  // The status bar is the demo's own claim about throughput, so it is checked
  // rather than trusted. `0 conn`/`0 subs` was a real client bug (boot() read
  // /api/relay before it opened the socket and never re-read until the 10s
  // poll); if it comes back, the fix regressed and the bar is lying again.
  if (/\b0 conn\b/.test(final.status)) problems.push(`the status bar reads 0 conn under load: ${final.status}`)
  if (/\b0 subs\b/.test(final.status)) problems.push(`the status bar reads 0 subs under load: ${final.status}`)
  //
  // The two rates in one line, because they are the demo's whole claim: what
  // the relay was fed, and what the page it filmed says it received. They are
  // not equal and should not be expected to be — the page's meter is its own
  // last-5s window over the events it is ALLOWED to see and has managed to
  // render — but a page an order of magnitude behind would mean the recording
  // shows a load the client never actually took.
  const shown = Number(final.status.match(/([\d.]+) ev\/s/)?.[1] ?? 0)
  log(`throughput: relay fed ${rate} ev/s, page meter reads ${shown} ev/s (${Math.round((shown / rate) * 100)}%)`)
  if (shown < rate * 0.6) {
    problems.push(`the page meter reads ${shown} ev/s against ${rate} ev/s published: the client is not keeping up with the take`)
  }
  if (problems.length > 0) throw new Error('the recording is not usable:\n- ' + problems.join('\n- '))
  log(`status bar at the last frame: ${final.status}`)

  // ---- assemble ---------------------------------------------------------
  //
  // The MP4 is the whole take. The GIF is a loop cut out of it, and that split
  // is forced by what a GIF costs once the picture stops holding still.
  //
  // Measured on this take, 1280x720: ~40 KB per frame however the palette is
  // tuned. 256 colours and 32 colours both land at 12 MB for 30s; dropping to
  // 8 fps saves 1 MB, and downscaling to 900 wide makes it BIGGER (16 MB —
  // resampling turns crisp flat text into gradients that LZW cannot pack).
  // Under load nearly every pixel in the transcript and the flow pane changes
  // every frame, so there is no palette trick left to play: the only lever is
  // duration. A 30s GIF of this is ~12 MB, which is not a thing to put at the
  // top of a README. So the GIF is a 7s loop of the busiest stretch — both
  // channel switches, 3.1 MB — and the MP4, which h264 encodes at a twentieth
  // of the bitrate, carries the full 30s including the compose.
  const list = path.join(WORK, 'frames.txt')
  const gifList = path.join(WORK, 'gif-frames.txt')
  const palette = path.join(WORK, 'palette.png')
  await writeConcatList(frames, list, { fps: FPS })
  const gifFrames = await writeConcatList(frames, gifList, { fps: FPS, from: GIF_WINDOW[0], to: GIF_WINDOW[1] })
  log(`gif window ${GIF_WINDOW[0]}s..${GIF_WINDOW[1]}s = ${gifFrames.length} frames`)

  log('rendering the gif')
  await renderGif(gifList, OUT_GIF, { fps: FPS, colors: 64, palettePath: palette })

  log('rendering the mp4')
  await renderMp4(list, OUT_MP4, { fps: FPS })

  for (const out of [OUT_GIF, OUT_MP4]) {
    log(path.relative(REPO, out), `${((await fs.stat(out)).size / 1e6).toFixed(1)} MB`)
  }
}

try {
  await main()
} finally {
  killAll()
}

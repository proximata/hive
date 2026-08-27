//
// The camera, shared by every browser recording in this repo.
//
// This module is the ENGINE: spawn a process tree that survives Bare's double
// exec, drive headless Chrome over CDP with nothing but Node's global
// WebSocket, screenshot on a timer with real capture timestamps, and hand the
// frames to ffmpeg with the flags that are known to survive Chrome changing its
// PNG colour type mid-stream.
//
// It knows nothing about Hive. The SCENE — which relay, which seeder, which
// clicks, which captions, which assertions — lives in the recorder that imports
// this: scripts/record-web-demo.mjs films a workspace under load,
// scripts/record-a2a-demo.mjs films two humans talking through their agents.
// The two scenes diverged far enough to be separate scripts; everything they
// still agree about is here, so a fix to the pipeline lands in both.
//
// No new dependency: Node 24 has a global WebSocket, which is the whole of the
// CDP client below.

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const createLog = (tag) => (...args) => console.log(`[${tag}]`, ...args)

// ------------------------------------------------------------ processes --

export const children = []

/**
 * `detached` puts each child in its own process group, because the ones that
 * matter are not the ones spawned: `node scripts/bare.js` execs a bare runtime
 * which execs the platform binary. Killing the pid leaves the grandchild alive,
 * still holding the port and the storage directory — which produced a run that
 * recorded the PREVIOUS relay's data and looked like it had worked.
 */
export function run (command, args, opts = {}) {
  const child = spawn(command, args, { stdio: 'pipe', detached: true, ...opts })
  children.push(child)
  return child
}

export function killTree (child) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch {}
  }
}

export function killAll () {
  for (const child of children) killTree(child)
}

/** Run to completion, failing loudly: a silent seed failure records an empty room. */
export async function runToEnd (command, args, label, opts = {}) {
  const child = run(command, args, opts)
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk; process.stdout.write(`  ${label}!: ${chunk}`) })
  child.stdout.on('data', (chunk) => process.stdout.write(`  ${label}: ${chunk}`))
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`${label} exited ${code}\n${stderr}`)
  if (stderr.includes('REFUSED')) throw new Error(`${label} had events refused by the relay:\n${stderr}`)
  return child
}

/**
 * Start a child and keep everything it says, without waiting for it to exit.
 *
 * Some of what a recorder spawns has to be watched WHILE it runs — a load
 * seeder that backfills and then streams from one process so its rate-limit
 * budget matches the relay's, or a delegation script whose beats are the demo.
 * So the recorder waits for a LINE on stdout, not for an exit.
 */
export function background (command, args, label, opts = {}) {
  const child = run(command, args, opts)
  child.out = ''
  child.err = ''
  child.done = null
  child.stdout.on('data', (chunk) => { child.out += chunk; process.stdout.write(`  ${label}: ${chunk}`) })
  child.stderr.on('data', (chunk) => { child.err += chunk; process.stdout.write(`  ${label}!: ${chunk}`) })
  child.on('exit', (code) => { child.done = code })
  return child
}

export async function waitForLine (child, marker, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.out.includes(marker)) return
    if (child.done !== null) {
      throw new Error(`${label} exited (${child.done}) before printing ${JSON.stringify(marker)}\n${child.err}`)
    }
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label} to print ${JSON.stringify(marker)}`)
}

export async function waitForHttp (url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
    } catch {}
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${url}`)
}

/**
 * Refuse to film a port this run does not own.
 *
 * Otherwise a leftover relay from a previous take answers, gets seeded on top
 * of, and the recording is of someone else's data.
 */
export async function assertPortFree (port) {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
  } catch {
    return
  }
  throw new Error(`port ${port} is already serving something; not recording against it`)
}

// ------------------------------------------------------------------ CDP --

export class CDP {
  constructor (socket) {
    this.socket = socket
    this.id = 0
    this.pending = new Map()
    socket.addEventListener('message', (message) => {
      const frame = JSON.parse(message.data)
      const waiter = this.pending.get(frame.id)
      if (waiter === undefined) return
      this.pending.delete(frame.id)
      if (frame.error) waiter.reject(new Error(`${frame.error.message} (${waiter.method})`))
      else waiter.resolve(frame.result)
    })
  }

  static async attach (wsUrl) {
    const socket = new WebSocket(wsUrl)
    await once(socket, 'open')
    return new CDP(socket)
  }

  send (method, params = {}) {
    const id = ++this.id
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }))
  }

  eval (expression) {
    return this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      .then((result) => result.result?.value)
  }
}

/**
 * Launch headless Chrome, attach to its page, and pin everything that would
 * otherwise vary between takes.
 *
 * `background` is the one non-obvious argument. Without an opaque backdrop in
 * the app's own --bg, Chrome emits about:blank as rgb24 and the painted app as
 * rgba, ffmpeg's filter graph will not reconfigure mid-stream, and the take
 * opens on a white first-paint flash.
 */
export async function launchChrome ({ port, width, height, profile, background: bg }) {
  const chrome = run(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank'
  ])

  await waitForHttp(`http://127.0.0.1:${port}/json/version`)
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const cdp = await CDP.attach(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  // Chrome sizes the screenshot from the window, which the WM may not have
  // honoured exactly; pinning the metrics makes the frame size deterministic.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { ...bg, a: 1 } })

  return { chrome, cdp }
}

/** A real key event, not a synthetic submit: the page's own handlers run. */
export async function pressEnter (cdp) {
  for (const type of ['rawKeyDown', 'char', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r'
    })
  }
}

export async function type (cdp, text, perChar = 45) {
  for (const char of text) {
    await cdp.send('Input.insertText', { text: char })
    await sleep(perChar)
  }
}

// -------------------------------------------------------------- capture --

/**
 * Screenshot on a timer until stopped.
 *
 * Every frame carries its real capture time, so the concat list built later
 * replays at the speed it happened rather than at a nominal framerate.
 *
 * A screenshot taken across a navigation answers "Not attached to an active
 * page". That is a dropped frame, not a failed recording — the frame list
 * carries real timestamps, so a gap replays as a gap. Counted, so a browser
 * that died mid-run cannot pass as a demo with a few dropped frames.
 */
export function startCapture (cdp, { dir, fps }) {
  const frames = []
  const state = { recording: true, dropped: 0 }

  const done = (async () => {
    while (state.recording) {
      const at = Date.now()
      let shot
      try {
        shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      } catch {
        if (!state.recording) break
        state.dropped++
        await sleep(1000 / fps)
        continue
      }
      const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.png`)
      const png = Buffer.from(shot.data, 'base64')
      await fs.writeFile(file, png)
      // PNG IHDR colour type, byte 25: 2 = RGB, 6 = RGBA. Recorded here so the
      // odd frames out can be normalised rather than diagnosed in ffmpeg's log.
      frames.push({ file, at, colour: png[25] })
      const spent = Date.now() - at
      await sleep(Math.max(0, 1000 / fps - spent))
    }
  })()

  return {
    frames,
    get dropped () { return state.dropped },
    async stop () {
      state.recording = false
      await done
    }
  }
}

// ------------------------------------------------------------- pipeline --

export async function ffmpeg (args, label) {
  const child = run('ffmpeg', args)
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`${label} failed:\n${stderr.slice(-3000)}`)
}

/**
 * One PNG colour type across the whole take.
 *
 * Chrome hands some frames back as RGB and some as RGBA, and the choice is its
 * own: about:blank is always RGB, and under load the painted page alternates
 * too — a 30s take at 40 ev/s came back 40% RGB, in runs of one to ten frames.
 * ffmpeg's filter graph will not reconfigure across that change mid-stream; it
 * aborts with 'Internal bug, should not have happened' a few frames in, having
 * written a four frame GIF. Rather than diagnose that in ffmpeg's log every
 * time Chrome's compositor changes its mind, the odd frames out are re-encoded
 * before ffmpeg sees the sequence at all.
 *
 * One batched call rather than one per frame: the odd frames are not
 * contiguous, so they are staged under the sequential names the image2 demuxer
 * insists on. ~0.1s per frame adds up to 15s otherwise, on every take.
 */
export async function normaliseFrames (frames, colour, workDir) {
  const odd = frames.filter((frame) => frame.colour !== colour)
  if (odd.length === 0) return 0

  const stage = path.join(workDir, 'normalise')
  await fs.rm(stage, { recursive: true, force: true })
  await fs.mkdir(stage, { recursive: true })
  for (const [i, frame] of odd.entries()) {
    await fs.copyFile(frame.file, path.join(stage, `in${String(i).padStart(5, '0')}.png`))
  }

  await ffmpeg(['-y', '-v', 'error',
    '-start_number', '0', '-i', path.join(stage, 'in%05d.png'),
    '-pix_fmt', colour === 6 ? 'rgba' : 'rgb24',
    '-start_number', '0', path.join(stage, 'out%05d.png')], 'normalise')

  for (const [i, frame] of odd.entries()) {
    const converted = path.join(stage, `out${String(i).padStart(5, '0')}.png`)
    const png = await fs.readFile(converted)
    // Checked rather than assumed: a silently unconverted frame would put the
    // failure back in ffmpeg's lap with the fix looking like it had run.
    if (png[25] !== colour) throw new Error(`normalising ${frame.file} produced colour type ${png[25]}, not ${colour}`)
    await fs.writeFile(frame.file, png)
    frame.colour = colour
  }
  return odd.length
}

/**
 * Pin the whole take to one PNG colour type, dropping the pre-navigation head.
 *
 * The target is the MAJORITY colour type of the take, not a fixed one. It used
 * to be hardcoded to RGBA on the reasoning that about:blank comes back RGB and
 * the painted page comes back RGBA — which is true right up until it is not: a
 * 33s load take came back 355 frames of RGB and ZERO of RGBA, page included,
 * and the fixed target shifted every frame off the list and reported "the page
 * did not load" about a recording that had worked perfectly. Chrome's
 * compositor picks, and it is allowed to pick either for both.
 *
 * The leading frames are the pre-navigation ones: about:blank, painted in the
 * backdrop override. They are dropped WHEN they differ from the majority,
 * because they are not the demo. When they do not differ they are
 * indistinguishable from the app's own background — that is exactly what the
 * backdrop override is for — and cost a fraction of a second of flat colour at
 * the head rather than a failed take.
 */
export async function prepareFrames (frames, workDir) {
  if (frames.length === 0) throw new Error('no frames were captured at all; the browser never answered')

  const histogram = new Map()
  for (const frame of frames) histogram.set(frame.colour, (histogram.get(frame.colour) ?? 0) + 1)
  const [colour] = [...histogram].sort((a, b) => b[1] - a[1])[0]

  let head = 0
  while (frames.length > 0 && frames[0].colour !== colour) {
    frames.shift()
    head++
  }
  if (frames.length === 0) throw new Error('no frame ever came back painted; the page did not load')

  const normalised = await normaliseFrames(frames, colour, workDir)
  return { colour, head, normalised }
}

/**
 * Frames carry their real capture time, so the concat list replays at the speed
 * it happened. Screenshot latency is not constant; a fixed -framerate would
 * quietly stretch or compress the parts of the demo where the page was busiest,
 * which is exactly where the timing is the point.
 */
export async function writeConcatList (frames, listPath, { fps, from = 0, to = Infinity }) {
  const t0 = frames[0].at
  const window = frames.filter((frame) => {
    const at = (frame.at - t0) / 1000
    return at >= from && at <= to
  })
  if (window.length < 2) throw new Error(`the window ${from}s..${to}s holds ${window.length} frames`)

  const lines = []
  for (const [i, frame] of window.entries()) {
    const next = window[i + 1]
    const duration = next === undefined ? 1 / fps : (next.at - frame.at) / 1000
    lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(4)}`)
  }
  // The concat demuxer drops the last entry's duration unless the file repeats.
  lines.push(`file '${window[window.length - 1].file}'`)
  await fs.writeFile(listPath, lines.join('\n') + '\n')
  return window
}

/**
 * GIF, via a two-pass palette.
 *
 * dither=none, not bayer: the palette is a terminal palette, so the frames are
 * already flat colour. Dithering it adds noise that costs ~20% of the file and
 * makes the type look worse rather than better. `format=rgba` is load-bearing:
 * it pins the pixel format the filter graph is configured for — see
 * normaliseFrames() for the other half of that story.
 */
export async function renderGif (listPath, out, { fps, colors = 64, palettePath, scale = null }) {
  const pre = scale === null ? '' : `scale=${scale}:-1:flags=lanczos,`
  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', `fps=${fps},${pre}format=rgba,palettegen=max_colors=${colors}:stats_mode=diff`, palettePath], 'palettegen')

  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-i', palettePath,
    '-lavfi', `fps=${fps},${pre}format=rgba [x]; [x][1:v] paletteuse=dither=none:diff_mode=rectangle`,
    '-loop', '0', out], 'gif')
}

/**
 * MP4, with the TUI demo's h264 settings exactly, so every artefact in docs/
 * decodes the same. Straight from the frames rather than through the GIF, so
 * the MP4 does not inherit a 64 colour palette.
 */
export async function renderMp4 (listPath, out, { fps }) {
  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-movflags', '+faststart', '-an',
    '-vf', `fps=${fps},scale=ceil(iw/2)*2:ceil(ih/2)*2:flags=neighbor,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', out], 'mp4')
}

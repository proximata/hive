'use strict'

// The demo, as a terminal application.
//
// One process: it boots the same relay scripts/demo.js boots, runs the scene
// script against it, and paints what the relay actually did. Nothing on screen
// is staged — every line comes out of world.state, and world.state is fed by
// the relay's own event stream.
//
// Three ways to run it, one code path:
//   --demo    no colour, no terminal, every scene asserted, PASS/FAIL per scene
//   --record  real pacing into a real terminal, driven by the script
//   (none)    the same, plus a keyboard to steer the view while it plays

const process = require('bare-process')

const { parseArgs } = require('hive-cli/lib/args.js')

const { Screen, displayWidth } = require('./lib/tui/screen')
const { Input } = require('./lib/tui/input')
const { setColor } = require('./lib/tui/widgets')
const { createWorld } = require('./lib/demo/world')
const { scenes } = require('./lib/demo/script')
const panesUser = require('./lib/demo/panes-user')
const panesAdmin = require('./lib/demo/panes-admin')

const FRAME_MS = 100 // ~10fps: fast enough to feel live, slow enough to diff cheaply
const SAMPLE_MS = 500 // the store survey behind the admin panes costs SQL, so it runs slower
const SERIES_CAP = 60
const REJECTION_CAP = 20

// --demo has no terminal to ask, and a fixed frame is the only way a recorded
// run and a CI run can be compared line for line.
const DEMO_COLUMNS = 100
const DEMO_ROWS = 30

// Tab order for the user half. The admin half has one pane per sub-tab, so
// there Tab walks the sub-tabs instead — see focusNext().
const USER_FOCUS = ['channels', 'dms', 'messages', 'flow']

const USAGE = `hive demo — the Hive workspace demo as a TUI

  hive demo [flags]
  npm run demo:tui -- [flags]

Flags:
  --demo          run every scene headless, assert each one, exit non-zero on failure
  --record        play the script at real pace into the terminal, then exit
  --relay <url>   attach to a running relay instead of booting one; the scenes
                  that need its own store or event stream then report SKIP
  --speed <n>     multiply the pace: 2 is twice as fast, 0.5 half
  --no-swarm      skip the hyperdht testnet (faster boot, no peer-to-peer scene)
  --seed <n>      derive the demo identities, so a run replays with the same keys
  --cols <n>      force the frame width
  --rows <n>      force the frame height
  --help          this text

Keys:
  1 user · 2 admin · tab focus · ↑↓ move · [ ] admin sub-tabs
  / search · enter send · esc cancel · q quit`

function number (value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseFlags (argv) {
  const { flags } = parseArgs(argv)

  return {
    demo: flags.demo === true,
    record: flags.record === true,
    help: flags.help === true || flags.h === true,
    relayUrl: typeof flags.relay === 'string' ? flags.relay : null,
    speed: number(flags.speed, 1),
    swarm: flags.swarm !== false,
    seed: flags.seed === undefined || flags.seed === true ? null : String(flags.seed),
    columns: flags.cols === undefined ? null : number(flags.cols, null),
    rows: flags.rows === undefined ? null : number(flags.rows, null)
  }
}

// hive-cli's exit codes. 3 (auth) and 5 (conflict) are the two the relay
// answered with; 1 (user) and 2 (network) never reached it.
const RELAY_REFUSALS = new Set([3, 5])

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Bare.exit() does not drain the standard streams: when stdout is a file, a
 * PASS/FAIL line written a millisecond earlier is simply lost. A zero-length
 * write is queued behind everything already pending, so its callback is the
 * cheapest proof that the earlier writes went out.
 */
function flush (stream) {
  return new Promise((resolve) => {
    try {
      stream.write('', () => resolve())
    } catch {
      resolve()
    }
  })
}

async function exit (code) {
  await flush(process.stdout)
  await flush(process.stderr)
  Bare.exit(code)
}

/** Exactly `rows` lines of exactly `columns` cells, or the reason it is not. */
function rectangleError (lines, columns, rows) {
  if (lines.length !== rows) return `the pane returned ${lines.length} rows, expected ${rows}`

  for (let i = 0; i < lines.length; i++) {
    const width = displayWidth(lines[i])
    if (width !== columns) return `row ${i} is ${width} columns wide, expected ${columns}`
  }

  return null
}

async function main (argv = []) {
  const options = parseFlags(argv)

  if (options.help) {
    console.log(USAGE)
    return exit(0)
  }

  // --demo renders into a log and the panes are compared as plain strings; a
  // recording and a live run both want the colour.
  setColor(!options.demo)

  // --cols/--rows win wherever they are given. The fixed frame is only the
  // fallback for a headless run that was told nothing, since that run has no
  // terminal to ask; an interactive one falls back to the terminal's own size.
  const columns = options.columns ?? (options.demo ? DEMO_COLUMNS : null)
  const rows = options.rows ?? (options.demo ? DEMO_ROWS : null)
  const screen = new Screen({ interactive: !options.demo, columns, rows })

  // --demo and --record are both driven by the script, so neither reads keys.
  // --record still listens, but only for the quit chord: an operator has to be
  // able to abandon a recording without a stuck terminal.
  const input = options.demo ? null : new Input()

  let world = null
  let frameTimer = null
  let surveyTimer = null
  let stopping = false

  // main() resolves when the app is really over, not when the script runs out:
  // an interactive session outlives its last scene, and `hive demo` awaits this
  // to know it may not carry on parsing the command line.
  let finish = null
  const finished = new Promise((resolve) => { finish = resolve })

  // The restore path, hoisted out of shutdown() so it can also run from the
  // interpreter's own exit hook. Leaving a terminal in raw mode or in the alt
  // buffer is the one failure this program must not have, so it is wired to
  // every exit there is: q, ctrl-c, a signal, a thrown error, normal
  // completion. Both halves are idempotent, so running twice costs nothing.
  function restore () {
    if (input !== null) input.stop()
    screen.stop()
  }

  Bare.on('exit', restore)

  // Bare does not run its 'exit' hook on an uncaught throw or a rejected
  // promise — it prints the stack and aborts — so the hook above covers
  // Bare.exit() and nothing else. These two are the other half: restore the
  // terminal, then report the failure the interpreter was about to report.
  function crash (err) {
    restore()
    console.error(`\ndemo-tui crashed: ${err?.stack ?? err}`)
    exit(1)
  }

  Bare.on('uncaughtException', crash)
  Bare.on('unhandledRejection', crash)

  /**
   * A timer or event callback that must not take the terminal down with it.
   * A pane that throws costs its tick and becomes a notice; the loop, the
   * script and the restore path all survive it.
   */
  function guard (label, fn) {
    return (...args) => {
      try {
        fn(...args)
      } catch (err) {
        if (world !== null) world.notice(`${label}: ${err.message}`, 'error')
      }
    }
  }

  async function shutdown (code) {
    if (stopping) return
    stopping = true

    if (frameTimer !== null) clearInterval(frameTimer)
    if (surveyTimer !== null) clearInterval(surveyTimer)

    // Terminal first, relay second: closing the world can take a second and
    // can throw, and neither may delay handing the terminal back.
    restore()

    try {
      if (world !== null) await world.close()
    } catch (err) {
      console.error(`could not close the demo world cleanly: ${err.message}`)
    }

    finish()
    await exit(code)
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { shutdown(130) })
  }

  world = await createWorld({
    relayUrl: options.relayUrl,
    swarm: options.swarm,
    seed: options.seed
  })

  const state = world.state
  const series = []

  // Runtime-only slices the panes read on top of the frozen world.state
  // fields. They are declared up front so a pane never meets an undefined it
  // has to guess about.
  state.mode = 'user'
  state.focus = null
  state.adminTab = 'overview'
  state.selectedMessage = null
  state.searchQuery = ''
  state.searchResults = null
  state.composer = ''
  state.metrics = world.metrics
  state.series = series
  state.rateHistory = series
  state.relay = null
  state.health = null
  state.connections = []
  state.rejections = []

  const startedAt = Date.now()
  const names = new Map(Object.values(world.actors).map((actor) => [actor.pubkey, actor.name]))

  function nameFor (pubkey) {
    return names.get(pubkey) ?? String(pubkey).slice(0, 8)
  }

  // ------------------------------------------------------------- sampling --

  /**
   * What the admin panes cannot get from the event stream: the NIP-11 document,
   * the live connection table and the store's own totals. Read straight off the
   * relay rather than over HTTP — same numbers, no round trip per frame — and
   * only when this world hosts one.
   */
  function survey () {
    if (world.relay === null || world.store === null) return

    const relay = world.relay

    state.relay = {
      ...relay.info(),
      swarm: relay.swarmKey ?? world.swarmKey ?? null,
      connections: relay.connections.size,
      subscriptions: relay.subscriptions.size
    }

    state.connections = [...relay.connections.values()].map((connection) => ({
      pubkey: connection.pubkey ?? '',
      subscriptions: relay.subscriptions.count(connection.id)
    }))

    // The relay roster is the one projection the event stream can miss: an
    // operator enrols and revokes members through the store the policy reads,
    // and no NIP-43 event is published to invalidate anything. So read the
    // same table the policy checks against.
    state.relayMembers = world.store.listRelayMembers().map((member) => ({
      pubkey: member.pubkey,
      name: nameFor(member.pubkey),
      role: member.role
    }))

    const kinds = world.store.db
      .prepare('SELECT kind, COUNT(*) AS n FROM events WHERE deleted_at IS NULL GROUP BY kind ORDER BY n DESC')
      .all()

    state.health = {
      swarm: state.relay.swarm,
      connections: state.relay.connections,
      subscriptions: state.relay.subscriptions,
      uptimeMs: Date.now() - startedAt,
      kinds,
      events: kinds.reduce((total, row) => total + row.n, 0),
      payloadBytes: world.store.db
        .prepare('SELECT COALESCE(SUM(LENGTH(content) + LENGTH(tags)), 0) AS bytes FROM events')
        .get().bytes,
      media: world.store.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM media').get(),
      // This process is the relay, so its resident set is the relay's.
      memory: process.memoryUsage().rss
    }
  }

  function sample () {
    series.push(world.metrics.eventsPerSecond())
    while (series.length > SERIES_CAP) series.shift()
  }

  // ------------------------------------------------------------ rendering --

  function frame () {
    const pane = state.mode === 'admin' ? panesAdmin : panesUser
    return pane.render(state, { width: screen.columns, height: screen.rows, focus: state.focus })
  }

  function draw () {
    if (stopping) return
    sample()
    screen.render(frame())
  }

  // ----------------------------------------------------------- navigation --

  function setMode (mode) {
    state.mode = mode
    state.focus = mode === 'admin' ? tabById(state.adminTab).focus : USER_FOCUS[0]
  }

  function tabById (id) {
    return panesAdmin.TABS.find((tab) => tab.id === id) ?? panesAdmin.TABS[0]
  }

  function setTab (id) {
    state.adminTab = id
    state.focus = tabById(id).focus
  }

  function cycleTab (delta) {
    const tabs = panesAdmin.TABS
    const at = tabs.findIndex((tab) => tab.id === state.adminTab)
    setTab(tabs[(at + delta + tabs.length) % tabs.length].id)
  }

  /**
   * A pane name as the scenes say it. The tab already open wins if it renders
   * that focus — 'relay' belongs to both Overview and Health, and a scene that
   * opened Health does not mean to be sent back to Overview — then a tab whose
   * id matches the name, then any tab that highlights on it.
   */
  function setFocus (name) {
    state.focus = name
    if (state.mode !== 'admin' || tabById(state.adminTab).focus === name) return

    const tab = panesAdmin.TABS.find((entry) => entry.id === name) ??
      panesAdmin.TABS.find((entry) => entry.focus === name)
    if (tab !== undefined) state.adminTab = tab.id
  }

  function focusNext (delta) {
    // The admin half draws one pane per sub-tab, so there is nothing else for
    // Tab to move between — it walks the strip, like [ and ].
    if (state.mode === 'admin') return cycleTab(delta)

    const at = USER_FOCUS.indexOf(state.focus)
    state.focus = USER_FOCUS[(Math.max(0, at) + delta + USER_FOCUS.length) % USER_FOCUS.length]
  }

  function step (list, id, delta) {
    if (list.length === 0) return null
    const at = list.findIndex((entry) => entry.id === id)
    return list[(Math.max(0, at) + delta + list.length) % list.length].id
  }

  function move (delta) {
    if (state.focus === 'dms') {
      const id = step(state.dms, state.activeChannel, delta)
      if (id !== null) world.setActiveChannel(id)
      return
    }

    if (state.focus === 'messages') {
      const id = step(state.messages[state.activeChannel] ?? [], state.selectedMessage, delta)
      state.selectedMessage = id
      return
    }

    const id = step(state.channels, state.activeChannel, delta)
    if (id !== null) world.setActiveChannel(id)
  }

  // --------------------------------------------------------------- typing --

  let editing = null // null, 'search' or 'compose'

  /** The relay's own words, out of the JSON error body the CLI printed. */
  function reasonOf (err) {
    try {
      return JSON.parse(err.stderr).message
    } catch {
      return err.message
    }
  }

  /**
   * The access pane reads state.rejections as "the relay refused this", so only
   * a refusal the relay actually answered with belongs there. A mistyped
   * command fails argument validation in this process, never reaches the
   * relay, and is a notice and nothing more.
   */
  function noteRefusal (err, action) {
    if (RELAY_REFUSALS.has(err.exitCode)) {
      state.rejections.push({ actor: 'alice', action, reason: reasonOf(err) })
      while (state.rejections.length > REJECTION_CAP) state.rejections.shift()
    }

    world.notice(err.message, 'warn')
  }

  /** Real messages over the real CLI, signed as alice — the keyboard is a client. */
  async function send (content) {
    if (state.activeChannel === null) return world.notice('no channel is selected', 'warn')

    try {
      await world.cli(world.actors.alice, [
        'messages', 'send', '--channel', state.activeChannel, '--content', content
      ])
    } catch (err) {
      noteRefusal(err, 'send')
    }
  }

  async function search (query) {
    try {
      const argv = ['messages', 'search', '--query', query]
      if (state.activeChannel !== null) argv.push('--channel', state.activeChannel)
      state.searchResults = await world.cli(world.actors.alice, argv)
    } catch (err) {
      state.searchResults = []
      noteRefusal(err, 'search')
    }
  }

  /** The printable half of a keystroke, applied to the buffer being edited. */
  function edit (buffer, key) {
    if (key.name === 'backspace') return buffer.slice(0, -1)
    if (key.name === 'space') return buffer + ' '
    if (key.name === 'char' && !key.ctrl) return buffer + key.ch
    return buffer
  }

  function onKey (key) {
    if (key.ctrl && key.name === 'char' && key.ch === 'c') return shutdown(130)

    // While a buffer is open every printable key belongs to it, or / and q
    // would be unwriteable.
    if (editing === 'search') {
      if (key.name === 'escape') {
        editing = null
        state.searchQuery = ''
        state.searchResults = null
        return
      }
      // The query stays open after a search, so refining it is one more key.
      if (key.name === 'enter') return void search(state.searchQuery)
      state.searchQuery = edit(state.searchQuery, key)
      return
    }

    if (editing === 'compose') {
      const text = state.composer
      if (key.name === 'escape' || key.name === 'enter') {
        editing = null
        state.composer = ''
        if (key.name === 'enter' && text !== '') send(text)
        return
      }
      state.composer = edit(text, key)
      return
    }

    switch (key.name) {
      case 'up': return move(-1)
      case 'down': return move(1)
      case 'left': return state.mode === 'admin' ? cycleTab(-1) : focusNext(-1)
      case 'right': return state.mode === 'admin' ? cycleTab(1) : focusNext(1)
      case 'tab': return focusNext(1)
      case 'backtab': return focusNext(-1)
      case 'escape':
        state.searchQuery = ''
        state.searchResults = null
        state.selectedMessage = null
        return
      case 'enter':
        editing = 'compose'
        // Same as search: the composer lives in the transcript pane.
        state.mode = 'user'
        setFocus('composer')
        return
    }

    if (key.name !== 'char' || key.ctrl) return

    switch (key.ch) {
      case 'q': return shutdown(0)
      case '1': return setMode('user')
      case '2': return setMode('admin')
      case '[': return cycleTab(-1)
      case ']': return cycleTab(1)
      case '/':
        editing = 'search'
        state.searchQuery = ''
        state.searchResults = null
        // Search reads the transcript, which only the user half draws — asking
        // for it from an admin tab means asking to go back there.
        state.mode = 'user'
        setFocus('search')
        return
    }

    // 1 and 2 belong to the mode switch, so the strip's own [1] and [2] are
    // labels rather than bindings; the rest of the digits still jump.
    if (state.mode === 'admin' && key.ch >= '3' && key.ch <= '8') {
      const tab = panesAdmin.TABS.find((entry) => entry.key === key.ch)
      if (tab !== undefined) setTab(tab.id)
    }
  }

  // ----------------------------------------------------------- the script --

  const ui = {
    // The status bar is the only narration surface, so a scene's caption states
    // its thesis and each say() replaces it with what is happening right now.
    say (text) {
      state.caption = String(text)
      if (options.demo) return
      draw()
    },

    async pause (ms) {
      if (options.demo || stopping) return
      await sleep(Math.max(0, Math.round(ms / options.speed)))
    },

    focus (name) {
      setFocus(name)
    },

    select (kind, value) {
      if (kind === 'channel') world.setActiveChannel(value)
      else if (kind === 'message') state.selectedMessage = value
      else if (kind === 'run') state.selectedRun = value
      else if (kind === 'persona') state.selectedPersona = value
    }
  }

  const ctx = { world, ui }
  const results = []

  /**
   * --demo output goes through the screen's own stream. console.log is not
   * ordered against it, so a PASS written with console.log drifts above or
   * below the frame it belongs to depending on how the two flush.
   */
  function report (line) {
    process.stdout.write(line + '\n')
  }

  async function play () {
    for (const scene of scenes) {
      if (stopping) break

      state.mode = scene.mode
      state.caption = scene.caption
      // A scene named after a sub-tab opens it; everything else is decided by
      // the first ui.focus() the scene makes.
      if (scene.mode === 'admin') {
        const named = panesAdmin.TABS.some((tab) => tab.id === scene.id)
        setTab(named ? scene.id : 'overview')
      } else {
        state.focus = null
      }

      let failure = null
      let skipped = null
      try {
        await scene.run(ctx)

        // A scene that published outside the CLI left the derived state on a
        // debounce timer, and --demo skips every pause it would have waited
        // out. Settling here is what keeps the frame level with the relay.
        await world.refresh()
        survey()

        if (options.demo) {
          // The only sample a headless run takes: one per scene, so the
          // sparkline in the frame is a real rate history rather than a stub.
          sample()
          const lines = frame()
          failure = rectangleError(lines, screen.columns, screen.rows)
          screen.render(lines)
        }
        // An assert that could not run its real check against this relay says
        // so by returning a reason. That is a scene not verified here — never
        // a pass.
        if (failure === null) skipped = (await scene.assert(ctx))?.skipped ?? null
      } catch (err) {
        failure = err.message
      }

      results.push({ id: scene.id, failure, skipped })

      if (options.demo) {
        if (failure !== null) report(`FAIL ${scene.id} ${failure}`)
        else if (skipped !== null) report(`SKIP ${scene.id} ${skipped}`)
        else report(`PASS ${scene.id}`)
      } else if (failure !== null) {
        world.notice(`${scene.id}: ${failure}`, 'error')
      }
    }

    return results.filter((result) => result.failure !== null).length
  }

  /** " (2 skipped)", or nothing at all when every scene ran its own check. */
  function skippedSuffix () {
    const count = results.filter((result) => result.skipped !== null).length
    return count === 0 ? '' : ` (${count} skipped)`
  }

  // ------------------------------------------------------------------ run --

  survey()

  if (options.demo) {
    const failures = await play()
    const skippedCount = results.filter((result) => result.skipped !== null).length
    const passed = results.length - failures - skippedCount
    report(`\n${passed}/${results.length} scene(s) passed${skippedSuffix()}`)
    return shutdown(failures === 0 ? 0 : 1)
  }

  screen.start()
  screen.on('resize', guard('resize', draw))

  if (input !== null) {
    input.start()
    // Guarded as one unit: the draw is as much part of handling a key as the
    // key handler is, and a pane that rejects the state a keystroke produced
    // must not be the thing that ends the session.
    input.on('key', guard('key', (key) => {
      // --record is the script's recording, so the keyboard may stop it and
      // nothing else — a stray arrow key must not steer a take.
      if (options.record) {
        if (key.name === 'char' && (key.ch === 'q' || (key.ctrl && key.ch === 'c'))) shutdown(130)
        return
      }

      onKey(key)
      draw()
    }))
  }

  const tick = guard('frame', draw)
  frameTimer = setInterval(tick, FRAME_MS)
  surveyTimer = setInterval(guard('survey', survey), SAMPLE_MS)
  tick()

  const failures = await play()
  const skipped = skippedSuffix()
  state.caption = failures === 0 && skipped === ''
    ? `all ${results.length} scenes passed — press q to quit`
    : `${failures} of ${results.length} scenes failed${skipped} — press q to quit`
  draw()

  // A recording has to end for the cast to be a demo rather than a session; an
  // interactive run stays up so the terminal can be explored afterwards.
  if (options.record) await shutdown(failures === 0 ? 0 : 1)

  await finished
}

function start (argv) {
  return main(argv).catch((err) => {
    console.error(`\ndemo-tui failed: ${err.message}`)
    console.error(err.stack)
    return exit(1)
  })
}

module.exports = { main, start }

// Only when this file is the entry script. `hive demo` imports the module and
// hands it the binary's own argv instead, so loading it must not start a relay.
if (/(^|[/\\])demo-tui\.js$/.test(Bare.argv[1] ?? '')) start(Bare.argv.slice(2))

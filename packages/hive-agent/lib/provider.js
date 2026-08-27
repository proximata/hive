'use strict'

/**
 * The inference boundary.
 *
 * Everything above this line is protocol; everything below is a model. Keeping
 * them apart is what lets the whole relay and agent test suite run with no GPU,
 * no model download and no network — and what lets a persona choose a local
 * model, a delegated peer, or something else entirely without the harness
 * caring.
 *
 *   capabilities()  -> string[]                     what this provider can do
 *   complete(req)   -> { events, final }            streaming generation
 *   embed(texts)    -> number[][]
 *   transcribe(pcm) -> { text }
 *   speak(text)     -> { audio }
 *
 * `complete` returns an object with an async-iterable `events` and a `final`
 * promise, mirroring the QVAC SDK's CompletionRun so the real adapter is a thin
 * translation rather than a re-shaping.
 *
 * Three OPTIONAL fields on `final` let a provider drive the harness without the
 * harness knowing anything about a particular model. All three are ignored when
 * absent, so QVAC and Mock are unaffected:
 *
 *   mentions  string[]              who the reply p-tags, REPLACING the default
 *                                   "whoever triggered me". This is what lets an
 *                                   agent address a third party at all.
 *   delegate  { to, prompt }        hand the work on: the harness publishes a
 *                                   kind-43001 job request to `to`.
 *   memo      { slug, content }     record this to the log as a kind-30174
 *                                   engram before the reply goes out.
 *
 * And one optional stream event: `{ type: 'progress', text }`, which the harness
 * republishes as kind-43003 job progress. A provider that narrates its work gets
 * that narration onto the audit log for free.
 */

const core = require('hive-core')

const CAPABILITIES = {
  TEXT_GENERATION: 'text-generation',
  EMBEDDINGS: 'embeddings',
  TRANSCRIPTION: 'transcription',
  TEXT_TO_SPEECH: 'text-to-speech',
  RAG: 'rag',
  IMAGE_GENERATION: 'image-generation',
  TRANSLATION: 'translation'
}

class InferenceProvider {
  async capabilities () {
    throw new Error('not implemented')
  }

  complete () {
    throw new Error('not implemented')
  }

  async embed () {
    throw new Error(`${this.constructor.name} does not support embeddings`)
  }

  async transcribe () {
    throw new Error(`${this.constructor.name} does not support transcription`)
  }

  async speak () {
    throw new Error(`${this.constructor.name} does not support speech synthesis`)
  }

  async close () {}
}

/**
 * Deterministic provider used by every test and by `--inference mock`.
 *
 * It is deliberately dull: given the same history it produces the same reply,
 * so a test can assert on exact output and a failure means the harness broke,
 * not that a model drifted.
 */
class MockProvider extends InferenceProvider {
  constructor (opts = {}) {
    super()
    this.model = opts.model ?? 'mock-1'
    this.systemPrompt = opts.systemPrompt ?? null
    this.reply = opts.reply ?? null
    this.delay = opts.delay ?? 0
    this.calls = []
  }

  async capabilities () {
    return [CAPABILITIES.TEXT_GENERATION, CAPABILITIES.EMBEDDINGS]
  }

  complete ({ history = [], tools = [], signal = null } = {}) {
    this.calls.push({ history, tools })

    const last = [...history].reverse().find((m) => m.role === 'user')
    const text = this.reply ?? summarize(last?.content ?? '')
    const chunks = text.match(/.{1,16}/gs) ?? ['']

    const self = this
    const final = { content: text, model: this.model, thinking: null, toolCalls: [], stats: { tokens: chunks.length } }

    return {
      events: (async function * () {
        for (const chunk of chunks) {
          if (signal?.aborted) return
          if (self.delay > 0) await new Promise((resolve) => setTimeout(resolve, self.delay))
          yield { type: 'contentDelta', text: chunk }
        }
        yield { type: 'final', final }
      })(),
      final: Promise.resolve(final)
    }
  }

  async embed (texts) {
    // A stable bag-of-characters projection: not useful for retrieval, but
    // deterministic and dimensionally correct, which is what a test needs.
    return (Array.isArray(texts) ? texts : [texts]).map((text) => {
      const vector = new Array(8).fill(0)
      for (let i = 0; i < text.length; i++) vector[i % 8] += text.charCodeAt(i) / 1000
      return vector
    })
  }
}

function summarize (prompt) {
  const cleaned = prompt.replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) return 'I received an empty message.'
  return `Acknowledged: ${cleaned.slice(0, 120)}`
}

// ------------------------------------------------------------- triage --

// Urgency, most severe first, first match wins. Deliberately a small readable
// ladder rather than a classifier: the point is that the label is DERIVED from
// the text and can be checked by reading it, not that it is clever.
const URGENCY = [
  ['critical', /\b(outage|sev-?1|breach|data ?loss|paging|is down|on fire)\b/i],
  ['high', /\b(block(ed|er)|regression|failing|urgent|asap|deadline|rollback|revert)\b/i],
  ['normal', /\b(review|question|can you|could you|when|need|please|ship|deploy|ask)\b/i]
]

// Words that carry no signal in a one-line work request. Dropping them is what
// makes the summary shorter than the input rather than a slice of it.
const FILLER = new Set((
  'a an the and or but so just really very please can could would should i we you ' +
  'my our your to of is are was were be been it its that this these those for on ' +
  'in at with from by about as if then there here do does did have has had will'
).split(' '))

const LEVELS = ['low', 'normal', 'high', 'critical']

function classify (text) {
  for (const [level, pattern] of URGENCY) if (pattern.test(text)) return level
  return 'low'
}

// The wire format one scripted agent uses to hand work to another:
//
//   @scout — relayed for alice [high]: <payload> · <trail>
//
// Owned here rather than by the caller precisely so it can be taken apart
// again. Without that, the second agent in a chain summarises the FIRST agent's
// envelope instead of the request inside it, and by the third hop the message
// is a summary of a header. Routing still matches the whole line — the header
// IS the addressing — but triage only ever sees the payload.
const ENVELOPE = /^@(\S+)\s+—\s+(.*?)\s+\[(critical|high|normal|low)\]:\s*/
const TRAIL = ' · '

function unwrap (text) {
  const match = ENVELOPE.exec(text)
  const declared = match === null ? null : match[3]
  let payload = match === null ? text : text.slice(match[0].length)

  const cut = payload.lastIndexOf(TRAIL)
  if (cut > 0) payload = payload.slice(0, cut)

  return { payload: payload.trim(), declared }
}

/** The more severe of two labels. An upstream agent's urgency is never lost. */
function escalate (level, declared) {
  if (declared === null) return level
  return LEVELS.indexOf(declared) > LEVELS.indexOf(level) ? declared : level
}

/**
 * Extractive summary: drop filler, keep order, cap the length.
 *
 * Lossy on purpose and reversible by eye — a reader can diff it against the
 * original and see exactly what was thrown away, which is the property a
 * `sleep()` pretending to think does not have.
 */
function condense (text, max = 16) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter((w) => w.length > 0)
  const kept = words.filter((w) => !FILLER.has(w.toLowerCase().replace(/[^a-z0-9-]/gi, '')))
  const chosen = kept.length > 0 ? kept : words
  return chosen.slice(0, max).join(' ') + (chosen.length > max ? '…' : '')
}

/**
 * A deterministic provider that triages instead of parroting.
 *
 * QVAC is an optional peer dependency and is not installed, so there is no
 * model on this machine at all. That makes a scripted provider the only
 * available choice — and the right one anyway for a recorded demo, because the
 * same input produces byte-identical output on every take.
 *
 * What it actually does with a message, all of it derived from the text:
 *
 *   1. classify  urgency from the words present
 *   2. condense  an extractive summary
 *   3. route     the first `routes[]` entry whose `when` matches decides who
 *                the reply addresses, and whether that is a delegation
 *   4. memo      a triage record keyed by the hash of the request
 *
 * Routing is the interesting half: `route.to` becomes `final.mentions`, which
 * the harness uses INSTEAD of "reply to whoever asked". That is the whole
 * mechanism behind human → agent → agent → human; there is no new event kind
 * under it.
 *
 * A route is `{ name, when: RegExp, to: pubkey, toName, note, trail, delegate }`.
 * `when` is matched against the WHOLE incoming line, envelope included, because
 * the envelope is the addressing; `note` and `trail` are this agent's own words
 * around the payload it forwards.
 */
class ScriptedProvider extends InferenceProvider {
  constructor (opts = {}) {
    super()
    this.model = opts.model ?? 'scripted-1'
    this.name = opts.name ?? 'agent'
    this.routes = opts.routes ?? []
    this.systemPrompt = opts.systemPrompt ?? null
    // Streaming is visible work: the UI paints deltas as they land, so a turn
    // that returns in one lump looks like nothing happened.
    this.chunkDelay = opts.chunkDelay ?? 0
    this.chunkSize = opts.chunkSize ?? 14
    this.calls = []
  }

  async capabilities () {
    // Only what it can really do. Claiming embeddings here would put a lie in
    // the kind-10100 discovery surface.
    return [CAPABILITIES.TEXT_GENERATION]
  }

  routeFor (text) {
    for (const route of this.routes) if (route.when.test(text)) return route
    return null
  }

  complete ({ history = [], tools = [], signal = null } = {}) {
    this.calls.push({ history, tools })

    const last = [...history].reverse().find((m) => m.role === 'user')
    const incoming = (last?.content ?? '').replace(/\s+/g, ' ').trim()
    const from = last?.name ?? 'unknown'

    // Route on what arrived; triage what it contains.
    const route = this.routeFor(incoming)
    const { payload: request, declared } = unwrap(incoming)

    const urgency = escalate(classify(request), declared)
    const summary = condense(request)

    // Slugged by the hash of the request, so the same request always lands on
    // the same addressable slot — a repeat replaces rather than piles up — and
    // a checker that knows the text can compute the slug and read it back.
    const memo = {
      slug: `triage/${core.toHex(core.sha256(Buffer.from(request, 'utf8'))).slice(0, 12)}`,
      content: JSON.stringify({
        by: this.name,
        from,
        urgency,
        escalated_from: declared === null ? null : classify(request),
        summary,
        words_in: request.split(' ').filter((w) => w.length > 0).length,
        words_out: summary.split(' ').length,
        route: route?.name ?? null,
        forwarded_to: route?.to ?? null
      })
    }

    const steps = [
      `triage: ${from} → urgency ${urgency}`,
      `store: engram ${memo.slug} (${memo.content.length}B)`,
      route === null
        ? 'process: no route matched — answering in place'
        : `process: route “${route.name}” → ${route.to.slice(0, 8)}…${route.delegate === true ? ' (delegating)' : ''}`
    ]

    const text = route === null
      ? `[${urgency}] ${summary} — no onward route; holding the context here.`
      : `@${route.toName ?? route.to.slice(0, 8)} — ${route.note} [${urgency}]: ${summary}${TRAIL}${route.trail}`

    const chunks = text.match(new RegExp(`.{1,${this.chunkSize}}`, 'gs')) ?? ['']

    const final = {
      content: text,
      model: this.model,
      thinking: null,
      toolCalls: [],
      mentions: route === null ? null : [route.to],
      delegate: route?.delegate === true ? { to: route.to, prompt: text } : null,
      memo,
      stats: { tokens: chunks.length, urgency, route: route?.name ?? null }
    }

    const self = this
    return {
      events: (async function * () {
        for (const step of steps) {
          if (signal?.aborted) return
          yield { type: 'progress', text: step }
        }
        for (const chunk of chunks) {
          if (signal?.aborted) return
          if (self.chunkDelay > 0) await new Promise((resolve) => setTimeout(resolve, self.chunkDelay))
          yield { type: 'contentDelta', text: chunk }
        }
        yield { type: 'final', final }
      })(),
      final: Promise.resolve(final)
    }
  }
}

module.exports = { InferenceProvider, MockProvider, ScriptedProvider, CAPABILITIES, classify, condense, unwrap }

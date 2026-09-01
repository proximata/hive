'use strict'

const { InferenceProvider, CAPABILITIES } = require('./provider')

/**
 * QVAC adapter — Tether's local-first inference SDK.
 *
 * `@qvac/sdk` is required lazily and is an optional dependency, so neither the
 * relay nor the test suite ever needs it installed. A persona selects this
 * provider with `runtime: "qvac"`.
 *
 * The require goes through the `#qvac-sdk` import rather than naming the SDK
 * directly, so that a bundler resolving the graph ahead of time finds the
 * `lib/qvac-absent.js` fallback instead of failing the build. See that file.
 *
 * Delegated inference is the interesting part for a Pears deployment: when a
 * persona names a `provider` public key, `loadModel` is given a `delegate`
 * block and inference runs on a remote peer over HyperDHT — the same DHT the
 * relay transport uses. A laptop agent can run a model it could never host,
 * and neither machine needs a public address.
 */
class QvacProvider extends InferenceProvider {
  constructor (opts = {}) {
    super()
    this.modelSrc = opts.model ?? 'LLAMA_3_2_1B_INST_Q4_0'
    this.systemPrompt = opts.systemPrompt ?? null
    this.delegate = opts.delegate ?? null // { providerPublicKey, timeout, fallbackToLocal }
    this.sdk = opts.sdk ?? null
    this.modelId = null
    this.onProgress = opts.onProgress ?? null
  }

  #load () {
    if (this.sdk !== null) return this.sdk
    try {
      this.sdk = require('#qvac-sdk')
    } catch {
      throw new Error(
        'the qvac runtime needs @qvac/sdk installed: npm install @qvac/sdk ' +
        '(or run with --inference mock)'
      )
    }
    return this.sdk
  }

  // On Bare the SDK ships no plugins by default: the first call fails with
  // WORKER_PLUGINS_NOT_REGISTERED unless the engine is registered up front.
  // Registered lazily and once, because `plugins()` is process-global.
  #registerPlugins (sdk) {
    if (QvacProvider.pluginsRegistered === true) return
    if (typeof sdk.plugins !== 'function') return
    // The package `exports` map declares these subpaths with an "import"
    // condition only, so Bare's `require` cannot resolve `@qvac/sdk/...`.
    // ponytail: reached by relative file path instead. Ceiling — this breaks
    // if the SDK moves its dist layout. Upgrade path: use `@qvac/bare-sdk`,
    // which the SDK's own error message recommends for direct Bare usage.
    const plugin = require('../../../node_modules/@qvac/sdk/dist/server/bare/plugins/llamacpp-completion/plugin.js')
    sdk.plugins([plugin.llmPlugin])
    QvacProvider.pluginsRegistered = true
  }

  // `loadModel` needs a descriptor carrying engine metadata, not a bare name:
  // a plain string fails with MODEL_TYPE_REQUIRED. A persona names a model as
  // a string, so resolve that name against the SDK's exported constants.
  // An SDK that does not export the name is not an error: a caller may pass a
  // descriptor the SDK understands, and the test suite injects a fake SDK that
  // exports no constants at all. Pass the string through and let loadModel
  // reject it, so this method resolves what it can and refuses nothing.
  #resolveModel (sdk) {
    if (typeof this.modelSrc !== 'string') return this.modelSrc
    return sdk[this.modelSrc] ?? this.modelSrc
  }

  async ready () {
    if (this.modelId !== null) return this.modelId
    const sdk = this.#load()
    this.#registerPlugins(sdk)

    const params = { modelSrc: this.#resolveModel(sdk) }
    if (this.onProgress !== null) params.onProgress = this.onProgress
    if (this.delegate !== null) {
      params.delegate = {
        providerPublicKey: this.delegate.providerPublicKey,
        // The first call on a cold DHT can take 15-45s to bootstrap and find
        // the provider; later calls reuse the open socket and are sub-second.
        timeout: this.delegate.timeout ?? 60000,
        fallbackToLocal: this.delegate.fallbackToLocal ?? true
      }
    }

    this.modelId = await sdk.loadModel(params)
    return this.modelId
  }

  async capabilities () {
    // What this configuration can actually do. Advertised in the agent's
    // kind-10100 profile so "who here can transcribe audio?" is a filter query.
    const caps = [CAPABILITIES.TEXT_GENERATION]
    const sdk = this.sdk ?? tryLoad()
    if (sdk === null) return caps

    if (typeof sdk.embed === 'function') caps.push(CAPABILITIES.EMBEDDINGS)
    if (typeof sdk.transcribe === 'function') caps.push(CAPABILITIES.TRANSCRIPTION)
    if (typeof sdk.textToSpeech === 'function') caps.push(CAPABILITIES.TEXT_TO_SPEECH)
    if (typeof sdk.ragSearch === 'function') caps.push(CAPABILITIES.RAG)
    if (typeof sdk.translate === 'function') caps.push(CAPABILITIES.TRANSLATION)
    return caps
  }

  complete ({ history = [], tools = [], signal = null } = {}) {
    // Only when the caller did not bring one. The harness builds the system
    // message itself (agent.js `_systemPrompt`), so prepending unconditionally
    // sent the model two system turns — and the stale one first, which is
    // exactly wrong once a home directory overrides the persona's prompt.
    const messages = this.systemPrompt === null || history[0]?.role === 'system'
      ? history
      : [{ role: 'system', content: this.systemPrompt }, ...history]

    const self = this
    let run = null

    const start = async () => {
      const sdk = self.#load()
      await self.ready()
      run = sdk.completion({ modelId: self.modelId, history: messages, tools, stream: true })

      if (signal !== null) {
        signal.addEventListener?.('abort', () => {
          try {
            sdk.cancel?.({ requestId: run.requestId })
          } catch {
            // Cancellation is best-effort; the stream ends either way.
          }
        })
      }
      return run
    }

    const started = start()

    return {
      events: (async function * () {
        const active = await started
        // QVAC's CompletionEvent shape is already what the harness consumes:
        // contentDelta / toolCall / final.
        for await (const event of active.events) yield event
      })(),
      // QVAC names the finished text `contentText`; the harness reads
      // `content`. Without this the harness silently falls back to the
      // concatenated deltas — right answer today, but wrong the moment a
      // non-streaming run returns text with no deltas at all.
      final: started.then((active) => active.final).then((final) => (
        final !== null && typeof final === 'object' && final.content === undefined
          ? { ...final, content: final.contentText }
          : final
      ))
    }
  }

  async embed (texts) {
    const sdk = this.#load()
    await this.ready()
    return sdk.embed({ modelId: this.modelId, texts: Array.isArray(texts) ? texts : [texts] })
  }

  async transcribe (audio) {
    const sdk = this.#load()
    return sdk.transcribe({ audio })
  }

  async speak (text) {
    const sdk = this.#load()
    return sdk.textToSpeech({ text })
  }

  async close () {
    if (this.modelId === null || this.sdk === null) return
    try {
      await this.sdk.unloadModel({ modelId: this.modelId })
    } catch {
      // Unloading a model that is already gone is not worth failing shutdown.
    }
    this.modelId = null
  }
}

function tryLoad () {
  try {
    return require('#qvac-sdk')
  } catch {
    return null
  }
}

/**
 * Build a provider from a persona's runtime fields. This is the single place
 * that decides what `runtime: "qvac"` means, so the CLI, the harness and any
 * future client all agree.
 */
function providerFromPersona (persona, opts = {}) {
  const { MockProvider, ScriptedProvider } = require('./provider')
  const runtime = persona?.runtime ?? opts.defaultRuntime ?? 'mock'

  if (runtime === 'qvac') {
    return new QvacProvider({
      model: persona.model ?? undefined,
      systemPrompt: persona.system_prompt ?? null,
      delegate: persona.provider ? { providerPublicKey: persona.provider } : null,
      sdk: opts.sdk ?? null
    })
  }

  if (runtime === 'mock') {
    return new MockProvider({
      model: persona?.model ?? 'mock-1',
      systemPrompt: persona?.system_prompt ?? null,
      ...opts.mock
    })
  }

  // Routes cannot come from a persona document — they are pubkeys, resolved at
  // wiring time — so `opts.scripted` carries them.
  if (runtime === 'scripted') {
    return new ScriptedProvider({
      name: persona?.slug ?? persona?.display_name ?? 'agent',
      systemPrompt: persona?.system_prompt ?? null,
      ...opts.scripted
    })
  }

  throw new Error(`unknown persona runtime: ${runtime}`)
}

module.exports = { QvacProvider, providerFromPersona }

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
// The persona-to-model mapping.
//
// A persona's `model` is one of three things, checked in this order:
//
//   1. a size alias below — what a persona should normally say, because
//      "medium" survives the SDK renaming a quantization and `QWEN3_4B_Q4_K_M`
//      does not;
//   2. an SDK constant name, passed through and resolved against the SDK's
//      exports (`sdk.LLAMA_3_2_1B_INST_Q4_0`), for a persona that wants an
//      exact build;
//   3. a descriptor object or a URL/path string the SDK understands.
//
// Only text generation is mapped. The SDK exports ~400 constants including
// whisper, TTS and diffusion builds; an agent turn is a chat completion, and
// aliasing anything else here would be inventing a capability the harness does
// not drive.
const MODELS = {
  small: 'LLAMA_3_2_1B_INST_Q4_0', //  ~0.8 GB — answers a chat turn on a laptop CPU
  medium: 'QWEN3_4B_INST_Q4_K_M', //   ~2.5 GB
  large: 'QWEN3_8B_INST_Q4_K_M' //     ~5 GB, wants a GPU
}

// The smallest thing that works, because the first run of a new agent should
// not be a multi-gigabyte download nobody asked for.
const DEFAULT_MODEL = MODELS.small

// An SDK constant name: SHOUTING_SNAKE_CASE. Anything else lowercase that is
// not an alias is a typo, and saying so beats letting loadModel fail with a
// registry error four layers down.
const CONSTANT = /^[A-Z][A-Z0-9_]*$/

function formatBytes (bytes) {
  if (typeof bytes !== 'number' || bytes <= 0) return null
  return `${(bytes / 1e9).toFixed(1)} GB`
}

class QvacProvider extends InferenceProvider {
  constructor (opts = {}) {
    super()
    this.modelSrc = opts.model ?? DEFAULT_MODEL
    this.systemPrompt = opts.systemPrompt ?? null
    this.delegate = opts.delegate ?? null // { providerPublicKey, timeout, fallbackToLocal }
    this.sdk = opts.sdk ?? null
    this.modelId = null
    this.onProgress = opts.onProgress ?? null
    // Where the model download narrates itself. Null is silent, which is what a
    // test wants and what a browser has no console discipline for; `hive agent
    // run` passes its logger.
    this.log = opts.log ?? null
    this.closeTimeout = opts.closeTimeout ?? 5000
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
    let plugin
    try {
      plugin = require('../../../node_modules/@qvac/sdk/dist/server/bare/plugins/llamacpp-completion/plugin.js')
    } catch {
      throw new Error(
        '@qvac/sdk is installed but its Bare llamacpp plugin could not be reached at ' +
        'dist/server/bare/plugins/llamacpp-completion/plugin.js — the dist layout moved. ' +
        'Use @qvac/bare-sdk, which the SDK recommends for direct Bare use.'
      )
    }
    sdk.plugins([plugin.llmPlugin])
    QvacProvider.pluginsRegistered = true
  }

  // `loadModel` needs a descriptor carrying engine metadata, not a bare name:
  // a plain string fails with MODEL_TYPE_REQUIRED. A persona names a model as
  // a string, so resolve the alias, then the SDK's exported constants.
  //
  // An SDK that does not export a SHOUTING_SNAKE_CASE name is not an error: a
  // caller may pass a descriptor or a URL the SDK understands, and the test
  // suite injects a fake SDK that exports no constants at all. A lowercase name
  // that is not an alias IS an error, and says what the aliases are — that case
  // is a persona typo, and a registry error four layers down does not name it.
  #resolveModel (sdk) {
    if (typeof this.modelSrc !== 'string') return this.modelSrc

    const name = MODELS[this.modelSrc] ?? this.modelSrc
    const descriptor = sdk[name]
    if (descriptor !== undefined) return descriptor

    if (!CONSTANT.test(name)) {
      throw new Error(
        `unknown model "${this.modelSrc}": use one of ${Object.keys(MODELS).join(', ')}, ` +
        'an @qvac/sdk model constant, or a descriptor'
      )
    }
    return name
  }

  /**
   * Say what is about to be downloaded, before it is.
   *
   * The first load of a model fetches its weights — 0.8 GB for the default and
   * several times that for `large` — and until it lands the process looks
   * hung: no output, no reply, nothing on the relay. An operator who was not
   * told will kill it at the two-minute mark and conclude the agent is broken.
   * So the size is printed up front from the descriptor's own `expectedSize`,
   * and progress at every 10%.
   */
  #announce (descriptor) {
    if (this.log === null) return null

    const name = typeof descriptor === 'object' && descriptor !== null
      ? descriptor.name ?? this.modelSrc
      : descriptor
    const size = formatBytes(descriptor?.expectedSize)

    this.log(size === null
      ? `[qvac] loading ${name}`
      : `[qvac] loading ${name} (${size}) — the first load downloads the weights and can take ` +
        'several minutes; later loads reuse the cache')

    let last = -1
    return (progress) => {
      const percent = Math.floor(Number(progress?.percentage ?? 0) / 10) * 10
      if (percent > last) {
        last = percent
        this.log(`[qvac] ${name}: ${percent}%`)
      }
    }
  }

  async ready () {
    if (this.modelId !== null) return this.modelId
    const sdk = this.#load()
    this.#registerPlugins(sdk)

    const modelSrc = this.#resolveModel(sdk)
    const params = { modelSrc }

    // Both callbacks, when both exist: the caller's own progress handling is
    // not something an operator-facing log line gets to replace.
    const announce = this.#announce(modelSrc)
    if (this.onProgress !== null || announce !== null) {
      params.onProgress = (progress) => {
        announce?.(progress)
        this.onProgress?.(progress)
      }
    }
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

  /**
   * Release the model and the SDK's workers.
   *
   * Bounded, because shutdown must terminate: neither call may throw and
   * neither may run forever.
   *
   * The deadline covers an SDK that stalls ASYNCHRONOUSLY. It cannot cover one
   * that blocks the thread, and @qvac/sdk 0.18.2 under Bare does exactly that:
   * `unloadModel` after a real completion never returns, starving every timer
   * including this one. That is why `hive agent run` does not call close() on
   * its way out at all — see `stopAndExit` in lib/run.js.
   *
   * ponytail: a timeout rather than a fix, because the hang is inside the SDK.
   * Upgrade path: @qvac/bare-sdk, which owns its own Bare worker lifecycle.
   */
  async close () {
    const sdk = this.sdk
    if (sdk === null) return

    if (this.modelId !== null) {
      await deadline(() => sdk.unloadModel({ modelId: this.modelId }), this.closeTimeout)
      this.modelId = null
    }
    await deadline(() => sdk.close?.(), this.closeTimeout)
  }
}

/** Run `fn`, and give up after `ms`. Never throws: this is teardown. */
function deadline (fn, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // A Bare process will not exit while a timer is pending, which would turn
    // this guard into the very hang it exists to prevent.
    timer.unref?.()

    Promise.resolve().then(fn).then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() }
    )
  })
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
      sdk: opts.sdk ?? null,
      log: opts.log ?? null
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

module.exports = { QvacProvider, providerFromPersona, MODELS, DEFAULT_MODEL }

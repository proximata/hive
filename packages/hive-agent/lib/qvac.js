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

  async ready () {
    if (this.modelId !== null) return this.modelId
    const sdk = this.#load()

    const params = { modelSrc: this.modelSrc }
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
    const messages = this.systemPrompt === null
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
      final: started.then((active) => active.final)
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
  const { MockProvider } = require('./provider')
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

  throw new Error(`unknown persona runtime: ${runtime}`)
}

module.exports = { QvacProvider, providerFromPersona }

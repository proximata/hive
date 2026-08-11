'use strict'

const { InferenceProvider, CAPABILITIES } = require('./provider')
const { spawn } = require('bare-process')

/**
 * Coding agent provider — delegates inference to external coding agents
 * (Claude Code, Codex, OpenCode, etc.) like Buzz does.
 *
 * This provider is selected with `runtime: "coding-agent"` in a persona.
 * It detects available coding agents on the system and uses them for
 * code generation tasks.
 *
 * For non-coding tasks, it falls back to a local model (QVAC or Mock).
 */

// Cross-runtime environment access (Bare uses bare-env, Node uses process.env)
const bareEnv = (() => {
  try { return require('bare-env') } catch { return null }
})()

function getEnv () {
  if (bareEnv) return bareEnv
  return globalThis.process?.env ?? {}
}

function getCwd () {
  try { return require('bare-fs').cwd() } catch { return globalThis.process?.cwd?.() ?? '.' }
}

// Known coding agents and their CLI commands
const CODING_AGENTS = [
  { name: 'claude-code', cmd: 'claude', args: ['-p'], detect: ['--version'] },
  { name: 'codex', cmd: 'codex', args: ['exec'], detect: ['--version'] },
  { name: 'opencode', cmd: 'opencode', args: ['run'], detect: ['--version'] },
  { name: 'cursor', cmd: 'cursor', args: ['--cli'], detect: ['--version'] }
]

class CodingAgentProvider extends InferenceProvider {
  constructor (opts = {}) {
    super()
    this.preferredAgent = opts.agent ?? null // Specific agent to prefer
    this.systemPrompt = opts.systemPrompt ?? null
    this.fallbackProvider = opts.fallbackProvider ?? null
    this.agent = null
    this.workDir = opts.workDir ?? getCwd()
    this.timeout = opts.timeout ?? 300000 // 5 minutes default
  }

  /**
   * Detect available coding agents on the system.
   * Returns the first one that responds to version check.
   */
  async #detectAgent () {
    if (this.preferredAgent) {
      const agent = CODING_AGENTS.find(a => a.name === this.preferredAgent)
      if (agent && await this.#checkAgent(agent)) return agent
      throw new Error(`Preferred agent ${this.preferredAgent} not available`)
    }

    for (const agent of CODING_AGENTS) {
      if (await this.#checkAgent(agent)) return agent
    }

    return null
  }

  async #checkAgent (agent) {
    try {
      const result = await this.#runCommand(agent.cmd, [...agent.detect], { timeout: 5000 })
      return result.exitCode === 0
    } catch {
      return false
    }
  }

  async #runCommand (cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd ?? this.workDir,
        env: { ...getEnv(), ...opts.env }
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data) => { stdout += data.toString() })
      child.stderr?.on('data', (data) => { stderr += data.toString() })

      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`Command timed out after ${opts.timeout ?? this.timeout}ms`))
      }, opts.timeout ?? this.timeout)

      child.on('close', (code) => {
        clearTimeout(timeout)
        resolve({ exitCode: code, stdout, stderr })
      })

      child.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  async ready () {
    if (this.agent !== null) return this.agent

    this.agent = await this.#detectAgent()
    if (this.agent === null) {
      throw new Error(
        'No coding agent found. Install one of: claude-code, codex, opencode, cursor. ' +
        'Or specify a fallback provider.'
      )
    }

    return this.agent
  }

  async capabilities () {
    const caps = [CAPABILITIES.TEXT_GENERATION]

    // If we have a coding agent, we can do code-related tasks
    if (this.agent !== null || await this.#detectAgent()) {
      caps.push(CAPABILITIES.CODING)
    }

    // Fallback provider may have additional capabilities
    if (this.fallbackProvider) {
      const fallbackCaps = await this.fallbackProvider.capabilities()
      caps.push(...fallbackCaps)
    }

    return [...new Set(caps)]
  }

  /**
   * Complete a coding task using the external coding agent.
   *
   * The prompt is sent to the coding agent as a task. The agent's output
   * is streamed back as contentDelta events.
   */
  complete ({ history = [], tools = [], signal = null } = {}) {
    const self = this

    const start = async () => {
      await self.ready()

      // Build the prompt from history
      const prompt = self.#buildPrompt(history)

      // Add system prompt if present
      const fullPrompt = self.systemPrompt
        ? `${self.systemPrompt}\n\n${prompt}`
        : prompt

      // Run the coding agent
      const run = await self.#runCodingAgent(fullPrompt, tools, signal)
      return run
    }

    const started = start()

    return {
      events: (async function * () {
        const active = await started
        for await (const event of active.events) yield event
      })(),
      final: started.then((active) => active.final)
    }
  }

  #buildPrompt (history) {
    // Convert history to a prompt suitable for a coding agent
    const parts = []

    for (const msg of history) {
      if (msg.role === 'system') {
        parts.push(`[System]: ${msg.content}`)
      } else if (msg.role === 'user') {
        const name = msg.name ? ` (from ${msg.name})` : ''
        parts.push(`[User${name}]: ${msg.content}`)
      } else if (msg.role === 'assistant') {
        parts.push(`[Assistant]: ${msg.content}`)
      }
    }

    return parts.join('\n\n')
  }

  async #runCodingAgent (prompt, tools, signal) {
    const agent = this.agent
    if (!agent) throw new Error('No coding agent available')

    // Prepare the command based on the agent
    const cmdArgs = this.#getAgentArgs(agent, prompt)

    return new Promise((resolve, reject) => {
      const child = spawn(agent.cmd, cmdArgs, {
        cwd: this.workDir,
        env: { ...getEnv() }
      })

      let stdout = ''
      let stderr = ''
      let hasError = false

      const events = []
      let finalContent = ''

      child.stdout?.on('data', (data) => {
        const text = data.toString()
        stdout += text
        finalContent += text
        events.push({ type: 'contentDelta', text })
      })

      child.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      const onAbort = () => {
        child.kill('SIGTERM')
      }

      if (signal) {
        signal.addEventListener?.('abort', onAbort)
      }

      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`Coding agent timed out after ${this.timeout}ms`))
      }, this.timeout)

      child.on('close', (code) => {
        clearTimeout(timeout)
        if (signal) signal.removeEventListener?.('abort', onAbort)

        if (code !== 0 && !hasError) {
          hasError = true
          reject(new Error(`Coding agent exited with code ${code}: ${stderr}`))
          return
        }

        const final = {
          content: finalContent || '(no response)',
          model: agent.name,
          thinking: null,
          toolCalls: [],
          stats: { tokens: finalContent.length }
        }

        events.push({ type: 'final', final })

        resolve({
          events: (async function * () {
            for (const event of events) yield event
          })(),
          final: Promise.resolve(final)
        })
      })

      child.on('error', (err) => {
        clearTimeout(timeout)
        if (signal) signal.removeEventListener?.('abort', onAbort)
        hasError = true
        reject(err)
      })
    })
  }

  #getAgentArgs (agent, prompt) {
    const baseArgs = [...agent.args]

    switch (agent.name) {
      case 'claude-code':
        // claude -p "prompt" --max-turns 10
        return [...baseArgs, prompt, '--max-turns', '10']
      case 'codex':
        // codex exec "prompt"
        return [...baseArgs, prompt]
      case 'opencode':
        // opencode run "prompt"
        return [...baseArgs, prompt]
      case 'cursor':
        // cursor --cli "prompt"
        return [...baseArgs, prompt]
      default:
        return [...baseArgs, prompt]
    }
  }

  async embed (texts) {
    // Fall back to fallback provider for embeddings
    if (this.fallbackProvider) {
      return this.fallbackProvider.embed(texts)
    }
    throw new Error('CodingAgentProvider does not support embeddings')
  }

  async transcribe (audio) {
    if (this.fallbackProvider) {
      return this.fallbackProvider.transcribe(audio)
    }
    throw new Error('CodingAgentProvider does not support transcription')
  }

  async speak (text) {
    if (this.fallbackProvider) {
      return this.fallbackProvider.speak(text)
    }
    throw new Error('CodingAgentProvider does not support speech synthesis')
  }

  async close () {
    if (this.fallbackProvider) {
      await this.fallbackProvider.close()
    }
  }
}

/**
 * Factory function to create a coding agent provider from persona config.
 */
function providerFromPersona (persona, opts = {}) {
  const { MockProvider } = require('./provider')
  const { QvacProvider } = require('./qvac')

  const runtime = persona?.runtime ?? opts.defaultRuntime ?? 'mock'

  if (runtime === 'coding-agent') {
    let fallbackProvider = null

    // Create fallback provider based on persona config
    if (persona.fallback === 'qvac') {
      fallbackProvider = new QvacProvider({
        model: persona.fallbackModel,
        systemPrompt: persona.system_prompt,
        delegate: persona.provider ? { providerPublicKey: persona.provider } : null
      })
    } else if (persona.fallback === 'mock') {
      fallbackProvider = new MockProvider({
        model: persona.model,
        systemPrompt: persona.system_prompt
      })
    }

    return new CodingAgentProvider({
      agent: persona.agent, // Specific agent to use
      systemPrompt: persona.system_prompt,
      fallbackProvider,
      workDir: opts.workDir,
      timeout: opts.timeout
    })
  }

  // Not our runtime, let other factories handle it
  return null
}

module.exports = { CodingAgentProvider, providerFromPersona, CODING_AGENTS }
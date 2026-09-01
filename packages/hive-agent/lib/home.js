'use strict'

/**
 * An agent's home directory on disk.
 *
 * Layout, copied from Hamlet's persistence.js and nothing else from it:
 *
 *   <root>/agents/<name>/
 *     keypair            the agent's secret key, 64 hex chars, mode 0600
 *     metadata.json      operator-owned persona overrides
 *     files/
 *       instruction.md   system prompt override
 *     skills/
 *       <skill>/SKILL.md learned behaviour, appended to the prompt
 *
 * WHICH SOURCE WINS. The kind-30175 persona event stays authoritative: it is
 * the signed, published, replaceable document that other people read, and it
 * alone decides identity — slug, runtime, model, allowlist. This directory is
 * layered ON TOP of it, for this process only, and nothing here is ever
 * published back. The split is deliberate: the prompt and the skills are the
 * things an operator edits between two turns while tuning an agent, and having
 * to re-sign and re-publish a persona event to try a wording is what stops
 * people tuning at all. Everything else would be a second source of truth for
 * a field that already has one, so it is not offered.
 *
 * NOT A SANDBOX. bare-fs is unrestricted and this class does not restrict it:
 * a provider, a skill, or any other code in this process can read and write
 * every path the operator can, home directory or not. This is a CONVENTION for
 * where an agent's own state lives — a filing rule, not a jail. Do not host a
 * third-party agent on it. The real sandbox is TASK-22 and does not exist yet.
 *
 * fs is INJECTED. `packages/hive-agent` has no fs dependency and must keep
 * loading under Bare and in a browser, so this module requires nothing at all;
 * the caller passes an adapter. `lib/run.js` builds the bare-fs one.
 * The adapter needs: existsSync, mkdirSync, readFileSync, writeFileSync,
 * readdirSync, chmodSync.
 */

// A name reaches this class from an operator's `--name` flag, so it is a trust
// boundary: it is interpolated into a filesystem path and `../../etc` would
// escape the root. Allowlisted rather than sanitised — a rejected name is a
// typo the operator fixes, a rewritten one is a surprise.
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

const KEY = /^[0-9a-f]{64}$/i

function join (...parts) {
  // ponytail: string join instead of bare-path, so this module requires nothing
  // and stays loadable in a browser. Ceiling — a Windows path with backslashes
  // is not normalised; forward slashes work on every platform's fs calls, so
  // the visible cost is cosmetic paths in error messages. Upgrade path: inject
  // `path` alongside `fs` if that ever stops being true.
  return parts.join('/')
}

class AgentHome {
  constructor ({ root, name, fs }) {
    if (fs === undefined || fs === null) throw new Error('AgentHome needs an injected fs adapter')
    if (typeof root !== 'string' || root.length === 0) throw new Error('AgentHome needs a root directory')
    if (!NAME.test(name ?? '')) {
      throw new Error(`invalid agent name "${name}": use letters, digits, dot, dash or underscore`)
    }

    this.fs = fs
    this.root = root
    this.name = name
    this.dir = join(root, 'agents', name)
    this.keypairPath = join(this.dir, 'keypair')
    this.metadataPath = join(this.dir, 'metadata.json')
    this.filesDir = join(this.dir, 'files')
    this.instructionPath = join(this.filesDir, 'instruction.md')
    this.skillsDir = join(this.dir, 'skills')
  }

  get exists () {
    return this.fs.existsSync(this.dir)
  }

  /** Create the layout. Idempotent: an existing home is left exactly as it is. */
  create () {
    for (const dir of [this.dir, this.filesDir, this.skillsDir]) {
      this.fs.mkdirSync(dir, { recursive: true })
    }
    return this
  }

  /**
   * The agent's secret key, as hex, or null when this home has none yet.
   *
   * Never logged, never returned in anything this process prints, and never
   * included in `describe()`. The one place it is allowed to travel is into the
   * Agent constructor.
   */
  readSecretKey () {
    if (!this.fs.existsSync(this.keypairPath)) return null
    const hex = this.fs.readFileSync(this.keypairPath, 'utf8').trim()
    if (!KEY.test(hex)) {
      throw new Error(`${this.keypairPath} is not a 64-character hex secret key`)
    }
    return hex.toLowerCase()
  }

  /**
   * Write the secret key 0600.
   *
   * Two calls, not `writeFileSync(..., { mode })`: the mode argument is only
   * honoured when the file is CREATED, so an existing world-readable keypair
   * would keep its permissions silently. chmod afterwards is unconditional.
   */
  writeSecretKey (hex) {
    if (!KEY.test(hex ?? '')) throw new Error('a secret key must be 64 hex characters')
    this.create()
    this.fs.writeFileSync(this.keypairPath, hex.toLowerCase() + '\n')
    this.fs.chmodSync(this.keypairPath, 0o600)
    return this.keypairPath
  }

  /** `metadata.json`, or `{}` when absent. A malformed one is an error, not a shrug. */
  readMetadata () {
    if (!this.fs.existsSync(this.metadataPath)) return {}
    const raw = this.fs.readFileSync(this.metadataPath, 'utf8')
    try {
      return JSON.parse(raw)
    } catch (err) {
      throw new Error(`${this.metadataPath} is not valid JSON: ${err.message}`)
    }
  }

  writeMetadata (metadata) {
    this.create()
    this.fs.writeFileSync(this.metadataPath, JSON.stringify(metadata, null, 2) + '\n')
    return this.metadataPath
  }

  /** `files/instruction.md`, or null. Whitespace-only counts as absent. */
  readInstruction () {
    if (!this.fs.existsSync(this.instructionPath)) return null
    const text = this.fs.readFileSync(this.instructionPath, 'utf8').trim()
    return text.length === 0 ? null : text
  }

  /** Every `skills/<name>/SKILL.md`, name-sorted so the prompt is stable. */
  readSkills () {
    if (!this.fs.existsSync(this.skillsDir)) return []

    const skills = []
    for (const name of this.fs.readdirSync(this.skillsDir).sort()) {
      const file = join(this.skillsDir, name, 'SKILL.md')
      if (!this.fs.existsSync(file)) continue
      const content = this.fs.readFileSync(file, 'utf8').trim()
      if (content.length > 0) skills.push({ name, content })
    }
    return skills
  }

  /**
   * The system prompt for the next turn: instruction override if there is one,
   * otherwise the persona's own, with every skill appended.
   *
   * Read from disk on every call rather than cached, so editing instruction.md
   * changes the NEXT turn with no restart. That is the whole point of the file
   * — an operator tuning an agent should see the effect on the next message,
   * not after a redeploy.
   */
  systemPrompt (persona = null) {
    const base = this.readInstruction() ?? persona?.system_prompt ?? null
    const skills = this.readSkills()
    if (skills.length === 0) return base

    const learned = skills.map((s) => `## Skill: ${s.name}\n\n${s.content}`).join('\n\n')
    return base === null ? learned : `${base}\n\n${learned}`
  }

  /** What an operator may safely be shown. Deliberately excludes the key. */
  describe () {
    const skills = this.readSkills().map((s) => s.name)
    return {
      name: this.name,
      dir: this.dir,
      hasKeypair: this.fs.existsSync(this.keypairPath),
      hasInstruction: this.readInstruction() !== null,
      skills
    }
  }
}

module.exports = { AgentHome }

'use strict'

const yaml = require('js-yaml')

// Workflow definitions are YAML-as-code, stored as canonical JSON in kind 30620.

const TRIGGERS = ['message_posted', 'reaction_added', 'schedule', 'webhook']

const ACTIONS = [
  'send_message',
  'send_dm',
  'set_channel_topic',
  'add_reaction',
  'call_webhook',
  'request_approval',
  'delay'
]

const MAX_DELAY_SECONDS = 300
const STEP_ID = /^[a-zA-Z0-9_]+$/

class WorkflowError extends Error {
  constructor (message) {
    super(message)
    this.name = 'WorkflowError'
  }
}

/**
 * Parse and validate a definition. Accepts YAML or JSON — agents tend to emit
 * JSON, humans YAML, and there is no reason to make either wrong.
 */
function parseWorkflow (source) {
  let raw
  if (typeof source === 'object' && source !== null) {
    raw = source
  } else {
    try {
      raw = yaml.load(source)
    } catch (err) {
      throw new WorkflowError(`definition is not valid YAML or JSON: ${err.message}`)
    }
  }

  if (raw === null || typeof raw !== 'object') throw new WorkflowError('definition must be a mapping')
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new WorkflowError('definition requires a name')
  }

  const trigger = raw.trigger ?? {}
  if (!TRIGGERS.includes(trigger.on)) {
    throw new WorkflowError(`trigger.on must be one of: ${TRIGGERS.join(', ')}`)
  }
  if (trigger.on === 'schedule' && typeof trigger.cron !== 'string') {
    throw new WorkflowError('a schedule trigger requires a cron expression')
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new WorkflowError('definition requires at least one step')
  }

  const seen = new Set()
  const steps = raw.steps.map((step, index) => {
    if (step === null || typeof step !== 'object') throw new WorkflowError(`step ${index} must be a mapping`)

    const id = step.id ?? `step_${index}`
    // Step ids become variable names in `{{steps.ID.output}}` and in condition
    // contexts, so anything outside this alphabet could inject a variable.
    if (!STEP_ID.test(id)) {
      throw new WorkflowError(`step id "${id}" must contain only letters, digits and underscores`)
    }
    if (seen.has(id)) throw new WorkflowError(`duplicate step id "${id}"`)
    seen.add(id)

    if (!ACTIONS.includes(step.action)) {
      throw new WorkflowError(`step "${id}" has unknown action "${step.action}"; expected one of: ${ACTIONS.join(', ')}`)
    }

    if (step.action === 'delay') {
      const seconds = Number(step.seconds ?? 0)
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DELAY_SECONDS) {
        throw new WorkflowError(`step "${id}": delay must be between 0 and ${MAX_DELAY_SECONDS} seconds`)
      }
    }

    if (step.action === 'call_webhook' && typeof step.url !== 'string') {
      throw new WorkflowError(`step "${id}": call_webhook requires a url`)
    }

    if (step.action === 'request_approval' && typeof step.from !== 'string') {
      throw new WorkflowError(`step "${id}": request_approval requires a "from" pubkey or template`)
    }

    return { ...step, id }
  })

  return {
    name: raw.name,
    description: raw.description ?? '',
    trigger: { ...trigger },
    steps
  }
}

/**
 * Single-pass template resolution — `{{trigger.text}}`, `{{steps.ID.output}}`.
 *
 * Single pass on purpose: resolving recursively would let a message whose text
 * is itself `{{...}}` reach into the context, which is a small injection
 * primitive nobody needs. Unknown variables are left as literal text so a
 * typo is visible in the output rather than silently blank.
 */
function resolveTemplate (text, context) {
  if (typeof text !== 'string') return text

  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, path) => {
    const value = lookup(context, path)
    return value === undefined ? match : String(value)
  })
}

function lookup (context, path) {
  let current = context
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

/** Flatten a context to the underscore-joined names the evaluator expects. */
function flattenContext (context, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(context)) {
    const name = prefix === '' ? key : `${prefix}_${key}`
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenContext(value, name, out)
    } else {
      out[name] = value
    }
  }
  return out
}

module.exports = {
  parseWorkflow,
  resolveTemplate,
  flattenContext,
  lookup,
  TRIGGERS,
  ACTIONS,
  MAX_DELAY_SECONDS,
  WorkflowError
}

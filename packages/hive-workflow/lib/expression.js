'use strict'

// A small expression evaluator for workflow `if:` and `filter:` conditions.
//
// Deliberately not `eval` or `new Function`: workflow definitions are
// user-supplied and would otherwise be arbitrary code execution inside the
// relay. This is a recursive-descent parser over a fixed grammar with no
// property access, no calls beyond a fixed function table, and a wall-clock
// budget so a pathological expression cannot stall the pipeline.

const DEFAULT_TIMEOUT_MS = 100

const FUNCTIONS = {
  str_contains: (haystack, needle) => String(haystack).includes(String(needle)),
  str_starts_with: (value, prefix) => String(value).startsWith(String(prefix)),
  str_ends_with: (value, suffix) => String(value).endsWith(String(suffix)),
  str_len: (value) => String(value).length,
  str_lower: (value) => String(value).toLowerCase(),
  str_upper: (value) => String(value).toUpperCase(),
  int: (value) => Number.parseInt(value, 10),
  bool: (value) => Boolean(value)
}

class ExpressionError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ExpressionError'
  }
}

function tokenize (input) {
  const tokens = []
  let i = 0

  while (i < input.length) {
    const c = input[i]

    if (/\s/.test(c)) {
      i++
      continue
    }

    if (c === '"' || c === "'") {
      let value = ''
      i++
      while (i < input.length && input[i] !== c) {
        if (input[i] === '\\' && i + 1 < input.length) {
          value += input[++i]
        } else {
          value += input[i]
        }
        i++
      }
      if (i >= input.length) throw new ExpressionError('unterminated string literal')
      i++
      tokens.push({ type: 'string', value })
      continue
    }

    if (/[0-9]/.test(c)) {
      let value = ''
      while (i < input.length && /[0-9.]/.test(input[i])) value += input[i++]
      tokens.push({ type: 'number', value: Number(value) })
      continue
    }

    if (/[a-zA-Z_]/.test(c)) {
      let value = ''
      // Dot notation is accepted and folded to underscores, so a definition can
      // read `trigger.text` while the context is flat.
      while (i < input.length && /[a-zA-Z0-9_.]/.test(input[i])) value += input[i++]
      tokens.push({ type: 'identifier', value: value.replace(/\./g, '_') })
      continue
    }

    const two = input.slice(i, i + 2)
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'operator', value: two })
      i += 2
      continue
    }

    if ('()<>!,'.includes(c)) {
      tokens.push({ type: c === '(' || c === ')' || c === ',' ? c : 'operator', value: c })
      i++
      continue
    }

    throw new ExpressionError(`unexpected character "${c}" in expression`)
  }

  return tokens
}

function parse (tokens) {
  let position = 0

  const peek = () => tokens[position]
  const next = () => tokens[position++]

  function parseOr () {
    let left = parseAnd()
    while (peek()?.value === '||') {
      next()
      left = { type: 'or', left, right: parseAnd() }
    }
    return left
  }

  function parseAnd () {
    let left = parseComparison()
    while (peek()?.value === '&&') {
      next()
      left = { type: 'and', left, right: parseComparison() }
    }
    return left
  }

  function parseComparison () {
    const left = parseUnary()
    const op = peek()
    if (op !== undefined && ['==', '!=', '>', '<', '>=', '<='].includes(op.value)) {
      next()
      return { type: 'compare', op: op.value, left, right: parseUnary() }
    }
    return left
  }

  function parseUnary () {
    if (peek()?.value === '!') {
      next()
      return { type: 'not', operand: parseUnary() }
    }
    return parsePrimary()
  }

  function parsePrimary () {
    const token = next()
    if (token === undefined) throw new ExpressionError('unexpected end of expression')

    if (token.type === '(') {
      const expression = parseOr()
      if (next()?.type !== ')') throw new ExpressionError('missing closing parenthesis')
      return expression
    }

    if (token.type === 'string') return { type: 'literal', value: token.value }
    if (token.type === 'number') return { type: 'literal', value: token.value }

    if (token.type === 'identifier') {
      if (token.value === 'true') return { type: 'literal', value: true }
      if (token.value === 'false') return { type: 'literal', value: false }

      if (peek()?.type === '(') {
        next()
        const args = []
        while (peek()?.type !== ')') {
          args.push(parseOr())
          if (peek()?.type === ',') next()
          else break
        }
        if (next()?.type !== ')') throw new ExpressionError('missing closing parenthesis in call')
        return { type: 'call', name: token.value, args }
      }

      return { type: 'variable', name: token.value }
    }

    throw new ExpressionError(`unexpected token "${token.value}"`)
  }

  const ast = parseOr()
  if (position < tokens.length) {
    throw new ExpressionError(`unexpected trailing input at "${tokens[position].value}"`)
  }
  return ast
}

function evaluateNode (node, context, deadline) {
  if (Date.now() > deadline) throw new ExpressionError('expression evaluation timed out')

  switch (node.type) {
    case 'literal':
      return node.value

    case 'variable':
      // An unknown variable is empty, not an error: a trigger that did not set
      // a field should make the condition false rather than fail the run.
      return Object.prototype.hasOwnProperty.call(context, node.name) ? context[node.name] : ''

    case 'not':
      return !evaluateNode(node.operand, context, deadline)

    case 'and':
      return Boolean(evaluateNode(node.left, context, deadline)) &&
        Boolean(evaluateNode(node.right, context, deadline))

    case 'or':
      return Boolean(evaluateNode(node.left, context, deadline)) ||
        Boolean(evaluateNode(node.right, context, deadline))

    case 'compare': {
      const left = evaluateNode(node.left, context, deadline)
      const right = evaluateNode(node.right, context, deadline)
      switch (node.op) {
        case '==': return left === right
        case '!=': return left !== right
        case '>': return left > right
        case '<': return left < right
        case '>=': return left >= right
        case '<=': return left <= right
      }
      throw new ExpressionError(`unknown operator ${node.op}`)
    }

    case 'call': {
      const fn = FUNCTIONS[node.name]
      if (fn === undefined) throw new ExpressionError(`unknown function "${node.name}"`)
      return fn(...node.args.map((arg) => evaluateNode(arg, context, deadline)))
    }
  }

  throw new ExpressionError(`unknown node type ${node.type}`)
}

/**
 * Evaluate `expression` against `context`. Returns a boolean.
 * A malformed expression throws; an expression over unknown variables is false.
 */
function evaluate (expression, context = {}, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  if (expression === undefined || expression === null || expression === '') return true

  const ast = parse(tokenize(expression))
  return Boolean(evaluateNode(ast, context, Date.now() + timeout))
}

module.exports = { evaluate, tokenize, parse, FUNCTIONS, ExpressionError, DEFAULT_TIMEOUT_MS }

'use strict'

// Exit codes are buzz-cli's, so a script or agent prompt written against Buzz
// behaves identically here.
const EXIT_CODES = {
  ok: 0,
  user: 1,
  network: 2,
  auth: 3,
  other: 4,
  conflict: 5
}

class CliError extends Error {
  constructor (category, message) {
    super(message)
    this.name = 'CliError'
    this.category = EXIT_CODES[category] === undefined ? 'other' : category
    this.exitCode = EXIT_CODES[this.category]
  }

  toJSON () {
    return { error: this.category, message: this.message }
  }
}

module.exports = { CliError, EXIT_CODES }

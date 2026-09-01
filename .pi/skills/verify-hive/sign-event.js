// Sign one arbitrary event with HIVE_PRIVATE_KEY and print it as JSON.
//
// The CLI never lets a caller choose `kind` or `created_at`, so the relay's
// created_at bound and its kind handling cannot be driven through it at all.
// Everything else in this skill goes through a real user verb; this exists
// only for the caps that have no verb.
//
//   node scripts/bare.js .pi/skills/verify-hive/sign-event.js <kind> <created_at-drift-seconds> [content]
//
// Feed the output to POST /events with a NIP-98 header (see features/relay-limits.md).
const core = require('hive-core')
const env = require('bare-env')

const [kind, drift, content] = Bare.argv.slice(-3)
const sk = core.fromHex(env.HIVE_PRIVATE_KEY)

console.log(JSON.stringify(core.finalizeEvent({
  kind: Number(kind),
  created_at: Math.floor(Date.now() / 1000) + Number(drift),
  tags: [],
  content: content ?? 'sign-event probe'
}, sk)))

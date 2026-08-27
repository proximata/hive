// Print a NIP-98 Authorization header so curl can make an authenticated call.
// Bare has no global fetch and no process.argv: use Bare.argv.
// Usage: node scripts/bare.js scripts/nip98-header.js <url> <method> <hex-secret-key>
const { buildNip98Header } = require('hive-auth')
console.log(buildNip98Header({
  url: Bare.argv[2],
  method: Bare.argv[3] || 'GET',
  secretKey: Bare.argv[4],
  body: null
}))

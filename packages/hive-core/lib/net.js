'use strict'

// SSRF protection for outbound workflow webhooks. A workflow definition is
// user-supplied, so `call_webhook` is a request-forgery primitive unless the
// destination is checked against every address range that could reach internal
// infrastructure.

function parseIPv4 (address) {
  const parts = address.split('.')
  if (parts.length !== 4) return null

  const octets = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    octets.push(n)
  }
  return octets
}

function isPrivateIPv4 (octets) {
  const [a, b] = octets

  if (a === 0) return true // 0.0.0.0/8 unspecified
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
  if (a === 255 && octets.every((o) => o === 255)) return true // broadcast

  return false
}

function expandIPv6 (address) {
  const zoneless = address.split('%')[0]
  const halves = zoneless.split('::')
  if (halves.length > 2) return null

  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []

  // A trailing IPv4 literal (::ffff:127.0.0.1) becomes two 16-bit groups.
  const last = tail.length > 0 ? tail[tail.length - 1] : head[head.length - 1]
  if (last !== undefined && last.includes('.')) {
    const octets = parseIPv4(last)
    if (octets === null) return null
    const groups = [
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16)
    ]
    if (tail.length > 0) tail.splice(-1, 1, ...groups)
    else head.splice(-1, 1, ...groups)
  }

  if (halves.length === 1) {
    if (head.length !== 8) return null
    return head.map((g) => parseInt(g, 16))
  }

  const missing = 8 - head.length - tail.length
  if (missing < 0) return null

  const groups = [...head, ...new Array(missing).fill('0'), ...tail]
  const parsed = groups.map((g) => parseInt(g === '' ? '0' : g, 16))
  return parsed.some((n) => Number.isNaN(n)) ? null : parsed
}

function isPrivateIPv6 (groups) {
  const [g0] = groups

  if (groups.every((g) => g === 0)) return true // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1 loopback
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (g0 === 0x2001 && groups[1] === 0x0db8) return true // 2001:db8::/32 documentation

  // IPv4-mapped ::ffff:0:0/96 — recurse into the embedded address so that
  // ::ffff:127.0.0.1 is rejected for the same reason 127.0.0.1 is.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const octets = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]
    return isPrivateIPv4(octets)
  }

  return false
}

/**
 * True when this address must not be dialled from a user-supplied URL.
 * Unparseable input returns true — fail closed.
 */
function isPrivateIp (address) {
  if (typeof address !== 'string' || address.length === 0) return true

  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address

  const v4 = parseIPv4(bare)
  if (v4 !== null) return isPrivateIPv4(v4)

  if (bare.includes(':')) {
    const v6 = expandIPv6(bare)
    return v6 === null ? true : isPrivateIPv6(v6)
  }

  // A hostname: not an IP literal, so the caller must resolve it and re-check.
  return false
}

module.exports = { isPrivateIp, parseIPv4, expandIPv6 }

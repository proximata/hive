'use strict'

// Minimal BIP-173 bech32, enough for NIP-19 npub/nsec/note. Implemented here
// rather than pulled in as a dependency: it is 60 lines of well-specified code
// and hive-core is meant to stay dependency-light.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod (values) {
  let chk = 1
  for (const value of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i]
    }
  }
  return chk
}

function hrpExpand (hrp) {
  const out = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}

function convertBits (data, from, to, pad) {
  let acc = 0
  let bits = 0
  const out = []
  const maxv = (1 << to) - 1
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error('invalid value in bech32 conversion')
    acc = (acc << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & maxv)
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv)
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error('invalid padding in bech32 conversion')
  }
  return out
}

function encode (hrp, data) {
  const values = hrpExpand(hrp).concat(data)
  const mod = polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ 1
  let out = hrp + '1'
  for (const d of data) out += CHARSET[d]
  for (let i = 0; i < 6; i++) out += CHARSET[(mod >> (5 * (5 - i))) & 31]
  return out
}

function decode (str) {
  if (str.length < 8 || str.length > 1023) throw new Error('bech32 string of invalid length')
  const lower = str.toLowerCase()
  if (str !== lower && str !== str.toUpperCase()) throw new Error('bech32 string has mixed case')

  const pos = lower.lastIndexOf('1')
  if (pos < 1 || pos + 7 > lower.length) throw new Error('bech32 string has no separator')

  const hrp = lower.slice(0, pos)
  const data = []
  for (const ch of lower.slice(pos + 1)) {
    const index = CHARSET.indexOf(ch)
    if (index === -1) throw new Error('bech32 string has invalid character')
    data.push(index)
  }
  if (polymod(hrpExpand(hrp).concat(data)) !== 1) throw new Error('bech32 checksum mismatch')

  return { hrp, data: data.slice(0, -6) }
}

/** Encode 32 raw bytes as a NIP-19 entity, e.g. toWords('npub', pubkeyBytes). */
function encodeBytes (hrp, bytes) {
  return encode(hrp, convertBits(Array.from(bytes), 8, 5, true))
}

/** Decode a NIP-19 entity back to { hrp, bytes }. */
function decodeBytes (str) {
  const { hrp, data } = decode(str)
  return { hrp, bytes: Uint8Array.from(convertBits(data, 5, 8, false)) }
}

module.exports = { encode, decode, encodeBytes, decodeBytes, convertBits }

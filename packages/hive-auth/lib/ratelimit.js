'use strict'

// Buzz defines four rate-limit tiers but ships only a permissive stub, so
// nothing is actually enforced there. Hive implements them: the tiers below are
// Buzz's, the token bucket is ours.

const TIERS = {
  human: { events: 30, burst: 60, subscriptions: 20, window: 60 },
  'agent-standard': { events: 120, burst: 240, subscriptions: 60, window: 60 },
  'agent-elevated': { events: 600, burst: 1200, subscriptions: 200, window: 60 },
  'agent-platform': { events: 6000, burst: 12000, subscriptions: 1000, window: 60 }
}

class TokenBucket {
  constructor (capacity, refillPerSecond, now) {
    this.capacity = capacity
    this.tokens = capacity
    this.refillPerSecond = refillPerSecond
    this.updatedAt = now
  }

  take (count, now) {
    const elapsed = Math.max(0, now - this.updatedAt) / 1000
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond)
    this.updatedAt = now

    if (this.tokens < count) return false
    this.tokens -= count
    return true
  }
}

class RateLimiter {
  constructor (opts = {}) {
    this.tier = TIERS[opts.tier ?? 'human'] ?? TIERS.human
    this.enabled = opts.enabled !== false
    this.buckets = new Map()
    this.clock = opts.clock ?? (() => Date.now())
  }

  #bucket (pubkey) {
    let bucket = this.buckets.get(pubkey)
    if (bucket === undefined) {
      bucket = new TokenBucket(this.tier.burst, this.tier.events / this.tier.window, this.clock())
      this.buckets.set(pubkey, bucket)
    }
    return bucket
  }

  /** Returns true when the action is permitted. */
  allow (pubkey, cost = 1) {
    if (!this.enabled) return true
    return this.#bucket(pubkey).take(cost, this.clock())
  }

  /** Drop buckets that have refilled completely, so idle peers cost nothing. */
  sweep () {
    const now = this.clock()
    for (const [pubkey, bucket] of this.buckets) {
      const elapsed = (now - bucket.updatedAt) / 1000
      if (bucket.tokens + elapsed * bucket.refillPerSecond >= bucket.capacity) {
        this.buckets.delete(pubkey)
      }
    }
  }
}

/** Used in tests and in single-user deployments where limiting is noise. */
class AlwaysAllowRateLimiter {
  allow () {
    return true
  }

  sweep () {}
}

module.exports = { TIERS, RateLimiter, AlwaysAllowRateLimiter, TokenBucket }

import { getRedisCommandClient, getRedisPublisher, getRedisSubscriber, hasRedis } from "./redis.js"

/**
 * Two-tier read-through cache for hot, read-mostly projections.
 *
 * L1 — per-process Map with a sub-second TTL. Absorbs the request burst: at
 *      1M concurrent viewers the same key is asked for thousands of times per
 *      second per instance and answered from memory with zero I/O.
 * L2 — Redis with a slightly longer TTL, shared by every instance. Only an L1
 *      miss reaches it, so the whole fleet issues a handful of Redis reads per
 *      second regardless of user count.
 * DB — reached only when both tiers miss, and then by exactly one caller per
 *      instance thanks to the in-flight map below (single-flight): a cold key
 *      cannot stampede Postgres.
 *
 * Writes invalidate through a Redis pub/sub fan-out so every instance drops its
 * L1 copy at once, which keeps the staleness window bounded by the TTL rather
 * than by how long an instance happens to hold a value.
 *
 * Redis is optional. Without it the cache still works per-process (L1 +
 * single-flight) and invalidation stays local, which is exactly right for a
 * single-instance deployment.
 */

const INVALIDATION_CHANNEL = "sahasra:cache:invalidate"

/** @type {Map<string, { value: unknown, expiresAt: number }>} */
const l1 = new Map()
/** @type {Map<string, Promise<unknown>>} */
const inFlight = new Map()
/** @type {Map<string, Set<() => void>>} */
const invalidationListeners = new Map()
/**
 * Bumped every time a key is invalidated. A `load()` that was already running
 * when the invalidation arrived would otherwise write its pre-invalidation
 * result into the cache and resurrect stale data; comparing generations lets
 * that result be returned to its caller but not stored.
 *
 * @type {Map<string, number>}
 */
const generations = new Map()

// Keys are a small fixed set (one per cached projection), but a bug that
// generated per-request keys would otherwise leak memory for the process
// lifetime. The cap turns that into a bounded, self-healing FIFO eviction.
const L1_MAX_ENTRIES = Number(process.env.CACHE_L1_MAX_ENTRIES ?? 500)

let subscriberReady = false

function ensureInvalidationSubscriber() {
  if (subscriberReady || !hasRedis()) return
  const subscriber = getRedisSubscriber()
  if (!subscriber) return
  subscriberReady = true
  subscriber.subscribe(INVALIDATION_CHANNEL).catch(error => {
    subscriberReady = false
    console.error("cache_subscribe_failed", { message: error instanceof Error ? error.message : error })
  })
  subscriber.on("message", (channel, key) => {
    if (channel !== INVALIDATION_CHANNEL || !key) return
    dropLocal(key)
  })
}

function dropLocal(key) {
  l1.delete(key)
  generations.set(key, (generations.get(key) ?? 0) + 1)
  const listeners = invalidationListeners.get(key)
  if (!listeners) return
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error("cache_invalidation_listener_failed", {
        key,
        message: error instanceof Error ? error.message : error,
      })
    }
  }
}

function setL1(key, value, ttlMs) {
  if (l1.size >= L1_MAX_ENTRIES && !l1.has(key)) {
    const oldest = l1.keys().next()
    if (!oldest.done) l1.delete(oldest.value)
  }
  l1.set(key, { value, expiresAt: Date.now() + Math.max(0, ttlMs) })
}

async function readL2(key) {
  const client = getRedisCommandClient()
  if (!client) return undefined
  try {
    const raw = await client.get(key)
    if (raw === null || raw === undefined) return undefined
    return JSON.parse(raw)
  } catch (error) {
    console.error("cache_l2_read_failed", { key, message: error instanceof Error ? error.message : error })
    return undefined
  }
}

async function writeL2(key, value, ttlMs) {
  const client = getRedisCommandClient()
  if (!client) return
  try {
    await client.set(key, JSON.stringify(value), "PX", Math.max(1, Math.trunc(ttlMs)))
  } catch (error) {
    console.error("cache_l2_write_failed", { key, message: error instanceof Error ? error.message : error })
  }
}

/**
 * Read `key` through the cache, calling `load()` only on a full miss.
 *
 * @template T
 * @param {string} key Cache key (include a version suffix so a shape change cannot read old entries)
 * @param {{ l1TtlMs?: number, l2TtlMs?: number, load: () => Promise<T> }} options
 * @returns {Promise<T>}
 */
export async function cachedRead(key, { l1TtlMs = 1000, l2TtlMs = 5000, load }) {
  ensureInvalidationSubscriber()
  const hit = l1.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value

  const pending = inFlight.get(key)
  if (pending) return pending

  const startedAtGeneration = generations.get(key) ?? 0
  const promise = (async () => {
    const fromL2 = await readL2(key)
    const stillCurrent = () => (generations.get(key) ?? 0) === startedAtGeneration
    if (fromL2 !== undefined) {
      if (stillCurrent()) setL1(key, fromL2, l1TtlMs)
      return fromL2
    }
    const value = await load()
    // Invalidated while this read was in flight: hand the value back to the
    // caller (it is at worst as fresh as when the request arrived) but do not
    // repopulate the cache with it.
    if (!stillCurrent()) return value
    setL1(key, value, l1TtlMs)
    await writeL2(key, value, l2TtlMs)
    return value
  })()

  inFlight.set(key, promise)
  // Settle handlers (not `.finally()`) so a rejected load clears the slot without
  // creating a derived promise that would reject with no handler attached.
  promise.then(
    () => inFlight.delete(key),
    () => inFlight.delete(key)
  )
  return promise
}

/**
 * Drop `key` everywhere: this process immediately, Redis, and every other
 * instance via pub/sub. Safe to call on every write — invalidations are orders
 * of magnitude rarer than reads.
 *
 * @param {string} key
 */
export async function invalidateCacheKey(key) {
  dropLocal(key)
  const client = getRedisCommandClient()
  if (client) {
    try {
      await client.del(key)
    } catch (error) {
      console.error("cache_l2_delete_failed", { key, message: error instanceof Error ? error.message : error })
    }
  }
  const publisher = getRedisPublisher()
  if (publisher) {
    try {
      await publisher.publish(INVALIDATION_CHANNEL, key)
    } catch (error) {
      console.error("cache_invalidation_publish_failed", {
        key,
        message: error instanceof Error ? error.message : error,
      })
    }
  }
}

/**
 * Run `listener` whenever `key` is invalidated, locally or by another instance.
 * Lets derived in-memory state (memoized projections, broadcast digests) reset
 * in lockstep with the cache entry it was computed from.
 *
 * @param {string} key
 * @param {() => void} listener
 */
export function onCacheInvalidated(key, listener) {
  ensureInvalidationSubscriber()
  if (!invalidationListeners.has(key)) invalidationListeners.set(key, new Set())
  invalidationListeners.get(key).add(listener)
}

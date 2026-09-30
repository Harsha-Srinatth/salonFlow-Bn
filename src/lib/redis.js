import Redis from "ioredis"

/**
 * Shared ioredis clients for the API process.
 *
 * Three connections at most, created lazily and reused for the lifetime of the
 * process: one for commands, one for pub/sub publishing, one subscriber (a
 * subscribed ioredis connection cannot run normal commands, so it must be its
 * own socket).
 *
 * Everything here is optional: when `REDIS_URL` is not set every getter returns
 * `null` and callers fall back to their single-instance behaviour. That keeps
 * local development dependency-free while the same code runs unchanged against
 * ElastiCache / MemoryDB in production.
 */

const clients = {
  command: null,
  publisher: null,
  subscriber: null,
}

let warnedMissingUrl = false

export function hasRedis() {
  return Boolean(`${process.env.REDIS_URL ?? ""}`.trim())
}

function createClient(label) {
  const url = `${process.env.REDIS_URL ?? ""}`.trim()
  if (!url) {
    if (!warnedMissingUrl) {
      warnedMissingUrl = true
      console.warn("redis_not_configured", {
        message: "REDIS_URL is unset — shared cache falls back to per-process memory only.",
      })
    }
    return null
  }
  const client = new Redis(url, {
    // A cache read must never become the slowest part of a request: fail fast and
    // let the caller fall through to Postgres instead of queueing while Redis is down.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 3000),
  })
  client.on("error", error => {
    console.error("redis_error", { label, message: error instanceof Error ? error.message : error })
  })
  return client
}

export function getRedisCommandClient() {
  if (!hasRedis()) return null
  if (!clients.command) clients.command = createClient("command")
  return clients.command
}

export function getRedisPublisher() {
  if (!hasRedis()) return null
  if (!clients.publisher) clients.publisher = createClient("publisher")
  return clients.publisher
}

export function getRedisSubscriber() {
  if (!hasRedis()) return null
  if (!clients.subscriber) clients.subscriber = createClient("subscriber")
  return clients.subscriber
}

/**
 * Best-effort distributed "only one instance does this tick" lock.
 *
 * Used for work that is correct but wasteful when every instance repeats it
 * (broadcasting the same realtime snapshot, running the same reminder sweep).
 * Returns `true` when this process may proceed. Without Redis there is only one
 * process by definition, so it always returns `true`.
 *
 * @param {string} key Lock name
 * @param {number} ttlMs How long the slot stays claimed
 * @returns {Promise<boolean>}
 */
export async function tryAcquireSlot(key, ttlMs) {
  const client = getRedisCommandClient()
  if (!client) return true
  try {
    const result = await client.set(key, `${process.pid}:${Date.now()}`, "PX", Math.max(1, Math.trunc(ttlMs)), "NX")
    return result === "OK"
  } catch (error) {
    // A Redis outage must not silently stop scheduled work — degrade to "every
    // instance runs it", which the callers are individually safe against.
    console.error("redis_slot_acquire_failed", { key, message: error instanceof Error ? error.message : error })
    return true
  }
}

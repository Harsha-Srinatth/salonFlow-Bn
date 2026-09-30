import { invalidateCacheKey } from "../lib/cache.js"
import { QUEUE_ROWS_CACHE_KEY } from "./constants.js"

/**
 * The one call every booking mutation makes to keep the live queue honest.
 *
 * It lives in its own module (importing nothing but the cache) so the realtime
 * gateway can invoke it without creating an import cycle with the queue service,
 * which in turn depends on the gateway to publish snapshots.
 *
 * Fire-and-forget by design: a booking write must not fail or wait because a
 * cache delete was slow. Worst case the snapshot is stale for one TTL.
 */
export function markQueueMutated() {
  void invalidateCacheKey(QUEUE_ROWS_CACHE_KEY).catch(error => {
    console.error("queue_cache_invalidation_failed", {
      message: error instanceof Error ? error.message : error,
    })
  })
}

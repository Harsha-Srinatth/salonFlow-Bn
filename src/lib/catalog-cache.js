import { invalidateCacheKey } from "./cache.js"

/**
 * Cache keys for read-mostly data that every booking screen needs and that only an admin
 * edits. Each is read through `cachedRead` (per-process memory + Redis when configured) and
 * dropped by the admin write paths, so the staleness window is the short TTL at worst.
 */
export const CATALOG_ACTIVE_CACHE_KEY = "sahasra:svc:catalog:active:v1"
export const CATALOG_ALL_CACHE_KEY = "sahasra:svc:catalog:all:v1"
export const OFFER_ROWS_CACHE_KEY = "sahasra:offers:rows:v1"
export const REVENUE_SUMMARY_CACHE_PREFIX = "sahasra:revenue:summary:v1:"

/** Service catalog changed: the catalog lists and the offer center (which embeds services) are stale. */
export async function invalidateCatalogCaches() {
  await Promise.all([
    invalidateCacheKey(CATALOG_ACTIVE_CACHE_KEY),
    invalidateCacheKey(CATALOG_ALL_CACHE_KEY),
    invalidateCacheKey(OFFER_ROWS_CACHE_KEY),
  ])
}

export async function invalidateOfferCaches() {
  await invalidateCacheKey(OFFER_ROWS_CACHE_KEY)
}

export function invalidateRevenueSummary(timezone) {
  return invalidateCacheKey(`${REVENUE_SUMMARY_CACHE_PREFIX}${timezone}`)
}

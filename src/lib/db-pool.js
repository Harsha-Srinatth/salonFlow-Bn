import { Pool } from "pg"

function intFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Single shared PostgreSQL pool for the API process.
 *
 * The limits matter as much as the sharing:
 *  - `connectionTimeoutMillis`: without it a request that cannot get a connection waits
 *    forever, so one exhausted pool silently wedges every route. With it the request fails
 *    fast (and the error handler answers 500) instead of hanging until a restart.
 *  - `statement_timeout`: one runaway query cannot hold a connection indefinitely.
 *  - `max`: per-process ceiling. Total connections = max x instances, which must stay
 *    below Postgres `max_connections` (or sit behind a pooler such as PgBouncer).
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: intFromEnv("DB_POOL_MAX", 10),
  connectionTimeoutMillis: intFromEnv("DB_CONNECTION_TIMEOUT_MS", 10_000),
  idleTimeoutMillis: intFromEnv("DB_IDLE_TIMEOUT_MS", 30_000),
  statement_timeout: intFromEnv("DB_STATEMENT_TIMEOUT_MS", 30_000),
})

// An idle client dying (DB restart, network drop) emits 'error' on the pool; with no
// listener Node treats it as an uncaught exception and exits.
pool.on("error", error => {
  console.error("pg_pool_idle_client_error", error instanceof Error ? error.message : error)
})

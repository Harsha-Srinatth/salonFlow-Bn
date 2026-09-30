import { pool } from "./db-pool.js"

/**
 * Single advisory lock shared by every schema module.
 *
 * Per-module lock ids look tidier but deadlock: nearly every module also runs
 * `ALTER TABLE users ADD COLUMN IF NOT EXISTS`, which holds ACCESS EXCLUSIVE on
 * `users` for the rest of its transaction. Instance A can then hold the "offers"
 * lock while waiting for `users`, which instance B holds while waiting for the
 * "offers" lock — a textbook lock-ordering cycle, and Postgres kills one of
 * them. One lock for all schema bootstrap removes the ordering problem entirely,
 * and costs nothing real: these modules share `users`, `bookings` and
 * `service_catalog`, so their DDL was never going to run in parallel anyway.
 */
const SCHEMA_BOOTSTRAP_LOCK_ID = 4823001

/**
 * Concurrency-safe bootstrap for the `ensure*Schema` functions.
 *
 * `CREATE TABLE IF NOT EXISTS` is not safe to run concurrently: two callers that
 * pass the existence check at the same moment both proceed, and one fails with
 * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`,
 * turning a normal request into a 500. Two things go wrong independently:
 *
 *  1. Within one process, several requests arriving together on a cold start all
 *     see the "not ensured yet" flag and run the DDL at once. Memoizing the
 *     in-flight promise collapses them into a single run.
 *  2. Across instances, several pods booting together race the same way, and no
 *     amount of per-process state helps. A transaction-scoped advisory lock
 *     serialises the DDL fleet-wide; it releases automatically on commit or
 *     rollback, so a crashed instance cannot wedge the others.
 *
 * `migrate` receives the locked client and must use it for every statement,
 * including any data seeding. Anything that touches these tables on a *different*
 * connection has to wait until after the ensure resolves: while this transaction
 * is open it holds `users` exclusively, so a concurrent insert elsewhere that
 * needs a foreign-key lock on `users` deadlocks against it.
 *
 * @param {{ name: string, migrate: (client: import("pg").PoolClient) => Promise<void> }} options
 * @returns {() => Promise<void>} idempotent ensure function
 */
export function createSchemaEnsurer({ name, migrate }) {
  let ensurePromise = null

  async function run() {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_BOOTSTRAP_LOCK_ID])
      await migrate(client)
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      throw Object.assign(error, { schemaModule: name })
    } finally {
      client.release()
    }
  }

  return async function ensureSchema() {
    if (!ensurePromise) {
      ensurePromise = run().catch(error => {
        // Clear on failure so the next caller retries, rather than caching a
        // broken bootstrap for the lifetime of the process.
        ensurePromise = null
        throw error
      })
    }
    return ensurePromise
  }
}

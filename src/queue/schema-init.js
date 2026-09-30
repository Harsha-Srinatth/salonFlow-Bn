import { createSchemaEnsurer } from "../lib/schema-guard.js"

/**
 * Schema owned by the live queue module.
 *
 * `queue_reminders` is an idempotency ledger, not a log: the unique key is what
 * makes "notify the customer once when their turn is close" safe to run from
 * every API instance simultaneously. Whoever wins the insert sends; everyone
 * else no-ops.
 *
 * The partial index is what keeps the snapshot query O(active bookings) rather
 * than O(all bookings ever) — it only holds rows the queue can ever contain, so
 * it stays small no matter how large `bookings` grows.
 */
export const ensureQueueSchema = createSchemaEnsurer({
  name: "queue",
  async migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS queue_reminders (
        id UUID PRIMARY KEY,
        booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        kind VARCHAR(32) NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (booking_id, kind)
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS queue_reminders_sent_at_idx ON queue_reminders(sent_at)`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS bookings_active_queue_idx
      ON bookings (starts_at)
      WHERE status IN ('PENDING', 'CONFIRMED', 'STARTED')
    `)
  },
})

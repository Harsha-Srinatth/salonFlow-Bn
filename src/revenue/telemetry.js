import { pool } from "../lib/db-pool.js"
import { createSchemaEnsurer } from "../lib/schema-guard.js"
import { SALON_TIMEZONE } from "../lib/salon-time.js"

/**
 * Revenue telemetry: one row per payment event with the salon-local hour and weekday already
 * broken out, so demand patterns (peak hours, quiet weekdays) can be read straight off the table
 * later, e.g. to train or feed a dynamic-pricing model.
 *
 * Off by default. Set REVENUE_TELEMETRY_ENABLED=true to start recording. The admin live revenue
 * chart does NOT depend on this: it reads payment_transactions directly.
 *
 * No customer name, phone or email is stored here: only amount, mode, services and time.
 */
export function revenueTelemetryEnabled() {
  return `${process.env.REVENUE_TELEMETRY_ENABLED ?? "false"}`.trim().toLowerCase() === "true"
}

export const ensureRevenueTelemetrySchema = createSchemaEnsurer({
  name: "revenue-telemetry",
  async migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS revenue_events (
        id BIGSERIAL PRIMARY KEY,
        payment_id UUID NOT NULL UNIQUE,
        booking_id UUID,
        source_type VARCHAR(16) NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        payment_mode VARCHAR(32) NOT NULL,
        service_names TEXT,
        collected_at TIMESTAMPTZ NOT NULL,
        local_date DATE NOT NULL,
        local_hour SMALLINT NOT NULL,
        local_dow SMALLINT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS revenue_events_collected_at_idx ON revenue_events (collected_at)`)
    await client.query(`CREATE INDEX IF NOT EXISTS revenue_events_dow_hour_idx ON revenue_events (local_dow, local_hour)`)
  },
})

/**
 * Fire-and-forget: telemetry must never slow down or fail a payment. `amount` is stored signed
 * (refunds are negative). Safe to call twice for the same payment.
 */
export function recordRevenueEvent(paymentId) {
  if (!revenueTelemetryEnabled() || !paymentId) return
  void (async () => {
    try {
      await ensureRevenueTelemetrySchema()
      // The payment may still be inside an open transaction (not visible yet): retry a few times.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 1500))
        const result = await pool.query(
        `
          INSERT INTO revenue_events (payment_id, booking_id, source_type, amount, payment_mode, service_names, collected_at, local_date, local_hour, local_dow)
          SELECT
            p.id,
            p.booking_id,
            p.source_type,
            CASE WHEN p.source_type = 'REFUND' THEN -p.amount ELSE p.amount END,
            p.payment_mode,
            b.service_name,
            p.collected_at,
            (p.collected_at AT TIME ZONE '${SALON_TIMEZONE}')::date,
            EXTRACT(HOUR FROM p.collected_at AT TIME ZONE '${SALON_TIMEZONE}')::smallint,
            EXTRACT(DOW FROM p.collected_at AT TIME ZONE '${SALON_TIMEZONE}')::smallint
          FROM payment_transactions p
          LEFT JOIN bookings b ON b.id = p.booking_id
          WHERE p.id = $1
          ON CONFLICT (payment_id) DO NOTHING
        `,
        [paymentId]
      )
        if (result.rowCount > 0) return
        const { rows } = await pool.query(`SELECT 1 FROM revenue_events WHERE payment_id = $1`, [paymentId])
        if (rows.length) return
      }
    } catch (error) {
      console.error("Revenue telemetry write failed", error?.message ?? error)
    }
  })()
}

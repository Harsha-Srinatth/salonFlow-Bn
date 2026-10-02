import { createSchemaEnsurer } from "../lib/schema-guard.js"
import { ensureBookingsSchema } from "../bookings/schema-init.js"

/**
 * Razorpay payment tracking. Three tables, deliberately separate from `payment_transactions`
 * (that one is the *cash ledger* revenue reports sum over; a row is written there only once a
 * payment is verified and the booking exists):
 *
 *  - razorpay_payments        one row per Razorpay order = one checkout attempt, with its
 *                             gateway status and the booking it produced. The payment lifecycle
 *                             lives here, independent of the booking lifecycle.
 *  - razorpay_payment_events  append-only journal (CHECKOUT_STARTED, ORDER_CREATED,
 *                             CHECKOUT_OPENED, PAYMENT_FAILED, ...) used to see where users drop off.
 *  - razorpay_webhook_events  every webhook delivery, keyed by Razorpay's event id so a
 *                             redelivery is recognised and processed at most once.
 */
export const ensurePaymentsSchema = createSchemaEnsurer({
  name: "payments",
  async migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS razorpay_payments (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
        payment_transaction_id UUID REFERENCES payment_transactions(id) ON DELETE SET NULL,
        intent_key VARCHAR(64) NOT NULL,
        request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        amount NUMERIC(12,2) NOT NULL,
        amount_paise BIGINT NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'INR',
        razorpay_order_id VARCHAR(64),
        razorpay_payment_id VARCHAR(64),
        status VARCHAR(16) NOT NULL DEFAULT 'CREATED',
        fulfillment VARCHAR(24) NOT NULL DEFAULT 'NONE',
        gateway_status VARCHAR(24),
        payment_method VARCHAR(32),
        failure_code VARCHAR(128),
        failure_reason TEXT,
        failure_source VARCHAR(64),
        failure_step VARCHAR(64),
        booking_failure_code VARCHAR(48),
        refund_id VARCHAR(64),
        refund_status VARCHAR(24),
        verified_via VARCHAR(16),
        order_created_at TIMESTAMPTZ,
        checkout_opened_at TIMESTAMPTZ,
        payment_attempted_at TIMESTAMPTZ,
        captured_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        last_reconciled_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // Backstops: whatever the application code does, the database refuses a second row for the
    // same Razorpay order / payment / booking, and a second *open* checkout for the same intent.
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS razorpay_payments_order_id_uidx ON razorpay_payments (razorpay_order_id) WHERE razorpay_order_id IS NOT NULL`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS razorpay_payments_payment_id_uidx ON razorpay_payments (razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS razorpay_payments_booking_id_uidx ON razorpay_payments (booking_id) WHERE booking_id IS NOT NULL`)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS razorpay_payments_open_intent_uidx
      ON razorpay_payments (intent_key) WHERE status IN ('CREATED', 'PENDING') AND fulfillment = 'NONE'
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS razorpay_payments_user_idx ON razorpay_payments (user_id, created_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS razorpay_payments_sweep_idx ON razorpay_payments (status, expires_at)`)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'razorpay_payments_status_check') THEN
          ALTER TABLE razorpay_payments ADD CONSTRAINT razorpay_payments_status_check
            CHECK (status IN ('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'razorpay_payments_fulfillment_check') THEN
          ALTER TABLE razorpay_payments ADD CONSTRAINT razorpay_payments_fulfillment_check
            CHECK (fulfillment IN ('NONE', 'BOOKED', 'REFUND_PENDING', 'REFUND_INITIATED', 'REFUNDED', 'REFUND_FAILED'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'razorpay_payments_amount_check') THEN
          ALTER TABLE razorpay_payments ADD CONSTRAINT razorpay_payments_amount_check
            CHECK (amount_paise > 0 AND currency = 'INR');
        END IF;
      END $$;
    `)
    // Gateway refund owed because the booking was cancelled after paying (amount set by the cancellation policy).
    await client.query(`ALTER TABLE razorpay_payments ADD COLUMN IF NOT EXISTS cancel_refund_paise BIGINT`)
    await client.query(`ALTER TABLE razorpay_payments ADD COLUMN IF NOT EXISTS cancel_refund_id VARCHAR(64)`)
    await client.query(`ALTER TABLE razorpay_payments ADD COLUMN IF NOT EXISTS cancel_refund_status VARCHAR(16)`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS razorpay_payment_events (
        id BIGSERIAL PRIMARY KEY,
        payment_id UUID NOT NULL REFERENCES razorpay_payments(id) ON DELETE CASCADE,
        event_type VARCHAR(48) NOT NULL,
        source VARCHAR(16) NOT NULL,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS razorpay_payment_events_payment_idx ON razorpay_payment_events (payment_id, id)`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
        id BIGSERIAL PRIMARY KEY,
        event_id VARCHAR(128) NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        razorpay_order_id VARCHAR(64),
        razorpay_payment_id VARCHAR(64),
        summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        attempts INTEGER NOT NULL DEFAULT 1,
        result VARCHAR(48),
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ
      )
    `)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS razorpay_webhook_events_event_id_uidx ON razorpay_webhook_events (event_id)`)
  },
})

/** The payments tables reference `bookings` and `payment_transactions`; make sure those exist first. */
export async function ensurePaymentsStack() {
  await ensureBookingsSchema()
  await ensurePaymentsSchema()
}

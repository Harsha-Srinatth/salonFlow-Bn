import { createSchemaEnsurer } from "../lib/schema-guard.js"

/**
 * Tables behind WhatsApp messaging. Runtime DDL like every other module (drizzle is not
 * used for migrations here). Nothing on `users` or `bookings` is altered: consent lives in
 * `whatsapp_contacts`, keyed by phone, because opt-outs arrive from WhatsApp as a phone
 * number that may not belong to any account.
 *
 *  - whatsapp_otp_challenges: one row per code sent. Only an HMAC of the code is stored.
 *  - whatsapp_messages: the outbox. Every notification is a row first and a send second,
 *    written in the same transaction as the booking change that caused it, so a crash
 *    after commit cannot lose it and a retried request cannot double it (`dedupe_key`).
 *  - whatsapp_contacts: marketing consent and opt-out per number.
 *  - whatsapp_webhook_events: ids of webhook events already applied (Meta redelivers).
 *  - whatsapp_campaigns: one row per promotional send of an offer.
 */
export const ensureWhatsAppSchema = createSchemaEnsurer({
  name: "whatsapp",
  async migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_otp_challenges (
        id UUID PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        purpose VARCHAR(16) NOT NULL,
        code_hash CHAR(64) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        ip_hash CHAR(64),
        wa_message_id VARCHAR(128),
        delivery_error VARCHAR(160),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        verified_at TIMESTAMPTZ,
        consumed_at TIMESTAMPTZ,
        CONSTRAINT whatsapp_otp_purpose_check CHECK (purpose IN ('LOGIN', 'SIGNUP', 'STAFF_SETUP')),
        CONSTRAINT whatsapp_otp_status_check CHECK (status IN ('ACTIVE', 'VERIFIED', 'CONSUMED', 'SUPERSEDED', 'EXPIRED', 'LOCKED', 'DELIVERY_FAILED'))
      )
    `)
    // At most one live code per number and purpose: issuing a new one supersedes the old.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_otp_one_active_idx
      ON whatsapp_otp_challenges (phone, purpose) WHERE status = 'ACTIVE'
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_otp_phone_created_idx ON whatsapp_otp_challenges (phone, created_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_otp_ip_created_idx ON whatsapp_otp_challenges (ip_hash, created_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_otp_wa_message_idx ON whatsapp_otp_challenges (wa_message_id) WHERE wa_message_id IS NOT NULL`)
    // Monthly budget counts (budget.js).
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_otp_sent_month_idx ON whatsapp_otp_challenges (created_at) WHERE wa_message_id IS NOT NULL`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id UUID PRIMARY KEY,
        kind VARCHAR(32) NOT NULL,
        category VARCHAR(16) NOT NULL,
        dedupe_key VARCHAR(255) NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        phone VARCHAR(20) NOT NULL,
        booking_id UUID,
        campaign_id UUID,
        context JSONB NOT NULL DEFAULT '{}'::jsonb,
        template_name VARCHAR(512),
        template_language VARCHAR(16),
        status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        locked_until TIMESTAMPTZ,
        wa_message_id VARCHAR(128),
        last_error_code VARCHAR(32),
        last_error VARCHAR(400),
        sent_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        read_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT whatsapp_messages_dedupe_unique UNIQUE (dedupe_key),
        CONSTRAINT whatsapp_messages_category_check CHECK (category IN ('UTILITY', 'MARKETING', 'SERVICE')),
        CONSTRAINT whatsapp_messages_status_check CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED', 'EXPIRED', 'SKIPPED'))
      )
    `)
    // The worker's only query shape: due PENDING rows, and SENDING rows whose lease ran out.
    await client.query(`
      CREATE INDEX IF NOT EXISTS whatsapp_messages_due_idx
      ON whatsapp_messages (next_attempt_at) WHERE status IN ('PENDING', 'SENDING')
    `)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_wa_id_idx
      ON whatsapp_messages (wa_message_id) WHERE wa_message_id IS NOT NULL
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_messages_booking_idx ON whatsapp_messages (booking_id) WHERE booking_id IS NOT NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_messages_campaign_idx ON whatsapp_messages (campaign_id, status) WHERE campaign_id IS NOT NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_messages_user_idx ON whatsapp_messages (user_id, created_at DESC) WHERE user_id IS NOT NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_messages_kind_sent_idx ON whatsapp_messages (kind, sent_at) WHERE sent_at IS NOT NULL`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_contacts (
        phone VARCHAR(20) PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
        marketing_opt_in_at TIMESTAMPTZ,
        marketing_opt_out_at TIMESTAMPTZ,
        consent_source VARCHAR(32),
        last_inbound_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_contacts_user_idx ON whatsapp_contacts (user_id) WHERE user_id IS NOT NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_contacts_opted_in_idx ON whatsapp_contacts (phone) WHERE marketing_opt_in = TRUE`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
        event_key VARCHAR(255) PRIMARY KEY,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_webhook_events_received_idx ON whatsapp_webhook_events (received_at)`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
        id UUID PRIMARY KEY,
        offer_type VARCHAR(16) NOT NULL,
        offer_id UUID NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        offer_summary TEXT NOT NULL,
        valid_until_text VARCHAR(120) NOT NULL,
        recipients_count INTEGER NOT NULL DEFAULT 0,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT whatsapp_campaigns_idempotency_unique UNIQUE (idempotency_key)
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS whatsapp_campaigns_created_idx ON whatsapp_campaigns (created_at DESC)`)
  },
})

import { createSchemaEnsurer } from "../lib/schema-guard.js"

/**
 * Tables behind the email system. The marketing-consent and signup columns on `users` live in
 * `auth/schema-init.js` with the other profile columns, because every authenticated request
 * reads them.
 *
 *  - `email_messages`: the outbox. A row is one email, written in the same transaction as the
 *    change that caused it. It never holds a verification or reset token: those are minted by
 *    the worker at send time, so only their hashes ever reach the database.
 *  - `email_tokens`: hashes of single-use verification and password-reset tokens.
 *  - `email_suppressions`: addresses that bounced hard or complained; never mailed again.
 *  - `email_events`: delivery events from SES, idempotent on the SNS message id.
 *  - `email_campaigns`: promotional sends written by the salon.
 */
export const ensureEmailSchema = createSchemaEnsurer({
  name: "email",
  async migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_campaigns (
        id UUID PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        subject VARCHAR(150) NOT NULL,
        preheader VARCHAR(150) NOT NULL DEFAULT '',
        headline VARCHAR(150) NOT NULL,
        body TEXT NOT NULL,
        cta_label VARCHAR(40) NOT NULL DEFAULT '',
        cta_path VARCHAR(200) NOT NULL DEFAULT '',
        audience JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
        recipient_count INTEGER NOT NULL DEFAULT 0,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        started_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT email_campaigns_status_check CHECK (status IN ('DRAFT', 'SENDING', 'CANCELLED'))
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_messages (
        id UUID PRIMARY KEY,
        dedupe_key VARCHAR(255) NOT NULL,
        template VARCHAR(40) NOT NULL,
        category VARCHAR(16) NOT NULL DEFAULT 'TRANSACTIONAL',
        recipient VARCHAR(320) NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        booking_id UUID,
        campaign_id UUID REFERENCES email_campaigns(id) ON DELETE SET NULL,
        booking_starts_at TIMESTAMPTZ,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        scheduled_for TIMESTAMPTZ NOT NULL,
        next_attempt_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 6,
        locked_until TIMESTAMPTZ,
        provider_message_id VARCHAR(128),
        last_error VARCHAR(400),
        sent_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        bounced_at TIMESTAMPTZ,
        complained_at TIMESTAMPTZ,
        first_opened_at TIMESTAMPTZ,
        first_clicked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT email_messages_dedupe_unique UNIQUE (dedupe_key),
        CONSTRAINT email_messages_status_check CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED')),
        CONSTRAINT email_messages_category_check CHECK (category IN ('TRANSACTIONAL', 'MARKETING'))
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS email_messages_due_idx ON email_messages (next_attempt_at) WHERE status IN ('PENDING', 'SENDING')`)
    await client.query(`CREATE INDEX IF NOT EXISTS email_messages_booking_idx ON email_messages (booking_id) WHERE booking_id IS NOT NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS email_messages_campaign_idx ON email_messages (campaign_id) WHERE campaign_id IS NOT NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS email_messages_user_template_idx ON email_messages (user_id, template, created_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS email_messages_provider_idx ON email_messages (provider_message_id) WHERE provider_message_id IS NOT NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS email_messages_sent_idx ON email_messages (sent_at) WHERE sent_at IS NOT NULL`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_tokens (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose VARCHAR(16) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        invalidated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT email_tokens_hash_unique UNIQUE (token_hash),
        CONSTRAINT email_tokens_purpose_check CHECK (purpose IN ('VERIFY_EMAIL', 'RESET_PASSWORD'))
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens (user_id, purpose) WHERE consumed_at IS NULL AND invalidated_at IS NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS email_tokens_expires_idx ON email_tokens (expires_at)`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_suppressions (
        email VARCHAR(320) PRIMARY KEY,
        reason VARCHAR(16) NOT NULL,
        source VARCHAR(40) NOT NULL DEFAULT 'ses',
        detail VARCHAR(400),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT email_suppressions_reason_check CHECK (reason IN ('BOUNCE', 'COMPLAINT', 'MANUAL'))
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_events (
        id UUID PRIMARY KEY,
        sns_message_id VARCHAR(128) NOT NULL,
        provider_message_id VARCHAR(128),
        message_id UUID REFERENCES email_messages(id) ON DELETE SET NULL,
        event_type VARCHAR(24) NOT NULL,
        recipient VARCHAR(320),
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT email_events_sns_unique UNIQUE (sns_message_id)
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS email_events_provider_idx ON email_events (provider_message_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS email_events_occurred_idx ON email_events (occurred_at DESC)`)
  },
})

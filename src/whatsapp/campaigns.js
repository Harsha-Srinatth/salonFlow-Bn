/**
 * Promotional WhatsApp messages for offers that already exist in the Offer Center.
 *
 * Deliberately small: an admin picks one active offer and sends it; there is no separate
 * campaign builder. Safeguards:
 *  - Recipients are only customers who opted in to WhatsApp offers and have not opted out
 *    (`whatsapp_contacts`), never "every registered customer".
 *  - The text is generated from the offer row itself, and re-checked at send time: an offer
 *    that was disabled, expired or edited after the campaign was created is not sent.
 *  - One promotion per customer per offer (`dedupe_key`), however many times an admin
 *    clicks send; the request's idempotency key returns the same campaign on retry.
 *  - Audience size is capped (WHATSAPP_CAMPAIGN_MAX_RECIPIENTS) and rows are created with a
 *    single INSERT … SELECT, then drained by the normal outbox worker in small batches.
 *
 * OFFER template parameters: 1 first name, 2 offer description, 3 valid until.
 */
import { randomUUID } from "node:crypto"
import { pool } from "../lib/db-pool.js"
import { ensureOfferSchema } from "../offers/service.js"
import { TEMPLATE_KEYS, isWhatsAppSendingAvailable, templateFor, whatsappConfig } from "./config.js"
import { bodyComponents } from "./client.js"
import { registerMessageKind } from "./outbox.js"
import { ensureWhatsAppSchema } from "./schema-init.js"
import { firstName, formatSalonDate } from "./notifications.js"
import { normalizePhone } from "./phone.js"
import { BUDGETS, remainingThisMonth } from "./budget.js"

export const OFFER_TYPES = ["GLOBAL", "SERVICE", "MEMBERSHIP", "COMBO"]

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true, code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST" })
}

function percentText(value) {
  const n = Number(value)
  return Number.isInteger(n) ? `${n}%` : `${n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`
}

function isActive(row, now = new Date()) {
  if (!row?.is_enabled) return false
  if (row.start_at && now < new Date(row.start_at)) return false
  if (row.end_at && now > new Date(row.end_at)) return false
  return true
}

/**
 * Reads an offer and turns it into what the customer will be told. Throws when the offer
 * does not exist, is switched off, has not started or has ended.
 *
 * @returns {Promise<{ summary: string, validUntilText: string, endsAt: Date | null, segments: string[] | null, fingerprint: string }>}
 */
export async function describeOffer(type, id, db = pool) {
  const offerType = `${type ?? ""}`.trim().toUpperCase()
  if (!OFFER_TYPES.includes(offerType)) throw fail(400, "Unsupported offer type")
  if (!/^[0-9a-f-]{36}$/i.test(`${id ?? ""}`)) throw fail(400, "Offer id is not valid")
  let row
  let summary
  let segments = null
  if (offerType === "GLOBAL") {
    ;({ rows: [row] } = await db.query(`SELECT * FROM offer_global_discounts WHERE id = $1`, [id]))
    if (row) summary = `${percentText(row.discount_percent)} off all services`
  } else if (offerType === "SERVICE") {
    ;({ rows: [row] } = await db.query(
      `SELECT d.*, s.name AS service_name, s.is_active AS service_active FROM offer_service_discounts d JOIN service_catalog s ON s.id = d.service_id WHERE d.id = $1`,
      [id]
    ))
    if (row && !row.service_active) throw fail(400, "The service in this offer is no longer offered")
    if (row) summary = `${percentText(row.discount_percent)} off ${row.service_name}`
  } else if (offerType === "MEMBERSHIP") {
    ;({ rows: [row] } = await db.query(
      `SELECT d.*, s.name AS service_name, s.is_active AS service_active FROM offer_membership_service_discounts d JOIN service_catalog s ON s.id = d.service_id WHERE d.id = $1`,
      [id]
    ))
    if (row && !row.service_active) throw fail(400, "The service in this offer is no longer offered")
    if (row) {
      summary = `${percentText(row.discount_percent)} off ${row.service_name} for ${row.membership_segment} members`
      segments = [row.membership_segment]
    }
  } else {
    ;({ rows: [row] } = await db.query(`SELECT * FROM offer_combos WHERE id = $1`, [id]))
    if (row) {
      summary = `${row.name} combo at Rs ${Number(row.offer_price).toFixed(0)}`
      segments = Array.isArray(row.visible_segments) && row.visible_segments.length ? row.visible_segments : null
    }
  }
  if (!row) throw fail(404, "Offer not found")
  if (!row.is_enabled) throw fail(400, "This offer is switched off")
  const now = new Date()
  if (row.start_at && now < new Date(row.start_at)) throw fail(400, "This offer has not started yet")
  if (row.end_at && now > new Date(row.end_at)) throw fail(400, "This offer has ended")
  if (!isActive(row, now)) throw fail(400, "This offer is not active")
  const endsAt = row.end_at ? new Date(row.end_at) : null
  const validUntilText = endsAt ? formatSalonDate(endsAt) : "until further notice"
  // Anything that changes what the customer is promised changes the fingerprint.
  const fingerprint = JSON.stringify([offerType, summary, validUntilText, segments])
  return { summary, validUntilText, endsAt, segments, fingerprint }
}

/** Eligible audience size for an offer, without sending anything. */
export async function previewOfferAudience({ offerType, offerId, db = pool }) {
  await ensureOfferSchema()
  await ensureWhatsAppSchema()
  const offer = await describeOffer(offerType, offerId, db)
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS eligible
       FROM users u JOIN whatsapp_contacts c ON c.phone = u.phone
      WHERE u.role = 'USER' AND u.account_status = 'ACTIVE'
        AND c.marketing_opt_in = TRUE AND c.marketing_opt_out_at IS NULL
        AND ($1::text[] IS NULL OR u.membership_segment = ANY($1::text[]))`,
    [offer.segments]
  )
  return { offer: { summary: offer.summary, validUntil: offer.validUntilText }, eligibleRecipients: rows[0].eligible }
}

/**
 * Creates a campaign for an offer and queues one message per eligible customer.
 * Retrying with the same `idempotencyKey` returns the original campaign.
 */
export async function createOfferCampaign({ offerType, offerId, idempotencyKey, actorUserId, config = whatsappConfig(), db = pool }) {
  if (!isWhatsAppSendingAvailable(config)) throw fail(503, "WhatsApp is not configured on the server")
  if (!templateFor(TEMPLATE_KEYS.OFFER, config)) throw fail(503, "No approved offer template is configured (WHATSAPP_TEMPLATE_OFFER)")
  const key = `${idempotencyKey ?? ""}`.trim()
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw fail(400, "idempotencyKey (8-128 letters, digits, - or _) is required")
  await ensureOfferSchema()
  await ensureWhatsAppSchema()
  const type = `${offerType ?? ""}`.trim().toUpperCase()
  const offer = await describeOffer(type, offerId, db)
  // Offers already queued this month count against the cap too, not just the sent ones.
  const { rows: queued } = await db.query(`SELECT COUNT(*)::int AS n FROM whatsapp_messages WHERE kind = 'OFFER' AND status IN ('PENDING', 'SENDING')`)
  const budgetLeft = Math.max(0, (await remainingThisMonth(BUDGETS.OFFER, config, db)) - queued[0].n)
  const recipientCap = Math.min(config.marketing.maxRecipients, budgetLeft)
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const campaignId = randomUUID()
    const { rows: inserted } = await client.query(
      `INSERT INTO whatsapp_campaigns (id, offer_type, offer_id, idempotency_key, offer_summary, valid_until_text, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [campaignId, type, offerId, key, offer.summary, offer.validUntilText, actorUserId ?? null]
    )
    if (!inserted[0]) {
      await client.query("ROLLBACK")
      const { rows } = await db.query(`SELECT id FROM whatsapp_campaigns WHERE idempotency_key = $1`, [key])
      return { ...(await getCampaignStats(rows[0].id, db)), duplicateRequest: true }
    }
    if (recipientCap <= 0) {
      await client.query("ROLLBACK")
      throw fail(409, "This month's WhatsApp offer limit is used up (WHATSAPP_MONTHLY_LIMIT_OFFER)")
    }
    const maxExpiry = new Date(Date.now() + 3 * 24 * 3600_000)
    const expiresAt = offer.endsAt && offer.endsAt < maxExpiry ? offer.endsAt : maxExpiry
    const context = { offerType: type, offerId, fingerprint: offer.fingerprint, summary: offer.summary, validUntilText: offer.validUntilText }
    const { rowCount } = await client.query(
      `INSERT INTO whatsapp_messages (id, kind, category, dedupe_key, user_id, phone, campaign_id, context, max_attempts, expires_at)
       SELECT gen_random_uuid(), 'OFFER', 'MARKETING', 'offer:' || $1 || ':' || $2 || ':' || u.id::text,
              u.id, c.phone, $3, $4::jsonb, $5, $6
         FROM users u JOIN whatsapp_contacts c ON c.phone = u.phone
        WHERE u.role = 'USER' AND u.account_status = 'ACTIVE'
          AND c.marketing_opt_in = TRUE AND c.marketing_opt_out_at IS NULL
          AND ($7::text[] IS NULL OR u.membership_segment = ANY($7::text[]))
        ORDER BY u.created_at
        LIMIT $8
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [type, offerId, campaignId, JSON.stringify(context), Math.min(3, config.worker.maxAttempts), expiresAt.toISOString(), offer.segments, recipientCap]
    )
    await client.query(`UPDATE whatsapp_campaigns SET recipients_count = $2 WHERE id = $1`, [campaignId, rowCount])
    await client.query("COMMIT")
    return { ...(await getCampaignStats(campaignId, db)), duplicateRequest: false, monthlyOfferBudgetLeft: budgetLeft - rowCount }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Recipients, attempts, sent/delivered/read/failed/skipped and opt-outs since the campaign started. */
export async function getCampaignStats(campaignId, db = pool) {
  const { rows: campaigns } = await db.query(`SELECT * FROM whatsapp_campaigns WHERE id = $1`, [campaignId])
  const campaign = campaigns[0]
  if (!campaign) throw fail(404, "Campaign not found")
  const { rows } = await db.query(
    `SELECT
       COUNT(*)::int AS recipients,
       COUNT(*) FILTER (WHERE m.attempts > 0)::int AS attempted,
       COUNT(*) FILTER (WHERE m.status IN ('SENT', 'DELIVERED', 'READ'))::int AS sent,
       COUNT(*) FILTER (WHERE m.status IN ('DELIVERED', 'READ'))::int AS delivered,
       COUNT(*) FILTER (WHERE m.status = 'READ')::int AS read,
       COUNT(*) FILTER (WHERE m.status = 'FAILED')::int AS failed,
       COUNT(*) FILTER (WHERE m.status IN ('SKIPPED', 'EXPIRED', 'CANCELLED'))::int AS skipped,
       COUNT(*) FILTER (WHERE m.status IN ('PENDING', 'SENDING'))::int AS pending,
       COUNT(*) FILTER (WHERE c.marketing_opt_out_at > $2)::int AS opted_out
     FROM whatsapp_messages m
     LEFT JOIN whatsapp_contacts c ON c.phone = m.phone
     WHERE m.campaign_id = $1`,
    [campaignId, campaign.created_at]
  )
  return {
    campaign: {
      id: campaign.id,
      offerType: campaign.offer_type,
      offerId: campaign.offer_id,
      offerSummary: campaign.offer_summary,
      validUntil: campaign.valid_until_text,
      createdAt: campaign.created_at,
    },
    stats: {
      recipients: rows[0].recipients,
      attempted: rows[0].attempted,
      sent: rows[0].sent,
      delivered: rows[0].delivered,
      read: rows[0].read,
      failed: rows[0].failed,
      skipped: rows[0].skipped,
      pending: rows[0].pending,
      optedOut: rows[0].opted_out,
    },
  }
}

export async function listCampaigns({ limit = 20, db = pool } = {}) {
  await ensureWhatsAppSchema()
  const { rows } = await db.query(`SELECT id FROM whatsapp_campaigns ORDER BY created_at DESC LIMIT $1`, [Math.min(Math.max(Number(limit) || 20, 1), 100)])
  return Promise.all(rows.map(row => getCampaignStats(row.id, db)))
}

// ---------------------------------------------------------------------------------------
// Marketing consent (kept separate from transactional notifications).

export async function getMarketingPreference({ phone, db = pool }) {
  await ensureWhatsAppSchema()
  const normalized = normalizePhone(phone)
  if (!normalized) return { marketingOptIn: false, optedOutAt: null, phoneOnFile: false }
  const { rows } = await db.query(`SELECT marketing_opt_in, marketing_opt_out_at FROM whatsapp_contacts WHERE phone = $1`, [normalized])
  return { marketingOptIn: Boolean(rows[0]?.marketing_opt_in), optedOutAt: rows[0]?.marketing_opt_out_at ?? null, phoneOnFile: true }
}

/**
 * Records an explicit choice by the customer. Opting in is only ever done by the customer
 * (profile toggle or replying START); it is never defaulted on.
 */
export async function setMarketingPreference({ phone, userId = null, optIn, source, db = pool }) {
  await ensureWhatsAppSchema()
  const normalized = normalizePhone(phone)
  if (!normalized) throw fail(400, "A valid phone number is required for WhatsApp offers")
  await db.query(
    `INSERT INTO whatsapp_contacts (phone, user_id, marketing_opt_in, marketing_opt_in_at, marketing_opt_out_at, consent_source)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN NOW() END, CASE WHEN $3 THEN NULL ELSE NOW() END, $4)
     ON CONFLICT (phone) DO UPDATE SET
       user_id = COALESCE(EXCLUDED.user_id, whatsapp_contacts.user_id),
       marketing_opt_in = EXCLUDED.marketing_opt_in,
       marketing_opt_in_at = CASE WHEN EXCLUDED.marketing_opt_in THEN NOW() ELSE whatsapp_contacts.marketing_opt_in_at END,
       marketing_opt_out_at = CASE WHEN EXCLUDED.marketing_opt_in THEN NULL ELSE NOW() END,
       consent_source = EXCLUDED.consent_source,
       updated_at = NOW()`,
    [normalized, userId, Boolean(optIn), `${source ?? "UNKNOWN"}`.slice(0, 32)]
  )
  // Opting out also stops promotions already queued for this number.
  if (!optIn) {
    await db.query(
      `UPDATE whatsapp_messages SET status = 'CANCELLED', last_error = 'customer opted out', updated_at = NOW()
        WHERE phone = $1 AND category = 'MARKETING' AND status = 'PENDING'`,
      [normalized]
    )
  }
  return getMarketingPreference({ phone: normalized, db })
}

registerMessageKind("OFFER", {
  async prepare(row, ctx) {
    const { rows } = await pool.query(
      `SELECT c.marketing_opt_in, c.marketing_opt_out_at, u.name, u.account_status
         FROM whatsapp_contacts c LEFT JOIN users u ON u.id = $2
        WHERE c.phone = $1`,
      [row.phone, row.user_id]
    )
    const consent = rows[0]
    if (!consent?.marketing_opt_in || consent.marketing_opt_out_at) return { skip: "no marketing consent" }
    if (consent.account_status !== "ACTIVE") return { skip: "account not active" }
    const cacheKey = `offer:${row.context?.offerType}:${row.context?.offerId}`
    if (!ctx.cache.has(cacheKey)) {
      ctx.cache.set(
        cacheKey,
        await describeOffer(row.context?.offerType, row.context?.offerId).catch(error => ({ error: error.message }))
      )
    }
    const offer = ctx.cache.get(cacheKey)
    if (offer.error) return { skip: `offer no longer valid: ${offer.error}` }
    if (offer.fingerprint !== row.context?.fingerprint) return { skip: "offer changed after the campaign was created" }
    const template = templateFor(TEMPLATE_KEYS.OFFER)
    if (!template) return { skip: "offer template no longer configured" }
    return { send: { template, components: bodyComponents([firstName(consent.name), offer.summary, offer.validUntilText]) } }
  },
})

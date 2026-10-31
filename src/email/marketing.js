/**
 * Promotional email: consent, unsubscribe and campaigns.
 *
 * Consent is off by default and is only ever set by the customer. Nothing here sends on a
 * schedule: a campaign goes out when an admin presses send, and only to customers who are active,
 * confirmed their address, opted in, never unsubscribed and are not suppressed. The worker checks
 * consent again right before each send, so an unsubscribe takes effect even mid-campaign. The
 * dedupe key means a campaign reaches a customer at most once, however often send is pressed.
 */
import { randomUUID } from "node:crypto"
import { pool } from "../lib/db-pool.js"
import { emailConfig, isEmailAvailable } from "./config.js"
import { ensureEmailSchema } from "./schema.js"
import { CATEGORY_MARKETING, enqueueEmail, kickEmailWorker } from "./service.js"
import { verifyUnsubscribeToken } from "./tokens.js"

const CTA_PATH_RE = /^\/[A-Za-z0-9/_?=&.-]{0,199}$/
const SEGMENT_RE = /^[A-Z0-9_]{1,16}$/
const GENDERS = new Set(["MALE", "FEMALE", "OTHER"])

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status, expose: true })
}

// --- consent ----------------------------------------------------------------------------------

export async function setMarketingConsent(db, userId, consent, source) {
  await db.query(
    consent
      ? `UPDATE users
            SET marketing_email_consent = TRUE, marketing_email_consent_at = NOW(), marketing_email_consent_source = $2,
                marketing_email_unsubscribed_at = NULL, updated_at = NOW()
          WHERE id = $1`
      : `UPDATE users
            SET marketing_email_consent = FALSE, marketing_email_consent_source = $2,
                marketing_email_unsubscribed_at = COALESCE(marketing_email_unsubscribed_at, NOW()), updated_at = NOW()
          WHERE id = $1`,
    [userId, source]
  )
}

/** What the unsubscribe page and one-click header both call. Repeating it changes nothing. */
export async function unsubscribeWithToken(token, source = "unsubscribe_link", config = emailConfig()) {
  const userId = verifyUnsubscribeToken(token, config.linkSecret)
  if (!userId) return false
  await setMarketingConsent(pool, userId, false, source)
  await pool.query(
    `UPDATE email_messages SET status = 'CANCELLED', last_error = 'customer unsubscribed', updated_at = NOW()
      WHERE user_id = $1 AND category = 'MARKETING' AND status = 'PENDING'`,
    [userId]
  )
  return true
}

export async function getEmailPreferences(userId) {
  const { rows } = await pool.query(
    `SELECT marketing_email_consent, marketing_email_consent_at, marketing_email_unsubscribed_at, email_booking_updates FROM users WHERE id = $1`,
    [userId]
  )
  const row = rows[0]
  return {
    marketingEmails: row?.marketing_email_consent === true,
    marketingConsentAt: row?.marketing_email_consent_at ?? null,
    marketingUnsubscribedAt: row?.marketing_email_unsubscribed_at ?? null,
    bookingEmails: row?.email_booking_updates !== false,
  }
}

export async function updateEmailPreferences(userId, { marketingEmails, bookingEmails }) {
  if (typeof marketingEmails === "boolean") await setMarketingConsent(pool, userId, marketingEmails, "profile")
  if (typeof bookingEmails === "boolean") {
    await pool.query(`UPDATE users SET email_booking_updates = $2, updated_at = NOW() WHERE id = $1`, [userId, bookingEmails])
  }
  return getEmailPreferences(userId)
}

// --- audience ---------------------------------------------------------------------------------

/** Keeps only filters this code understands; everything else is dropped, never interpolated. */
export function normalizeAudience(input = {}) {
  const segments = (Array.isArray(input.membershipSegments) ? input.membershipSegments : [])
    .map(value => `${value}`.trim().toUpperCase())
    .filter(value => SEGMENT_RE.test(value))
  const genders = (Array.isArray(input.genders) ? input.genders : [])
    .map(value => `${value}`.trim().toUpperCase())
    .filter(value => GENDERS.has(value))
  const dayCount = value => {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 3650 ? parsed : null
  }
  const month = Number(input.birthdayMonth)
  return {
    membershipSegments: [...new Set(segments)],
    genders: [...new Set(genders)],
    visitedWithinDays: dayCount(input.visitedWithinDays),
    inactiveForDays: dayCount(input.inactiveForDays),
    birthdayMonth: Number.isInteger(month) && month >= 1 && month <= 12 ? month : null,
  }
}

/** Customers who may receive promotions, narrowed by the campaign's filters. */
function audienceQuery(audience) {
  const values = []
  const where = [
    `u.role = 'USER'`,
    `u.account_status = 'ACTIVE'`,
    `u.email_verified = TRUE`,
    `u.marketing_email_consent = TRUE`,
    `u.marketing_email_unsubscribed_at IS NULL`,
    `NOT EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email = lower(btrim(u.email)))`,
  ]
  const add = value => {
    values.push(value)
    return `$${values.length}`
  }
  if (audience.membershipSegments.length) where.push(`u.membership_segment = ANY(${add(audience.membershipSegments)}::text[])`)
  if (audience.genders.length) where.push(`u.gender = ANY(${add(audience.genders)}::text[])`)
  if (audience.birthdayMonth) where.push(`EXTRACT(MONTH FROM u.date_of_birth) = ${add(audience.birthdayMonth)}`)
  if (audience.visitedWithinDays) {
    where.push(`EXISTS (SELECT 1 FROM bookings b WHERE b.created_by = u.id AND b.status = 'COMPLETED'
                         AND b.starts_at >= NOW() - make_interval(days => ${add(audience.visitedWithinDays)}))`)
  }
  if (audience.inactiveForDays) {
    where.push(`NOT EXISTS (SELECT 1 FROM bookings b WHERE b.created_by = u.id AND b.status IN ('COMPLETED', 'CONFIRMED', 'STARTED')
                             AND b.starts_at >= NOW() - make_interval(days => ${add(audience.inactiveForDays)}))`)
  }
  return { where: where.join(" AND "), values }
}

export async function previewAudience(input) {
  const audience = normalizeAudience(input)
  const { where, values } = audienceQuery(audience)
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM users u WHERE ${where}`, values)
  return { audience, recipients: rows[0].n }
}

// --- campaigns --------------------------------------------------------------------------------

function cleanCampaign(input = {}) {
  const field = (name, max, { required = false } = {}) => {
    const value = `${input[name] ?? ""}`.trim()
    if (required && !value) throw fail(`${name} is required`)
    if (value.length > max) throw fail(`${name} must be ${max} characters or fewer`)
    return value
  }
  const ctaPath = field("ctaPath", 200)
  if (ctaPath && !CTA_PATH_RE.test(ctaPath)) throw fail("The button link must be a path on the Sahasra site, such as /user-dashboard/offers")
  return {
    name: field("name", 120, { required: true }),
    subject: field("subject", 150, { required: true }),
    preheader: field("preheader", 150),
    headline: field("headline", 150, { required: true }),
    body: field("body", 5000, { required: true }),
    ctaLabel: field("ctaLabel", 40),
    ctaPath,
    audience: normalizeAudience(input.audience),
  }
}

function mapCampaign(row) {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    preheader: row.preheader,
    headline: row.headline,
    body: row.body,
    ctaLabel: row.cta_label,
    ctaPath: row.cta_path,
    audience: row.audience,
    status: row.status,
    recipientCount: row.recipient_count,
    startedAt: row.started_at,
    createdAt: row.created_at,
    stats: row.stats ?? undefined,
  }
}

export async function createCampaign(input, actorUserId) {
  await ensureEmailSchema()
  const campaign = cleanCampaign(input)
  const { rows } = await pool.query(
    `INSERT INTO email_campaigns (id, name, subject, preheader, headline, body, cta_label, cta_path, audience, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [randomUUID(), campaign.name, campaign.subject, campaign.preheader, campaign.headline, campaign.body, campaign.ctaLabel, campaign.ctaPath, JSON.stringify(campaign.audience), actorUserId]
  )
  return mapCampaign(rows[0])
}

export async function listCampaigns() {
  await ensureEmailSchema()
  const { rows } = await pool.query(`
    SELECT c.*, (
      SELECT json_build_object(
        'queued', COUNT(*) FILTER (WHERE m.status IN ('PENDING', 'SENDING')),
        'sent', COUNT(*) FILTER (WHERE m.status = 'SENT'),
        'skipped', COUNT(*) FILTER (WHERE m.status IN ('SKIPPED', 'CANCELLED')),
        'failed', COUNT(*) FILTER (WHERE m.status = 'FAILED'),
        'delivered', COUNT(m.delivered_at),
        'bounced', COUNT(m.bounced_at),
        'complained', COUNT(m.complained_at),
        'opened', COUNT(m.first_opened_at),
        'clicked', COUNT(m.first_clicked_at)
      ) FROM email_messages m WHERE m.campaign_id = c.id
    ) AS stats
    FROM email_campaigns c
    ORDER BY c.created_at DESC
    LIMIT 50
  `)
  return rows.map(mapCampaign)
}

async function getCampaign(id, db = pool) {
  const { rows } = await db.query(`SELECT * FROM email_campaigns WHERE id = $1`, [id])
  if (!rows[0]) throw fail("Campaign not found", 404)
  return rows[0]
}

function campaignPayload(row, config) {
  return {
    subject: row.subject,
    preheader: row.preheader,
    headline: row.headline,
    body: row.body,
    ctaLabel: row.cta_label,
    ctaUrl: row.cta_path ? `${config.publicUrl}${row.cta_path}` : "",
  }
}

function assertMarketingAvailable(config) {
  if (!isEmailAvailable(config) || !config.marketingEnabled) {
    throw fail("Promotional email is switched off (EMAIL_MARKETING_ENABLED).", 409)
  }
}

/**
 * Sends a campaign to the admin who is writing it, as a check of how it looks. Goes through the
 * same worker, so it needs that admin to have opted in too; otherwise it would be skipped.
 */
export async function sendCampaignTest(id, adminUser, config = emailConfig()) {
  assertMarketingAvailable(config)
  const row = await getCampaign(id)
  await enqueueEmail(pool, {
    template: "promotional",
    category: CATEGORY_MARKETING,
    recipient: adminUser.email,
    dedupeKey: `campaign-test:${row.id}:${randomUUID()}`,
    userId: adminUser.id,
    payload: campaignPayload(row, config),
  })
  kickEmailWorker()
  return { sentTo: adminUser.email }
}

/** Queues the campaign for its audience. Only a draft can start, and only once. */
export async function sendCampaign(id, config = emailConfig()) {
  assertMarketingAvailable(config)
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const row = await getCampaign(id, client)
    const { rowCount } = await client.query(
      `UPDATE email_campaigns SET status = 'SENDING', started_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'DRAFT'`,
      [id]
    )
    if (!rowCount) throw fail("This campaign has already been sent or cancelled.", 409)
    const { where, values } = audienceQuery(normalizeAudience(row.audience))
    const { rows: recipients } = await client.query(`SELECT u.id, u.email FROM users u WHERE ${where}`, values)
    const payload = campaignPayload(row, config)
    for (const recipient of recipients) {
      await enqueueEmail(client, {
        template: "promotional",
        category: CATEGORY_MARKETING,
        recipient: recipient.email,
        dedupeKey: `campaign:${row.id}:user:${recipient.id}`,
        userId: recipient.id,
        campaignId: row.id,
        payload,
      })
    }
    await client.query(`UPDATE email_campaigns SET recipient_count = $2 WHERE id = $1`, [id, recipients.length])
    await client.query("COMMIT")
    kickEmailWorker()
    return { recipients: recipients.length }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Stops anything still queued. Messages already sent cannot be recalled. */
export async function cancelCampaign(id) {
  await getCampaign(id)
  await pool.query(`UPDATE email_campaigns SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`, [id])
  const { rowCount } = await pool.query(
    `UPDATE email_messages SET status = 'CANCELLED', last_error = 'campaign cancelled', updated_at = NOW()
      WHERE campaign_id = $1 AND status = 'PENDING'`,
    [id]
  )
  return { cancelled: rowCount }
}

/**
 * Delivery events from SES, which reach us as SNS notifications on POST /api/webhooks/ses.
 *
 * SNS signs every message with an AWS certificate. The signature is checked over the exact
 * canonical string SNS defines, the certificate must come from an sns.*.amazonaws.com host, and
 * the topic must be ours; only then is anything acted on. The subscription handshake URL gets
 * the same host check, because otherwise this endpoint could be made to fetch any address.
 *
 * Processing is idempotent on the SNS message id: SNS delivers at least once.
 */
import { createVerify, randomUUID } from "node:crypto"
import { pool } from "../lib/db-pool.js"
import { emailConfig } from "./config.js"
import { maskEmail, normalizeEmailAddress } from "./service.js"

const SNS_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com$/
const CERT_CACHE_LIMIT = 8
const certCache = new Map()

let fetcher = (...args) => fetch(...args)

/** Test seam: replaces the HTTP client used for certificates and subscription confirmation. */
export function setSnsFetchForTests(fake) {
  fetcher = fake ?? ((...args) => fetch(...args))
  certCache.clear()
}

function isSnsUrl(value, { pem = false } = {}) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && SNS_HOST_RE.test(url.hostname) && (!pem || url.pathname.endsWith(".pem"))
  } catch {
    return false
  }
}

async function loadCertificate(url) {
  if (certCache.has(url)) return certCache.get(url)
  const response = await fetcher(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`certificate fetch failed: ${response.status}`)
  const pem = await response.text()
  if (certCache.size >= CERT_CACHE_LIMIT) certCache.clear()
  certCache.set(url, pem)
  return pem
}

/** The string SNS signed: named fields, sorted, each as "Name\nValue\n". */
export function snsCanonicalString(message) {
  const fields =
    message.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]
  return fields
    .filter(field => message[field] !== undefined && message[field] !== null)
    .map(field => `${field}\n${message[field]}\n`)
    .join("")
}

export async function verifySnsSignature(message) {
  if (!isSnsUrl(message.SigningCertURL, { pem: true })) return false
  const algorithm = message.SignatureVersion === "2" ? "RSA-SHA256" : message.SignatureVersion === "1" ? "RSA-SHA1" : null
  if (!algorithm || !message.Signature) return false
  const certificate = await loadCertificate(message.SigningCertURL)
  return createVerify(algorithm).update(snsCanonicalString(message), "utf8").verify(certificate, message.Signature, "base64")
}

/** Permanent bounces and complaints end all mail to the address; a complaint also ends consent. */
async function suppress(db, address, reason, detail) {
  await db.query(
    `INSERT INTO email_suppressions (email, reason, detail) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
    [address, reason, `${detail ?? ""}`.slice(0, 400)]
  )
  await db.query(
    `UPDATE email_messages SET status = 'SKIPPED', last_error = $2, updated_at = NOW() WHERE recipient = $1 AND status = 'PENDING'`,
    [address, `address suppressed: ${reason}`]
  )
  console.log("email_suppressed", { to: maskEmail(address), reason })
}

async function revokeMarketingConsent(db, address) {
  await db.query(
    `UPDATE users
        SET marketing_email_consent = FALSE, marketing_email_unsubscribed_at = COALESCE(marketing_email_unsubscribed_at, NOW()), updated_at = NOW()
      WHERE lower(btrim(email)) = $1 AND marketing_email_consent = TRUE`,
    [address]
  )
}

const TRACKED_COLUMNS = {
  Delivery: "delivered_at",
  Bounce: "bounced_at",
  Complaint: "complained_at",
  Open: "first_opened_at",
  Click: "first_clicked_at",
}

/**
 * Applies one SES event.
 *
 * @param {string} snsMessageId idempotency key
 * @param {object} event the SES event object
 * @returns {Promise<boolean>} false when this notification was already processed
 */
export async function processSesEvent(snsMessageId, event, db = pool) {
  const type = `${event?.eventType ?? event?.notificationType ?? "Unknown"}`
  const providerId = event?.mail?.messageId ?? null
  const recipients = {
    Bounce: (event?.bounce?.bouncedRecipients ?? []).map(entry => entry.emailAddress),
    Complaint: (event?.complaint?.complainedRecipients ?? []).map(entry => entry.emailAddress),
  }[type] ?? event?.mail?.destination ?? []
  const addresses = recipients.map(normalizeEmailAddress).filter(Boolean)
  const occurredAt = event?.[type.toLowerCase()]?.timestamp ?? event?.mail?.timestamp ?? new Date().toISOString()

  const { rows: messages } = providerId
    ? await db.query(`SELECT id FROM email_messages WHERE provider_message_id = $1`, [providerId])
    : { rows: [] }
  const { rowCount } = await db.query(
    `INSERT INTO email_events (id, sns_message_id, provider_message_id, message_id, event_type, recipient, detail, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (sns_message_id) DO NOTHING`,
    [
      randomUUID(),
      snsMessageId,
      providerId,
      messages[0]?.id ?? null,
      type,
      addresses[0] ?? null,
      JSON.stringify({
        bounceType: event?.bounce?.bounceType,
        bounceSubType: event?.bounce?.bounceSubType,
        complaintType: event?.complaint?.complaintFeedbackType,
        rejectReason: event?.reject?.reason,
        renderingError: event?.failure?.errorMessage,
        delayType: event?.deliveryDelay?.delayType,
        link: event?.click?.link,
      }),
      new Date(occurredAt).toISOString(),
    ]
  )
  if (!rowCount) return false

  const column = TRACKED_COLUMNS[type]
  if (column && messages[0]) {
    await db.query(
      `UPDATE email_messages SET ${column} = COALESCE(${column}, $2), updated_at = NOW() WHERE id = $1`,
      [messages[0].id, new Date(occurredAt).toISOString()]
    )
  }
  if (type === "Bounce" && event?.bounce?.bounceType === "Permanent") {
    for (const address of addresses) await suppress(db, address, "BOUNCE", event.bounce.bounceSubType)
  }
  if (type === "Complaint") {
    for (const address of addresses) {
      await suppress(db, address, "COMPLAINT", event.complaint?.complaintFeedbackType)
      await revokeMarketingConsent(db, address)
    }
  }
  if (["Reject", "Rendering Failure"].includes(type)) {
    console.error("email_rejected_by_ses", { type, providerId })
  }
  return true
}

/**
 * Express handler. Receives the raw body as text, because SNS posts JSON as text/plain.
 * Answers 200 only once the message is safely handled, so SNS retries anything else.
 *
 * @type {import("express").RequestHandler}
 */
export async function sesWebhookHandler(req, res) {
  const config = emailConfig()
  let message
  try {
    message = JSON.parse(typeof req.body === "string" ? req.body : "")
  } catch {
    return res.status(400).json({ error: "Invalid payload" })
  }
  try {
    if (!config.eventsTopicArn || message.TopicArn !== config.eventsTopicArn) {
      console.warn("ses_webhook_rejected", { reason: "unknown_topic" })
      return res.status(403).json({ error: "Forbidden" })
    }
    if (!(await verifySnsSignature(message))) {
      console.warn("ses_webhook_rejected", { reason: "bad_signature" })
      return res.status(403).json({ error: "Forbidden" })
    }
    if (message.Type === "SubscriptionConfirmation") {
      if (!isSnsUrl(message.SubscribeURL)) return res.status(403).json({ error: "Forbidden" })
      const response = await fetcher(message.SubscribeURL, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`subscription confirmation failed: ${response.status}`)
      console.log("ses_webhook_subscribed")
      return res.json({ ok: true })
    }
    if (message.Type === "Notification") {
      await processSesEvent(message.MessageId, JSON.parse(message.Message))
    }
    return res.json({ ok: true })
  } catch (error) {
    console.error("ses_webhook_failed", { error: error?.message })
    return res.status(500).json({ error: "Could not process event" })
  }
}

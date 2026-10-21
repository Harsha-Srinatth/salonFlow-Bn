/**
 * Meta webhook for the WhatsApp Business Account: `GET` is the subscription handshake,
 * `POST` carries message statuses and inbound customer messages.
 *
 * Mounted with `express.raw` before the JSON parser, because the signature
 * (`X-Hub-Signature-256: sha256=<HMAC of the exact bytes with the app secret>`) is over the
 * raw body. Responses: 200 once everything in the delivery is applied (or deliberately
 * ignored); 401 for a bad signature; 400 for a body that is not JSON; 500 when our own
 * database fails, so Meta redelivers — every event is idempotent, so redelivery is safe.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import { pool } from "../lib/db-pool.js"
import { whatsappConfig } from "./config.js"
import { enqueueWhatsAppMessage, registerMessageKind } from "./outbox.js"
import { ensureWhatsAppSchema } from "./schema-init.js"
import { fromWaId, maskPhone } from "./phone.js"

const OPT_OUT_WORDS = new Set(["STOP", "STOP PROMOTIONS", "STOP OFFERS", "UNSUBSCRIBE", "OPT OUT", "OPTOUT", "STOP ALL"])
const OPT_IN_WORDS = new Set(["START", "SUBSCRIBE", "START OFFERS", "RESUME PROMOTIONS"])

const STATUS_COLUMNS = { sent: "sent_at", delivered: "delivered_at", read: "read_at", failed: "failed_at" }
// Which current states each incoming status may move a message out of. Statuses can arrive
// out of order (read before delivered, a late sent after read); a message never moves back.
const ALLOWED_FROM = {
  sent: ["SENDING"],
  delivered: ["SENDING", "SENT"],
  read: ["SENDING", "SENT", "DELIVERED"],
  failed: ["SENDING", "SENT"],
}

export function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) return false
  const expected = createHmac("sha256", appSecret).update(rawBody).digest()
  let provided
  try {
    provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex")
  } catch {
    return false
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

/** GET handshake: echo `hub.challenge` only for our own verify token. */
export function handleWebhookVerification(req, res) {
  const config = whatsappConfig()
  const mode = req.query["hub.mode"]
  const token = `${req.query["hub.verify_token"] ?? ""}`
  const challenge = `${req.query["hub.challenge"] ?? ""}`
  const expected = config.webhookVerifyToken
  const matches =
    expected && token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  if (mode === "subscribe" && matches && /^[\w-]{1,256}$/.test(challenge)) {
    res.status(200).type("text/plain").send(challenge)
    return
  }
  res.sendStatus(403)
}

/** Records an event key; false when it was already processed (Meta redelivery). */
async function firstTime(db, eventKey) {
  const { rowCount } = await db.query(
    `INSERT INTO whatsapp_webhook_events (event_key) VALUES ($1) ON CONFLICT (event_key) DO NOTHING`,
    [eventKey.slice(0, 255)]
  )
  return rowCount === 1
}

function eventTime(timestamp) {
  const seconds = Number(timestamp)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date()
}

async function applyStatus(db, status) {
  const id = typeof status?.id === "string" ? status.id : null
  const state = typeof status?.status === "string" ? status.status.toLowerCase() : null
  if (!id || !ALLOWED_FROM[state]) return
  if (!(await firstTime(db, `status:${id}:${state}:${status.timestamp ?? ""}`))) return
  const at = eventTime(status.timestamp)
  const error = Array.isArray(status.errors) ? status.errors[0] : null
  const column = STATUS_COLUMNS[state]
  const { rowCount } = await db.query(
    `UPDATE whatsapp_messages
        SET status = $2::varchar,
            ${column} = COALESCE(${column}, $3::timestamptz),
            ${state === "read" ? "delivered_at = COALESCE(delivered_at, $3::timestamptz)," : ""}
            last_error_code = CASE WHEN $2::varchar = 'FAILED' THEN $4::varchar ELSE last_error_code END,
            last_error = CASE WHEN $2::varchar = 'FAILED' THEN $5::varchar ELSE last_error END,
            updated_at = NOW()
      WHERE wa_message_id = $1 AND status = ANY($6::text[])`,
    [
      id,
      state.toUpperCase(),
      at,
      error ? `${error.code ?? ""}`.slice(0, 32) : null,
      error ? `${error.title ?? error.message ?? "failed"}`.slice(0, 400) : null,
      ALLOWED_FROM[state],
    ]
  )
  if (!rowCount) {
    // Not an outbox message (an OTP, or a status older than our state): record OTP failures.
    if (state === "failed") {
      await db.query(
        `UPDATE whatsapp_otp_challenges SET delivery_error = $2 WHERE wa_message_id = $1`,
        [id, error ? `${error.code ?? ""}:${error.title ?? ""}`.slice(0, 160) : "failed"]
      )
    }
  }
  if (state === "failed" && Number(error?.code) === 131050) {
    const phone = fromWaId(status.recipient_id)
    if (phone) await setOptOut(db, phone, "META_131050")
  }
}

async function setOptOut(db, phone, source) {
  await db.query(
    `INSERT INTO whatsapp_contacts (phone, marketing_opt_in, marketing_opt_out_at, consent_source, last_inbound_at)
     VALUES ($1, FALSE, NOW(), $2, NOW())
     ON CONFLICT (phone) DO UPDATE SET marketing_opt_in = FALSE, marketing_opt_out_at = NOW(), consent_source = $2, updated_at = NOW()`,
    [phone, source]
  )
  await db.query(
    `UPDATE whatsapp_messages SET status = 'CANCELLED', last_error = 'customer opted out', updated_at = NOW()
      WHERE phone = $1 AND category = 'MARKETING' AND status = 'PENDING'`,
    [phone]
  )
}

function inboundText(message) {
  if (message?.type === "text") return `${message.text?.body ?? ""}`
  if (message?.type === "button") return `${message.button?.text ?? message.button?.payload ?? ""}`
  if (message?.type === "interactive") {
    return `${message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? ""}`
  }
  return ""
}

async function applyInboundMessage(db, message) {
  const id = typeof message?.id === "string" ? message.id : null
  const phone = fromWaId(message?.from)
  if (!id || !phone) return
  if (!(await firstTime(db, `message:${id}`))) return
  const keyword = inboundText(message).trim().toUpperCase().replace(/[.!]+$/, "").replace(/\s+/g, " ")
  await db.query(
    `INSERT INTO whatsapp_contacts (phone, last_inbound_at) VALUES ($1, NOW())
     ON CONFLICT (phone) DO UPDATE SET last_inbound_at = NOW(), updated_at = NOW()`,
    [phone]
  )
  if (OPT_OUT_WORDS.has(keyword)) {
    await setOptOut(db, phone, "WHATSAPP_STOP")
    await enqueueWhatsAppMessage(db, {
      kind: "SERVICE_REPLY",
      category: "SERVICE",
      dedupeKey: `reply:${id}`,
      phone,
      context: { text: "You will no longer receive offers from us on WhatsApp. Booking updates will still arrive. Reply START to get offers again." },
      expiresAt: new Date(Date.now() + 23 * 3600_000),
    })
    console.log("whatsapp_marketing_opt_out", { phone: maskPhone(phone) })
  } else if (OPT_IN_WORDS.has(keyword)) {
    await db.query(
      `UPDATE whatsapp_contacts SET marketing_opt_in = TRUE, marketing_opt_in_at = NOW(), marketing_opt_out_at = NULL,
              consent_source = 'WHATSAPP_START', updated_at = NOW()
        WHERE phone = $1`,
      [phone]
    )
    await enqueueWhatsAppMessage(db, {
      kind: "SERVICE_REPLY",
      category: "SERVICE",
      dedupeKey: `reply:${id}`,
      phone,
      context: { text: "You're subscribed to offers on WhatsApp. Reply STOP at any time to unsubscribe." },
      expiresAt: new Date(Date.now() + 23 * 3600_000),
    })
  }
}

/**
 * Applies one webhook delivery. Exported for tests.
 * @returns {Promise<{ statuses: number, messages: number, ignored: number }>}
 */
export async function processWebhookPayload(payload, { db = pool, config = whatsappConfig() } = {}) {
  const counts = { statuses: 0, messages: 0, ignored: 0 }
  if (payload?.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) {
    counts.ignored += 1
    return counts
  }
  for (const entry of payload.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value ?? {}
      if (change?.field === "account_update") {
        // Coexistence: the WhatsApp Business app on the salon phone was disconnected
        // (e.g. PRIMARY_INACTIVITY after ~14 days without opening it).
        console.warn("whatsapp_account_update", { event: value?.event ?? null, reason: value?.disconnection_info?.reason ?? null })
        continue
      }
      if (change?.field !== "messages") {
        // history / smb_app_state_sync / smb_message_echoes (coexistence) and anything else:
        // acknowledged, not stored — the salon's own chats stay in the app.
        counts.ignored += 1
        continue
      }
      const phoneNumberId = value?.metadata?.phone_number_id
      if (config.phoneNumberId && phoneNumberId && `${phoneNumberId}` !== config.phoneNumberId) {
        counts.ignored += 1
        continue
      }
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        await applyStatus(db, status)
        counts.statuses += 1
      }
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        await applyInboundMessage(db, message)
        counts.messages += 1
      }
    }
  }
  return counts
}

/** POST handler (body is a Buffer from `express.raw`). */
export async function handleWebhookEvent(req, res) {
  const config = whatsappConfig()
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("")
  if (!config.appSecret) {
    // Without the app secret nothing can be authenticated; refusing is safer than trusting.
    console.error("whatsapp_webhook_rejected", { reason: "WHATSAPP_APP_SECRET not set" })
    return res.sendStatus(503)
  }
  if (!verifyWebhookSignature(raw, req.headers["x-hub-signature-256"], config.appSecret)) {
    return res.sendStatus(401)
  }
  let payload
  try {
    payload = JSON.parse(raw.toString("utf8"))
  } catch {
    return res.sendStatus(400)
  }
  let client
  try {
    await ensureWhatsAppSchema()
    // One transaction per delivery: if anything fails, the dedupe keys roll back with the
    // changes, so Meta's redelivery is applied in full rather than skipped as "seen".
    client = await pool.connect()
    await client.query("BEGIN")
    await processWebhookPayload(payload, { config, db: client })
    await client.query("COMMIT")
    return res.sendStatus(200)
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => {})
    console.error("whatsapp_webhook_failed", { requestId: req.requestId, error: error?.message })
    return res.sendStatus(500)
  } finally {
    client?.release()
  }
}

registerMessageKind("SERVICE_REPLY", {
  async prepare(row) {
    const text = `${row.context?.text ?? ""}`.trim()
    return text ? { send: { text } } : { skip: "empty reply" }
  },
})

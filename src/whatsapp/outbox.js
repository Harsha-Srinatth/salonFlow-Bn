/**
 * Durable WhatsApp outbox and the worker that drains it.
 *
 * Every notification is first a row in `whatsapp_messages`, written on the caller's own
 * database client — for bookings that is the booking transaction itself, so the message
 * exists if and only if the booking change committed. The worker then claims due rows
 * with `FOR UPDATE SKIP LOCKED` and a lease, so any number of workers (instances,
 * restarts) can run at once without two of them sending the same row.
 *
 * Content is built at send time, not at enqueue time: each kind has a `prepare` handler
 * that reloads the source of truth (the booking, the offer, the consent record) and either
 * returns the template to send or a reason to skip. That is what stops a reminder for a
 * cancelled or moved appointment, and an offer whose discount has since changed.
 */
import { randomUUID } from "node:crypto"
import { pool } from "../lib/db-pool.js"
import { whatsappConfig, isWhatsAppSendingAvailable } from "./config.js"
import { sendTemplateMessage, sendTextMessage } from "./client.js"
import { maskPhone } from "./phone.js"
import { budgetForKind, remainingThisMonth } from "./budget.js"

/** @type {Map<string, { category: string, prepare: (row: object, ctx: object) => Promise<object> }>} */
const kinds = new Map()

/**
 * Registers how a message kind is prepared. `prepare` returns one of:
 *  - `{ send: { template: { name, language }, components } }` or `{ send: { text } }`
 *  - `{ skip: "REASON" }`   (row becomes SKIPPED: no longer applicable)
 */
export function registerMessageKind(kind, handler) {
  kinds.set(kind, handler)
}

/**
 * Adds a message to the outbox. Idempotent on `dedupeKey`: a retried request, a replayed
 * payment webhook or a double-click produce the same key and therefore no second row.
 *
 * @param {import("pg").PoolClient | import("pg").Pool} db
 * @returns {Promise<string | null>} new row id, or null when the key already existed
 */
export async function enqueueWhatsAppMessage(db, message) {
  const config = whatsappConfig()
  const {
    kind,
    category,
    dedupeKey,
    userId = null,
    phone,
    bookingId = null,
    campaignId = null,
    context = {},
    scheduledFor = null,
    expiresAt = null,
    maxAttempts = config.worker.maxAttempts,
  } = message
  const { rows } = await db.query(
    `INSERT INTO whatsapp_messages
       (id, kind, category, dedupe_key, user_id, phone, booking_id, campaign_id, context,
        scheduled_for, next_attempt_at, expires_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
             COALESCE($10::timestamptz, NOW()), COALESCE($10::timestamptz, NOW()), $11, $12)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      kind,
      category,
      dedupeKey,
      userId,
      phone,
      bookingId,
      campaignId,
      JSON.stringify(context),
      scheduledFor ? new Date(scheduledFor).toISOString() : null,
      expiresAt ? new Date(expiresAt).toISOString() : null,
      maxAttempts,
    ]
  )
  return rows[0]?.id ?? null
}

/** Cancels not-yet-sent messages of the given kinds for a booking. @returns {Promise<number>} */
export async function cancelPendingBookingMessages(db, bookingId, kindList, reason) {
  const { rowCount } = await db.query(
    `UPDATE whatsapp_messages
        SET status = 'CANCELLED', last_error = $3, updated_at = NOW()
      WHERE booking_id = $1 AND status = 'PENDING' AND kind = ANY($2::text[])`,
    [bookingId, kindList, `${reason ?? "cancelled"}`.slice(0, 400)]
  )
  return rowCount
}

/** Exponential backoff with ±20 % jitter: 30 s, 60 s, 2 min, 4 min … capped at 1 h. */
export function retryDelayMs(attempt, retryAfterMs = null) {
  const base = Math.min(3600_000, 30_000 * 2 ** Math.max(0, attempt - 1))
  const jittered = base * (0.8 + Math.random() * 0.4)
  return Math.round(Math.max(jittered, Math.min(retryAfterMs ?? 0, 3600_000)))
}

async function claimDueMessages(db, { batchSize, leaseSeconds }) {
  const { rows } = await db.query(
    `WITH due AS (
       SELECT id FROM whatsapp_messages
        WHERE (status = 'PENDING' AND next_attempt_at <= NOW())
           OR (status = 'SENDING' AND locked_until < NOW())
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE whatsapp_messages m
        SET status = 'SENDING', attempts = m.attempts + 1,
            locked_until = NOW() + make_interval(secs => $2), updated_at = NOW()
       FROM due
      WHERE m.id = due.id
     RETURNING m.*`,
    [batchSize, leaseSeconds]
  )
  return rows
}

async function finish(db, id, fields) {
  const sets = ["locked_until = NULL", "updated_at = NOW()"]
  const values = [id]
  for (const [column, value] of Object.entries(fields)) {
    values.push(value)
    sets.push(`${column} = $${values.length}`)
  }
  // Only the worker holding the claim may finish it.
  await db.query(`UPDATE whatsapp_messages SET ${sets.join(", ")} WHERE id = $1 AND status = 'SENDING'`, values)
}

async function processMessage(db, row, ctx, config) {
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    await finish(db, row.id, { status: "EXPIRED", last_error: "expired before it could be sent" })
    return "EXPIRED"
  }
  if (row.attempts > row.max_attempts) {
    // Lease ran out repeatedly (crashes mid-send): stop rather than loop forever.
    await finish(db, row.id, { status: "FAILED", failed_at: new Date(), last_error: "attempt limit reached" })
    return "FAILED"
  }
  const handler = kinds.get(row.kind)
  if (!handler) {
    await finish(db, row.id, { status: "FAILED", failed_at: new Date(), last_error: `no handler for kind ${row.kind}` })
    return "FAILED"
  }
  let prepared
  try {
    prepared = await handler.prepare(row, ctx)
  } catch (error) {
    // Our own failure (database blip): retry like a transient send error.
    const delay = retryDelayMs(row.attempts)
    const giveUp = row.attempts >= row.max_attempts
    await finish(db, row.id, {
      status: giveUp ? "FAILED" : "PENDING",
      next_attempt_at: new Date(Date.now() + delay),
      ...(giveUp ? { failed_at: new Date() } : {}),
      last_error_code: "PREPARE",
      last_error: `${error?.message ?? "prepare failed"}`.slice(0, 400),
    })
    console.error("whatsapp_prepare_failed", { id: row.id, kind: row.kind, error: error?.message })
    return giveUp ? "FAILED" : "RETRY"
  }
  if (prepared?.skip) {
    await finish(db, row.id, { status: "SKIPPED", last_error: `${prepared.skip}`.slice(0, 400) })
    return "SKIPPED"
  }
  const budget = budgetForKind(row.kind)
  if (budget) {
    const key = `budget:${budget}`
    if (!ctx.cache.has(key)) ctx.cache.set(key, await remainingThisMonth(budget, config, db))
    if (ctx.cache.get(key) <= 0) {
      await finish(db, row.id, { status: "SKIPPED", last_error_code: "MONTHLY_LIMIT", last_error: `monthly ${budget} limit reached` })
      return "SKIPPED"
    }
    // Counted before the send: a failed send then under-uses the cap rather than over-spends it.
    ctx.cache.set(key, ctx.cache.get(key) - 1)
  }
  try {
    const result = prepared.send.text
      ? await sendTextMessage({ to: row.phone, body: prepared.send.text }, config)
      : await sendTemplateMessage(
          {
            to: row.phone,
            name: prepared.send.template.name,
            language: prepared.send.template.language,
            components: prepared.send.components,
          },
          config
        )
    await finish(db, row.id, {
      status: "SENT",
      wa_message_id: result.messageId,
      sent_at: new Date(),
      template_name: prepared.send.template?.name ?? null,
      template_language: prepared.send.template?.language ?? null,
      last_error_code: null,
      last_error: null,
    })
    return "SENT"
  } catch (error) {
    const giveUp = !error?.retryable || row.attempts >= row.max_attempts
    await finish(db, row.id, {
      status: giveUp ? "FAILED" : "PENDING",
      next_attempt_at: new Date(Date.now() + retryDelayMs(row.attempts, error?.retryAfterMs)),
      ...(giveUp ? { failed_at: new Date() } : {}),
      template_name: prepared.send.template?.name ?? null,
      last_error_code: `${error?.code ?? error?.kind ?? "ERROR"}`.slice(0, 32),
      last_error: `${error?.message ?? "send failed"}`.slice(0, 400),
    })
    if (Number(error?.code) === 131050) {
      // Meta says the customer stopped marketing messages: honour it everywhere.
      await db
        .query(
          `INSERT INTO whatsapp_contacts (phone, marketing_opt_in, marketing_opt_out_at, consent_source)
           VALUES ($1, FALSE, NOW(), 'META_131050')
           ON CONFLICT (phone) DO UPDATE SET marketing_opt_in = FALSE, marketing_opt_out_at = NOW(), updated_at = NOW()`,
          [row.phone]
        )
        .catch(() => {})
    }
    console.error("whatsapp_send_failed", {
      id: row.id,
      kind: row.kind,
      to: maskPhone(row.phone),
      errorKind: error?.kind ?? null,
      code: error?.code ?? null,
      attempt: row.attempts,
      willRetry: !giveUp,
    })
    return giveUp ? "FAILED" : "RETRY"
  }
}

/**
 * One pass of the worker: claims a bounded batch and processes it sequentially (Cloud API
 * throughput is per number, and a small salon never needs parallel sends).
 *
 * @returns {Promise<Record<string, number>>} outcome counts, for logs and tests
 */
export async function runWhatsAppOutboxOnce({ db = pool, config = whatsappConfig() } = {}) {
  const counts = {}
  if (!isWhatsAppSendingAvailable(config)) return counts
  const rows = await claimDueMessages(db, config.worker)
  const ctx = { cache: new Map() }
  for (const row of rows) {
    const outcome = await processMessage(db, row, ctx, config)
    counts[outcome] = (counts[outcome] ?? 0) + 1
  }
  return counts
}

/**
 * Starts the periodic worker. Returns `stop()`, which clears the timer and resolves once
 * an in-flight pass has finished (used on SIGTERM so a send is not cut off halfway).
 */
export function startWhatsAppWorker({ intervalMs = whatsappConfig().worker.intervalMs } = {}) {
  let running = null
  let stopped = false
  const tick = () => {
    if (stopped || running) return
    running = runWhatsAppOutboxOnce()
      .then(counts => {
        if (Object.keys(counts).length) console.log("whatsapp_outbox_pass", counts)
      })
      .catch(error => console.error("whatsapp_outbox_pass_failed", { error: error?.message }))
      .finally(() => {
        running = null
      })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  tick()
  return async function stop() {
    stopped = true
    clearInterval(timer)
    if (running) await running
  }
}

/** Retention for the outbox and webhook dedupe table. */
export async function pruneWhatsAppTables({ messageDays = 180, eventDays = 14, db = pool } = {}) {
  await db.query(
    `DELETE FROM whatsapp_messages WHERE created_at < NOW() - make_interval(days => $1) AND status NOT IN ('PENDING', 'SENDING')`,
    [messageDays]
  )
  await db.query(`DELETE FROM whatsapp_webhook_events WHERE received_at < NOW() - make_interval(days => $1)`, [eventDays])
}

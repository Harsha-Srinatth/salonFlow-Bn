/**
 * The email outbox and its worker. Nothing else in the app calls SES.
 *
 * Callers add a row with `enqueueEmail`, on their own transaction when the email belongs to a
 * database change, so it exists only if that change committed and it survives a restart. The
 * worker claims due rows with `FOR UPDATE SKIP LOCKED` and a lease, so two workers never send
 * the same row, and a crashed worker's rows come back when the lease ends. `dedupe_key` makes
 * enqueueing idempotent. Right before sending, each row is checked again against the current
 * world: suppression list, consent, booking status.
 *
 * Runs in the API process alongside the other sweeps; production has one instance and no Redis,
 * so Postgres is the queue.
 */
import { randomUUID } from "node:crypto"
import { pool } from "../lib/db-pool.js"
import { getBookingById } from "../bookings/repository.js"
import { getBusinessProfile } from "../business/service.js"
import { describeEmailConfig, emailConfig, isEmailAvailable, validateEmailConfig } from "./config.js"
import { ensureEmailSchema } from "./schema.js"
import { sendSesEmail } from "./ses-provider.js"
import { DEFAULT_BUSINESS, renderEmail } from "./templates.js"
import { TOKEN_RESET_PASSWORD, TOKEN_VERIFY_EMAIL, issueEmailToken, signUnsubscribeToken } from "./tokens.js"

export const CATEGORY_TRANSACTIONAL = "TRANSACTIONAL"
export const CATEGORY_MARKETING = "MARKETING"

/** Addresses that can never receive mail: QA accounts and documentation domains. */
const UNDELIVERABLE_DOMAIN_RE = /(\.test|\.example|\.invalid|\.local|\.localhost)$|^example\.(com|net|org)$/i

export function normalizeEmailAddress(value) {
  return `${value ?? ""}`.trim().toLowerCase()
}

export function maskEmail(value) {
  const [local, domain] = normalizeEmailAddress(value).split("@")
  return domain ? `${local.slice(0, 2)}…@${domain}` : "…"
}

/**
 * Adds a message to the outbox. A repeated `dedupeKey` is a no-op, except that a row cancelled
 * earlier comes back: a booking moved away and then back to the same time needs its reminder.
 *
 * @param {import("pg").Pool | import("pg").PoolClient} db pool, or the caller's transaction
 * @returns {Promise<boolean>} whether a row was written
 */
export async function enqueueEmail(
  db,
  { template, recipient, dedupeKey, userId = null, bookingId = null, campaignId = null, bookingStartsAt = null, payload = {}, category = CATEGORY_TRANSACTIONAL, scheduledFor = new Date(), maxAttempts = emailConfig().worker.maxAttempts }
) {
  const to = normalizeEmailAddress(recipient)
  if (!to.includes("@")) return false
  const { rowCount } = await db.query(
    `INSERT INTO email_messages (id, dedupe_key, template, category, recipient, user_id, booking_id, campaign_id, booking_starts_at, payload, scheduled_for, next_attempt_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET status = 'PENDING', attempts = 0, next_attempt_at = EXCLUDED.next_attempt_at, last_error = NULL, updated_at = NOW()
       WHERE email_messages.status = 'CANCELLED'`,
    [randomUUID(), dedupeKey, template, category, to, userId, bookingId, campaignId, bookingStartsAt, JSON.stringify(payload), new Date(scheduledFor).toISOString(), maxAttempts]
  )
  return rowCount > 0
}

/** 1 min, 2 min, 4 min … capped at 2 h, ±20 % jitter so retries do not arrive together. */
export function emailRetryDelayMs(attempt) {
  return Math.round(Math.min(7_200_000, 60_000 * 2 ** Math.max(0, attempt - 1)) * (0.8 + Math.random() * 0.4))
}

async function finish(db, id, fields) {
  const sets = ["locked_until = NULL", "updated_at = NOW()"]
  const values = [id]
  for (const [column, value] of Object.entries(fields)) {
    values.push(value)
    sets.push(`${column} = $${values.length}`)
  }
  // Only the worker holding the claim may finish it.
  await db.query(`UPDATE email_messages SET ${sets.join(", ")} WHERE id = $1 AND status = 'SENDING'`, values)
}

async function loadBusiness() {
  try {
    const { profile } = await getBusinessProfile()
    return profile ?? DEFAULT_BUSINESS
  } catch {
    return DEFAULT_BUSINESS
  }
}

async function isSuppressed(db, address) {
  const { rows } = await db.query(`SELECT 1 FROM email_suppressions WHERE email = $1`, [address])
  return rows.length > 0
}

async function loadRecipientUser(db, userId) {
  if (!userId) return null
  const { rows } = await db.query(
    `SELECT id, name, email, pending_email_signup_at, email_booking_updates, marketing_email_consent, marketing_email_unsubscribed_at
       FROM users WHERE id = $1`,
    [userId]
  )
  return rows[0] ?? null
}

function expiryLabel(minutes) {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60
    return `${hours} hour${hours === 1 ? "" : "s"}`
  }
  return `${minutes} minutes`
}

function bookingSnapshot(booking) {
  return {
    customerName: booking.customer,
    service: booking.service,
    stylistName: booking.stylistName ?? "",
    startsAt: booking.startsAt,
    durationMinutes: booking.durationMinutes,
    payableAmount: Number(booking.payableAmount ?? 0),
    invoiceNumber: booking.invoiceNumber ?? "",
  }
}

/** Rows that depend on the current state of a booking. `reason` set means do not send. */
async function bookingCheck(row) {
  const booking = await getBookingById(row.booking_id, pool)
  if (!booking) return { reason: "booking not found" }
  if (row.template === "booking_reminder") {
    if (booking.status !== "CONFIRMED") return { reason: `booking is ${booking.status}` }
    const startsAt = new Date(booking.startsAt).getTime()
    if (startsAt !== new Date(row.booking_starts_at).getTime()) return { reason: "appointment time changed" }
    if (startsAt <= Date.now()) return { reason: "appointment already started" }
    return { booking }
  }
  if (row.template === "booking_confirmation" && booking.status === "CANCELLED") return { reason: "booking is CANCELLED" }
  return { booking }
}

/**
 * Decides whether a claimed row goes out, and builds what it needs. Verification and reset
 * tokens are created here, at the last moment, so they never sit in the outbox.
 *
 * @returns {Promise<{ reason?: string, data?: object, headers?: Array<object> }>}
 */
async function prepareMessage(db, row, config) {
  const domain = row.recipient.split("@")[1] ?? ""
  if (UNDELIVERABLE_DOMAIN_RE.test(domain)) return { reason: "undeliverable test address" }
  if (config.recipientAllowlist.length && !config.recipientAllowlist.includes(row.recipient)) {
    return { reason: "not on EMAIL_RECIPIENT_ALLOWLIST" }
  }
  if (await isSuppressed(db, row.recipient)) return { reason: "address is suppressed" }

  const user = await loadRecipientUser(db, row.user_id)
  switch (row.template) {
    case "verify_email": {
      if (!user?.pending_email_signup_at) return { reason: "account no longer pending" }
      const token = await issueEmailToken(db, { userId: user.id, purpose: TOKEN_VERIFY_EMAIL, ttlMinutes: config.verificationTokenMinutes })
      return {
        data: {
          name: user.name,
          verifyUrl: `${config.publicUrl}/auth/verify-email?token=${encodeURIComponent(token)}`,
          expiresInLabel: expiryLabel(config.verificationTokenMinutes),
        },
      }
    }
    case "password_reset": {
      if (!user) return { reason: "account not found" }
      const token = await issueEmailToken(db, { userId: user.id, purpose: TOKEN_RESET_PASSWORD, ttlMinutes: config.passwordResetTokenMinutes })
      return {
        data: {
          name: user.name,
          resetUrl: `${config.publicUrl}/auth/reset-password?token=${encodeURIComponent(token)}`,
          expiresInLabel: expiryLabel(config.passwordResetTokenMinutes),
        },
      }
    }
    case "booking_confirmation":
    case "booking_reminder":
    case "booking_cancelled":
    case "booking_rescheduled": {
      if (user && user.email_booking_updates === false) return { reason: "customer turned off booking emails" }
      if (row.template === "booking_reminder" && !config.remindersEnabled) return { reason: "reminders are off" }
      const { reason, booking } = await bookingCheck(row)
      if (reason) return { reason }
      // Reminders read the booking as it is now; the rest describe the moment they were queued.
      return { data: row.template === "booking_reminder" ? bookingSnapshot(booking) : row.payload }
    }
    case "promotional": {
      if (!config.marketingEnabled) return { reason: "marketing is off" }
      if (!user || user.marketing_email_consent !== true || user.marketing_email_unsubscribed_at) return { reason: "no marketing consent" }
      const token = signUnsubscribeToken(user.id, config.linkSecret)
      const unsubscribeUrl = `${config.publicUrl}/email/unsubscribe?token=${encodeURIComponent(token)}`
      const oneClickUrl = `${config.apiPublicUrl}/api/email/unsubscribe?token=${encodeURIComponent(token)}`
      return {
        data: { ...row.payload, name: user.name, unsubscribeUrl },
        headers: [
          { name: "List-Unsubscribe", value: `<${oneClickUrl}>` },
          { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
        ],
      }
    }
    default:
      return { data: { ...row.payload, name: row.payload?.name ?? user?.name } }
  }
}

async function claimDue(db, config) {
  const { rows: marketing } = await db.query(
    `SELECT COUNT(*)::int AS n FROM email_messages WHERE category = 'MARKETING' AND sent_at >= NOW() - interval '24 hours'`
  )
  // Past the daily ceiling, marketing rows simply wait. Transactional mail always goes first.
  const allowMarketing = marketing[0].n < config.marketingDailyLimit
  const { rows } = await db.query(
    `WITH due AS (
       SELECT id FROM email_messages
        WHERE ((status = 'PENDING' AND next_attempt_at <= NOW()) OR (status = 'SENDING' AND locked_until < NOW()))
          AND ($3 OR category <> 'MARKETING')
        ORDER BY (category = 'MARKETING'), next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE email_messages m
        SET status = 'SENDING', attempts = m.attempts + 1, locked_until = NOW() + make_interval(secs => $2), updated_at = NOW()
       FROM due WHERE m.id = due.id
     RETURNING m.*`,
    [config.worker.batchSize, config.worker.leaseSeconds, allowMarketing]
  )
  return rows
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

/** One pass: claims a bounded batch and sends it. @returns {Promise<Record<string, number>>} outcome counts */
export async function runEmailWorkerOnce({ db = pool, config = emailConfig(), send = sendSesEmail } = {}) {
  const counts = {}
  if (!isEmailAvailable(config)) return counts
  const bump = outcome => {
    counts[outcome] = (counts[outcome] ?? 0) + 1
  }
  const rows = await claimDue(db, config)
  if (!rows.length) return counts
  const business = await loadBusiness()
  let sentInPass = 0
  for (const row of rows) {
    if (row.attempts > row.max_attempts) {
      await finish(db, row.id, { status: "FAILED", last_error: "attempt limit reached" })
      bump("FAILED")
      continue
    }
    try {
      const { reason, data, headers } = await prepareMessage(db, row, config)
      if (reason) {
        await finish(db, row.id, { status: "SKIPPED", last_error: reason })
        bump("SKIPPED")
        continue
      }
      const { subject, html, text } = renderEmail(row.template, data, { appUrl: config.publicUrl, business })
      if (sentInPass > 0 && config.worker.sendIntervalMs) await pause(config.worker.sendIntervalMs)
      sentInPass += 1
      const { messageId } = await send({ to: row.recipient, subject, html, text, category: row.category, template: row.template, headers }, config)
      await finish(db, row.id, { status: "SENT", provider_message_id: messageId, sent_at: new Date(), last_error: null })
      console.log("email_sent", { id: row.id, template: row.template, to: maskEmail(row.recipient), attempt: row.attempts })
      bump("SENT")
    } catch (error) {
      const giveUp = error?.retryable === false || row.attempts >= row.max_attempts
      await finish(db, row.id, {
        status: giveUp ? "FAILED" : "PENDING",
        next_attempt_at: new Date(Date.now() + emailRetryDelayMs(row.attempts)),
        last_error: `${error?.message ?? "send failed"}`.slice(0, 400),
      })
      console.error("email_send_failed", {
        id: row.id,
        template: row.template,
        to: maskEmail(row.recipient),
        errorKind: error?.kind ?? null,
        attempt: row.attempts,
        willRetry: !giveUp,
      })
      bump(giveUp ? "FAILED" : "RETRY")
    }
  }
  return counts
}

let kick = () => {}

/** Sends what is due now instead of at the next tick. Safe to call anywhere; never throws. */
export function kickEmailWorker() {
  kick()
}

/**
 * Removes expired tokens, and signups nobody confirmed so their email and phone are free again.
 * Only rows carrying the signup marker can match: a walk-in account shares the
 * PENDING_VERIFICATION status but is a real customer and must never be deleted here.
 */
export async function runEmailMaintenance({ db = pool, config = emailConfig() } = {}) {
  await db.query(`DELETE FROM email_tokens WHERE expires_at < NOW() - interval '7 days'`)
  const { rows } = await db.query(
    `SELECT u.id FROM users u
      WHERE u.pending_email_signup_at < NOW() - make_interval(hours => $1)
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.created_by = u.id)`,
    [config.pendingSignupRetentionHours]
  )
  let removed = 0
  for (const { id } of rows) {
    // A foreign key from another feature means the row is in use; keep it.
    const result = await db.query(`DELETE FROM users WHERE id = $1 AND pending_email_signup_at IS NOT NULL`, [id]).catch(() => null)
    removed += result?.rowCount ?? 0
  }
  if (removed) console.log("email_pending_signups_removed", { removed })
  return { removed }
}

/**
 * Boot-time wiring: reports the configuration and starts the worker. Returns `stop()`, which
 * resolves once an in-flight pass has finished (used on SIGTERM).
 */
export async function startEmailService() {
  const config = emailConfig()
  const problems = validateEmailConfig(config)
  console.log("email_config", { ...describeEmailConfig(config), problems })
  await ensureEmailSchema()
  if (!isEmailAvailable(config)) return async () => {}
  let running = null
  let stopped = false
  let again = false
  const tick = () => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = runEmailWorkerOnce()
      .then(counts => {
        if (Object.keys(counts).length) console.log("email_worker_pass", counts)
      })
      .catch(error => console.error("email_worker_pass_failed", { error: error?.message }))
      .finally(() => {
        running = null
        if (again) {
          again = false
          tick()
        }
      })
  }
  kick = tick
  const timer = setInterval(tick, config.worker.intervalMs)
  timer.unref?.()
  const maintenance = setInterval(() => {
    runEmailMaintenance().catch(error => console.error("email_maintenance_failed", { error: error?.message }))
  }, 3600_000)
  maintenance.unref?.()
  tick()
  return async () => {
    stopped = true
    kick = () => {}
    clearInterval(timer)
    clearInterval(maintenance)
    if (running) await running
  }
}

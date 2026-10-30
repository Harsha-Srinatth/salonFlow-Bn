/**
 * Appointment reminders by SMS: 24 h and 2 h before each confirmed booking (configurable).
 *
 * Reminders are rows in `sms_messages`, written in the same transaction as the booking
 * change that caused them, so they exist only if that change committed and they survive
 * restarts. Each `queue`/`cancel` call runs inside a SAVEPOINT: a problem here can never
 * abort the booking itself.
 *
 * The worker claims due rows with `FOR UPDATE SKIP LOCKED` and a lease, so several workers
 * never send the same row. Right before sending it reloads the booking, so a cancelled,
 * moved, started or past appointment gets nothing.
 *
 * Template variables: VAR1 first name, VAR2 services, VAR3 date, VAR4 time, VAR5 salon phone.
 */
import { randomUUID } from "node:crypto"
import { pool } from "../lib/db-pool.js"
import { SALON_TIMEZONE } from "../lib/salon-time.js"
import { createSchemaEnsurer } from "../lib/schema-guard.js"
import { getBookingById } from "../bookings/repository.js"
import { getBusinessProfile } from "../business/service.js"
import { describeSmsConfig, isSmsAvailable, smsConfig, validateSmsConfig } from "./config.js"
import { sendReminderSms } from "./client.js"
import { maskPhone, toIndianSmsRecipient } from "./phone.js"

export const ensureSmsSchema = createSchemaEnsurer({
  name: "sms",
  async migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sms_messages (
        id UUID PRIMARY KEY,
        dedupe_key VARCHAR(255) NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        booking_id UUID NOT NULL,
        phone VARCHAR(20) NOT NULL,
        booking_starts_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        scheduled_for TIMESTAMPTZ NOT NULL,
        next_attempt_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        locked_until TIMESTAMPTZ,
        provider_message_id VARCHAR(128),
        last_error VARCHAR(400),
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT sms_messages_dedupe_unique UNIQUE (dedupe_key),
        CONSTRAINT sms_messages_status_check CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED'))
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS sms_messages_due_idx ON sms_messages (next_attempt_at) WHERE status IN ('PENDING', 'SENDING')`)
    await client.query(`CREATE INDEX IF NOT EXISTS sms_messages_booking_idx ON sms_messages (booking_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS sms_messages_sent_idx ON sms_messages (sent_at) WHERE sent_at IS NOT NULL`)
  },
})

let schemaReady = false

/**
 * Makes sure the table exists before a booking transaction writes to it. Must run outside
 * that transaction (schema DDL would deadlock against it). Never throws: if it fails,
 * reminders are skipped, bookings are not.
 */
export async function prepareSmsReminders() {
  if (schemaReady) return true
  if (!smsConfig().enabled) return false
  try {
    await ensureSmsSchema()
    schemaReady = true
  } catch (error) {
    console.error("sms_schema_unavailable", { error: error?.message })
  }
  return schemaReady
}

async function withSavepoint(db, label, run) {
  try {
    await db.query(`SAVEPOINT sms_${label}`)
    await run()
    await db.query(`RELEASE SAVEPOINT sms_${label}`)
  } catch (error) {
    await db.query(`ROLLBACK TO SAVEPOINT sms_${label}`).catch(() => {})
    console.error("sms_enqueue_failed", { label, error: error?.message })
  }
}

async function insertReminders(db, booking, config) {
  const phone = toIndianSmsRecipient(booking.customerPhone)
  const startsAt = new Date(booking.startsAt)
  if (!phone || Number.isNaN(startsAt.getTime())) return
  const earliest = Date.now() + config.reminders.minLeadMinutes * 60_000
  for (const offsetMinutes of config.reminders.offsetsMinutes) {
    const sendAt = new Date(startsAt.getTime() - offsetMinutes * 60_000)
    // A booking made at 14:00 for 15:00 gets no "2 hours to go" message.
    if (sendAt.getTime() < earliest) continue
    // Conflict means this exact reminder exists. It only comes back to life when it was
    // cancelled, which happens when a booking is moved away and then back to the same time.
    await db.query(
      `INSERT INTO sms_messages (id, dedupe_key, user_id, booking_id, phone, booking_starts_at, scheduled_for, next_attempt_at, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
       ON CONFLICT (dedupe_key) DO UPDATE
         SET status = 'PENDING', attempts = 0, next_attempt_at = EXCLUDED.next_attempt_at, last_error = NULL, updated_at = NOW()
         WHERE sms_messages.status = 'CANCELLED'`,
      [
        randomUUID(),
        `booking:${booking.id}:reminder:${offsetMinutes}:${startsAt.getTime()}`,
        booking.createdBy ?? null,
        booking.id,
        phone,
        startsAt.toISOString(),
        sendAt.toISOString(),
        config.worker.maxAttempts,
      ]
    )
  }
}

async function cancelPending(db, bookingId, reason) {
  await db.query(
    `UPDATE sms_messages SET status = 'CANCELLED', last_error = $2, updated_at = NOW() WHERE booking_id = $1 AND status = 'PENDING'`,
    [bookingId, reason]
  )
}

/** New booking, inside its transaction. */
export async function queueBookingReminders(db, booking, config = smsConfig()) {
  if (!booking?.id || !schemaReady || !isSmsAvailable(config)) return
  await withSavepoint(db, "queue", () => insertReminders(db, booking, config))
}

/** Booking moved to a new time, inside its transaction: old reminders go, new ones replace them. */
export async function rescheduleBookingReminders(db, booking, config = smsConfig()) {
  if (!booking?.id || !schemaReady) return
  await withSavepoint(db, "reschedule", async () => {
    await cancelPending(db, booking.id, "booking rescheduled")
    if (isSmsAvailable(config)) await insertReminders(db, booking, config)
  })
}

/** Booking cancelled, inside its transaction. */
export async function cancelBookingReminders(db, bookingId) {
  if (!bookingId || !schemaReady) return
  await withSavepoint(db, "cancel", () => cancelPending(db, bookingId, "booking cancelled"))
}

// ---------------------------------------------------------------------------------------
// Worker

const dateFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: SALON_TIMEZONE, day: "numeric", month: "short" })
const timeFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: SALON_TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true })

/** DLT limits a variable to 30 characters. */
function variable(value) {
  const clean = `${value ?? ""}`.replace(/\s+/g, " ").trim()
  return clean.length > 30 ? `${clean.slice(0, 29)}…` : clean || "-"
}

export function reminderVariables(booking, salonPhone) {
  const startsAt = new Date(booking.startsAt)
  return [
    `${booking.customer ?? ""}`.trim().split(/\s+/)[0] || "there",
    booking.service,
    dateFormatter.format(startsAt),
    timeFormatter.format(startsAt).toUpperCase(),
    salonPhone,
  ].map(variable)
}

/** 30 s, 60 s, 2 min … capped at 1 h, ±20 % jitter so retries do not arrive together. */
export function retryDelayMs(attempt) {
  return Math.round(Math.min(3600_000, 30_000 * 2 ** Math.max(0, attempt - 1)) * (0.8 + Math.random() * 0.4))
}

async function sentThisMonth(db) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM sms_messages
      WHERE sent_at >= (date_trunc('month', NOW() AT TIME ZONE '${SALON_TIMEZONE}') AT TIME ZONE '${SALON_TIMEZONE}')`
  )
  return rows[0].n
}

async function finish(db, id, fields) {
  const sets = ["locked_until = NULL", "updated_at = NOW()"]
  const values = [id]
  for (const [column, value] of Object.entries(fields)) {
    values.push(value)
    sets.push(`${column} = $${values.length}`)
  }
  // Only the worker holding the claim may finish it.
  await db.query(`UPDATE sms_messages SET ${sets.join(", ")} WHERE id = $1 AND status = 'SENDING'`, values)
}

async function loadSalonPhone() {
  try {
    const { profile } = await getBusinessProfile()
    return profile?.phone || "-"
  } catch {
    return "-"
  }
}

async function skipReason(row) {
  const booking = await getBookingById(row.booking_id, pool)
  if (!booking) return { reason: "booking not found" }
  if (booking.status !== "CONFIRMED") return { reason: `booking is ${booking.status}` }
  const startsAt = new Date(booking.startsAt).getTime()
  if (startsAt !== new Date(row.booking_starts_at).getTime()) return { reason: "appointment time changed" }
  if (startsAt <= Date.now()) return { reason: "appointment already started" }
  return { booking }
}

/** One pass: claims a bounded batch and sends it. @returns {Promise<Record<string, number>>} outcome counts */
export async function runSmsRemindersOnce({ db = pool, config = smsConfig() } = {}) {
  const counts = {}
  if (!isSmsAvailable(config)) return counts
  const bump = outcome => {
    counts[outcome] = (counts[outcome] ?? 0) + 1
  }
  const { rows } = await db.query(
    `WITH due AS (
       SELECT id FROM sms_messages
        WHERE (status = 'PENDING' AND next_attempt_at <= NOW()) OR (status = 'SENDING' AND locked_until < NOW())
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE sms_messages m
        SET status = 'SENDING', attempts = m.attempts + 1, locked_until = NOW() + make_interval(secs => $2), updated_at = NOW()
       FROM due WHERE m.id = due.id
     RETURNING m.*`,
    [config.worker.batchSize, config.worker.leaseSeconds]
  )
  if (!rows.length) return counts
  let remaining = Math.max(0, config.monthlyLimit - (await sentThisMonth(db)))
  const salonPhone = await loadSalonPhone()
  for (const row of rows) {
    if (row.attempts > row.max_attempts) {
      await finish(db, row.id, { status: "FAILED", last_error: "attempt limit reached" })
      bump("FAILED")
      continue
    }
    const { reason, booking } = await skipReason(row)
    if (reason) {
      await finish(db, row.id, { status: "SKIPPED", last_error: reason })
      bump("SKIPPED")
      continue
    }
    if (remaining <= 0) {
      await finish(db, row.id, { status: "SKIPPED", last_error: "monthly limit reached" })
      bump("SKIPPED")
      continue
    }
    remaining -= 1
    try {
      const { messageId } = await sendReminderSms({ to: row.phone, variables: reminderVariables(booking, salonPhone) }, config)
      await finish(db, row.id, { status: "SENT", provider_message_id: messageId, sent_at: new Date(), last_error: null })
      bump("SENT")
    } catch (error) {
      const giveUp = !error?.retryable || row.attempts >= row.max_attempts
      await finish(db, row.id, {
        status: giveUp ? "FAILED" : "PENDING",
        next_attempt_at: new Date(Date.now() + retryDelayMs(row.attempts)),
        last_error: `${error?.message ?? "send failed"}`.slice(0, 400),
      })
      console.error("sms_send_failed", { id: row.id, to: maskPhone(row.phone), errorKind: error?.kind ?? null, attempt: row.attempts, willRetry: !giveUp })
      bump(giveUp ? "FAILED" : "RETRY")
    }
  }
  return counts
}

/**
 * Boot-time wiring: reports the configuration and starts the worker. Returns `stop()`, which
 * resolves once an in-flight pass has finished (used on SIGTERM).
 */
export async function startSmsReminders() {
  const config = smsConfig()
  const problems = validateSmsConfig(config)
  console.log("sms_config", { ...describeSmsConfig(config), problems })
  if (!isSmsAvailable(config)) return async () => {}
  await prepareSmsReminders()
  let running = null
  let stopped = false
  const tick = () => {
    if (stopped || running) return
    running = runSmsRemindersOnce()
      .then(counts => {
        if (Object.keys(counts).length) console.log("sms_reminders_pass", counts)
      })
      .catch(error => console.error("sms_reminders_pass_failed", { error: error?.message }))
      .finally(() => {
        running = null
      })
  }
  const timer = setInterval(tick, config.worker.intervalMs)
  timer.unref?.()
  tick()
  return async () => {
    stopped = true
    clearInterval(timer)
    if (running) await running
  }
}

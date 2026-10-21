/**
 * Monthly message caps, so WhatsApp spend stays inside a fixed budget.
 *
 * Every paid message type belongs to one bucket with a monthly limit (salon calendar
 * month). When a bucket is used up, that type simply stops for the rest of the month:
 * OTP requests are refused with a clear message, queued welcome/reminder/offer rows are
 * marked SKIPPED ("monthly limit reached"), and new offer campaigns are sized to what is
 * left. A limit of 0 switches the type off entirely.
 *
 * Defaults follow the salon's budget: 1,000 OTPs, 1,000 welcomes, 2,000 reminders,
 * 1,000 offers. Booking confirmation / cancellation / reschedule messages are not in the
 * budget, so their bucket defaults to 0 (off) even if a template is configured.
 *
 * The cap is "soft" by at most the number of workers sending at the same instant (counts
 * are read, then sent); on one instance that is exact.
 */
import { pool } from "../lib/db-pool.js"
import { SALON_TIMEZONE } from "../lib/salon-time.js"

export const BUDGETS = {
  OTP: "OTP",
  WELCOME: "WELCOME",
  REMINDER: "REMINDER",
  OFFER: "OFFER",
  BOOKING_UPDATES: "BOOKING_UPDATES",
}

const KIND_TO_BUDGET = {
  WELCOME: BUDGETS.WELCOME,
  APPOINTMENT_REMINDER: BUDGETS.REMINDER,
  OFFER: BUDGETS.OFFER,
  BOOKING_CONFIRMED: BUDGETS.BOOKING_UPDATES,
  BOOKING_CANCELLED: BUDGETS.BOOKING_UPDATES,
  BOOKING_RESCHEDULED: BUDGETS.BOOKING_UPDATES,
  // SERVICE_REPLY (the STOP/START acknowledgement) is a reply inside the customer's own
  // 24-hour window, which WhatsApp does not charge for: no bucket.
}

const BUDGET_KINDS = Object.entries(KIND_TO_BUDGET).reduce((acc, [kind, budget]) => {
  ;(acc[budget] ??= []).push(kind)
  return acc
}, {})

const MONTH_START_SQL = `(date_trunc('month', NOW() AT TIME ZONE '${SALON_TIMEZONE}') AT TIME ZONE '${SALON_TIMEZONE}')`

export function budgetForKind(kind) {
  return KIND_TO_BUDGET[kind] ?? null
}

/** The configured monthly limit for a bucket (0 = off). */
export function monthlyLimit(budget, config) {
  return config.budget[budget] ?? 0
}

/** Messages of this bucket already sent this salon month. */
export async function usedThisMonth(budget, db = pool) {
  if (budget === BUDGETS.OTP) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM whatsapp_otp_challenges WHERE wa_message_id IS NOT NULL AND created_at >= ${MONTH_START_SQL}`
    )
    return rows[0].n
  }
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM whatsapp_messages WHERE kind = ANY($1::text[]) AND sent_at >= ${MONTH_START_SQL}`,
    [BUDGET_KINDS[budget] ?? []]
  )
  return rows[0].n
}

/** How many more messages of this bucket may be sent this month. */
export async function remainingThisMonth(budget, config, db = pool) {
  const limit = monthlyLimit(budget, config)
  if (limit <= 0) return 0
  return Math.max(0, limit - (await usedThisMonth(budget, db)))
}

/** Usage report for the admin status endpoint and the check script. */
export async function budgetReport(config, db = pool) {
  const report = {}
  for (const budget of Object.values(BUDGETS)) {
    const limit = monthlyLimit(budget, config)
    const used = await usedThisMonth(budget, db)
    report[budget] = { limit, used, remaining: Math.max(0, limit - used) }
  }
  return report
}

/**
 * Customer-facing WhatsApp notifications: welcome, booking confirmed / rescheduled /
 * cancelled, and the two appointment reminders.
 *
 * The `queue*` functions are called from inside the transaction that commits the booking
 * change (pass that transaction's client). They only write outbox rows; nothing is sent
 * until the transaction commits and the worker picks the rows up. Each one runs inside a
 * SAVEPOINT, so a problem with the notification tables can never abort the booking itself.
 *
 * Cost control (see budget.js): by default only WELCOME and the two reminders are produced.
 * Confirmed / rescheduled / cancelled messages stay in the code but are off unless
 * WHATSAPP_MONTHLY_LIMIT_BOOKING_UPDATES is raised above 0 (rescheduling and cancelling
 * still move or cancel the reminders either way).
 *
 * Template parameters (positional, `{{1}}..{{n}}`), which the approved templates must match:
 *   WELCOME                1 first name
 *   BOOKING_CONFIRMED      1 first name, 2 services, 3 date, 4 time, 5 stylist, 6 booking ref, 7 salon phone
 *   BOOKING_RESCHEDULED    1 first name, 2 services, 3 new date, 4 new time, 5 stylist, 6 booking ref, 7 salon phone
 *   APPOINTMENT_REMINDER   1 first name, 2 services, 3 date, 4 time, 5 stylist, 6 booking ref, 7 salon phone
 *   BOOKING_CANCELLED      1 first name, 2 services, 3 date, 4 time, 5 booking ref, 6 salon phone
 */
import { pool } from "../lib/db-pool.js"
import { SALON_TIMEZONE } from "../lib/salon-time.js"
import { getBookingById } from "../bookings/repository.js"
import { getBusinessProfile } from "../business/service.js"
import { TEMPLATE_KEYS, isWhatsAppSendingAvailable, templateFor, whatsappConfig } from "./config.js"
import { bodyComponents } from "./client.js"
import { cancelPendingBookingMessages, enqueueWhatsAppMessage, registerMessageKind } from "./outbox.js"
import { ensureWhatsAppSchema } from "./schema-init.js"
import { normalizePhone } from "./phone.js"
import { BUDGETS, monthlyLimit } from "./budget.js"

const TEMPLATE_BUDGET = {
  [TEMPLATE_KEYS.WELCOME]: BUDGETS.WELCOME,
  [TEMPLATE_KEYS.APPOINTMENT_REMINDER]: BUDGETS.REMINDER,
  [TEMPLATE_KEYS.BOOKING_CONFIRMED]: BUDGETS.BOOKING_UPDATES,
  [TEMPLATE_KEYS.BOOKING_CANCELLED]: BUDGETS.BOOKING_UPDATES,
  [TEMPLATE_KEYS.BOOKING_RESCHEDULED]: BUDGETS.BOOKING_UPDATES,
}

export const MESSAGE_KINDS = {
  WELCOME: "WELCOME",
  BOOKING_CONFIRMED: "BOOKING_CONFIRMED",
  BOOKING_RESCHEDULED: "BOOKING_RESCHEDULED",
  BOOKING_CANCELLED: "BOOKING_CANCELLED",
  APPOINTMENT_REMINDER: "APPOINTMENT_REMINDER",
}

const UPCOMING_BOOKING_KINDS = [MESSAGE_KINDS.BOOKING_CONFIRMED, MESSAGE_KINDS.BOOKING_RESCHEDULED, MESSAGE_KINDS.APPOINTMENT_REMINDER]

let schemaReady = false

/**
 * Makes sure the outbox tables exist before a booking transaction tries to write to them.
 * Must run *outside* that transaction (schema DDL takes locks a booking transaction would
 * deadlock against). Never throws: if it fails, notifications are skipped, bookings are not.
 */
export async function prepareWhatsAppNotifications() {
  if (schemaReady) return true
  if (!whatsappConfig().enabled) return false
  try {
    await ensureWhatsAppSchema()
    schemaReady = true
  } catch (error) {
    console.error("whatsapp_schema_unavailable", { error: error?.message })
  }
  return schemaReady
}

/** Test hook. */
export function resetWhatsAppNotificationStateForTests() {
  schemaReady = false
}

/** A type is produced only with an approved template AND a non-zero monthly limit. */
function featureOn(templateKey, config) {
  const budget = TEMPLATE_BUDGET[templateKey]
  if (budget && monthlyLimit(budget, config) <= 0) return false
  return schemaReady && isWhatsAppSendingAvailable(config) && Boolean(templateFor(templateKey, config))
}

function isClient(db) {
  return typeof db?.release === "function"
}

async function withSavepoint(db, label, run) {
  const savepoint = `wa_${label}`
  const useSavepoint = isClient(db)
  try {
    if (useSavepoint) await db.query(`SAVEPOINT ${savepoint}`)
    const result = await run()
    if (useSavepoint) await db.query(`RELEASE SAVEPOINT ${savepoint}`)
    return result
  } catch (error) {
    if (useSavepoint) await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => {})
    console.error("whatsapp_enqueue_failed", { label, error: error?.message })
    return null
  }
}

function startsAtIso(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Reminder rows for a booking at its current time. Reminders already due (or nearly) are not created. */
async function enqueueReminders(db, booking, phone, config, now = Date.now()) {
  if (!featureOn(TEMPLATE_KEYS.APPOINTMENT_REMINDER, config)) return 0
  const startsAt = startsAtIso(booking.startsAt)
  if (!startsAt) return 0
  const startsMs = new Date(startsAt).getTime()
  const minLeadMs = config.reminders.minLeadMinutes * 60_000
  let created = 0
  for (const [index, offsetMinutes] of (config.reminders.offsetsMinutes ?? []).entries()) {
    const sendAt = startsMs - offsetMinutes * 60_000
    // A booking made at 14:00 for 15:00 does not get a "2 hours to go" message at 14:00:
    // reminders whose time has passed, or that would land right after the confirmation,
    // are simply not scheduled.
    if (sendAt < now + minLeadMs) continue
    const id = await enqueueWhatsAppMessage(db, {
      kind: MESSAGE_KINDS.APPOINTMENT_REMINDER,
      category: "UTILITY",
      dedupeKey: `booking:${booking.id}:reminder:${offsetMinutes}:${startsMs}`,
      userId: booking.createdBy ?? null,
      phone,
      bookingId: booking.id,
      context: { startsAt, offsetMinutes, reminderNumber: index + 1 },
      scheduledFor: new Date(sendAt),
      expiresAt: new Date(startsMs),
    })
    if (id) created += 1
  }
  return created
}

/** A just-committed (in this transaction) new booking: confirmation + reminders. */
export async function queueBookingCreatedNotifications(db, booking, config = whatsappConfig()) {
  if (!booking?.id || !schemaReady || !isWhatsAppSendingAvailable(config)) return
  const phone = normalizePhone(booking.customerPhone, config.defaultCountryCode)
  if (!phone) return
  await withSavepoint(db, "booking_created", async () => {
    const startsAt = startsAtIso(booking.startsAt)
    if (featureOn(TEMPLATE_KEYS.BOOKING_CONFIRMED, config) && startsAt) {
      await enqueueWhatsAppMessage(db, {
        kind: MESSAGE_KINDS.BOOKING_CONFIRMED,
        category: "UTILITY",
        dedupeKey: `booking:${booking.id}:confirmed`,
        userId: booking.createdBy ?? null,
        phone,
        bookingId: booking.id,
        context: { startsAt },
        expiresAt: new Date(startsAt),
      })
    }
    await enqueueReminders(db, booking, phone, config)
  })
}

/** The booking was moved (time and/or stylist). Old reminders go, new ones are scheduled. */
export async function queueBookingRescheduledNotifications(db, booking, config = whatsappConfig()) {
  if (!booking?.id || !schemaReady || !isWhatsAppSendingAvailable(config)) return
  const phone = normalizePhone(booking.customerPhone, config.defaultCountryCode)
  if (!phone) return
  await withSavepoint(db, "booking_rescheduled", async () => {
    await cancelPendingBookingMessages(db, booking.id, [MESSAGE_KINDS.APPOINTMENT_REMINDER, MESSAGE_KINDS.BOOKING_RESCHEDULED], "booking rescheduled")
    const startsAt = startsAtIso(booking.startsAt)
    if (featureOn(TEMPLATE_KEYS.BOOKING_RESCHEDULED, config) && startsAt) {
      await enqueueWhatsAppMessage(db, {
        kind: MESSAGE_KINDS.BOOKING_RESCHEDULED,
        category: "UTILITY",
        dedupeKey: `booking:${booking.id}:rescheduled:${new Date(startsAt).getTime()}:${booking.stylistId ?? ""}`,
        userId: booking.createdBy ?? null,
        phone,
        bookingId: booking.id,
        context: { startsAt, stylistId: booking.stylistId ?? null },
        expiresAt: new Date(startsAt),
      })
    }
    await enqueueReminders(db, booking, phone, config)
  })
}

/** The booking was cancelled in this transaction. Nothing about it is sent any more except the cancellation. */
export async function queueBookingCancelledNotifications(db, booking, config = whatsappConfig()) {
  if (!booking?.id || !schemaReady) return
  await withSavepoint(db, "booking_cancelled", async () => {
    // Even with sending switched off, pending rows must not survive a cancellation.
    await cancelPendingBookingMessages(db, booking.id, UPCOMING_BOOKING_KINDS, "booking cancelled")
    if (!featureOn(TEMPLATE_KEYS.BOOKING_CANCELLED, config)) return
    const phone = normalizePhone(booking.customerPhone, config.defaultCountryCode)
    if (!phone) return
    await enqueueWhatsAppMessage(db, {
      kind: MESSAGE_KINDS.BOOKING_CANCELLED,
      category: "UTILITY",
      dedupeKey: `booking:${booking.id}:cancelled`,
      userId: booking.createdBy ?? null,
      phone,
      bookingId: booking.id,
      context: { startsAt: startsAtIso(booking.startsAt) },
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    })
  })
}

/** Welcome for a newly registered customer. Keyed by user id: a retried registration cannot repeat it. */
export async function queueWelcomeMessage(db, user, config = whatsappConfig()) {
  if (!user?.id) return null
  await prepareWhatsAppNotifications()
  if (!featureOn(TEMPLATE_KEYS.WELCOME, config)) return null
  const phone = normalizePhone(user.phone, config.defaultCountryCode)
  if (!phone) return null
  return withSavepoint(db, "welcome", () =>
    enqueueWhatsAppMessage(db, {
      kind: MESSAGE_KINDS.WELCOME,
      category: "UTILITY",
      dedupeKey: `welcome:${user.id}`,
      userId: user.id,
      phone,
      context: {},
      expiresAt: new Date(Date.now() + 3 * 24 * 3600_000),
    })
  )
}

// ---------------------------------------------------------------------------------------
// Send-time preparation: reload the booking and decide whether the message still applies.

const dateFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: SALON_TIMEZONE, weekday: "short", day: "numeric", month: "short", year: "numeric" })
const timeFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: SALON_TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true })

export function formatSalonDate(value) {
  return dateFormatter.format(new Date(value))
}

export function formatSalonTime(value) {
  return timeFormatter.format(new Date(value)).replace(/\s?(am|pm)$/i, (_, suffix) => ` ${suffix.toUpperCase()}`)
}

export function firstName(name) {
  const value = `${name ?? ""}`.trim().split(/\s+/)[0] ?? ""
  return value.slice(0, 40) || "there"
}

function bookingRef(booking) {
  return booking.invoiceNumber || `${booking.id}`.slice(0, 8).toUpperCase()
}

async function salonPhone(ctx) {
  if (!ctx.cache.has("salonPhone")) {
    let phone = "-"
    try {
      const { profile } = await getBusinessProfile()
      phone = profile?.phone || profile?.whatsapp || "-"
    } catch {
      phone = "-"
    }
    ctx.cache.set("salonPhone", phone)
  }
  return ctx.cache.get("salonPhone")
}

function sameInstant(a, b) {
  return a && b && new Date(a).getTime() === new Date(b).getTime()
}

async function loadBooking(row) {
  if (!row.booking_id) return null
  return getBookingById(row.booking_id, pool)
}

function upcomingParams(booking, phone) {
  return [
    firstName(booking.customer),
    booking.service,
    formatSalonDate(booking.startsAt),
    formatSalonTime(booking.startsAt),
    booking.stylistName || "our team",
    bookingRef(booking),
    phone,
  ]
}

function templateSend(key, values) {
  const template = templateFor(key)
  if (!template) return { skip: `template ${key} no longer configured` }
  return { send: { template, components: bodyComponents(values) } }
}

registerMessageKind(MESSAGE_KINDS.BOOKING_CONFIRMED, {
  async prepare(row, ctx) {
    const booking = await loadBooking(row)
    if (!booking) return { skip: "booking not found" }
    if (!["CONFIRMED", "PENDING"].includes(booking.status)) return { skip: `booking is ${booking.status}` }
    if (new Date(booking.startsAt).getTime() <= Date.now()) return { skip: "appointment already started" }
    return templateSend(TEMPLATE_KEYS.BOOKING_CONFIRMED, upcomingParams(booking, await salonPhone(ctx)))
  },
})

registerMessageKind(MESSAGE_KINDS.BOOKING_RESCHEDULED, {
  async prepare(row, ctx) {
    const booking = await loadBooking(row)
    if (!booking) return { skip: "booking not found" }
    if (!["CONFIRMED", "PENDING"].includes(booking.status)) return { skip: `booking is ${booking.status}` }
    if (!sameInstant(booking.startsAt, row.context?.startsAt)) return { skip: "superseded by a later change" }
    if (new Date(booking.startsAt).getTime() <= Date.now()) return { skip: "appointment already started" }
    return templateSend(TEMPLATE_KEYS.BOOKING_RESCHEDULED, upcomingParams(booking, await salonPhone(ctx)))
  },
})

registerMessageKind(MESSAGE_KINDS.APPOINTMENT_REMINDER, {
  async prepare(row, ctx) {
    const booking = await loadBooking(row)
    if (!booking) return { skip: "booking not found" }
    // Re-checked right before sending: cancelled, no-show, started or completed bookings get nothing.
    if (booking.status !== "CONFIRMED") return { skip: `booking is ${booking.status}` }
    if (!sameInstant(booking.startsAt, row.context?.startsAt)) return { skip: "appointment time changed" }
    if (new Date(booking.startsAt).getTime() <= Date.now()) return { skip: "appointment already started" }
    return templateSend(TEMPLATE_KEYS.APPOINTMENT_REMINDER, upcomingParams(booking, await salonPhone(ctx)))
  },
})

registerMessageKind(MESSAGE_KINDS.BOOKING_CANCELLED, {
  async prepare(row, ctx) {
    const booking = await loadBooking(row)
    if (!booking) return { skip: "booking not found" }
    // Only for a cancellation that really committed.
    if (booking.status !== "CANCELLED") return { skip: `booking is ${booking.status}` }
    return templateSend(TEMPLATE_KEYS.BOOKING_CANCELLED, [
      firstName(booking.customer),
      booking.service,
      formatSalonDate(booking.startsAt),
      formatSalonTime(booking.startsAt),
      bookingRef(booking),
      await salonPhone(ctx),
    ])
  },
})

registerMessageKind(MESSAGE_KINDS.WELCOME, {
  async prepare(row) {
    if (!row.user_id) return { skip: "user removed" }
    const { rows } = await pool.query(`SELECT name, phone FROM users WHERE id = $1`, [row.user_id])
    if (!rows[0]) return { skip: "user removed" }
    return templateSend(TEMPLATE_KEYS.WELCOME, [firstName(rows[0].name)])
  },
})

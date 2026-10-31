/**
 * Booking emails: confirmation, 24 h and 2 h reminders, rescheduling and cancellation.
 *
 * Same shape as the SMS reminders in `sms/reminders.js`, and called from the same places.
 * Rows are written on the booking's transaction, each inside a SAVEPOINT, so they exist only if
 * the booking change committed and a problem here can never abort the booking itself.
 */
import { emailConfig, isEmailAvailable } from "./config.js"
import { ensureEmailSchema } from "./schema.js"
import { enqueueEmail } from "./service.js"

let schemaReady = false

/** Must run outside the booking transaction (schema DDL would deadlock against it). Never throws. */
export async function prepareBookingEmails() {
  if (schemaReady) return true
  if (!emailConfig().enabled) return false
  try {
    await ensureEmailSchema()
    schemaReady = true
  } catch (error) {
    console.error("email_schema_unavailable", { error: error?.message })
  }
  return schemaReady
}

async function withSavepoint(db, label, run) {
  try {
    await db.query(`SAVEPOINT email_${label}`)
    await run()
    await db.query(`RELEASE SAVEPOINT email_${label}`)
  } catch (error) {
    await db.query(`ROLLBACK TO SAVEPOINT email_${label}`).catch(() => {})
    console.error("email_enqueue_failed", { label, error: error?.message })
  }
}

function snapshot(booking) {
  return {
    customerName: booking.customer,
    service: booking.service,
    stylistName: booking.stylistName ?? "",
    startsAt: new Date(booking.startsAt).toISOString(),
    durationMinutes: booking.durationMinutes,
    payableAmount: Number(booking.payableAmount ?? 0),
    invoiceNumber: booking.invoiceNumber ?? "",
  }
}

async function insertReminders(db, booking, config) {
  const startsAt = new Date(booking.startsAt)
  if (Number.isNaN(startsAt.getTime())) return
  const earliest = Date.now() + config.reminders.minLeadMinutes * 60_000
  for (const offsetMinutes of config.reminders.offsetsMinutes) {
    const sendAt = new Date(startsAt.getTime() - offsetMinutes * 60_000)
    // A booking made at 14:00 for 15:00 gets no "2 hours to go" message.
    if (sendAt.getTime() < earliest) continue
    await enqueueEmail(db, {
      template: "booking_reminder",
      recipient: booking.customerEmail,
      // The time is in the key: a moved booking gets fresh reminders, a repeat call gets none.
      dedupeKey: `booking:${booking.id}:reminder:${offsetMinutes}:${startsAt.getTime()}`,
      userId: booking.createdBy ?? null,
      bookingId: booking.id,
      bookingStartsAt: startsAt.toISOString(),
      scheduledFor: sendAt,
    })
  }
}

async function cancelPendingReminders(db, bookingId, reason) {
  await db.query(
    `UPDATE email_messages SET status = 'CANCELLED', last_error = $2, updated_at = NOW()
      WHERE booking_id = $1 AND template = 'booking_reminder' AND status = 'PENDING'`,
    [bookingId, reason]
  )
}

/** New booking, inside its transaction. */
export async function queueBookingEmails(db, booking, config = emailConfig()) {
  if (!booking?.id || !schemaReady || !isEmailAvailable(config)) return
  await withSavepoint(db, "queue", async () => {
    await enqueueEmail(db, {
      template: "booking_confirmation",
      recipient: booking.customerEmail,
      dedupeKey: `booking:${booking.id}:confirmation`,
      userId: booking.createdBy ?? null,
      bookingId: booking.id,
      bookingStartsAt: new Date(booking.startsAt).toISOString(),
      payload: snapshot(booking),
    })
    if (config.remindersEnabled) await insertReminders(db, booking, config)
  })
}

/** Booking moved, inside its transaction: the old reminders go, new ones replace them. */
export async function rescheduleBookingEmails(db, booking, { previousStartsAt, timeChanged }, config = emailConfig()) {
  if (!booking?.id || !schemaReady || !isEmailAvailable(config)) return
  await withSavepoint(db, "reschedule", async () => {
    if (timeChanged) {
      await cancelPendingReminders(db, booking.id, "booking rescheduled")
      if (config.remindersEnabled) await insertReminders(db, booking, config)
    }
    await enqueueEmail(db, {
      template: "booking_rescheduled",
      recipient: booking.customerEmail,
      dedupeKey: `booking:${booking.id}:rescheduled:${new Date(booking.startsAt).getTime()}:${booking.stylistId ?? ""}:${Date.now()}`,
      userId: booking.createdBy ?? null,
      bookingId: booking.id,
      bookingStartsAt: new Date(booking.startsAt).toISOString(),
      payload: { ...snapshot(booking), previousStartsAt: timeChanged ? new Date(previousStartsAt).toISOString() : "" },
    })
  })
}

/** Booking cancelled, inside its transaction. */
export async function cancelBookingEmails(db, booking, { refundAmount = 0, refundPercent = 0 } = {}, config = emailConfig()) {
  if (!booking?.id || !schemaReady) return
  await withSavepoint(db, "cancel", async () => {
    await cancelPendingReminders(db, booking.id, "booking cancelled")
    if (!isEmailAvailable(config)) return
    await enqueueEmail(db, {
      template: "booking_cancelled",
      recipient: booking.customerEmail,
      dedupeKey: `booking:${booking.id}:cancelled`,
      userId: booking.createdBy ?? null,
      bookingId: booking.id,
      payload: { ...snapshot(booking), refundAmount: Number(refundAmount ?? 0), refundPercent: Number(refundPercent ?? 0) },
    })
  })
}

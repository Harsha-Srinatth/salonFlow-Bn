import { graph, jsonResponse, sentTemplates } from "./setup.js"
import test from "node:test"
import assert from "node:assert/strict"
import { createUser, insertBooking, makeAllDue, messages, pool, prepareDatabase, resetData } from "./fixtures.js"
import { withTransaction } from "../../src/bookings/repository.js"
import { cancelCustomerBooking, updateReceptionBookingLifecycle } from "../../src/bookings/service.js"
import {
  queueBookingCancelledNotifications,
  queueBookingCreatedNotifications,
  queueBookingRescheduledNotifications,
  queueWelcomeMessage,
} from "../../src/whatsapp/notifications.js"
import { runWhatsAppOutboxOnce } from "../../src/whatsapp/outbox.js"
import { salonDateString, addDaysToDateString, salonWallClockToDate } from "../../src/lib/salon-time.js"

test.before(async () => {
  await prepareDatabase()
})
test.after(async () => {
  await pool.end()
})
test.beforeEach(async () => {
  graph.reset()
  await resetData()
})

/** Books inside a transaction exactly like the booking service does: row + outbox together. */
async function book(customer, hoursAhead) {
  return withTransaction(async client => {
    const booking = await insertBooking({ customer, hoursAhead, db: client })
    await queueBookingCreatedNotifications(client, booking)
    return booking
  })
}

test("booking: confirmation + two reminders scheduled relative to the appointment", async () => {
  const customer = await createUser()
  const booking = await book(customer, 30)
  const rows = await messages()
  assert.deepEqual(rows.map(r => r.kind).sort(), ["APPOINTMENT_REMINDER", "APPOINTMENT_REMINDER", "BOOKING_CONFIRMED"])
  const start = new Date(booking.startsAt).getTime()
  const reminders = rows.filter(r => r.kind === "APPOINTMENT_REMINDER").map(r => (start - new Date(r.scheduled_for).getTime()) / 60_000).sort((a, b) => b - a)
  assert.deepEqual(reminders, [1440, 120])
  for (const row of rows) assert.equal(new Date(row.expires_at).getTime(), start, "nothing is sent after the appointment starts")
  // Only the confirmation is due now: the reminders are NOT sent at booking time.
  const counts = await runWhatsAppOutboxOnce()
  assert.deepEqual(counts, { SENT: 1 })
  assert.deepEqual(sentTemplates(), ["sahasra_booking_confirmed"])
  const params = graph.calls[0].body.template.components[0].parameters.map(p => p.text)
  assert.equal(params.length, 7)
  assert.equal(params[0], "Asha")
  assert.equal(params[1], "Haircut")
  assert.equal(params[5], booking.invoiceNumber)
})

test("booking: a booking created 3 hours ahead gets the 2-hour reminder only", async () => {
  const customer = await createUser()
  await book(customer, 3)
  const reminders = await messages("kind = 'APPOINTMENT_REMINDER'")
  assert.equal(reminders.length, 1)
  assert.equal(reminders[0].context.offsetMinutes, 120)
})

test("booking: an appointment 1 hour away (or in the past) gets no reminders", async () => {
  const customer = await createUser()
  await book(customer, 1)
  await withTransaction(async client => {
    const past = await insertBooking({ customer, hoursAhead: -2, db: client })
    await queueBookingCreatedNotifications(client, past)
  })
  assert.equal((await messages("kind = 'APPOINTMENT_REMINDER'")).length, 0)
})

test("booking: a failed (rolled back) booking leaves no confirmation", async () => {
  const customer = await createUser()
  await assert.rejects(
    withTransaction(async client => {
      const booking = await insertBooking({ customer, hoursAhead: 30, db: client })
      await queueBookingCreatedNotifications(client, booking)
      throw new Error("payment check failed after insert")
    })
  )
  assert.equal((await messages()).length, 0)
  await runWhatsAppOutboxOnce()
  assert.equal(graph.calls.length, 0)
})

test("booking: re-queueing the same booking (retry / replayed webhook) creates no duplicates", async () => {
  const customer = await createUser()
  const booking = await book(customer, 30)
  await queueBookingCreatedNotifications(pool, booking)
  await withTransaction(client => queueBookingCreatedNotifications(client, booking))
  assert.equal((await messages()).length, 3)
  await makeAllDue()
  await runWhatsAppOutboxOnce()
  await runWhatsAppOutboxOnce()
  assert.equal(sentTemplates().filter(name => name === "sahasra_booking_confirmed").length, 1)
})

test("booking: an outbox failure never aborts the booking transaction", async () => {
  const customer = await createUser()
  const booking = await withTransaction(async client => {
    const created = await insertBooking({ customer, hoursAhead: 30, db: client })
    // An id that is not a uuid makes the outbox INSERT fail with a real database error
    // inside its savepoint; the surrounding booking transaction must survive it.
    await queueBookingCreatedNotifications(client, { ...created, id: "not-a-uuid" })
    await client.query("SELECT 1") // transaction is still usable
    return created
  })
  const { rows } = await pool.query("SELECT status FROM bookings WHERE id = $1", [booking.id])
  assert.equal(rows[0].status, "CONFIRMED")
  assert.equal((await messages()).length, 0)
})

test("cancel: real customer cancellation cancels reminders and sends exactly one cancellation", async () => {
  const customer = await createUser()
  const booking = await book(customer, 30)
  await runWhatsAppOutboxOnce() // confirmation goes out
  const result = await cancelCustomerBooking({ bookingId: booking.id, actorUser: { id: customer.id, email: "", phone: "" } })
  assert.equal(result.booking.status, "CANCELLED")
  const reminders = await messages("kind = 'APPOINTMENT_REMINDER'")
  assert.ok(reminders.every(r => r.status === "CANCELLED"))
  await makeAllDue()
  await runWhatsAppOutboxOnce()
  assert.deepEqual(sentTemplates(), ["sahasra_booking_confirmed", "sahasra_booking_cancelled"])
  // Cancelling again is refused by the booking service and produces no second message.
  await assert.rejects(cancelCustomerBooking({ bookingId: booking.id, actorUser: { id: customer.id } }))
  assert.equal((await messages("kind = 'BOOKING_CANCELLED'")).length, 1)
})

test("cancel: a cancellation message for a booking that is not cancelled is never sent", async () => {
  const customer = await createUser()
  const booking = await book(customer, 30)
  // Queued outside a real cancellation (e.g. the transaction that would have cancelled it failed later).
  await queueBookingCancelledNotifications(pool, booking)
  await makeAllDue()
  await runWhatsAppOutboxOnce()
  assert.ok(!sentTemplates().includes("sahasra_booking_cancelled"))
  const [row] = await messages("kind = 'BOOKING_CANCELLED'")
  assert.equal(row.status, "SKIPPED")
})

test("cancel: a reminder already due is re-checked at send time and skipped", async () => {
  const customer = await createUser()
  const booking = await book(customer, 30)
  await pool.query("UPDATE bookings SET status = 'CANCELLED' WHERE id = $1", [booking.id]) // changed behind the outbox's back
  await makeAllDue()
  await runWhatsAppOutboxOnce()
  assert.equal(sentTemplates().length, 0)
  assert.ok((await messages()).every(r => r.status === "SKIPPED"))
})

test("reschedule: real reception reschedule replaces the reminders and notifies once", async () => {
  const customer = await createUser()
  const stylist = await createUser({ role: "STAFF", name: "Ravi Stylist" })
  const tomorrow = addDaysToDateString(salonDateString(), 1)
  const firstStart = salonWallClockToDate(tomorrow, 18 * 60)
  const booking = await withTransaction(async client => {
    const created = await insertBooking({ customer, hoursAhead: (firstStart.getTime() - Date.now()) / 3600_000, stylistId: stylist.id, db: client })
    await queueBookingCreatedNotifications(client, created)
    return created
  })
  const before = await messages("kind = 'APPOINTMENT_REMINDER'")
  const newStart = salonWallClockToDate(tomorrow, 20 * 60)
  const updated = await updateReceptionBookingLifecycle({
    bookingId: booking.id,
    payload: { action: "reschedule", startsAt: newStart.toISOString() },
    actorUserId: stylist.id,
  })
  assert.equal(new Date(updated.startsAt).getTime(), newStart.getTime())
  const after = await messages("kind = 'APPOINTMENT_REMINDER'")
  const oldIds = new Set(before.map(r => r.id))
  assert.ok(after.filter(r => oldIds.has(r.id)).every(r => r.status === "CANCELLED"), "old reminders cancelled")
  const fresh = after.filter(r => !oldIds.has(r.id))
  assert.ok(fresh.length >= 1)
  for (const row of fresh) assert.equal(new Date(row.context.startsAt).getTime(), newStart.getTime())
  assert.equal((await messages("kind = 'BOOKING_RESCHEDULED'")).length, 1)
})

test("reschedule: a stale reminder for the old time is skipped even if it slipped through", async () => {
  const customer = await createUser()
  const booking = await book(customer, 30)
  await pool.query("UPDATE bookings SET starts_at = starts_at + interval '3 hours' WHERE id = $1", [booking.id])
  await pool.query("UPDATE whatsapp_messages SET next_attempt_at = NOW() WHERE kind = 'APPOINTMENT_REMINDER'")
  await runWhatsAppOutboxOnce()
  const reminders = await messages("kind = 'APPOINTMENT_REMINDER'")
  assert.ok(reminders.every(r => r.status === "SKIPPED"))
})

test("reschedule: queueing twice for the same new time is idempotent", async () => {
  const customer = await createUser()
  const booking = await book(customer, 30)
  const moved = { ...booking, startsAt: new Date(new Date(booking.startsAt).getTime() + 3600_000).toISOString() }
  await queueBookingRescheduledNotifications(pool, moved)
  await queueBookingRescheduledNotifications(pool, moved)
  assert.equal((await messages("kind = 'BOOKING_RESCHEDULED'")).length, 1)
})

test("reminders: survive a restart (state is in the database) and send once when due", async () => {
  const customer = await createUser()
  await book(customer, 30)
  await runWhatsAppOutboxOnce()
  // "Restart": nothing in memory matters, the next worker simply reads the table.
  await makeAllDue()
  await runWhatsAppOutboxOnce()
  assert.equal(sentTemplates().filter(n => n === "sahasra_appointment_reminder").length, 2)
  const reminders = await messages("kind = 'APPOINTMENT_REMINDER'")
  for (const row of reminders) {
    assert.equal(row.status, "SENT")
    assert.equal(row.attempts, 1)
    assert.match(row.wa_message_id, /^wamid\./)
  }
})

test("reminders: concurrent workers never send the same reminder twice", async () => {
  for (let i = 0; i < 8; i += 1) await book(await createUser(), 30)
  await makeAllDue()
  graph.respond = async body => {
    await new Promise(resolve => setTimeout(resolve, 5))
    return jsonResponse(200, { messages: [{ id: `wamid.C${graph.calls.length}-${body.to}` }] })
  }
  await Promise.all([runWhatsAppOutboxOnce(), runWhatsAppOutboxOnce(), runWhatsAppOutboxOnce(), runWhatsAppOutboxOnce()])
  const all = await messages()
  assert.equal(all.length, 24)
  assert.ok(all.every(r => r.status === "SENT"))
  assert.equal(graph.calls.length, 24, "each row sent exactly once")
})

test("retries: transient failure is retried with backoff, permanent failure is not", async () => {
  const customer = await createUser()
  await book(customer, 30)
  graph.respond = () => jsonResponse(503, { error: { code: 131016, message: "temporarily unavailable" } })
  await runWhatsAppOutboxOnce()
  let [confirmation] = await messages("kind = 'BOOKING_CONFIRMED'")
  assert.equal(confirmation.status, "PENDING")
  assert.equal(confirmation.attempts, 1)
  assert.ok(new Date(confirmation.next_attempt_at).getTime() > Date.now() + 20_000)
  assert.equal(confirmation.last_error_code, "131016")
  graph.reset()
  await makeAllDue()
  await runWhatsAppOutboxOnce()
  ;[confirmation] = await messages("kind = 'BOOKING_CONFIRMED'")
  assert.equal(confirmation.status, "SENT")
  assert.equal(confirmation.attempts, 2)

  const other = await createUser()
  await book(other, 30)
  graph.respond = () => jsonResponse(404, { error: { code: 132001, message: "template does not exist" } })
  await runWhatsAppOutboxOnce()
  const [failed] = await messages("kind = 'BOOKING_CONFIRMED' AND user_id = $1", [other.id])
  assert.equal(failed.status, "FAILED")
  assert.equal(failed.attempts, 1)
})

test("retries: bounded — gives up after the attempt limit", async () => {
  const customer = await createUser()
  await book(customer, 30)
  graph.respond = () => jsonResponse(500, { error: { code: 1, message: "unknown" } })
  for (let i = 0; i < 6; i += 1) {
    await pool.query("UPDATE whatsapp_messages SET next_attempt_at = NOW() WHERE kind = 'BOOKING_CONFIRMED' AND status = 'PENDING'")
    await runWhatsAppOutboxOnce()
  }
  const [row] = await messages("kind = 'BOOKING_CONFIRMED'")
  assert.equal(row.status, "FAILED")
  assert.equal(row.attempts, 5)
})

test("worker: does nothing (and marks nothing sent) when WhatsApp is disabled", async () => {
  const customer = await createUser()
  await book(customer, 30)
  const counts = await runWhatsAppOutboxOnce({ config: (await import("../../src/whatsapp/config.js")).whatsappConfig({}) })
  assert.deepEqual(counts, {})
  assert.ok((await messages()).every(r => r.status === "PENDING"))
})

test("welcome: queued once per user even if registration is retried", async () => {
  const user = await createUser()
  await queueWelcomeMessage(pool, user)
  await queueWelcomeMessage(pool, user)
  await runWhatsAppOutboxOnce()
  await queueWelcomeMessage(pool, user) // e.g. a replayed request after it was sent
  await runWhatsAppOutboxOnce()
  assert.deepEqual(sentTemplates(), ["sahasra_welcome"])
  assert.equal(graph.calls[0].body.template.components[0].parameters[0].text, "Asha")
})

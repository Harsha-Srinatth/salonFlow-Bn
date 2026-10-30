import { jsonResponse, smsApi, TEST_ENV } from "../helpers/setup.js"
import test from "node:test"
import assert from "node:assert/strict"
import { createUser, insertBooking, makeAllDue, messages, pool, prepareDatabase, resetData } from "../helpers/fixtures.js"
import { withTransaction } from "../../src/bookings/repository.js"
import { cancelCustomerBooking, updateReceptionBookingLifecycle } from "../../src/bookings/service.js"
import { addDaysToDateString, salonDateString, salonWallClockToDate } from "../../src/lib/salon-time.js"
import { assertProductionEnv } from "../../src/lib/env-check.js"
import { isSmsAvailable, smsConfig, validateSmsConfig } from "../../src/sms/config.js"
import { maskPhone, toIndianSmsRecipient } from "../../src/sms/phone.js"
import { sendReminderSms } from "../../src/sms/client.js"
import {
  cancelBookingReminders,
  queueBookingReminders,
  reminderVariables,
  rescheduleBookingReminders,
  retryDelayMs,
  runSmsRemindersOnce,
} from "../../src/sms/reminders.js"

test.before(async () => {
  await prepareDatabase()
})
test.after(async () => {
  await pool.end()
})
test.beforeEach(async () => {
  smsApi.reset()
  await resetData()
  delete process.env.SMS_MONTHLY_LIMIT_REMINDER
})

function book(customer, hoursAhead, extra = {}) {
  return withTransaction(async client => {
    const booking = await insertBooking({ customer, hoursAhead, db: client, ...extra })
    await queueBookingReminders(client, booking)
    return booking
  })
}

test("config: off needs nothing; on needs the key and template", () => {
  assert.deepEqual(validateSmsConfig(smsConfig({})), [])
  assert.equal(isSmsAvailable(smsConfig({})), false)
  const problems = validateSmsConfig(smsConfig({ SMS_ENABLED: "true" }))
  assert.ok(problems.some(p => p.includes("MSG91_AUTH_KEY")))
  assert.ok(problems.some(p => p.includes("MSG91_REMINDER_TEMPLATE_ID")))
  assert.equal(isSmsAvailable(smsConfig(TEST_ENV)), true)
  assert.deepEqual(smsConfig({ SMS_REMINDER_OFFSETS_MINUTES: "60,720" }).reminders.offsetsMinutes, [720, 60])
  assert.ok(validateSmsConfig(smsConfig({ ...TEST_ENV, SMS_REMINDER_OFFSETS_MINUTES: "24h" })).length)
})

test("config: production refuses a half-set SMS configuration", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x",
    FRONTEND_ORIGIN: "https://example.test",
    STAFF_ACCESS_SECRET: "a".repeat(40),
    STAFF_SETUP_SECRET: "b".repeat(40),
    JWT_SECRET: "c".repeat(40),
    TRUST_PROXY: "1",
    ANTHROPIC_API_KEY: "x",
  }
  assert.doesNotThrow(() => assertProductionEnv(base))
  assert.throws(() => assertProductionEnv({ ...base, SMS_ENABLED: "true" }), /MSG91_AUTH_KEY/)
})

test("phone: common Indian formats normalise, others are refused", () => {
  for (const input of ["9876543210", "098765 43210", "+91 98765-43210", "919876543210", "0091 9876543210"]) {
    assert.equal(toIndianSmsRecipient(input), "919876543210", input)
  }
  for (const input of ["", "12345", "5876543210", "+14155552671", "98765abc10"]) {
    assert.equal(toIndianSmsRecipient(input), null, input)
  }
  assert.equal(maskPhone("919876543210"), "91******3210")
})

test("client: sends the template with its variables to MSG91", async () => {
  const result = await sendReminderSms({ to: "919876543210", variables: ["Asha", "Haircut"] })
  assert.match(result.messageId, /^req-/)
  const { body, authkey } = smsApi.calls[0]
  assert.equal(authkey, "test-auth-key-not-real")
  assert.deepEqual(body, { template_id: "test-template-id", short_url: "0", mobiles: "919876543210", VAR1: "Asha", VAR2: "Haircut" })
})

test("client: only an explicit success counts; failures are classified", async () => {
  const send = () => sendReminderSms({ to: "919876543210", variables: [] })
  smsApi.respond = () => jsonResponse(200, { type: "error", message: "Template not approved" })
  await assert.rejects(send(), err => err.kind === "REJECTED" && !err.retryable)
  smsApi.respond = () => jsonResponse(401, {})
  await assert.rejects(send(), err => err.kind === "CONFIGURATION" && !err.retryable)
  smsApi.respond = () => jsonResponse(503, {})
  await assert.rejects(send(), err => err.retryable)
  smsApi.respond = () => {
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" })
  }
  await assert.rejects(send(), err => err.kind === "TIMEOUT" && err.retryable)
})

test("client: refuses without configuration, with no network call", async () => {
  await assert.rejects(sendReminderSms({ to: "919876543210", variables: [] }, smsConfig({})), err => err.kind === "NOT_CONFIGURED")
  assert.equal(smsApi.calls.length, 0)
})

test("variables: stay within DLT's 30 characters and use salon time", () => {
  const variables = reminderVariables(
    { customer: "Asha Rao", service: "Hair Colour, Keratin Treatment, Head Massage", startsAt: "2026-11-02T11:00:00.000Z" },
    "+919000000000"
  )
  assert.equal(variables[0], "Asha")
  assert.equal(variables[1].length, 30)
  assert.equal(variables[2], "2 Nov")
  assert.match(variables[3], /^4:30\sPM$/)
  assert.equal(variables[4], "+919000000000")
})

test("retry delay grows and stays capped", () => {
  assert.ok(retryDelayMs(1) >= 24_000 && retryDelayMs(1) <= 36_000)
  assert.ok(retryDelayMs(30) <= 3600_000 * 1.2)
})

test("reminders: two are scheduled relative to the appointment, none go out at booking time", async () => {
  const booking = await book(await createUser(), 30)
  const start = new Date(booking.startsAt).getTime()
  const rows = await messages()
  assert.deepEqual(rows.map(r => (start - new Date(r.scheduled_for).getTime()) / 60_000), [1440, 120])
  assert.deepEqual(await runSmsRemindersOnce(), {})
  assert.equal(smsApi.calls.length, 0)
})

test("reminders: late bookings only get the ones still ahead; past ones get none", async () => {
  const customer = await createUser()
  await book(customer, 3)
  assert.equal((await messages()).length, 1)
  await book(customer, 1)
  await book(customer, -2)
  assert.equal((await messages()).length, 1)
})

test("reminders: a rolled-back booking leaves nothing scheduled", async () => {
  const customer = await createUser()
  await assert.rejects(
    withTransaction(async client => {
      await queueBookingReminders(client, await insertBooking({ customer, hoursAhead: 30, db: client }))
      throw new Error("failed after insert")
    })
  )
  assert.equal((await messages()).length, 0)
})

test("reminders: a database failure while queueing does not abort the booking", async () => {
  const booking = await withTransaction(async client => {
    const created = await insertBooking({ customer: await createUser(), hoursAhead: 30, db: client })
    await queueBookingReminders(client, { ...created, id: "not-a-uuid" })
    await client.query("SELECT 1")
    return created
  })
  const { rows } = await pool.query("SELECT status FROM bookings WHERE id = $1", [booking.id])
  assert.equal(rows[0].status, "CONFIRMED")
})

test("reminders: queueing twice creates no duplicates; a restart loses nothing; each sends once", async () => {
  const booking = await book(await createUser(), 30)
  await withTransaction(client => queueBookingReminders(client, booking))
  assert.equal((await messages()).length, 2)
  await makeAllDue()
  assert.deepEqual(await runSmsRemindersOnce(), { SENT: 2 })
  assert.deepEqual(await runSmsRemindersOnce(), {})
  const rows = await messages()
  assert.ok(rows.every(r => r.status === "SENT" && r.attempts === 1 && r.provider_message_id))
})

test("reminders: concurrent workers never send the same one twice", async () => {
  for (let i = 0; i < 8; i += 1) await book(await createUser(), 30)
  await makeAllDue()
  smsApi.respond = async () => {
    await new Promise(resolve => setTimeout(resolve, 5))
    return jsonResponse(200, { type: "success", message: "req" })
  }
  await Promise.all([runSmsRemindersOnce(), runSmsRemindersOnce(), runSmsRemindersOnce(), runSmsRemindersOnce()])
  assert.equal(smsApi.calls.length, 16)
  assert.ok((await messages()).every(r => r.status === "SENT"))
})

test("cancel: a real customer cancellation stops the reminders", async () => {
  const customer = await createUser()
  const booking = await book(customer, 30)
  const result = await cancelCustomerBooking({ bookingId: booking.id, actorUser: { id: customer.id, email: "", phone: "" } })
  assert.equal(result.booking.status, "CANCELLED")
  assert.ok((await messages()).every(r => r.status === "CANCELLED"))
  await runSmsRemindersOnce()
  assert.equal(smsApi.calls.length, 0)
})

test("send time: status is re-checked, so a booking changed behind the queue gets nothing", async () => {
  const booking = await book(await createUser(), 30)
  await pool.query("UPDATE bookings SET status = 'NO-SHOW' WHERE id = $1", [booking.id])
  await makeAllDue()
  assert.deepEqual(await runSmsRemindersOnce(), { SKIPPED: 2 })
  assert.equal(smsApi.calls.length, 0)
})

test("send time: a moved appointment's stale reminder is skipped", async () => {
  const booking = await book(await createUser(), 30)
  await pool.query("UPDATE bookings SET starts_at = starts_at + interval '3 hours' WHERE id = $1", [booking.id])
  await makeAllDue()
  assert.deepEqual(await runSmsRemindersOnce(), { SKIPPED: 2 })
})

test("reschedule: a real reception move replaces the reminders", async () => {
  const customer = await createUser()
  const stylist = await createUser({ role: "STAFF", name: "Ravi Stylist" })
  const day = addDaysToDateString(salonDateString(), 2)
  const first = salonWallClockToDate(day, 18 * 60)
  const booking = await book(customer, (first.getTime() - Date.now()) / 3600_000, { stylistId: stylist.id })
  const before = new Set((await messages()).map(r => r.id))
  const moved = salonWallClockToDate(day, 20 * 60)
  await updateReceptionBookingLifecycle({ bookingId: booking.id, payload: { action: "reschedule", startsAt: moved.toISOString() }, actorUserId: stylist.id })
  const rows = await messages()
  assert.ok(rows.filter(r => before.has(r.id)).every(r => r.status === "CANCELLED"))
  const fresh = rows.filter(r => !before.has(r.id))
  assert.equal(fresh.length, 2)
  assert.ok(fresh.every(r => r.status === "PENDING" && new Date(r.booking_starts_at).getTime() === moved.getTime()))
})

test("reschedule: moving away and back to the same time restores the reminders", async () => {
  const booking = await book(await createUser(), 30)
  const later = { ...booking, startsAt: new Date(new Date(booking.startsAt).getTime() + 3600_000).toISOString() }
  await withTransaction(client => rescheduleBookingReminders(client, later))
  await withTransaction(client => rescheduleBookingReminders(client, booking))
  const pending = await messages("status = 'PENDING'")
  assert.equal(pending.length, 2)
  assert.ok(pending.every(r => new Date(r.booking_starts_at).getTime() === new Date(booking.startsAt).getTime()))
})

test("cancel: cancelling is safe when nothing is pending", async () => {
  const booking = await book(await createUser(), 30)
  await withTransaction(client => cancelBookingReminders(client, booking.id))
  await withTransaction(client => cancelBookingReminders(client, booking.id))
  assert.ok((await messages()).every(r => r.status === "CANCELLED"))
})

test("retries: transient failures back off and recover; rejections are not retried", async () => {
  await book(await createUser(), 30)
  await makeAllDue()
  smsApi.respond = () => jsonResponse(503, {})
  await runSmsRemindersOnce()
  let rows = await messages()
  assert.ok(rows.every(r => r.status === "PENDING" && r.attempts === 1 && new Date(r.next_attempt_at).getTime() > Date.now() + 20_000))
  smsApi.reset()
  await makeAllDue()
  await runSmsRemindersOnce()
  rows = await messages()
  assert.ok(rows.every(r => r.status === "SENT" && r.attempts === 2))

  await book(await createUser(), 30)
  await makeAllDue()
  smsApi.respond = () => jsonResponse(200, { type: "error", message: "Template not approved" })
  await runSmsRemindersOnce()
  assert.equal((await messages("status = 'FAILED'")).length, 2)
})

test("retries: bounded, gives up after the attempt limit", async () => {
  await book(await createUser(), 30)
  smsApi.respond = () => jsonResponse(500, {})
  for (let i = 0; i < 6; i += 1) {
    await makeAllDue()
    await runSmsRemindersOnce()
  }
  const rows = await messages()
  assert.ok(rows.every(r => r.status === "FAILED" && r.attempts === 5))
})

test("cap: reminders beyond the monthly limit are skipped, not sent", async () => {
  process.env.SMS_MONTHLY_LIMIT_REMINDER = "3"
  await book(await createUser(), 30)
  await book(await createUser(), 30)
  await makeAllDue()
  assert.deepEqual(await runSmsRemindersOnce(), { SENT: 3, SKIPPED: 1 })
  assert.equal((await messages("status = 'SKIPPED'"))[0].last_error, "monthly limit reached")
})

test("worker: does nothing, and marks nothing sent, when SMS is off", async () => {
  await book(await createUser(), 30)
  await makeAllDue()
  assert.deepEqual(await runSmsRemindersOnce({ config: smsConfig({}) }), {})
  assert.ok((await messages()).every(r => r.status === "PENDING"))
})

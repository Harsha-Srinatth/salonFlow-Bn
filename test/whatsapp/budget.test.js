import { graph, sentTemplates } from "./setup.js"
import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createUser, insertBooking, makeAllDue, messages, pool, prepareDatabase, resetData, uniquePhone } from "./fixtures.js"
import { withTransaction } from "../../src/bookings/repository.js"
import { queueBookingCancelledNotifications, queueBookingCreatedNotifications, queueWelcomeMessage } from "../../src/whatsapp/notifications.js"
import { runWhatsAppOutboxOnce } from "../../src/whatsapp/outbox.js"
import { requestWhatsAppOtp } from "../../src/whatsapp/otp.js"
import { createOfferCampaign, setMarketingPreference } from "../../src/whatsapp/campaigns.js"
import { budgetReport } from "../../src/whatsapp/budget.js"
import { whatsappConfig } from "../../src/whatsapp/config.js"

test.before(async () => {
  await prepareDatabase()
})
test.after(async () => {
  await pool.end()
})
test.beforeEach(async () => {
  graph.reset()
  await resetData()
  delete process.env.WHATSAPP_MONTHLY_LIMIT_BOOKING_UPDATES // real default: 0 (off)
  for (const key of ["OTP", "WELCOME", "REMINDER", "OFFER"]) delete process.env[`WHATSAPP_MONTHLY_LIMIT_${key}`]
})

test("defaults: limits match the salon budget and booking update messages are off", () => {
  assert.deepEqual(whatsappConfig().budget, { OTP: 1000, WELCOME: 1000, REMINDER: 2000, OFFER: 1000, BOOKING_UPDATES: 0 })
})

test("defaults: a booking queues only its two reminders (no confirmation), a cancellation sends nothing", async () => {
  const customer = await createUser()
  const booking = await withTransaction(async client => {
    const created = await insertBooking({ customer, hoursAhead: 30, db: client })
    await queueBookingCreatedNotifications(client, created)
    return created
  })
  assert.deepEqual((await messages()).map(r => r.kind), ["APPOINTMENT_REMINDER", "APPOINTMENT_REMINDER"])
  await queueBookingCancelledNotifications(pool, booking)
  const rows = await messages()
  assert.equal(rows.length, 2, "no cancellation message queued")
  assert.ok(rows.every(r => r.status === "CANCELLED"), "but the reminders are still cancelled")
  await runWhatsAppOutboxOnce()
  assert.equal(graph.calls.length, 0)
})

test("cap: OTPs stop at the monthly limit with a clear error", async () => {
  process.env.WHATSAPP_MONTHLY_LIMIT_OTP = "2"
  await requestWhatsAppOtp({ phone: uniquePhone(), purpose: "SIGNUP", ip: "10.9.0.1" })
  await requestWhatsAppOtp({ phone: uniquePhone(), purpose: "SIGNUP", ip: "10.9.0.2" })
  await assert.rejects(requestWhatsAppOtp({ phone: uniquePhone(), purpose: "SIGNUP", ip: "10.9.0.3" }), err => err.code === "WHATSAPP_MONTHLY_LIMIT")
  assert.equal(graph.calls.length, 2)
})

test("cap: reminders beyond the monthly limit are skipped, not sent", async () => {
  process.env.WHATSAPP_MONTHLY_LIMIT_REMINDER = "3"
  for (let i = 0; i < 3; i += 1) {
    const customer = await createUser()
    await withTransaction(async client => queueBookingCreatedNotifications(client, await insertBooking({ customer, hoursAhead: 30, db: client })))
  }
  await makeAllDue()
  await runWhatsAppOutboxOnce()
  assert.equal(sentTemplates().length, 3)
  const skipped = await messages("status = 'SKIPPED'")
  assert.equal(skipped.length, 3)
  assert.ok(skipped.every(r => r.last_error_code === "MONTHLY_LIMIT"))
  const report = await budgetReport(whatsappConfig())
  assert.deepEqual(report.REMINDER, { limit: 3, used: 3, remaining: 0 })
})

test("cap: welcome limit 0 switches welcomes off entirely", async () => {
  process.env.WHATSAPP_MONTHLY_LIMIT_WELCOME = "0"
  await queueWelcomeMessage(pool, await createUser())
  assert.equal((await messages()).length, 0)
})

test("cap: an offer campaign is sized to the remaining monthly offer budget", async () => {
  process.env.WHATSAPP_MONTHLY_LIMIT_OFFER = "2"
  for (let i = 0; i < 4; i += 1) {
    const user = await createUser()
    await setMarketingPreference({ phone: user.phone, userId: user.id, optIn: true, source: "TEST" })
  }
  const offerId = randomUUID()
  await pool.query(`INSERT INTO offer_global_discounts (id, discount_percent, end_at, is_enabled) VALUES ($1, 10, NOW() + interval '5 days', TRUE)`, [offerId])
  const first = await createOfferCampaign({ offerType: "GLOBAL", offerId, idempotencyKey: "budget-key-0001" })
  assert.equal(first.stats.recipients, 2)
  assert.equal(first.monthlyOfferBudgetLeft, 0)
  await assert.rejects(createOfferCampaign({ offerType: "GLOBAL", offerId, idempotencyKey: "budget-key-0002" }), /limit is used up/)
})

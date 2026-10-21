import { graph, sentTemplates } from "./setup.js"
import test from "node:test"
import assert from "node:assert/strict"
import { createHmac, randomUUID } from "node:crypto"
import express from "express"
import cookieParser from "cookie-parser"
import { createUser, insertBooking, makeAllDue, messages, pool, prepareDatabase, resetData } from "./fixtures.js"
import authRoutes from "../../src/routes/auth.js"
import { handleWebhookEvent, handleWebhookVerification } from "../../src/whatsapp/webhook.js"
import { createOfferCampaign, getCampaignStats, setMarketingPreference } from "../../src/whatsapp/campaigns.js"
import { queueBookingCreatedNotifications } from "../../src/whatsapp/notifications.js"
import { runWhatsAppOutboxOnce } from "../../src/whatsapp/outbox.js"
import { withTransaction } from "../../src/bookings/repository.js"

let server
let base
test.before(async () => {
  await prepareDatabase()
  const app = express()
  app.get("/api/whatsapp/webhook", handleWebhookVerification)
  app.post("/api/whatsapp/webhook", express.raw({ type: "*/*", limit: "1mb" }), handleWebhookEvent)
  app.use(express.json())
  app.use(cookieParser())
  app.use("/api/auth", authRoutes)
  await new Promise(resolve => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => {
  await new Promise(resolve => server.close(resolve))
  await pool.end()
})
test.beforeEach(async () => {
  graph.reset()
  await resetData()
})

const sign = body => `sha256=${createHmac("sha256", "test-app-secret").update(body).digest("hex")}`
async function postWebhook(payload, { signature, raw } = {}) {
  const body = raw ?? JSON.stringify(payload)
  return fetch(`${base}/api/whatsapp/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature ?? sign(body) },
    body,
  })
}
const statusPayload = (id, status, timestamp, extra = {}) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { metadata: { phone_number_id: "109876543210987" }, statuses: [{ id, status, timestamp: `${timestamp}`, recipient_id: "919876543210", ...extra }] } }] }],
})
const inboundPayload = (from, text, id = `wamid.IN${randomUUID()}`) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { metadata: { phone_number_id: "109876543210987" }, messages: [{ id, from, type: "text", text: { body: text }, timestamp: "1700000000" }] } }] }],
})

async function sentBookingMessage() {
  const customer = await createUser()
  await withTransaction(async client => queueBookingCreatedNotifications(client, await insertBooking({ customer, hoursAhead: 30, db: client })))
  await runWhatsAppOutboxOnce()
  const [row] = await messages("kind = 'BOOKING_CONFIRMED'")
  return row
}

// --- webhook verification -----------------------------------------------------------

test("webhook: verification challenge is echoed for the right token only", async () => {
  const ok = await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token-0123456789&hub.challenge=1158201444`)
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), "1158201444")
  const bad = await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)
  assert.equal(bad.status, 403)
})

test("webhook: invalid or missing signature is rejected", async () => {
  assert.equal((await postWebhook(statusPayload("x", "sent", 1), { signature: "sha256=deadbeef" })).status, 401)
  assert.equal((await postWebhook(statusPayload("x", "sent", 1), { signature: "" })).status, 401)
})

test("webhook: malformed JSON is a 400, not a crash; unknown shapes are acknowledged", async () => {
  assert.equal((await postWebhook(null, { raw: "{not json" })).status, 400)
  assert.equal((await postWebhook({ object: "page", entry: "nope" })).status, 200)
  assert.equal((await postWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { statuses: [{}], messages: [null] } }] }] })).status, 200)
})

test("webhook: delivered/read progress, duplicates are idempotent, out-of-order never regresses", async () => {
  const row = await sentBookingMessage()
  assert.equal(row.status, "SENT")
  const id = row.wa_message_id
  assert.equal((await postWebhook(statusPayload(id, "read", 1700000300))).status, 200)
  assert.equal((await postWebhook(statusPayload(id, "delivered", 1700000200))).status, 200) // late
  assert.equal((await postWebhook(statusPayload(id, "read", 1700000300))).status, 200) // duplicate
  assert.equal((await postWebhook(statusPayload(id, "sent", 1700000100))).status, 200) // late
  const [after] = await messages("id = $1", [row.id])
  assert.equal(after.status, "READ")
  assert.ok(after.read_at)
  assert.ok(after.delivered_at, "delivered_at filled when read arrives first")
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM whatsapp_webhook_events")
  assert.equal(rows[0].n, 3)
})

test("webhook: failed status is recorded with Meta's error code", async () => {
  const row = await sentBookingMessage()
  await postWebhook(statusPayload(row.wa_message_id, "failed", 1700000100, { errors: [{ code: 131026, title: "Message undeliverable" }] }))
  const [after] = await messages("id = $1", [row.id])
  assert.equal(after.status, "FAILED")
  assert.equal(after.last_error_code, "131026")
  assert.ok(after.failed_at)
})

test("webhook: STOP opts the customer out, cancels queued promotions and acknowledges once", async () => {
  const user = await createUser()
  await setMarketingPreference({ phone: user.phone, userId: user.id, optIn: true, source: "TEST" })
  const id = "wamid.STOP1"
  await postWebhook(inboundPayload(user.phone.slice(1), "stop", id))
  await postWebhook(inboundPayload(user.phone.slice(1), "stop", id)) // redelivery
  const { rows } = await pool.query("SELECT marketing_opt_in, marketing_opt_out_at FROM whatsapp_contacts WHERE phone = $1", [user.phone])
  assert.equal(rows[0].marketing_opt_in, false)
  assert.ok(rows[0].marketing_opt_out_at)
  const replies = await messages("kind = 'SERVICE_REPLY'")
  assert.equal(replies.length, 1)
  await runWhatsAppOutboxOnce()
  assert.equal(graph.calls.length, 1)
  assert.equal(graph.calls[0].body.type, "text")
})

// --- marketing ----------------------------------------------------------------------

async function createGlobalOffer({ percent = 20, enabled = true, endInDays = 7 } = {}) {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO offer_global_discounts (id, discount_percent, start_at, end_at, is_enabled) VALUES ($1, $2, NOW() - interval '1 day', NOW() + make_interval(days => $3), $4)`,
    [id, percent, endInDays, enabled]
  )
  return id
}

test("marketing: only opted-in, not opted-out, active customers are targeted", async () => {
  const optedIn = await createUser({ name: "Opted In" })
  const optedOut = await createUser({ name: "Opted Out" })
  const never = await createUser({ name: "Never Asked" })
  const staff = await createUser({ role: "STAFF" })
  await setMarketingPreference({ phone: optedIn.phone, userId: optedIn.id, optIn: true, source: "TEST" })
  await setMarketingPreference({ phone: optedOut.phone, userId: optedOut.id, optIn: true, source: "TEST" })
  await setMarketingPreference({ phone: optedOut.phone, userId: optedOut.id, optIn: false, source: "TEST" })
  await setMarketingPreference({ phone: staff.phone, userId: staff.id, optIn: true, source: "TEST" })
  const offerId = await createGlobalOffer({ percent: 15 })
  const result = await createOfferCampaign({ offerType: "GLOBAL", offerId, idempotencyKey: "campaign-test-0001", actorUserId: null })
  assert.equal(result.stats.recipients, 1)
  const queued = await messages("kind = 'OFFER'")
  assert.deepEqual(queued.map(r => r.user_id), [optedIn.id])
  assert.ok(!queued.some(r => r.user_id === never.id))
  await runWhatsAppOutboxOnce()
  assert.deepEqual(sentTemplates(), ["sahasra_offer"])
  const params = graph.calls[0].body.template.components[0].parameters.map(p => p.text)
  assert.equal(params[0], "Opted")
  assert.equal(params[1], "15% off all services", "text comes from the offer row itself")
})

test("marketing: duplicate campaign requests and repeat campaigns for the same offer send once", async () => {
  const user = await createUser()
  await setMarketingPreference({ phone: user.phone, userId: user.id, optIn: true, source: "TEST" })
  const offerId = await createGlobalOffer()
  const first = await createOfferCampaign({ offerType: "GLOBAL", offerId, idempotencyKey: "dup-key-0000001" })
  const retry = await createOfferCampaign({ offerType: "GLOBAL", offerId, idempotencyKey: "dup-key-0000001" })
  assert.equal(retry.duplicateRequest, true)
  assert.equal(retry.campaign.id, first.campaign.id)
  const second = await createOfferCampaign({ offerType: "GLOBAL", offerId, idempotencyKey: "dup-key-0000002" })
  assert.equal(second.stats.recipients, 0, "same customer is not sent the same offer again")
  await runWhatsAppOutboxOnce()
  assert.equal(graph.calls.length, 1)
  const stats = await getCampaignStats(first.campaign.id)
  assert.equal(stats.stats.sent, 1)
})

test("marketing: expired or disabled offers cannot be sent", async () => {
  const expired = randomUUID()
  await pool.query(`INSERT INTO offer_global_discounts (id, discount_percent, start_at, end_at, is_enabled) VALUES ($1, 10, NOW() - interval '10 days', NOW() - interval '1 day', TRUE)`, [expired])
  await assert.rejects(createOfferCampaign({ offerType: "GLOBAL", offerId: expired, idempotencyKey: "expired-key-01" }), /ended/)
  const disabled = await createGlobalOffer({ enabled: false })
  await assert.rejects(createOfferCampaign({ offerType: "GLOBAL", offerId: disabled, idempotencyKey: "disabled-key-01" }), /switched off/)
})

test("marketing: an offer edited or opted-out after queueing is not sent", async () => {
  const a = await createUser()
  const b = await createUser()
  for (const user of [a, b]) await setMarketingPreference({ phone: user.phone, userId: user.id, optIn: true, source: "TEST" })
  const offerId = await createGlobalOffer({ percent: 30 })
  const { campaign } = await createOfferCampaign({ offerType: "GLOBAL", offerId, idempotencyKey: "edit-key-000001" })
  await setMarketingPreference({ phone: b.phone, userId: b.id, optIn: false, source: "TEST" })
  await pool.query("UPDATE offer_global_discounts SET discount_percent = 10 WHERE id = $1", [offerId])
  await runWhatsAppOutboxOnce()
  assert.equal(graph.calls.length, 0, "advertised 30% no longer matches the offer")
  const stats = await getCampaignStats(campaign.id)
  assert.equal(stats.stats.optedOut, 1)
  assert.equal(stats.stats.skipped + stats.stats.pending + stats.stats.failed, 2)
})

// --- auth routes --------------------------------------------------------------------

async function postJson(path, body) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => ({})), headers: response.headers }
}
const lastCode = () => graph.calls.at(-1).body.template.components[0].parameters[0].text

test("routes: login OTP for an existing customer signs in with a cookie and sends no welcome", async () => {
  const user = await createUser()
  const national = user.phone.slice(3)
  const requested = await postJson("/api/auth/whatsapp-otp/request", { phone: national, purpose: "LOGIN" })
  assert.equal(requested.status, 200)
  assert.equal(requested.body.phone, user.phone)
  const wrong = await postJson("/api/auth/whatsapp-otp/verify", { phone: national, purpose: "LOGIN", code: lastCode() === "000000" ? "111111" : "000000" })
  assert.equal(wrong.status, 400)
  assert.equal(wrong.body.error, "OTP_INVALID")
  const verified = await postJson("/api/auth/whatsapp-otp/verify", { phone: national, purpose: "LOGIN", code: lastCode() })
  assert.equal(verified.status, 200)
  assert.equal(verified.body.user.id, user.id)
  assert.match(verified.headers.get("set-cookie") ?? "", /app_access_token=/)
  assert.equal((await messages("kind = 'WELCOME'")).length, 0)
  const replay = await postJson("/api/auth/whatsapp-otp/verify", { phone: national, purpose: "LOGIN", code: lastCode() })
  assert.equal(replay.status, 400, "a code cannot sign in twice")
})

test("routes: login OTP for an unknown number is refused before any message is sent", async () => {
  const response = await postJson("/api/auth/whatsapp-otp/request", { phone: "9123456789", purpose: "LOGIN" })
  assert.equal(response.status, 404)
  assert.equal(response.body.error, "ACCOUNT_NOT_FOUND")
  assert.equal(graph.calls.length, 0)
})

test("routes: signup OTP refuses registered numbers and returns a proof for new ones", async () => {
  const user = await createUser()
  const taken = await postJson("/api/auth/whatsapp-otp/request", { phone: user.phone, purpose: "SIGNUP" })
  assert.equal(taken.status, 409)
  const fresh = "+919000012345"
  assert.equal((await postJson("/api/auth/whatsapp-otp/request", { phone: fresh, purpose: "SIGNUP" })).status, 200)
  const verified = await postJson("/api/auth/whatsapp-otp/verify", { phone: fresh, purpose: "SIGNUP", code: lastCode() })
  assert.equal(verified.status, 200)
  assert.ok(verified.body.phoneProof)
  assert.equal(verified.headers.get("set-cookie"), null, "signup verification does not create a session")
})

test("routes: invalid input and bad purpose are 400s", async () => {
  assert.equal((await postJson("/api/auth/whatsapp-otp/request", { phone: "12", purpose: "LOGIN" })).status, 400)
  assert.equal((await postJson("/api/auth/whatsapp-otp/request", { phone: "9876543210", purpose: "ADMIN" })).status, 400)
  assert.equal((await postJson("/api/auth/whatsapp-otp/request", { phone: "+14155552671", purpose: "SIGNUP" })).body.error, "PHONE_COUNTRY_NOT_SUPPORTED")
})

test("routes: staff WhatsApp verification issues the password-setup token", async () => {
  const staff = await createUser({ role: "STAFF", status: "PENDING_OTP" })
  assert.equal((await postJson("/api/auth/staff/whatsapp-otp/request", { phone: staff.phone })).status, 200)
  const verified = await postJson("/api/auth/staff/whatsapp-otp/verify", { phone: staff.phone, code: lastCode() })
  assert.equal(verified.status, 200)
  assert.ok(verified.body.setupToken)
  const customer = await createUser()
  assert.equal((await postJson("/api/auth/staff/whatsapp-otp/request", { phone: customer.phone })).status, 404)
})

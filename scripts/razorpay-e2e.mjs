/**
 * Razorpay flow end-to-end test (TEST MODE keys only).
 *
 * Run from `bn/`:   node scripts/razorpay-e2e.mjs
 *
 * What it does
 *  - refuses to run unless RAZORPAY_KEY_ID is an rzp_test_ key
 *  - starts its own backend on port 18082 (stdout captured so it can scan the logs for secrets)
 *  - creates a throwaway customer, creates REAL Razorpay test orders through the API, and drives
 *    the HTTP endpoints exactly as the browser does
 *  - Razorpay webhooks are *simulated*: it builds the same JSON Razorpay sends and signs it with
 *    RAZORPAY_WEBHOOK_SECRET, so signature checking, idempotency and settlement are real, but
 *    the delivery is not from Razorpay's servers
 *  - real card/UPI payments cannot be made without the Checkout UI (see scripts/checkout-harness.*)
 *  - deletes everything it created
 */
import "dotenv/config"
import { spawn } from "node:child_process"
import { createHmac, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { v4 as uuid } from "uuid"

const KEY_ID = process.env.RAZORPAY_KEY_ID ?? ""
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? ""
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? ""
if (!KEY_ID.startsWith("rzp_test_")) {
  console.error("Refusing to run: RAZORPAY_KEY_ID is not a rzp_test_ key.")
  process.exit(2)
}
if (!WEBHOOK_SECRET) {
  console.error("RAZORPAY_WEBHOOK_SECRET is not set.")
  process.exit(2)
}

const PORT = 18082
const BASE = `http://127.0.0.1:${PORT}`
const { pool } = await import("../src/lib/db-pool.js")
const { signStaffAccessToken } = await import("../src/lib/tokens.js")

// ---- tiny test framework -------------------------------------------------------------------
const results = []
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const q = async (sql, params = []) => (await pool.query(sql, params)).rows

// ---- server ---------------------------------------------------------------------------------
mkdirSync("scripts/.out", { recursive: true })
const serverLogPath = "scripts/.out/server.log"
let serverLog = ""
const server = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), RAZORPAY_SWEEP_INTERVAL_MS: "3600000", RATE_PAYMENT_CREATE_MAX: "1000", RATE_PAYMENT_STATUS_MAX: "5000" },
  stdio: ["ignore", "pipe", "pipe"],
})
server.stdout.on("data", chunk => (serverLog += chunk))
server.stderr.on("data", chunk => (serverLog += chunk))
for (let i = 0; i < 80 && !serverLog.includes("Backend listening"); i += 1) await sleep(250)
if (!serverLog.includes("Backend listening")) {
  console.error("server did not start\n", serverLog)
  process.exit(2)
}
await sleep(1500) // let schema bootstrap finish

// ---- fixtures -------------------------------------------------------------------------------
const created = { userIds: [], orderIds: [] }
async function makeUser(label) {
  const id = uuid()
  const tag = randomBytes(3).toString("hex")
  await pool.query(
    `INSERT INTO users (id, name, email, phone, role, gender, latitude, longitude, email_verified, account_status)
     VALUES ($1, $2, $3, $4, 'USER', 'MALE', 0, 0, TRUE, 'ACTIVE')`,
    [id, `RZP Test ${label}`, `rzp-test-${tag}@example.test`, `+9199${Math.floor(10000000 + Math.random() * 89999999)}`]
  )
  created.userIds.push(id)
  return { id, cookie: `app_access_token=${await signStaffAccessToken(id)}` }
}

async function api(method, path, { user, body, headers = {}, raw } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...(user ? { Cookie: user.cookie } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: response.status, json, text }
}

function sign(rawBody) {
  return createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex")
}
function checkoutSignature(orderId, paymentId, secret = KEY_SECRET) {
  return createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex")
}

let eventCounter = 0
async function webhook(event, { orderId, paymentId, status, amount, eventId, badSignature = false, errorCode, method = "upi", extra = {} }) {
  eventCounter += 1
  const entity = {
    id: paymentId,
    entity: "payment",
    amount,
    currency: "INR",
    status,
    order_id: orderId,
    method,
    captured: status === "captured",
    vpa: "someone@okbank", // present on real UPI payloads: must NOT be stored
    email: "customer@example.test",
    contact: "+919999999999",
    ...(errorCode ? { error_code: errorCode, error_description: "Payment failed (test)", error_source: "customer", error_step: "payment_authentication", error_reason: "payment_failed" } : {}),
    ...extra,
  }
  const raw = JSON.stringify({ entity: "event", account_id: "acc_test", event, contains: ["payment"], payload: { payment: { entity } }, created_at: Math.floor(Date.now() / 1000) })
  return api("POST", "/api/payments/razorpay/webhook", {
    raw,
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-event-id": eventId ?? `evt_test_${Date.now()}_${eventCounter}`,
      "x-razorpay-signature": badSignature ? "0".repeat(64) : sign(raw),
    },
  })
}

const fakePaymentId = () => `pay_TEST${randomBytes(7).toString("hex")}`
const row = async orderId => (await q(`SELECT * FROM razorpay_payments WHERE razorpay_order_id = $1`, [orderId]))[0]
const events = async orderId => (await q(`SELECT e.event_type, e.source FROM razorpay_payment_events e JOIN razorpay_payments p ON p.id = e.payment_id WHERE p.razorpay_order_id = $1 ORDER BY e.id`, [orderId])).map(e => e.event_type)
const bookingCount = async userId => Number((await q(`SELECT COUNT(*) n FROM bookings WHERE created_by = $1`, [userId]))[0].n)
const ledgerCount = async userId => Number((await q(`SELECT COUNT(*) n FROM payment_transactions WHERE booking_id IN (SELECT id FROM bookings WHERE created_by = $1)`, [userId]))[0].n)

try {
  const alice = await makeUser("alice")
  const bob = await makeUser("bob")
  const adminRow = (await q(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`))[0]
  const admin = adminRow ? { id: adminRow.id, cookie: `app_access_token=${await signStaffAccessToken(adminRow.id)}` } : null

  // Pick a service the test user can book, and distinct free slots (tomorrow, so they are in the future).
  const [service] = await q(`SELECT id, name, base_price FROM service_catalog WHERE is_active AND target_gender IN ('MEN','UNISEX') AND base_price BETWEEN 50 AND 500 ORDER BY base_price LIMIT 1`)
  const salonDay = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10)
  const slotResponse = await api("GET", `/api/customer/slots?serviceIds=${service.id}&date=${salonDay}`, { user: alice })
  const slots = (slotResponse.json?.slots ?? []).filter(s => s.stylists?.length)
  const pickSlot = index => ({ startsAt: slots[index].startsAt, stylistId: slots[index].stylists[0].id })
  check("setup: have enough free slots to test with", slots.length >= 14, `slots=${slots.length}`)
  const stylistId = slots[0].stylists[0].id
  const body = index => ({ serviceIds: [service.id], ...pickSlot(index) })
  // A brand-new customer gets the first-booking discount; once they have a booking it is gone.
  // Both numbers come from the database, not from the code under test.
  const { getLoyaltySettings } = await import("../src/loyalty/service.js")
  const firstPct = Number((await getLoyaltySettings()).firstBookingDiscountPercent ?? 0)
  const fullPaise = Math.round(Number(service.base_price) * 100)
  const expectedPaise = Math.round(fullPaise * (1 - firstPct / 100)) // alice, before her first booking

  // ===== A. order creation ===================================================================
  const tampered = { ...body(0), amount: 1, payableAmount: 1, totalAmount: 1, amountPaise: 100 }
  const o1 = await api("POST", "/api/payments/razorpay/orders", { user: alice, body: tampered })
  created.orderIds.push(o1.json?.orderId)
  check("A1 order created via backend (201, order_ id, public key id returned)", o1.status === 201 && /^order_/.test(o1.json?.orderId) && o1.json?.keyId === KEY_ID, JSON.stringify(o1.json)?.slice(0, 200))
  check("A2 amount comes from server price, client-sent amount ignored", o1.json?.amount === expectedPaise && o1.json?.currency === "INR", `got ${o1.json?.amount}, want ${expectedPaise}`)
  check("A3 response never contains the secret", !o1.text.includes(KEY_SECRET) && !o1.text.includes(WEBHOOK_SECRET))
  const r1 = await row(o1.json.orderId)
  check("A4 DB row: user, amount, INR, order id, status CREATED, no booking", r1 && r1.user_id === alice.id && Number(r1.amount_paise) === expectedPaise && r1.currency === "INR" && r1.status === "CREATED" && r1.booking_id === null && r1.fulfillment === "NONE")
  check("A5 lifecycle journal: CHECKOUT_STARTED -> ORDER_CREATED", JSON.stringify(await events(o1.json.orderId)) === JSON.stringify(["CHECKOUT_STARTED", "ORDER_CREATED"]), JSON.stringify(await events(o1.json.orderId)))
  const gwOrder = await (await fetch(`https://api.razorpay.com/v1/orders/${o1.json.orderId}`, { headers: { Authorization: `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")}` } })).json()
  check("A6 Razorpay really has this order: same amount, INR, status created", gwOrder.amount === expectedPaise && gwOrder.currency === "INR" && gwOrder.status === "created", JSON.stringify(gwOrder).slice(0, 150))
  check("A7 no booking exists yet (booking is not created at order time)", (await bookingCount(alice.id)) === 0)

  const dup = await api("POST", "/api/payments/razorpay/orders", { user: alice, body: body(0) })
  check("A8 duplicate Pay click returns the SAME open order (no second order)", dup.json?.orderId === o1.json.orderId && dup.json?.reused === true, JSON.stringify(dup.json)?.slice(0, 150))
  const burst = await Promise.all(Array.from({ length: 6 }, () => api("POST", "/api/payments/razorpay/orders", { user: alice, body: body(1) })))
  const burstOrders = new Set(burst.map(b => b.json?.orderId))
  burst.forEach(b => created.orderIds.push(b.json?.orderId))
  const burstRows = await q(`SELECT COUNT(*) n FROM razorpay_payments WHERE user_id = $1 AND request_payload->>'startsAt' = $2`, [alice.id, slots[1].startsAt])
  check("A9 6 simultaneous Pay requests -> exactly 1 order / 1 DB row", burstOrders.size === 1 && Number(burstRows[0].n) === 1 && burst.every(b => [200, 201].includes(b.status)), `orders=${burstOrders.size} rows=${burstRows[0].n} statuses=${burst.map(b => b.status)}`)
  const legacy = await api("POST", "/api/customer/bookings", { user: alice, body: body(2) })
  check("A10 old unpaid booking endpoint is refused (402) and creates nothing", legacy.status === 402 && (await bookingCount(alice.id)) === 0, `${legacy.status} ${legacy.text.slice(0, 100)}`)
  const unauth = await api("POST", "/api/payments/razorpay/orders", { body: body(2) })
  check("A11 order creation requires login (401)", unauth.status === 401)
  const noServices = await api("POST", "/api/payments/razorpay/orders", { user: alice, body: { stylistId, startsAt: slots[2].startsAt } })
  check("A12 invalid request rejected (400)", noServices.status === 400)

  // ===== B. checkout opened / status / ownership ============================================
  const opened1 = await api("POST", `/api/payments/razorpay/${o1.json.orderId}/opened`, { user: alice })
  await api("POST", `/api/payments/razorpay/${o1.json.orderId}/opened`, { user: alice })
  check("B1 checkout-opened recorded once (CHECKOUT_OPENED event, timestamp set)", opened1.status === 200 && (await events(o1.json.orderId)).filter(e => e === "CHECKOUT_OPENED").length === 1 && (await row(o1.json.orderId)).checkout_opened_at)
  const st = await api("GET", `/api/payments/razorpay/${o1.json.orderId}/status`, { user: alice })
  check("B2 status API (owner): AWAITING_PAYMENT, no booking, no gateway internals", st.status === 200 && st.json?.state === "AWAITING_PAYMENT" && !st.json?.bookingId && !("failureReason" in st.json) && !st.text.includes("razorpay_payment_id"), st.text.slice(0, 200))
  const stOther = await api("GET", `/api/payments/razorpay/${o1.json.orderId}/status`, { user: bob })
  check("B3 another customer cannot read this payment (404)", stOther.status === 404)
  check("B4 status needs login (401) and bad ids are rejected (400)", (await api("GET", `/api/payments/razorpay/${o1.json.orderId}/status`)).status === 401 && (await api("GET", `/api/payments/razorpay/order_x'%20OR%201=1--/status`, { user: alice })).status === 400)
  check("B5 unknown order id -> 404", (await api("GET", `/api/payments/razorpay/order_DoesNotExist12345/status`, { user: alice })).status === 404)

  // ===== C. verify endpoint: invalid inputs ==================================================
  const badSig = await api("POST", "/api/payments/razorpay/verify", { user: alice, body: { razorpay_order_id: o1.json.orderId, razorpay_payment_id: fakePaymentId(), razorpay_signature: "a".repeat(64) } })
  const afterBad = await row(o1.json.orderId)
  check("C1 invalid signature -> 400, payment stays CREATED, no booking", badSig.status === 400 && afterBad.status === "CREATED" && (await bookingCount(alice.id)) === 0, `${badSig.status} ${badSig.text.slice(0, 120)}`)
  check("C2 invalid signature is journaled (SIGNATURE_INVALID)", (await events(o1.json.orderId)).includes("SIGNATURE_INVALID"))
  const wrongOrderSig = await api("POST", "/api/payments/razorpay/verify", { user: alice, body: { razorpay_order_id: "order_Unknown1234567", razorpay_payment_id: fakePaymentId(), razorpay_signature: "b".repeat(64) } })
  check("C3 unknown order id -> 404", wrongOrderSig.status === 404)
  const pid = fakePaymentId()
  const crossUser = await api("POST", "/api/payments/razorpay/verify", { user: bob, body: { razorpay_order_id: o1.json.orderId, razorpay_payment_id: pid, razorpay_signature: checkoutSignature(o1.json.orderId, pid) } })
  check("C4 someone else's order cannot be verified/confirmed (404)", crossUser.status === 404 && (await row(o1.json.orderId)).status === "CREATED")
  const malformed = await api("POST", "/api/payments/razorpay/verify", { user: alice, body: { razorpay_order_id: o1.json.orderId } })
  check("C5 missing fields -> 400", malformed.status === 400)
  const wrongSecretSig = await api("POST", "/api/payments/razorpay/verify", { user: alice, body: { razorpay_order_id: o1.json.orderId, razorpay_payment_id: pid, razorpay_signature: checkoutSignature(o1.json.orderId, pid, "not-the-secret") } })
  check("C6 signature made with the wrong secret is rejected (400)", wrongSecretSig.status === 400)
  const validSigFakePayment = await api("POST", "/api/payments/razorpay/verify", { user: alice, body: { razorpay_order_id: o1.json.orderId, razorpay_payment_id: pid, razorpay_signature: checkoutSignature(o1.json.orderId, pid) } })
  check("C7 valid signature but Razorpay has no such payment -> NOT confirmed (booking count 0)", (await bookingCount(alice.id)) === 0 && validSigFakePayment.json?.state !== "CONFIRMED", `${validSigFakePayment.status} ${validSigFakePayment.text.slice(0, 150)}`)

  // ===== D. webhook verification & idempotency ==============================================
  const failPid = fakePaymentId()
  const badHook = await webhook("payment.failed", { orderId: o1.json.orderId, paymentId: failPid, status: "failed", amount: expectedPaise, badSignature: true, errorCode: "BAD_REQUEST_ERROR" })
  check("D1 webhook with bad signature -> 400 and nothing changes", badHook.status === 400 && (await row(o1.json.orderId)).status !== "FAILED")
  const noSigHook = await api("POST", "/api/payments/razorpay/webhook", { raw: "{}", headers: { "Content-Type": "application/json" } })
  check("D2 webhook with no signature -> 400", noSigHook.status === 400)
  const failEvent = `evt_fail_${Date.now()}`
  const fh1 = await webhook("payment.failed", { orderId: o1.json.orderId, paymentId: failPid, status: "failed", amount: expectedPaise, eventId: failEvent, errorCode: "BAD_REQUEST_ERROR" })
  const rf = await row(o1.json.orderId)
  check("D3 payment.failed webhook -> status FAILED, failure code/reason/step stored, method stored, no booking", fh1.status === 200 && rf.status === "FAILED" && rf.failure_code === "BAD_REQUEST_ERROR" && rf.failure_reason && rf.failure_step === "payment_authentication" && rf.payment_method === "upi" && !rf.booking_id)
  const fh2 = await webhook("payment.failed", { orderId: o1.json.orderId, paymentId: failPid, status: "failed", amount: expectedPaise, eventId: failEvent, errorCode: "BAD_REQUEST_ERROR" })
  const wh = (await q(`SELECT attempts, result, summary FROM razorpay_webhook_events WHERE event_id = $1`, [failEvent]))[0]
  check("D4 same webhook delivered twice -> 2nd is a no-op (duplicate), one PAYMENT_FAILED journal entry", fh2.json?.duplicate === true && Number(wh.attempts) === 2 && (await events(o1.json.orderId)).filter(e => e === "PAYMENT_FAILED").length === 1)
  check("D5 webhook log stores a summary only: no vpa / email / contact", !JSON.stringify(wh.summary).match(/someone@okbank|customer@example|9999999999/))
  const stFailed = await api("GET", `/api/payments/razorpay/${o1.json.orderId}/status`, { user: alice })
  check("D6 status API says FAILED with a safe message (no raw gateway text)", stFailed.json?.state === "FAILED" && !stFailed.text.includes("Payment failed (test)"))
  const unknownHook = await webhook("payment.captured", { orderId: "order_NotOursAtAll123", paymentId: fakePaymentId(), status: "captured", amount: 5000 })
  check("D7 webhook for an order that is not ours -> 200, ignored", unknownHook.status === 200 && unknownHook.json?.result === "UNKNOWN_ORDER")
  const otherEvent = await webhook("payment.dispute.created", { orderId: o1.json.orderId, paymentId: fakePaymentId(), status: "captured", amount: expectedPaise })
  check("D8 unrelated event type -> 200, ignored", otherEvent.status === 200 && otherEvent.json?.result === "IGNORED_EVENT_TYPE")

  // retry after failure on the same order: pending -> success
  const authPid = fakePaymentId()
  await webhook("payment.authorized", { orderId: o1.json.orderId, paymentId: authPid, status: "authorized", amount: expectedPaise })
  const rAuth = await row(o1.json.orderId)
  check("D9 payment.authorized -> PENDING (not paid, no booking); capture attempt on a non-existent payment does not confirm", rAuth.status === "PENDING" && !rAuth.booking_id && (await bookingCount(alice.id)) === 0, rAuth.status)

  // ===== E. mismatch / success / duplicates / replays =======================================
  const mism = await webhook("payment.captured", { orderId: o1.json.orderId, paymentId: authPid, status: "captured", amount: expectedPaise - 100 })
  check("E1 captured webhook with the wrong amount -> MISMATCH, nothing confirmed", mism.json?.result === "MISMATCH" && (await bookingCount(alice.id)) === 0 && (await row(o1.json.orderId)).status !== "SUCCESS")
  const wrongCur = await webhook("payment.captured", { orderId: o1.json.orderId, paymentId: authPid, status: "captured", amount: expectedPaise, extra: { currency: "USD" } })
  check("E2 captured webhook in the wrong currency -> MISMATCH", wrongCur.json?.result === "MISMATCH" && (await bookingCount(alice.id)) === 0)

  const capEvent = `evt_cap_${Date.now()}`
  const cap1 = await webhook("payment.captured", { orderId: o1.json.orderId, paymentId: authPid, status: "captured", amount: expectedPaise, eventId: capEvent })
  const rOk = await row(o1.json.orderId)
  const bk = (await q(`SELECT id, status, payable_amount, stylist_id FROM bookings WHERE created_by = $1`, [alice.id]))
  const ledger = await q(`SELECT amount, payment_mode, source_type FROM payment_transactions WHERE booking_id = $1`, [bk[0]?.id])
  check("E3 captured webhook -> payment SUCCESS + BOOKED, booking CONFIRMED, correct amount", cap1.status === 200 && rOk.status === "SUCCESS" && rOk.fulfillment === "BOOKED" && bk.length === 1 && bk[0].status === "CONFIRMED" && Number(bk[0].payable_amount) === expectedPaise / 100 && rOk.booking_id === bk[0].id && rOk.razorpay_payment_id === authPid && rOk.verified_via === "WEBHOOK", JSON.stringify({ r: rOk.status, f: rOk.fulfillment, b: bk.length }))
  check("E4 exactly one ledger row (ONLINE, right amount) linked to the payment", ledger.length === 1 && Number(ledger[0].amount) === expectedPaise / 100 && ledger[0].payment_mode === "ONLINE" && rOk.payment_transaction_id)
  check("E5 journal shows the full lifecycle", JSON.stringify(await events(o1.json.orderId)).includes("PAYMENT_CAPTURED") && (await events(o1.json.orderId)).includes("BOOKING_CONFIRMED"))
  const cap2 = await webhook("payment.captured", { orderId: o1.json.orderId, paymentId: authPid, status: "captured", amount: expectedPaise, eventId: capEvent })
  const cap3 = await webhook("payment.captured", { orderId: o1.json.orderId, paymentId: authPid, status: "captured", amount: expectedPaise }) // new event id, same payment
  const orderPaid = await webhook("order.paid", { orderId: o1.json.orderId, paymentId: authPid, status: "captured", amount: expectedPaise })
  check("E6 duplicate / redelivered / order.paid webhooks -> still exactly 1 booking and 1 ledger row", cap2.json?.duplicate === true && cap3.json?.result === "ALREADY_SETTLED" && orderPaid.json?.result === "ALREADY_SETTLED" && (await bookingCount(alice.id)) === 1 && (await ledgerCount(alice.id)) === 1)
  await webhook("payment.failed", { orderId: o1.json.orderId, paymentId: fakePaymentId(), status: "failed", amount: expectedPaise, errorCode: "BAD_REQUEST_ERROR" })
  check("E7 a late 'payment.failed' for an older attempt never un-confirms a paid booking", (await row(o1.json.orderId)).status === "SUCCESS" && (await bookingCount(alice.id)) === 1)
  const stOk = await api("GET", `/api/payments/razorpay/${o1.json.orderId}/status`, { user: alice })
  check("E8 status API: CONFIRMED with booking summary (page refresh after payment shows the same)", stOk.json?.state === "CONFIRMED" && stOk.json?.booking?.id === bk[0].id && stOk.json?.terminal === true)
  const verifyAgain = await api("POST", "/api/payments/razorpay/verify", { user: alice, body: { razorpay_order_id: o1.json.orderId, razorpay_payment_id: authPid, razorpay_signature: checkoutSignature(o1.json.orderId, authPid) } })
  check("E9 verify replayed after success -> idempotent, no second booking", (await bookingCount(alice.id)) === 1 && (await ledgerCount(alice.id)) === 1, `${verifyAgain.status} ${verifyAgain.text.slice(0, 120)}`)
  const sameSlot = await api("POST", "/api/payments/razorpay/orders", { user: bob, body: body(0) })
  check("E10 the paid slot cannot be sold again (409, stylist unavailable)", sameSlot.status === 409, `${sameSlot.status} ${sameSlot.text.slice(0, 100)}`)
  const sec = await q(`SELECT 1 FROM razorpay_payments WHERE razorpay_order_id = $1 AND (failure_reason ILIKE '%secret%')`, [o1.json.orderId])
  check("E11 nothing secret-like in payment rows", sec.length === 0)

  // ===== F. races ===========================================================================
  const o3 = await api("POST", "/api/payments/razorpay/orders", { user: alice, body: body(3) })
  created.orderIds.push(o3.json.orderId)
  check("F0 after her first booking the first-booking discount no longer applies (server recomputes price)", o3.json?.amount === fullPaise, `${o3.json?.amount} vs ${fullPaise}`)
  const racePid = fakePaymentId()
  const race = await Promise.all([
    ...Array.from({ length: 5 }, () => webhook("payment.captured", { orderId: o3.json.orderId, paymentId: racePid, status: "captured", amount: fullPaise })),
    ...Array.from({ length: 3 }, () => api("GET", `/api/payments/razorpay/${o3.json.orderId}/status`, { user: alice })),
    api("POST", `/api/payments/razorpay/${o3.json.orderId}/client-event`, { user: alice, body: { type: "DISMISSED" } }),
  ])
  const raceBookings = await q(`SELECT COUNT(*) n FROM bookings WHERE created_by = $1 AND starts_at = $2`, [alice.id, slots[3].startsAt])
  const raceLedger = await q(`SELECT COUNT(*) n FROM payment_transactions WHERE booking_id IN (SELECT id FROM bookings WHERE created_by = $1 AND starts_at = $2)`, [alice.id, slots[3].startsAt])
  check("F1 5 concurrent webhooks + status polls + dismiss for one payment -> exactly 1 booking, 1 ledger row", Number(raceBookings[0].n) === 1 && Number(raceLedger[0].n) === 1 && race.slice(0, 5).every(r => r.status === 200), `bookings=${raceBookings[0].n} ledger=${raceLedger[0].n} statuses=${race.map(r => r.status)}`)
  check("F2 a dismiss arriving after payment never cancels a paid order", (await row(o3.json.orderId)).status === "SUCCESS")

  // ===== G. cancel / dismiss / expiry =======================================================
  const o4 = await api("POST", "/api/payments/razorpay/orders", { user: alice, body: body(4) })
  created.orderIds.push(o4.json.orderId)
  await api("POST", `/api/payments/razorpay/${o4.json.orderId}/opened`, { user: alice })
  const dismiss = await api("POST", `/api/payments/razorpay/${o4.json.orderId}/client-event`, { user: alice, body: { type: "DISMISSED" } })
  const r4 = await row(o4.json.orderId)
  check("G1 closing checkout before paying -> CANCELLED, no booking, state reported to the UI", dismiss.json?.state === "CANCELLED" && r4.status === "CANCELLED" && !r4.booking_id && (await events(o4.json.orderId)).includes("CHECKOUT_DISMISSED"))
  const o4b = await api("POST", `/api/payments/razorpay/orders`, { user: alice, body: body(4) })
  created.orderIds.push(o4b.json.orderId)
  check("G2 after cancelling, paying again creates a fresh order", o4b.status === 201 && o4b.json.orderId !== o4.json.orderId)

  const o5 = await api("POST", "/api/payments/razorpay/orders", { user: alice, body: body(5) })
  created.orderIds.push(o5.json.orderId)
  await api("POST", `/api/payments/razorpay/${o5.json.orderId}/opened`, { user: alice })
  await pool.query(`UPDATE razorpay_payments SET expires_at = NOW() - interval '1 minute' WHERE razorpay_order_id = $1`, [o5.json.orderId])
  const { runRazorpaySweep } = await import("../src/payments/service.js")
  await runRazorpaySweep()
  const r5 = await row(o5.json.orderId)
  check("G3 opened-but-never-paid checkout past its TTL -> EXPIRED by the sweep (after asking Razorpay), journaled", r5.status === "EXPIRED" && (await events(o5.json.orderId)).includes("EXPIRED") && r5.checkout_opened_at)
  const lateCap = await webhook("payment.captured", { orderId: o5.json.orderId, paymentId: fakePaymentId(), status: "captured", amount: fullPaise })
  const r5b = await row(o5.json.orderId)
  check("G4 a payment that lands after EXPIRED (e.g. slow UPI) still settles and books", lateCap.json?.result === "BOOKED" && r5b.status === "SUCCESS" && r5b.fulfillment === "BOOKED")

  // ===== H. paid but slot gone -> refund path ================================================
  const o6 = await api("POST", "/api/payments/razorpay/orders", { user: alice, body: body(6) })
  created.orderIds.push(o6.json.orderId)
  // someone else books that stylist/slot while the customer is paying
  await pool.query(
    `INSERT INTO bookings (id, customer_name, service_name, stylist_id, starts_at, duration_minutes, status, created_by) VALUES ($1, 'Walk-in Blocker', 'Blocker', $2, $3, 45, 'CONFIRMED', $4)`,
    [uuid(), slots[6].stylists[0].id, slots[6].startsAt, bob.id]
  )
  const lostPid = fakePaymentId()
  const lost = await webhook("payment.captured", { orderId: o6.json.orderId, paymentId: lostPid, status: "captured", amount: fullPaise })
  const r6 = await row(o6.json.orderId)
  const aliceBookingsForSlot = await q(`SELECT COUNT(*) n FROM bookings WHERE created_by = $1 AND starts_at = $2`, [alice.id, slots[6].startsAt])
  check("H1 paid but slot taken meanwhile -> NO booking, payment kept as SUCCESS + REFUND_PENDING (never silently kept)", r6.status === "SUCCESS" && r6.fulfillment === "REFUND_PENDING" && r6.booking_failure_code === "STYLIST_UNAVAILABLE" && Number(aliceBookingsForSlot[0].n) === 0 && lost.status === 200, `${r6.status}/${r6.fulfillment}/${r6.booking_failure_code}`)
  check("H2 refund attempt was made and journaled (fake payment id so Razorpay rejects it; stays REFUND_PENDING for retry)", (await events(o6.json.orderId)).includes("REFUND_REQUEST_FAILED"))
  const stRef = await api("GET", `/api/payments/razorpay/${o6.json.orderId}/status`, { user: alice })
  check("H3 status API tells the customer: refunding, booking not made", stRef.json?.state === "REFUNDING" && !stRef.json?.bookingId)

  // ===== I. admin funnel ====================================================================
  if (admin) {
    const funnel = await api("GET", "/api/payments/razorpay/admin/funnel?days=1", { user: admin })
    check("I1 admin funnel returns counts incl. abandoned checkouts", funnel.status === 200 && funnel.json?.counts?.checkout_started >= 6 && funnel.json?.counts?.checkout_opened >= 2 && funnel.json?.counts?.abandoned >= 1 && funnel.json?.counts?.booked >= 2, JSON.stringify(funnel.json?.counts))
    check("I2 customers cannot read the admin funnel (403)", (await api("GET", "/api/payments/razorpay/admin/funnel", { user: alice })).status === 403)
  }

  // ===== K. cancellation policy amounts (what gets refunded at the gateway) ==================
  const { computeCancellationRefund } = await import("../src/bookings/cancellation-policy.js")
  const now = new Date("2026-10-02T10:00:00Z")
  const at = minutes => new Date(now.getTime() + minutes * 60000)
  const tier = (minutes, paid = 90) => computeCancellationRefund({ payableAmount: paid, startsAt: at(minutes), now })
  check("K1 24h or more before -> 100% refund", tier(24 * 60).refundPercent === 100 && tier(24 * 60).refundAmount === 90 && tier(26 * 60).refundAmount === 90)
  check("K2 just under 24h -> 50% refund", tier(24 * 60 - 1).refundPercent === 50 && tier(24 * 60 - 1).refundAmount === 45 && tier(60).refundAmount === 45)
  check("K3 31 minutes before -> 50%; 30 minutes or less -> no refund", tier(31).refundPercent === 50 && tier(30).refundAmount === 0 && tier(5).refundAmount === 0)
  check("K4 started/past appointment cannot be cancelled", tier(-1).canCancel === false)
  check("K5 odd amounts round to the paisa (₹33.33 at 50% -> 16.67)", tier(60, 33.33).refundAmount === 16.67)

  // ===== L. receptionist-only cancellation with a chosen refund % ===========================
  const recepId = uuid()
  const recepJti = uuid()
  await pool.query(
    `INSERT INTO users (id, name, email, phone, role, gender, latitude, longitude, email_verified, account_status, staff_session_jti)
     VALUES ($1, 'RZP Test reception', $2, $3, 'RECEPTIONIST', 'FEMALE', 0, 0, TRUE, 'ACTIVE', $4)`,
    [recepId, `rzp-recep-${randomBytes(3).toString("hex")}@example.test`, `+9197${Math.floor(10000000 + Math.random() * 89999999)}`, recepJti]
  )
  created.userIds.push(recepId)
  const recep = { id: recepId, cookie: `staff_access_token=${await signStaffAccessToken(recepId, recepJti)}` }

  async function paidBooking(slotIndex) {
    const order = await api("POST", "/api/payments/razorpay/orders", { user: alice, body: body(slotIndex) })
    if (!order.json?.orderId) throw new Error(`order for slot ${slotIndex} failed: ${order.status} ${order.text.slice(0, 160)}`)
    created.orderIds.push(order.json.orderId)
    await webhook("payment.captured", { orderId: order.json.orderId, paymentId: fakePaymentId(), status: "captured", amount: order.json.amount })
    return { order, bookingId: (await row(order.json.orderId)).booking_id, paise: order.json.amount }
  }
  const pb1 = await paidBooking(9)
  check("L0 setup: a paid online booking exists", Boolean(pb1.bookingId) && pb1.paise === fullPaise)

  const pbC = await paidBooking(12)
  const custCancel = await api("POST", `/api/customer/bookings/${pbC.bookingId}/cancel`, { user: alice })
  const bkC = (await q(`SELECT starts_at FROM bookings WHERE id = $1`, [pbC.bookingId]))[0]
  const expectC = computeCancellationRefund({ payableAmount: fullPaise / 100, startsAt: bkC.starts_at })
  const payC = await row(pbC.order.json.orderId)
  const ledgerC = await q(`SELECT amount FROM payment_transactions WHERE booking_id = $1 AND source_type = 'REFUND'`, [pbC.bookingId])
  check("L1 customer can cancel their own paid booking; refund follows the policy tier (" + expectC.refundPercent + "%)", custCancel.status === 200 && custCancel.json?.refund?.percent === expectC.refundPercent && (expectC.refundAmount === 0 ? ledgerC.length === 0 : Number(ledgerC[0].amount) === expectC.refundAmount && Number(payC.cancel_refund_paise) === Math.round(expectC.refundAmount * 100)), `${custCancel.status} ${custCancel.text.slice(0, 160)}`)
  const bobCancel = await api("POST", `/api/customer/bookings/${pb1.bookingId}/cancel`, { user: bob })
  check("L1b another customer cannot cancel someone else's booking (403)", bobCancel.status === 403 && (await q(`SELECT status FROM bookings WHERE id = $1`, [pb1.bookingId]))[0].status === "CONFIRMED", `${bobCancel.status}`)
  const custOnRecep = await api("PATCH", `/api/reception/bookings/${pb1.bookingId}`, { user: alice, body: { action: "cancel", refundPercent: 100 } })
  check("L2 a customer session cannot use the reception cancel endpoint (401/403), booking untouched", [401, 403].includes(custOnRecep.status) && (await q(`SELECT status FROM bookings WHERE id = $1`, [pb1.bookingId]))[0].status === "CONFIRMED", `${custOnRecep.status}`)

  const prev = await api("GET", `/api/reception/bookings/${pb1.bookingId}/cancellation-preview`, { user: recep })
  check("L3 preview for reception: amount held, 0/25/50/75/100 options, standard-policy suggestion, paid online", prev.status === 200 && prev.json?.booking?.heldAmount === fullPaise / 100 && JSON.stringify(prev.json?.options) === "[0,25,50,75,100]" && [0, 50, 100].includes(prev.json?.policy?.percent) && prev.json?.paidOnline === true, prev.text.slice(0, 250))
  for (const bad of [150, -5, 33.5, "abc"]) {
    const r = await api("PATCH", `/api/reception/bookings/${pb1.bookingId}`, { user: recep, body: { action: "cancel", refundPercent: bad } })
    check(`L4 invalid refund percent ${JSON.stringify(bad)} rejected (400), booking not cancelled`, r.status === 400 && (await q(`SELECT status FROM bookings WHERE id = $1`, [pb1.bookingId]))[0].status === "CONFIRMED", `${r.status} ${r.text.slice(0, 80)}`)
  }
  const cancel75 = await api("PATCH", `/api/reception/bookings/${pb1.bookingId}`, { user: recep, body: { action: "cancel", refundPercent: 75 } })
  const heldRupees = fullPaise / 100
  const ledgerRefund = await q(`SELECT amount FROM payment_transactions WHERE booking_id = $1 AND source_type = 'REFUND'`, [pb1.bookingId])
  const payRow = await row(pb1.order.json.orderId)
  check("L5 reception cancels with 75%: booking CANCELLED, response says 75% of the amount", cancel75.status === 200 && cancel75.json?.booking?.status === "CANCELLED" && cancel75.json?.refund?.percent === 75 && cancel75.json?.refund?.amount === heldRupees * 0.75, cancel75.text.slice(0, 200))
  check("L6 ledger refund = 75% of paid; gateway refund queued for exactly 75% in paise", ledgerRefund.length === 1 && Number(ledgerRefund[0].amount) === heldRupees * 0.75 && Number(payRow.cancel_refund_paise) === Math.round(fullPaise * 0.75) && ["PENDING", "INITIATED", "REQUESTING"].includes(payRow.cancel_refund_status), JSON.stringify({ l: ledgerRefund, p: payRow.cancel_refund_paise, s: payRow.cancel_refund_status }))
  const again = await api("PATCH", `/api/reception/bookings/${pb1.bookingId}`, { user: recep, body: { action: "cancel", refundPercent: 100 } })
  check("L7 cancelling again is a harmless no-op: no second refund row, no second gateway refund", again.status === 200 && !again.json?.refund && (await q(`SELECT COUNT(*) n FROM payment_transactions WHERE booking_id = $1 AND source_type = 'REFUND'`, [pb1.bookingId]))[0].n === "1" && Number((await row(pb1.order.json.orderId)).cancel_refund_paise) === Math.round(fullPaise * 0.75), `${again.status}`)

  const pb2 = await paidBooking(10)
  const cancel0 = await api("PATCH", `/api/reception/bookings/${pb2.bookingId}`, { user: recep, body: { action: "cancel", refundPercent: 0 } })
  const pay2 = await row(pb2.order.json.orderId)
  check("L8 0% chosen: cancelled, no refund row, nothing queued at the gateway", cancel0.status === 200 && cancel0.json?.refund?.amount === 0 && (await q(`SELECT COUNT(*) n FROM payment_transactions WHERE booking_id = $1 AND source_type = 'REFUND'`, [pb2.bookingId]))[0].n === "0" && pay2.cancel_refund_status === null)

  const pb3 = await paidBooking(11)
  const cancel100 = await api("PATCH", `/api/reception/bookings/${pb3.bookingId}`, { user: recep, body: { action: "cancel", refundPercent: 100 } })
  const pay3 = await row(pb3.order.json.orderId)
  check("L9 100% chosen: full amount refunded (ledger + gateway paise)", cancel100.status === 200 && Number(pay3.cancel_refund_paise) === fullPaise && Number((await q(`SELECT amount FROM payment_transactions WHERE booking_id = $1 AND source_type = 'REFUND'`, [pb3.bookingId]))[0].amount) === heldRupees)

  // ===== M. admin uses the same percentage workflow =========================================
  if (admin) {
    const pbA = await paidBooking(20)
    check("M0 customer cannot read the admin cancellation preview (403)", (await api("GET", `/api/admin/bookings/${pbA.bookingId}/cancellation-preview`, { user: alice })).status === 403)
    const aPrev = await api("GET", `/api/admin/bookings/${pbA.bookingId}/cancellation-preview`, { user: admin })
    check("M1 admin preview: same shape as reception (held amount, options, policy suggestion, paid online)", aPrev.status === 200 && aPrev.json?.booking?.heldAmount === fullPaise / 100 && JSON.stringify(aPrev.json?.options) === "[0,25,50,75,100]" && aPrev.json?.paidOnline === true, aPrev.text.slice(0, 200))
    const aBad = await api("PATCH", `/api/admin/bookings/${pbA.bookingId}/status`, { user: admin, body: { status: "CANCELLED", refundPercent: 120 } })
    check("M2 admin invalid percent rejected (400), booking untouched", aBad.status === 400 && (await q(`SELECT status FROM bookings WHERE id = $1`, [pbA.bookingId]))[0].status === "CONFIRMED", `${aBad.status}`)
    const aCancel = await api("PATCH", `/api/admin/bookings/${pbA.bookingId}/status`, { user: admin, body: { status: "CANCELLED", refundPercent: 25 } })
    const aPay = await row(pbA.order.json.orderId)
    const aLedger = await q(`SELECT amount FROM payment_transactions WHERE booking_id = $1 AND source_type = 'REFUND'`, [pbA.bookingId])
    check("M3 admin cancels with 25%: cancelled, ledger = 25%, gateway refund queued for 25% in paise", aCancel.status === 200 && aCancel.json?.refund?.percent === 25 && aLedger.length === 1 && Number(aLedger[0].amount) === (fullPaise / 100) * 0.25 && Number(aPay.cancel_refund_paise) === Math.round(fullPaise * 0.25), `${aCancel.status} ${aCancel.text.slice(0, 160)}`)
  }

  // ===== J. server logs contain no secrets ===================================================
  await sleep(500)
  writeFileSync(serverLogPath, serverLog)
  check("J1 server log never contains the Razorpay secret or webhook secret", !serverLog.includes(KEY_SECRET) && !serverLog.includes(WEBHOOK_SECRET))
  check("J2 server log has structured payment events", ["order_created", "webhook_received", "payment_captured", "booking_confirmed", "payment_failed", "webhook_signature_invalid", "verify_signature_invalid", "booking_failed_after_payment"].every(e => serverLog.includes(`"event":"${e}"`)), "missing: " + ["order_created", "webhook_received", "payment_captured", "booking_confirmed", "payment_failed", "webhook_signature_invalid", "verify_signature_invalid", "booking_failed_after_payment"].filter(e => !serverLog.includes(`"event":"${e}"`)).join(","))
  check("J3 server log has no vpa/email/contact from payment payloads", !serverLog.match(/someone@okbank|customer@example\.test|9999999999/))
} catch (error) {
  console.error("TEST SCRIPT ERROR", error)
  results.push({ name: "script completed without exception", ok: false, detail: String(error?.stack ?? error) })
} finally {
  // cleanup everything this run created
  try {
    const ids = created.userIds
    await pool.query(`DELETE FROM razorpay_webhook_events WHERE razorpay_order_id = ANY($1::text[]) OR razorpay_order_id LIKE 'order_NotOurs%'`, [created.orderIds.filter(Boolean)])
    await pool.query(`DELETE FROM razorpay_payments WHERE user_id = ANY($1::uuid[])`, [ids])
    await pool.query(`DELETE FROM payment_transactions WHERE booking_id IN (SELECT id FROM bookings WHERE created_by = ANY($1::uuid[]))`, [ids])
    await pool.query(`DELETE FROM bookings WHERE created_by = ANY($1::uuid[])`, [ids])
    await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [ids]).catch(() => undefined)
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids])
  } catch (error) {
    console.error("cleanup problem:", error?.message)
  }
  server.kill()
  await pool.end().catch(() => undefined)
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) console.log("FAILED:\n" + failed.map(f => ` - ${f.name}\n     ${f.detail}`).join("\n"))
  process.exit(failed.length ? 1 : 0)
}

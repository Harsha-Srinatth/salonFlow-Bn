// Regression tests for the 0.0.0.1 pre-release audit. Same isolated database and mocks as the
// WhatsApp suite (sahasra_wa_test, never the development database).
import "../whatsapp/setup.js"
import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import express from "express"
import cookieParser from "cookie-parser"
import { createUser, insertBooking, pool, prepareDatabase, resetData } from "../whatsapp/fixtures.js"
import staffRoutes from "../../src/routes/staff.js"
import { signStaffAccessToken } from "../../src/lib/tokens.js"
import { createReceptionBooking, recordReceptionPayment } from "../../src/bookings/service.js"
import { upsertGlobalDiscount } from "../../src/offers/service.js"

let server
let base
test.before(async () => {
  await prepareDatabase()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use("/api/staff", staffRoutes)
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
  await resetData()
})

/** A stylist with a live staff session cookie, as /api/auth/staff/login would issue. */
async function stylistSession() {
  const stylist = await createUser({ role: "STAFF", name: "Ravi Kumar" })
  const jti = randomUUID()
  await pool.query("UPDATE users SET staff_session_jti = $2 WHERE id = $1", [stylist.id, jti])
  return { stylist, cookie: `staff_access_token=${await signStaffAccessToken(stylist.id, jti)}` }
}

async function post(path, cookie) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { cookie } })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

test("ids: a malformed booking id is a 404, not a database error (500)", async () => {
  const { cookie } = await stylistSession()
  for (const id of ["not-a-uuid", "1", "' OR 1=1 --"]) {
    const result = await post(`/api/staff/bookings/${encodeURIComponent(id)}/start`, cookie)
    assert.equal(result.status, 404, id)
  }
})

test("ids: the guard runs after authentication (no session -> 401)", async () => {
  const result = await post("/api/staff/bookings/not-a-uuid/start", "")
  assert.equal(result.status, 401)
})

test("stylist start: a booking for a later day cannot be started today", async () => {
  const { stylist, cookie } = await stylistSession()
  const customer = await createUser()
  // 30 h ahead is never the current salon day.
  const later = await insertBooking({ customer, hoursAhead: 30, stylistId: stylist.id })
  const result = await post(`/api/staff/bookings/${later.id}/start`, cookie)
  assert.equal(result.status, 409)
  const { rows } = await pool.query("SELECT status, actual_start_at FROM bookings WHERE id = $1", [later.id])
  assert.equal(rows[0].status, "CONFIRMED")
  assert.equal(rows[0].actual_start_at, null)
})

test("stylist start: today's booking starts, and a second tap is idempotent", async () => {
  const { stylist, cookie } = await stylistSession()
  const customer = await createUser()
  // Began five minutes ago: today in salon time except in the first five minutes after midnight.
  const today = await insertBooking({ customer, hoursAhead: -5 / 60, stylistId: stylist.id })
  const first = await post(`/api/staff/bookings/${today.id}/start`, cookie)
  assert.equal(first.status, 200)
  assert.equal(first.body.booking.status, "STARTED")
  const again = await post(`/api/staff/bookings/${today.id}/start`, cookie)
  assert.equal(again.status, 200)
})

test("stylist start: another stylist's booking is not found", async () => {
  const { cookie } = await stylistSession()
  const other = await createUser({ role: "STAFF", name: "Meena Iyer" })
  const customer = await createUser()
  const booking = await insertBooking({ customer, hoursAhead: -5 / 60, stylistId: other.id })
  const result = await post(`/api/staff/bookings/${booking.id}/start`, cookie)
  assert.equal(result.status, 404)
})

test("walk-in: an oversized customer name is a validation error, not a 500", async () => {
  const payload = {
    customerName: "x".repeat(5000),
    customerEmail: "walkin@example.test",
    customerPhone: "+919812345678",
    customerGender: "FEMALE",
    stylistId: randomUUID(),
    startsAt: new Date(Date.now() + 3600_000).toISOString(),
    serviceIds: [randomUUID()],
    paymentMode: "OFFLINE_CASH",
  }
  await assert.rejects(createReceptionBooking({ payload, actorUserId: randomUUID() }), err => err.code === "BAD_REQUEST" && /too long/.test(err.message))
  await assert.rejects(
    recordReceptionPayment({ payload: { sourceType: "WALKIN", paymentMode: "OFFLINE_CASH", amount: 100, customerName: "y".repeat(500) }, actorUserId: randomUUID() }),
    err => err.code === "BAD_REQUEST"
  )
})

test("offers: a global discount without a percent is rejected, not saved as 0%", async () => {
  const admin = await createUser({ role: "ADMIN" })
  for (const discountPercent of [undefined, null, "", "  "]) {
    await assert.rejects(upsertGlobalDiscount({ payload: { discountPercent }, actorUserId: admin.id }), err => err.code === "BAD_REQUEST")
  }
  await assert.rejects(upsertGlobalDiscount({ payload: { discountPercent: 150 }, actorUserId: admin.id }), err => err.code === "BAD_REQUEST")
  const { rows: none } = await pool.query("SELECT 1 FROM offer_global_discounts")
  assert.equal(none.length, 0, "nothing was written by the rejected calls")
  await upsertGlobalDiscount({ payload: { discountPercent: 0 }, actorUserId: admin.id })
  await upsertGlobalDiscount({ payload: { discountPercent: "12.5" }, actorUserId: admin.id })
  const { rows } = await pool.query("SELECT discount_percent FROM offer_global_discounts")
  assert.equal(Number(rows[0].discount_percent), 12.5)
})

test("names: a very long full name is invalid (it used to pass and then fail the insert)", async () => {
  const { isValidFullName } = await import("../../src/lib/validation.js")
  assert.equal(isValidFullName("Asha Rao"), true)
  assert.equal(isValidFullName("Venkata Lakshmi Narasimha Swamy Prasad"), true)
  assert.equal(isValidFullName(`Asha ${"Raoabcdefghij".repeat(30)}`), false)
})

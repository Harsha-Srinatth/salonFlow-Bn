import { graph, jsonResponse } from "./setup.js"
import test from "node:test"
import assert from "node:assert/strict"
import { pool, prepareDatabase, resetData, uniquePhone } from "./fixtures.js"
import {
  consumeOtpChallenge,
  issuePhoneProof,
  loadUsablePhoneProof,
  OtpError,
  requestWhatsAppOtp,
  verifyWhatsAppOtp,
} from "../../src/whatsapp/otp.js"
import { whatsappConfig } from "../../src/whatsapp/config.js"

test.before(async () => {
  await prepareDatabase()
  await resetData()
})
test.after(async () => {
  await pool.end()
})
test.beforeEach(() => graph.reset())

/** The code that went out in the last WhatsApp request (read from the mocked API call). */
function lastSentCode() {
  const call = graph.calls.at(-1)
  return call.body.template.components[0].parameters[0].text
}

test("otp: generates a 6-digit code, sends the authentication template, stores only a hash", async () => {
  const phone = uniquePhone()
  const result = await requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: "10.0.0.1" })
  assert.equal(result.deduplicated, false)
  assert.equal(graph.calls.length, 1)
  const { template, to } = graph.calls[0].body
  assert.equal(template.name, "sahasra_otp")
  assert.equal(to, phone.slice(1))
  const code = lastSentCode()
  assert.match(code, /^\d{6}$/)
  // Copy-code button carries the same code.
  assert.equal(template.components[1].sub_type, "url")
  assert.equal(template.components[1].parameters[0].text, code)
  const { rows } = await pool.query("SELECT * FROM whatsapp_otp_challenges WHERE phone = $1", [phone])
  assert.equal(rows.length, 1)
  assert.notEqual(rows[0].code_hash, code)
  assert.ok(!JSON.stringify(rows[0]).includes(`"${code}"`))
  assert.match(rows[0].wa_message_id, /^wamid\./)
  const verified = await verifyWhatsAppOtp({ phone, purpose: "LOGIN", code })
  assert.equal(verified.phone, phone)
})

test("otp: a verified code cannot be verified or consumed twice", async () => {
  const phone = uniquePhone()
  await requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: "10.0.0.2" })
  const code = lastSentCode()
  const verified = await verifyWhatsAppOtp({ phone, purpose: "LOGIN", code })
  assert.equal(await consumeOtpChallenge(pool, verified.challengeId), true)
  assert.equal(await consumeOtpChallenge(pool, verified.challengeId), false)
  await assert.rejects(verifyWhatsAppOtp({ phone, purpose: "LOGIN", code }), err => err.code === "OTP_NOT_FOUND")
})

test("otp: wrong code is refused with attempts remaining, and the attempt is persisted", async () => {
  const phone = uniquePhone()
  await requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: "10.0.0.3" })
  const code = lastSentCode()
  const wrong = code === "000000" ? "111111" : "000000"
  await assert.rejects(verifyWhatsAppOtp({ phone, purpose: "LOGIN", code: wrong }), err => err.code === "OTP_INVALID" && err.attemptsRemaining === 4)
  const { rows } = await pool.query("SELECT attempts FROM whatsapp_otp_challenges WHERE phone = $1", [phone])
  assert.equal(rows[0].attempts, 1)
  // The right code still works afterwards.
  await verifyWhatsAppOtp({ phone, purpose: "LOGIN", code })
})

test("otp: attempt limit locks the challenge, even for the right code afterwards", async () => {
  const phone = uniquePhone()
  await requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: "10.0.0.4" })
  const code = lastSentCode()
  const wrong = code === "000000" ? "111111" : "000000"
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(verifyWhatsAppOtp({ phone, purpose: "LOGIN", code: wrong }), err => err.code === "OTP_INVALID")
  }
  await assert.rejects(verifyWhatsAppOtp({ phone, purpose: "LOGIN", code: wrong }), err => err.code === "OTP_LOCKED" && err.status === 429)
  await assert.rejects(verifyWhatsAppOtp({ phone, purpose: "LOGIN", code }), err => err.code === "OTP_NOT_FOUND")
})

test("otp: an expired code is refused", async () => {
  const phone = uniquePhone()
  await requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: "10.0.0.5" })
  const code = lastSentCode()
  await pool.query("UPDATE whatsapp_otp_challenges SET expires_at = NOW() - interval '1 second' WHERE phone = $1", [phone])
  await assert.rejects(verifyWhatsAppOtp({ phone, purpose: "LOGIN", code }), err => err.code === "OTP_EXPIRED")
})

test("otp: duplicate requests inside the cooldown send one message and return the same challenge", async () => {
  const phone = uniquePhone()
  const results = await Promise.all([1, 2, 3].map(() => requestWhatsAppOtp({ phone, purpose: "SIGNUP", ip: "10.0.0.6" })))
  assert.equal(graph.calls.length, 1, "only one WhatsApp message for three concurrent requests")
  assert.equal(results.filter(r => r.deduplicated).length, 2)
  const again = await requestWhatsAppOtp({ phone, purpose: "SIGNUP", ip: "10.0.0.6" })
  assert.equal(again.deduplicated, true)
  assert.ok(again.resendAvailableInSeconds > 0)
  assert.equal(graph.calls.length, 1)
})

test("otp: a new code after the cooldown supersedes the old one", async () => {
  const phone = uniquePhone()
  await requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: "10.0.0.7" })
  const oldCode = lastSentCode()
  await pool.query("UPDATE whatsapp_otp_challenges SET created_at = NOW() - interval '2 minutes' WHERE phone = $1", [phone])
  const second = await requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: "10.0.0.7" })
  assert.equal(second.deduplicated, false)
  const newCode = lastSentCode()
  if (oldCode !== newCode) {
    await assert.rejects(verifyWhatsAppOtp({ phone, purpose: "LOGIN", code: oldCode }), err => err.code === "OTP_INVALID")
  }
  await verifyWhatsAppOtp({ phone, purpose: "LOGIN", code: newCode })
  const { rows } = await pool.query("SELECT status FROM whatsapp_otp_challenges WHERE phone = $1 ORDER BY created_at", [phone])
  assert.deepEqual(rows.map(r => r.status), ["SUPERSEDED", "VERIFIED"])
})

test("otp: per-phone hourly cap returns 429 with Retry-After seconds", async () => {
  const phone = uniquePhone()
  for (let i = 0; i < 5; i += 1) {
    await requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: `10.1.0.${i}` })
    await pool.query("UPDATE whatsapp_otp_challenges SET created_at = created_at - interval '50 seconds' WHERE phone = $1", [phone])
  }
  await assert.rejects(
    requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: "10.1.0.99" }),
    err => err instanceof OtpError && err.code === "OTP_RATE_LIMITED" && err.status === 429 && err.retryAfterSeconds > 0
  )
  assert.equal(graph.calls.length, 5)
})

test("otp: per-IP hourly cap applies across numbers", async () => {
  const ip = "10.2.0.1"
  for (let i = 0; i < 20; i += 1) await requestWhatsAppOtp({ phone: uniquePhone(), purpose: "LOGIN", ip })
  await assert.rejects(requestWhatsAppOtp({ phone: uniquePhone(), purpose: "LOGIN", ip }), err => err.code === "OTP_RATE_LIMITED")
})

test("otp: WhatsApp API failure returns a delivery error and does not leave a usable code", async () => {
  const phone = uniquePhone()
  graph.respond = () => jsonResponse(503, { error: { code: 131016, message: "Service unavailable" } })
  await assert.rejects(requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: "10.3.0.1" }), err => err.code === "OTP_DELIVERY_FAILED" && err.status === 502)
  const { rows } = await pool.query("SELECT status FROM whatsapp_otp_challenges WHERE phone = $1", [phone])
  assert.equal(rows[0].status, "DELIVERY_FAILED")
  // The customer can retry immediately (no cooldown on an undelivered code).
  graph.reset()
  const retry = await requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: "10.3.0.1" })
  assert.equal(retry.deduplicated, false)
  assert.equal(graph.calls.length, 1)
})

test("otp: number not on WhatsApp is reported as such", async () => {
  graph.respond = () => jsonResponse(400, { error: { code: 131026, message: "Message undeliverable" } })
  await assert.rejects(requestWhatsAppOtp({ phone: uniquePhone(), purpose: "SIGNUP", ip: "10.3.0.2" }), err => err.code === "WHATSAPP_NOT_AVAILABLE_FOR_NUMBER")
})

test("otp: unavailable when WhatsApp is disabled and no dev code is configured", async () => {
  const config = whatsappConfig({ NODE_ENV: "test" })
  await assert.rejects(requestWhatsAppOtp({ phone: uniquePhone(), purpose: "LOGIN", ip: "10.4.0.1", config }), err => err.code === "WHATSAPP_OTP_UNAVAILABLE" && err.status === 503)
  assert.equal(graph.calls.length, 0)
})

test("otp: local dev fixed code works without credentials and sends nothing", async () => {
  const config = whatsappConfig({ NODE_ENV: "development", WHATSAPP_DEV_FIXED_OTP: "246810" })
  const phone = uniquePhone()
  await requestWhatsAppOtp({ phone, purpose: "LOGIN", ip: "10.4.0.2", config })
  assert.equal(graph.calls.length, 0)
  await verifyWhatsAppOtp({ phone, purpose: "LOGIN", code: "246810" })
  // Never in production.
  const prod = whatsappConfig({ NODE_ENV: "production", WHATSAPP_DEV_FIXED_OTP: "246810" })
  await assert.rejects(requestWhatsAppOtp({ phone: uniquePhone(), purpose: "LOGIN", ip: "10.4.0.3", config: prod }), err => err.code === "WHATSAPP_OTP_UNAVAILABLE")
})

test("otp: signup proof is valid once, bound to its phone and purpose", async () => {
  const phone = uniquePhone()
  await requestWhatsAppOtp({ phone, purpose: "SIGNUP", ip: "10.5.0.1" })
  const verified = await verifyWhatsAppOtp({ phone, purpose: "SIGNUP", code: lastSentCode() })
  const proof = await issuePhoneProof(verified)
  assert.deepEqual(await loadUsablePhoneProof(proof), { phone, challengeId: verified.challengeId })
  assert.equal(await loadUsablePhoneProof(proof, { purpose: "LOGIN" }), null)
  assert.equal(await loadUsablePhoneProof(`${proof.slice(0, -2)}xx`), null, "tampered token")
  assert.equal(await consumeOtpChallenge(pool, verified.challengeId, { phone, purpose: "SIGNUP" }), true)
  assert.equal(await loadUsablePhoneProof(proof), null, "spent proof")
})

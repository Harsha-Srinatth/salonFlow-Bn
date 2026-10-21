import { graph, jsonResponse, TEST_ENV } from "./setup.js"
import test from "node:test"
import assert from "node:assert/strict"
import { isWhatsAppSendingAvailable, validateWhatsAppConfig, whatsappConfig } from "../../src/whatsapp/config.js"
import { classifyGraphError, sendTemplateMessage, WhatsAppApiError } from "../../src/whatsapp/client.js"
import { fromWaId, isAllowedCountry, maskPhone, normalizePhone, phoneLookupCandidates } from "../../src/whatsapp/phone.js"
import { assertProductionEnv } from "../../src/lib/env-check.js"
import { retryDelayMs } from "../../src/whatsapp/outbox.js"

const env = overrides => ({ ...TEST_ENV, ...overrides })

test("config: complete test configuration is valid and sendable", () => {
  const config = whatsappConfig(env({}))
  assert.deepEqual(validateWhatsAppConfig(config), [])
  assert.equal(isWhatsAppSendingAvailable(config), true)
  assert.deepEqual(config.reminders.offsetsMinutes, [1440, 120])
})

test("config: disabled needs nothing and is not sendable", () => {
  const config = whatsappConfig({ NODE_ENV: "development" })
  assert.equal(config.enabled, false)
  assert.deepEqual(validateWhatsAppConfig(config), [])
  assert.equal(isWhatsAppSendingAvailable(config), false)
})

test("config: missing credentials produce actionable errors and block sending", () => {
  const config = whatsappConfig({ WHATSAPP_ENABLED: "true" })
  const problems = validateWhatsAppConfig(config)
  assert.ok(problems.some(p => p.includes("WHATSAPP_ACCESS_TOKEN")))
  assert.ok(problems.some(p => p.includes("WHATSAPP_PHONE_NUMBER_ID")))
  assert.equal(isWhatsAppSendingAvailable(config), false)
})

test("config: a phone number in place of the phone number ID is rejected", () => {
  const problems = validateWhatsAppConfig(whatsappConfig(env({ WHATSAPP_PHONE_NUMBER_ID: "+919876543210" })))
  assert.ok(problems.some(p => p.includes("numeric phone number ID")))
})

test("config: invalid numbers and reminder offsets are reported", () => {
  const problems = validateWhatsAppConfig(
    whatsappConfig(env({ WHATSAPP_OTP_TTL_SECONDS: "abc", WHATSAPP_REMINDER_OFFSETS_MINUTES: "24h", WHATSAPP_GRAPH_API_VERSION: "26" }))
  )
  assert.ok(problems.some(p => p.includes("WHATSAPP_OTP_TTL_SECONDS")))
  assert.ok(problems.some(p => p.includes("WHATSAPP_REMINDER_OFFSETS_MINUTES")))
  assert.ok(problems.some(p => p.includes("WHATSAPP_GRAPH_API_VERSION")))
})

test("config: reminder offsets are configurable and ordered earliest first", () => {
  assert.deepEqual(whatsappConfig(env({ WHATSAPP_REMINDER_OFFSETS_MINUTES: "60, 720" })).reminders.offsetsMinutes, [720, 60])
})

test("config: production requires app secret and verify token, and refuses the dev OTP", () => {
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
  assert.throws(
    () => assertProductionEnv({ ...base, WHATSAPP_ENABLED: "true", WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "123456789" }),
    /WHATSAPP_APP_SECRET.*WHATSAPP_WEBHOOK_VERIFY_TOKEN|WHATSAPP_WEBHOOK_VERIFY_TOKEN/
  )
  assert.throws(() => assertProductionEnv({ ...base, WHATSAPP_DEV_FIXED_OTP: "123456" }), /WHATSAPP_DEV_FIXED_OTP/)
})

test("phone: Indian formats normalise to E.164", () => {
  for (const input of ["9876543210", "098765 43210", "+91 98765-43210", "919876543210", "0091 9876543210"]) {
    assert.equal(normalizePhone(input), "+919876543210", input)
  }
})

test("phone: invalid Indian numbers and junk are rejected", () => {
  for (const input of ["", "12345", "5876543210", "+91 5876543210", "98765abc10", "+0123"]) {
    assert.equal(normalizePhone(input), null, input)
  }
})

test("phone: international numbers with + are accepted, country allow-list applies", () => {
  assert.equal(normalizePhone("+1 415 555 2671"), "+14155552671")
  assert.equal(isAllowedCountry("+14155552671", ["91"]), false)
  assert.equal(isAllowedCountry("+919876543210", ["91"]), true)
  assert.equal(fromWaId("919876543210"), "+919876543210")
  assert.equal(maskPhone("+919876543210"), "+91******3210")
  assert.deepEqual(phoneLookupCandidates("+919876543210"), ["+919876543210", "9876543210", "919876543210"])
})

test("client: Graph errors are classified for retry", () => {
  assert.equal(classifyGraphError(400, { error: { code: 130429 } }).retryable, true)
  assert.equal(classifyGraphError(500, { error: { code: 1 } }).retryable, true)
  assert.equal(classifyGraphError(503, {}).retryable, true)
  const template = classifyGraphError(404, { error: { code: 132001 } })
  assert.equal(template.retryable, false)
  assert.equal(template.kind, "PERMANENT")
  const token = classifyGraphError(401, { error: { code: 190 } })
  assert.equal(token.kind, "CONFIGURATION")
  assert.equal(token.retryable, false)
})

test("client: sends a template to the right endpoint with the token, returns the message id", async () => {
  graph.reset()
  const result = await sendTemplateMessage({ to: "+919876543210", name: "x", language: "en", components: [] })
  assert.match(result.messageId, /^wamid\./)
  assert.equal(graph.calls.length, 1)
  assert.equal(graph.calls[0].url, "https://graph.facebook.com/v26.0/109876543210987/messages")
  assert.equal(graph.calls[0].auth, "Bearer test-access-token-not-real")
  assert.equal(graph.calls[0].body.to, "919876543210")
})

test("client: a 200 without a message id is not treated as sent", async () => {
  graph.reset()
  graph.respond = () => jsonResponse(200, { messaging_product: "whatsapp" })
  await assert.rejects(sendTemplateMessage({ to: "+919876543210", name: "x", language: "en" }), err => err instanceof WhatsAppApiError && err.retryable)
  graph.reset()
})

test("client: timeouts and network failures are retryable errors, not successes", async () => {
  graph.reset()
  graph.respond = () => {
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" })
  }
  await assert.rejects(sendTemplateMessage({ to: "+919876543210", name: "x", language: "en" }), err => err.kind === "TIMEOUT" && err.retryable)
  graph.reset()
})

test("client: refuses to send when disabled or misconfigured (no network call)", async () => {
  graph.reset()
  await assert.rejects(sendTemplateMessage({ to: "+919876543210", name: "x", language: "en" }, whatsappConfig({})), err => err.kind === "DISABLED")
  await assert.rejects(
    sendTemplateMessage({ to: "+919876543210", name: "x", language: "en" }, whatsappConfig({ WHATSAPP_ENABLED: "true" })),
    err => err.kind === "NOT_CONFIGURED"
  )
  assert.equal(graph.calls.length, 0)
})

test("outbox: retry delay grows exponentially and is capped", () => {
  const first = retryDelayMs(1)
  const fourth = retryDelayMs(4)
  assert.ok(first >= 24_000 && first <= 36_000)
  assert.ok(fourth >= 192_000 && fourth <= 288_000)
  assert.ok(retryDelayMs(30) <= 3600_000 * 1.2)
  assert.ok(retryDelayMs(1, 120_000) >= 120_000)
})

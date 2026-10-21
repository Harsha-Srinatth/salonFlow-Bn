/**
 * Test environment for the WhatsApp suite. Import this FIRST in every test file.
 *
 *  - Uses a dedicated database, `sahasra_wa_test` (override with TEST_DATABASE_URL), on the
 *    same server as the local DATABASE_URL. It never touches the development database.
 *    Only the connection host/user/password are read from bn/.env; no other secret from it
 *    is loaded into the test process.
 *  - Sets fake WhatsApp credentials and installs a fetch mock, so no request can reach Meta.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import dotenv from "dotenv"
import pg from "pg"

const here = path.dirname(fileURLToPath(import.meta.url))
let base = process.env.TEST_DATABASE_URL
if (!base) {
  let local = {}
  try {
    local = dotenv.parse(readFileSync(path.join(here, "..", "..", ".env")))
  } catch {
    local = {}
  }
  const source = local.DATABASE_URL || "postgres://postgres@localhost:5432/postgres"
  const url = new URL(source)
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("Refusing to run tests: set TEST_DATABASE_URL to a disposable local database")
  }
  url.pathname = "/sahasra_wa_test"
  base = url.toString()
}
const target = new URL(base)
const admin = new URL(base)
admin.pathname = "/postgres"
const adminClient = new pg.Client({ connectionString: admin.toString() })
await adminClient.connect()
const dbName = target.pathname.slice(1)
const { rows } = await adminClient.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName])
if (!rows.length) await adminClient.query(`CREATE DATABASE "${dbName.replace(/"/g, "")}"`)
await adminClient.end()

process.env.DATABASE_URL = target.toString()
process.env.NODE_ENV = "test"
process.env.STAFF_SETUP_SECRET = "test-setup-secret-for-whatsapp-suite-0123456789"
process.env.STAFF_ACCESS_SECRET = "test-access-secret-for-whatsapp-suite-0123456789"
process.env.SALON_TIMEZONE = "Asia/Kolkata"
delete process.env.RAZORPAY_KEY_ID
delete process.env.REDIS_URL

export const TEST_ENV = {
  WHATSAPP_ENABLED: "true",
  WHATSAPP_ACCESS_TOKEN: "test-access-token-not-real",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210987",
  WHATSAPP_BUSINESS_ACCOUNT_ID: "209876543210987",
  WHATSAPP_APP_SECRET: "test-app-secret",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "test-verify-token-0123456789",
  WHATSAPP_GRAPH_API_VERSION: "v26.0",
  WHATSAPP_TEMPLATE_OTP: "sahasra_otp",
  WHATSAPP_TEMPLATE_WELCOME: "sahasra_welcome",
  WHATSAPP_TEMPLATE_BOOKING_CONFIRMED: "sahasra_booking_confirmed",
  WHATSAPP_TEMPLATE_BOOKING_RESCHEDULED: "sahasra_booking_rescheduled",
  WHATSAPP_TEMPLATE_BOOKING_CANCELLED: "sahasra_booking_cancelled",
  WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER: "sahasra_appointment_reminder",
  WHATSAPP_TEMPLATE_OFFER: "sahasra_offer",
  WHATSAPP_WORKER_BATCH_SIZE: "50",
  // Booking update messages are off by default (not in the salon's budget); the tests
  // that cover them switch the bucket on. budget.test.js checks the real defaults.
  WHATSAPP_MONTHLY_LIMIT_BOOKING_UPDATES: "100000",
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith("WHATSAPP_")) delete process.env[key]
}
Object.assign(process.env, TEST_ENV)

const { setWhatsAppFetchForTests } = await import("../../src/whatsapp/client.js")

/** Every Graph request made during a test, and a programmable responder. */
export const graph = {
  calls: [],
  respond: null,
  reset() {
    this.calls = []
    this.respond = null
  },
}
let counter = 0
setWhatsAppFetchForTests(async (url, init) => {
  if (!`${url}`.startsWith("https://graph.facebook.com/")) throw new Error(`unexpected URL in test: ${url}`)
  const body = init?.body ? JSON.parse(init.body) : null
  graph.calls.push({ url: `${url}`, method: init?.method, body, auth: init?.headers?.Authorization })
  if (graph.respond) return graph.respond(body, url)
  counter += 1
  return jsonResponse(200, { messaging_product: "whatsapp", contacts: [{ wa_id: body?.to }], messages: [{ id: `wamid.TEST${counter}` }] })
})

export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
}

export function sentTemplates() {
  return graph.calls.filter(call => call.body?.type === "template").map(call => call.body.template.name)
}

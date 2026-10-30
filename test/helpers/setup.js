/**
 * Test environment for the backend suites. Import this FIRST in every test file.
 *
 *  - Uses a dedicated database, `sahasra_wa_test` (override with TEST_DATABASE_URL), on the
 *    same server as the local DATABASE_URL. It never touches the development database.
 *    Only the connection host/user/password are read from bn/.env; no other secret from it
 *    is loaded into the test process.
 *  - Sets fake SMS credentials and installs a fetch mock, so no request can reach MSG91.
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
process.env.STAFF_SETUP_SECRET = "test-setup-secret-for-backend-suite-0123456789"
process.env.STAFF_ACCESS_SECRET = "test-access-secret-for-backend-suite-0123456789"
process.env.SALON_TIMEZONE = "Asia/Kolkata"
delete process.env.RAZORPAY_KEY_ID
delete process.env.REDIS_URL

export const TEST_ENV = {
  SMS_ENABLED: "true",
  MSG91_AUTH_KEY: "test-auth-key-not-real",
  MSG91_REMINDER_TEMPLATE_ID: "test-template-id",
  SMS_WORKER_BATCH_SIZE: "50",
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith("SMS_") || key.startsWith("MSG91_")) delete process.env[key]
}
Object.assign(process.env, TEST_ENV)

const { setSmsFetchForTests } = await import("../../src/sms/client.js")

/** Every SMS API request made during a test, and a programmable responder. */
export const smsApi = {
  calls: [],
  respond: null,
  reset() {
    this.calls = []
    this.respond = null
  },
}
let counter = 0
setSmsFetchForTests(async (url, init) => {
  if (`${url}` !== "https://control.msg91.com/api/v5/flow/") throw new Error(`unexpected URL in test: ${url}`)
  const body = init?.body ? JSON.parse(init.body) : null
  smsApi.calls.push({ url: `${url}`, body, authkey: init?.headers?.authkey })
  if (smsApi.respond) return smsApi.respond(body)
  counter += 1
  return jsonResponse(200, { type: "success", message: `req-${counter}` })
})

export function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

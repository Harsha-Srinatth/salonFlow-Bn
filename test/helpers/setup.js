/**
 * Test environment for the backend suites. Import this FIRST in every test file.
 *
 *  - Uses a dedicated database, `sahasra_wa_test` (override with TEST_DATABASE_URL), on the
 *    same server as the local DATABASE_URL. It never touches the development database.
 *    Only the connection host/user/password are read from bn/.env; no other secret from it
 *    is loaded into the test process.
 *  - Sets fake SMS credentials and installs a fetch mock, so no request can reach MSG91.
 *  - Sets fake SES settings and installs a fake client, so no request can reach AWS.
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
export const TEST_EMAIL_ENV = {
  EMAIL_ENABLED: "true",
  EMAIL_VERIFICATION_ENABLED: "true",
  PHONE_VERIFICATION_ENABLED: "false",
  EMAIL_REMINDERS_ENABLED: "true",
  EMAIL_MARKETING_ENABLED: "true",
  AWS_SES_FROM_EMAIL: "support@sahasra-test.in",
  AWS_SES_CONFIGURATION_SET: "test-transactional",
  AWS_SES_MARKETING_CONFIGURATION_SET: "test-marketing",
  AWS_SES_REPLY_TO: "team@sahasra-test.in",
  AWS_SES_EVENTS_TOPIC_ARN: "arn:aws:sns:ap-southeast-2:000000000000:test-topic",
  APP_PUBLIC_URL: "https://sahasra-test.in",
  API_PUBLIC_URL: "https://api.sahasra-test.in",
  EMAIL_LINK_SECRET: "test-link-secret-for-backend-suite-0123456789",
  EMAIL_WORKER_SEND_INTERVAL_MS: "0",
  EMAIL_REQUEST_COOLDOWN_SECONDS: "0",
  EMAIL_REQUEST_HOURLY_LIMIT: "100",
  EMAIL_WORKER_BATCH_SIZE: "50",
  RATE_REGISTER_MAX: "1000",
  RATE_RESEND_VERIFICATION_MAX: "1000",
  RATE_EMAIL_TOKEN_MAX: "1000",
  RATE_PWRESET_REQUEST_MAX: "1000",
  RATE_PWRESET_COMPLETE_MAX: "1000",
  RATE_LOGIN_MAX: "1000",
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith("SMS_") || key.startsWith("MSG91_") || key.startsWith("EMAIL_") || key.startsWith("AWS_SES_") || key.startsWith("AWS_ACCESS")) delete process.env[key]
}
delete process.env.PHONE_VERIFICATION_ENABLED
delete process.env.PASSWORD_RESET_TOKEN_EXPIRY
Object.assign(process.env, TEST_ENV, TEST_EMAIL_ENV)

const { setSmsFetchForTests } = await import("../../src/sms/client.js")
const { setSesClientForTests } = await import("../../src/email/ses-provider.js")

/** Every SES request made during a test, and a programmable responder. */
export const sesApi = {
  calls: [],
  respond: null,
  reset() {
    this.calls = []
    this.respond = null
  },
}
let sesCounter = 0
setSesClientForTests({
  async send(command) {
    const input = command.input
    if (!input.Destination) return { ProductionAccessEnabled: false, SendingEnabled: true, SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 0 } }
    sesApi.calls.push({
      to: input.Destination.ToAddresses[0],
      from: input.FromEmailAddress,
      replyTo: input.ReplyToAddresses,
      configurationSet: input.ConfigurationSetName,
      subject: input.Content.Simple.Subject.Data,
      html: input.Content.Simple.Body.Html.Data,
      text: input.Content.Simple.Body.Text.Data,
      headers: input.Content.Simple.Headers ?? [],
      tags: input.EmailTags,
    })
    if (sesApi.respond) return sesApi.respond(input)
    sesCounter += 1
    return { MessageId: `ses-${sesCounter}` }
  },
})

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

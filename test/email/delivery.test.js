// The outbox, booking emails, reminders, SES failures, bounces, complaints and marketing.
import { sesApi, TEST_EMAIL_ENV } from "../helpers/setup.js"
import test from "node:test"
import assert from "node:assert/strict"
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto"
import { createUser, insertBooking, pool, prepareDatabase, resetData } from "../helpers/fixtures.js"
import { drainOutbox, makeEmailsDue, outbox, startApp, userByEmail } from "./helpers.js"
import { withTransaction } from "../../src/bookings/repository.js"
import { cancelCustomerBooking } from "../../src/bookings/service.js"
import { cancelBookingEmails, queueBookingEmails, rescheduleBookingEmails } from "../../src/email/booking-emails.js"
import { emailConfig, isEmailAvailable, publicAuthConfig, validateEmailConfig } from "../../src/email/config.js"
import { processSesEvent, setSnsFetchForTests, snsCanonicalString } from "../../src/email/events.js"
import {
  cancelCampaign,
  createCampaign,
  previewAudience,
  sendCampaign,
  setMarketingConsent,
  updateEmailPreferences,
} from "../../src/email/marketing.js"
import { emailRetryDelayMs, enqueueEmail, runEmailWorkerOnce } from "../../src/email/service.js"
import { TEMPLATE_NAMES, escapeHtml, renderEmail } from "../../src/email/templates.js"
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../../src/email/tokens.js"
import { assertProductionEnv } from "../../src/lib/env-check.js"

let app
test.before(async () => {
  await prepareDatabase()
  app = await startApp()
})
test.after(async () => {
  await app.stop()
  await pool.end()
})
test.beforeEach(async () => {
  sesApi.reset()
  await resetData()
  Object.assign(process.env, TEST_EMAIL_ENV)
  delete process.env.EMAIL_RECIPIENT_ALLOWLIST
})

async function customer(overrides = {}) {
  const user = await createUser(overrides)
  const email = `${user.name.split(" ")[0].toLowerCase()}.${user.id.slice(0, 8)}@customer-mail.in`
  await pool.query(`UPDATE users SET email = $2, email_verified = TRUE WHERE id = $1`, [user.id, email])
  return { ...user, email }
}

function book(person, hoursAhead) {
  return withTransaction(async client => {
    const booking = await insertBooking({ customer: person, hoursAhead, db: client })
    booking.customerEmail = person.email
    await queueBookingEmails(client, booking)
    return booking
  })
}

const reminders = (bookingId, status = "PENDING") => outbox(`booking_id = $1 AND template = 'booking_reminder' AND status = $2`, [bookingId, status])

// --- configuration ----------------------------------------------------------------------------

test("config: off needs nothing, on needs its values, phone off needs email on", () => {
  assert.deepEqual(validateEmailConfig(emailConfig({})), [])
  assert.equal(isEmailAvailable(emailConfig({})), false)
  const problems = validateEmailConfig(emailConfig({ EMAIL_ENABLED: "true" }))
  assert.ok(problems.some(p => p.includes("AWS_SES_FROM_EMAIL")))
  assert.ok(problems.some(p => p.includes("EMAIL_LINK_SECRET")))
  assert.ok(validateEmailConfig(emailConfig({ PHONE_VERIFICATION_ENABLED: "false" })).some(p => p.includes("EMAIL_VERIFICATION_ENABLED")))
  assert.ok(validateEmailConfig(emailConfig({ EMAIL_VERIFICATION_ENABLED: "true" })).some(p => p.includes("EMAIL_ENABLED")))
  assert.equal(emailConfig({}).phoneVerificationEnabled, true, "phone stays on unless switched off")
  assert.deepEqual(publicAuthConfig(emailConfig({})), { emailVerificationEnabled: false, phoneVerificationEnabled: true })
})

test("config: production refuses a half-set email configuration", () => {
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
  assert.throws(() => assertProductionEnv({ ...base, EMAIL_ENABLED: "true" }), /AWS_SES_FROM_EMAIL/)
  assert.throws(() => assertProductionEnv({ ...base, ...TEST_EMAIL_ENV, APP_PUBLIC_URL: "http://plain.test" }), /APP_PUBLIC_URL must be https/)
})

// --- templates --------------------------------------------------------------------------------

const SAMPLE = {
  verify_email: { name: "Asha Rao", verifyUrl: "https://s.test/v?token=abc", expiresInLabel: "24 hours" },
  welcome: { name: "Asha Rao" },
  account_exists: { name: "Asha Rao" },
  password_reset: { name: "Asha Rao", resetUrl: "https://s.test/r?token=abc", expiresInLabel: "30 minutes" },
  booking_confirmation: { customerName: "Asha Rao", service: "Haircut", stylistName: "Ravi", startsAt: "2026-11-02T06:30:00Z", durationMinutes: 45, payableAmount: 500, invoiceNumber: "INV-1" },
  booking_reminder: { customerName: "Asha Rao", service: "Haircut", startsAt: "2026-11-02T06:30:00Z", durationMinutes: 45 },
  booking_cancelled: { customerName: "Asha Rao", service: "Haircut", startsAt: "2026-11-02T06:30:00Z", refundAmount: 250, refundPercent: 50 },
  booking_rescheduled: { customerName: "Asha Rao", service: "Haircut", startsAt: "2026-11-02T06:30:00Z", previousStartsAt: "2026-11-01T06:30:00Z" },
  promotional: { name: "Asha Rao", subject: "Festive care", headline: "A little something", body: "Line one\n\nLine two", ctaLabel: "See offers", ctaUrl: "https://s.test/o", unsubscribeUrl: "https://s.test/u" },
}

test("templates: every message renders HTML and plain text with footer details", () => {
  const business = { businessName: "Sahasra Family Salon", addressLine1: "Red Bridge", city: "Amalapuram", state: "Andhra Pradesh", phone: "+91 72870 34555" }
  assert.deepEqual(Object.keys(SAMPLE).sort(), [...TEMPLATE_NAMES].sort())
  for (const name of TEMPLATE_NAMES) {
    const { subject, html, text } = renderEmail(name, SAMPLE[name], { appUrl: "https://sahasrafamilysalon.in", business })
    assert.ok(subject.length > 0 && subject.length < 90, `${name} subject: ${subject}`)
    assert.ok(html.startsWith("<!doctype html>"), name)
    assert.ok(html.includes("https://sahasrafamilysalon.in/email-logo.png"), name)
    assert.ok(html.includes("Red Bridge, Amalapuram, Andhra Pradesh"), name)
    assert.ok(text.includes("Red Bridge, Amalapuram, Andhra Pradesh"), name)
    assert.ok(!/<[a-z]/i.test(text), `${name} plain text must not contain markup`)
    assert.ok(!/href="\/|src="\/|http:\/\/|127\.0\.0\.1|localhost/.test(html), `${name}: links must be absolute https`)
    assert.ok(!/free!|act now|limited time|100%|click here|\$\$\$/i.test(`${subject} ${text}`), `${name}: spam-like wording`)
    assert.ok(/<title>/.test(html) && /max-width:600px/.test(html) && /@media only screen/.test(html), `${name}: layout`)
  }
})

test("templates: customer text is escaped, times are in salon time, reminders say when", () => {
  assert.equal(escapeHtml(`<a href="x">`), "&lt;a href=&quot;x&quot;&gt;")
  const hostile = renderEmail("welcome", { name: "<script>alert(1)</script> Rao" }, { appUrl: "https://s.test" })
  assert.ok(!hostile.html.includes("<script>"))
  const { subject, html } = renderEmail("booking_confirmation", SAMPLE.booking_confirmation, { appUrl: "https://s.test" })
  assert.ok(subject.includes("12:00 PM"), subject) // 06:30 UTC is noon in Asia/Kolkata
  assert.ok(html.includes("12:00 PM"))
  assert.ok(html.includes("₹500"))
  const now = new Date("2026-11-01T10:00:00Z")
  assert.match(renderEmail("booking_reminder", SAMPLE.booking_reminder, { appUrl: "https://s.test", now }).subject, /tomorrow at 12:00 PM/)
  const sameDay = new Date("2026-11-02T04:30:00Z")
  assert.match(renderEmail("booking_reminder", SAMPLE.booking_reminder, { appUrl: "https://s.test", now: sameDay }).subject, /today at 12:00 PM/)
})

test("templates: unsubscribe appears on promotions and not on service mail", () => {
  const promo = renderEmail("promotional", SAMPLE.promotional, { appUrl: "https://s.test" })
  assert.ok(promo.html.includes("Unsubscribe") && promo.text.includes("Unsubscribe: https://s.test/u"))
  assert.ok(!renderEmail("booking_reminder", SAMPLE.booking_reminder, { appUrl: "https://s.test" }).html.includes("Unsubscribe"))
})

// --- booking emails ---------------------------------------------------------------------------

test("a new booking queues a confirmation and two reminders at the right times", async () => {
  const person = await customer()
  const booking = await book(person, 30)
  const rows = await outbox(`booking_id = $1`, [booking.id])
  assert.equal(rows.filter(row => row.template === "booking_confirmation").length, 1)
  const queued = await reminders(booking.id)
  assert.equal(queued.length, 2)
  const starts = new Date(booking.startsAt).getTime()
  assert.deepEqual(queued.map(row => (starts - new Date(row.scheduled_for).getTime()) / 60_000), [1440, 120])
  await drainOutbox()
  assert.equal(sesApi.calls.length, 1, "reminders wait for their time")
  assert.match(sesApi.calls[0].subject, /is confirmed/)
  assert.equal(sesApi.calls[0].to, person.email)
})

test("close bookings skip reminders that would already have passed", async () => {
  const booking = await book(await customer(), 5)
  const queued = await reminders(booking.id)
  assert.equal(queued.length, 1)
  assert.equal(new Date(booking.startsAt).getTime() - new Date(queued[0].scheduled_for).getTime(), 120 * 60_000)
  assert.equal((await reminders((await book(await customer({ phone: "+919000000001" }), 1)).id)).length, 0)
})

test("a due reminder sends once, even across repeated worker passes and queueing", async () => {
  const person = await customer()
  const booking = await book(person, 30)
  await drainOutbox()
  sesApi.reset()
  await withTransaction(client => queueBookingEmails(client, { ...booking, customerEmail: person.email }))
  assert.equal((await reminders(booking.id)).length, 2, "queueing twice must not duplicate")
  await makeEmailsDue()
  await Promise.all([runEmailWorkerOnce(), runEmailWorkerOnce(), runEmailWorkerOnce()])
  await drainOutbox()
  assert.equal(sesApi.calls.length, 2, "one message per reminder row")
  assert.ok(sesApi.calls.every(call => /Reminder/.test(call.subject)))
  assert.equal((await reminders(booking.id, "SENT")).length, 2)
})

test("a rescheduled booking replaces reminders, tells the customer, and old ones never fire", async () => {
  const person = await customer()
  const booking = await book(person, 30)
  await drainOutbox()
  sesApi.reset()
  const moved = { ...booking, customerEmail: person.email, startsAt: new Date(new Date(booking.startsAt).getTime() + 26 * 3600_000).toISOString() }
  await pool.query(`UPDATE bookings SET starts_at = $2 WHERE id = $1`, [booking.id, moved.startsAt])
  await withTransaction(client => rescheduleBookingEmails(client, moved, { previousStartsAt: booking.startsAt, timeChanged: true }))
  assert.equal((await reminders(booking.id, "CANCELLED")).length, 2)
  const fresh = await reminders(booking.id)
  assert.equal(fresh.length, 2)
  assert.ok(fresh.every(row => new Date(row.booking_starts_at).getTime() === new Date(moved.startsAt).getTime()))
  await drainOutbox()
  assert.equal(sesApi.calls.length, 1)
  assert.match(sesApi.calls[0].subject, /has moved to/)
  assert.ok(sesApi.calls[0].text.includes("Previously"))
})

test("a reminder for a time that changed behind its back is skipped at send", async () => {
  const booking = await book(await customer(), 30)
  await drainOutbox()
  sesApi.reset()
  await pool.query(`UPDATE bookings SET starts_at = starts_at + interval '3 hours' WHERE id = $1`, [booking.id])
  await makeEmailsDue()
  await drainOutbox()
  assert.equal(sesApi.calls.length, 0)
  assert.ok((await reminders(booking.id, "SKIPPED")).every(row => row.last_error === "appointment time changed"))
})

test("a cancelled booking drops its reminders and sends the cancellation with the refund", async () => {
  const person = await customer()
  const booking = await book(person, 30)
  await drainOutbox()
  sesApi.reset()
  await pool.query(`UPDATE bookings SET status = 'CANCELLED' WHERE id = $1`, [booking.id])
  await withTransaction(client => cancelBookingEmails(client, { ...booking, customerEmail: person.email }, { refundAmount: 250, refundPercent: 50 }))
  assert.equal((await reminders(booking.id, "CANCELLED")).length, 2)
  await makeEmailsDue()
  await drainOutbox()
  assert.equal(sesApi.calls.length, 1)
  assert.match(sesApi.calls[0].subject, /has been cancelled/)
  assert.ok(sesApi.calls[0].text.includes("₹250"))
})

test("the real cancel path sends the cancellation; a lifecycle change stops reminders", async () => {
  const person = await customer()
  const booking = await book(person, 30)
  await cancelCustomerBooking({ bookingId: booking.id, actorUser: { id: person.id, email: person.email, phone: person.phone, name: person.name } })
  assert.equal((await outbox(`booking_id = $1 AND template = 'booking_cancelled'`, [booking.id])).length, 1)
  const other = await customer({ phone: "+919000000002" })
  const second = await book(other, 30)
  await pool.query(`UPDATE bookings SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`, [second.id])
  await makeEmailsDue()
  sesApi.reset()
  await drainOutbox()
  assert.ok(!sesApi.calls.some(call => call.to === other.email && /Reminder/.test(call.subject)))
})

test("a customer who turned off booking emails gets none, and promotions stay separate", async () => {
  const person = await customer()
  await updateEmailPreferences(person.id, { bookingEmails: false })
  const booking = await book(person, 30)
  await drainOutbox()
  assert.equal(sesApi.calls.length, 0)
  const [row] = await outbox(`booking_id = $1 AND template = 'booking_confirmation'`, [booking.id])
  assert.equal(row.status, "SKIPPED")
  assert.equal((await userByEmail(person.email)).marketing_email_consent, false)
})

test("with reminders switched off, none are queued and none already queued are sent", async () => {
  const person = await customer()
  const before = await book(person, 30)
  process.env.EMAIL_REMINDERS_ENABLED = "false"
  const after = await book(await customer({ phone: "+919000000003" }), 30)
  assert.equal((await reminders(after.id)).length, 0)
  await makeEmailsDue()
  await drainOutbox()
  assert.ok((await reminders(before.id, "SKIPPED")).every(row => row.last_error === "reminders are off"))
})

// --- sending ----------------------------------------------------------------------------------

test("a throttled send retries with backoff, then succeeds and records its timestamps", async () => {
  const person = await customer()
  await enqueueEmail(pool, { template: "welcome", recipient: person.email, dedupeKey: "w1", userId: person.id, payload: { name: "Asha" } })
  sesApi.respond = () => {
    throw Object.assign(new Error("Maximum sending rate exceeded."), { name: "TooManyRequestsException", $metadata: { httpStatusCode: 429 } })
  }
  assert.deepEqual(await runEmailWorkerOnce(), { RETRY: 1 })
  let [row] = await outbox()
  assert.equal(row.status, "PENDING")
  assert.equal(row.attempts, 1)
  assert.ok(new Date(row.next_attempt_at).getTime() > Date.now())
  assert.match(row.last_error, /TooManyRequests/)
  assert.deepEqual(await runEmailWorkerOnce(), {}, "not due yet")
  sesApi.respond = null
  await makeEmailsDue()
  assert.deepEqual(await runEmailWorkerOnce(), { SENT: 1 })
  ;[row] = await outbox()
  assert.equal(row.status, "SENT")
  assert.ok(row.sent_at)
  assert.ok(row.provider_message_id)
  assert.equal(row.last_error, null)
})

test("a rejected message fails at once; repeated outages stop at the attempt limit", async () => {
  const person = await customer()
  await enqueueEmail(pool, { template: "welcome", recipient: person.email, dedupeKey: "w1", userId: person.id, payload: {} })
  sesApi.respond = () => {
    throw Object.assign(new Error("Email address is not verified."), { name: "MessageRejected", $metadata: { httpStatusCode: 400 } })
  }
  assert.deepEqual(await runEmailWorkerOnce(), { FAILED: 1 })
  await enqueueEmail(pool, { template: "welcome", recipient: person.email, dedupeKey: "w2", userId: person.id, payload: {}, maxAttempts: 2 })
  sesApi.respond = () => {
    throw Object.assign(new Error("socket hang up"), { name: "Error" })
  }
  assert.deepEqual(await runEmailWorkerOnce(), { RETRY: 1 })
  await makeEmailsDue()
  assert.deepEqual(await runEmailWorkerOnce(), { FAILED: 1 })
})

test("retry delays grow and are capped", () => {
  const delays = [1, 2, 3, 12].map(emailRetryDelayMs)
  assert.ok(delays[0] >= 48_000 && delays[0] <= 72_000)
  assert.ok(delays[1] > delays[0] * 1.2)
  assert.ok(delays[3] <= 2 * 3600_000 * 1.2)
})

test("a crashed worker's claim is picked up after its lease ends", async () => {
  const person = await customer()
  await enqueueEmail(pool, { template: "welcome", recipient: person.email, dedupeKey: "w1", userId: person.id, payload: {} })
  await pool.query(`UPDATE email_messages SET status = 'SENDING', locked_until = NOW() - interval '1 second', attempts = 1`)
  assert.deepEqual(await runEmailWorkerOnce(), { SENT: 1 })
})

test("test addresses and anyone off the allowlist are skipped, never sent to SES", async () => {
  await enqueueEmail(pool, { template: "welcome", recipient: "qa@sahasra.test", dedupeKey: "t1", payload: {} })
  assert.deepEqual(await runEmailWorkerOnce(), { SKIPPED: 1 })
  process.env.EMAIL_RECIPIENT_ALLOWLIST = "success@simulator.amazonses.com"
  await enqueueEmail(pool, { template: "welcome", recipient: "real.customer@customer-mail.in", dedupeKey: "t2", payload: {} })
  await enqueueEmail(pool, { template: "welcome", recipient: "success@simulator.amazonses.com", dedupeKey: "t3", payload: {} })
  assert.deepEqual(await runEmailWorkerOnce(), { SKIPPED: 1, SENT: 1 })
  assert.deepEqual(sesApi.calls.map(call => call.to), ["success@simulator.amazonses.com"])
})

test("the configured reply-to is set and logs carry no address in full", async () => {
  const person = await customer()
  await enqueueEmail(pool, { template: "welcome", recipient: person.email, dedupeKey: "w1", userId: person.id, payload: {} })
  const seen = []
  const original = console.log
  console.log = (...args) => seen.push(JSON.stringify(args))
  await runEmailWorkerOnce().finally(() => {
    console.log = original
  })
  assert.deepEqual(sesApi.calls[0].replyTo, ["team@sahasra-test.in"])
  assert.ok(!seen.join(" ").includes(person.email))
})

// --- SES events -------------------------------------------------------------------------------

async function sentMessage(person, dedupeKey = "evt") {
  await enqueueEmail(pool, { template: "welcome", recipient: person.email, dedupeKey, userId: person.id, payload: {} })
  await drainOutbox()
  const [row] = await outbox(`dedupe_key = $1`, [dedupeKey])
  return row
}

test("delivery events are recorded once, however often SNS repeats them", async () => {
  const person = await customer()
  const row = await sentMessage(person)
  const event = { eventType: "Delivery", mail: { messageId: row.provider_message_id, destination: [person.email] }, delivery: { timestamp: "2026-11-01T10:00:00Z" } }
  assert.equal(await processSesEvent("sns-1", event), true)
  assert.equal(await processSesEvent("sns-1", event), false)
  const [updated] = await outbox(`id = $1`, [row.id])
  assert.equal(new Date(updated.delivered_at).toISOString(), "2026-11-01T10:00:00.000Z")
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM email_events`)).rows[0].n, 1)
})

test("a hard bounce suppresses the address, including mail already queued", async () => {
  const person = await customer()
  const row = await sentMessage(person)
  await enqueueEmail(pool, { template: "welcome", recipient: person.email, dedupeKey: "queued", userId: person.id, payload: {} })
  await processSesEvent("sns-2", {
    eventType: "Bounce",
    mail: { messageId: row.provider_message_id, destination: [person.email] },
    bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: person.email.toUpperCase() }], timestamp: "2026-11-01T10:00:00Z" },
  })
  const { rows } = await pool.query(`SELECT reason FROM email_suppressions WHERE email = $1`, [person.email])
  assert.equal(rows[0].reason, "BOUNCE")
  assert.equal((await outbox(`dedupe_key = 'queued'`))[0].status, "SKIPPED")
  assert.ok((await outbox(`id = $1`, [row.id]))[0].bounced_at)
  sesApi.reset()
  await enqueueEmail(pool, { template: "welcome", recipient: person.email, dedupeKey: "later", userId: person.id, payload: {} })
  await drainOutbox()
  assert.equal(sesApi.calls.length, 0, "a suppressed address is never mailed again")
})

test("a soft bounce does not suppress", async () => {
  const person = await customer()
  const row = await sentMessage(person)
  await processSesEvent("sns-3", {
    eventType: "Bounce",
    mail: { messageId: row.provider_message_id, destination: [person.email] },
    bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: person.email }] },
  })
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM email_suppressions`)).rows[0].n, 0)
})

test("a complaint suppresses the address and ends marketing consent", async () => {
  const person = await customer()
  await setMarketingConsent(pool, person.id, true, "profile")
  const row = await sentMessage(person)
  await processSesEvent("sns-4", {
    eventType: "Complaint",
    mail: { messageId: row.provider_message_id, destination: [person.email] },
    complaint: { complainedRecipients: [{ emailAddress: person.email }], complaintFeedbackType: "abuse" },
  })
  const user = await userByEmail(person.email)
  assert.equal(user.marketing_email_consent, false)
  assert.ok(user.marketing_email_unsubscribed_at)
  assert.equal((await pool.query(`SELECT reason FROM email_suppressions`)).rows[0].reason, "COMPLAINT")
})

function signedSns(message, key, cert) {
  const body = {
    SignatureVersion: "2",
    SigningCertURL: "https://sns.ap-southeast-2.amazonaws.com/cert.pem",
    TopicArn: TEST_EMAIL_ENV.AWS_SES_EVENTS_TOPIC_ARN,
    Timestamp: "2026-11-01T10:00:00.000Z",
    MessageId: randomUUID(),
    ...message,
  }
  body.Signature = createSign("RSA-SHA256").update(snsCanonicalString(body), "utf8").sign(key, "base64")
  setSnsFetchForTests(async url => {
    if (`${url}`.endsWith("cert.pem")) return new Response(cert)
    return new Response("ok")
  })
  return body
}

function selfSignedPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  return { key: privateKey, cert: publicKey.export({ type: "spki", format: "pem" }) }
}

test("the webhook acts on a genuine signed notification and refuses everything else", async () => {
  const { key, cert } = selfSignedPair()
  const person = await customer()
  const row = await sentMessage(person)
  const post = body => fetch(`${app.base}/api/webhooks/ses`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) })
  const event = { eventType: "Delivery", mail: { messageId: row.provider_message_id, destination: [person.email] }, delivery: {} }

  const good = signedSns({ Type: "Notification", Message: JSON.stringify(event) }, key, cert)
  assert.equal((await post(good)).status, 200)
  assert.ok((await outbox(`id = $1`, [row.id]))[0].delivered_at)

  const tampered = { ...good, MessageId: randomUUID(), Message: JSON.stringify({ ...event, eventType: "Complaint" }) }
  assert.equal((await post(tampered)).status, 403)

  const otherTopic = signedSns({ Type: "Notification", Message: "{}", TopicArn: "arn:aws:sns:ap-southeast-2:1:other" }, key, cert)
  assert.equal((await post(otherTopic)).status, 403)

  const badHost = { ...good, MessageId: randomUUID(), SigningCertURL: "https://evil.example/cert.pem" }
  assert.equal((await post(badHost)).status, 403)

  const notJson = await fetch(`${app.base}/api/webhooks/ses`, { method: "POST", body: "nope" })
  assert.equal(notJson.status, 400)
  setSnsFetchForTests(null)
})

test("the webhook confirms its subscription only at an SNS address", async () => {
  const { key, cert } = selfSignedPair()
  const requested = []
  const body = signedSns({ Type: "SubscriptionConfirmation", Message: "confirm", Token: "t", SubscribeURL: "https://sns.ap-southeast-2.amazonaws.com/?Action=ConfirmSubscription" }, key, cert)
  setSnsFetchForTests(async url => {
    requested.push(`${url}`)
    return `${url}`.endsWith("cert.pem") ? new Response(cert) : new Response("ok")
  })
  const post = payload => fetch(`${app.base}/api/webhooks/ses`, { method: "POST", body: JSON.stringify(payload) })
  assert.equal((await post(body)).status, 200)
  assert.ok(requested.some(url => url.includes("ConfirmSubscription")))
  const evil = signedSns({ Type: "SubscriptionConfirmation", Message: "confirm", Token: "t", SubscribeURL: "https://evil.example/x" }, key, cert)
  assert.equal((await post(evil)).status, 403)
  setSnsFetchForTests(null)
})

// --- marketing --------------------------------------------------------------------------------

const CAMPAIGN = { name: "Festive", subject: "Festive care at Sahasra", headline: "Time for a little care", body: "Hair spa this month.\n\nBook whenever suits you.", ctaLabel: "See offers", ctaPath: "/user-dashboard/offers" }

async function consenting(overrides = {}) {
  const person = await customer(overrides)
  await pool.query(`UPDATE users SET account_status = 'ACTIVE' WHERE id = $1`, [person.id])
  await setMarketingConsent(pool, person.id, true, "profile")
  return person
}

test("consent is off by default and a campaign reaches only those who opted in", async () => {
  await customer({ name: "No Consent" })
  assert.equal((await previewAudience({})).recipients, 0)
  const person = await consenting({ phone: "+919000000011" })
  const { rows } = await pool.query(`SELECT marketing_email_consent, marketing_email_consent_at, marketing_email_consent_source FROM users WHERE id = $1`, [person.id])
  assert.equal(rows[0].marketing_email_consent_source, "profile")
  assert.ok(rows[0].marketing_email_consent_at)
  const campaign = await createCampaign(CAMPAIGN, null)
  assert.deepEqual(await sendCampaign(campaign.id), { recipients: 1 })
  await drainOutbox()
  assert.equal(sesApi.calls.length, 1)
  const [mail] = sesApi.calls
  assert.equal(mail.to, person.email)
  assert.equal(mail.configurationSet, "test-marketing")
  assert.ok(mail.html.includes("https://sahasra-test.in/email/unsubscribe?token="))
  assert.ok(mail.text.includes("https://sahasra-test.in/user-dashboard/offers"))
  const headers = Object.fromEntries(mail.headers.map(({ Name, Value }) => [Name, Value]))
  assert.match(headers["List-Unsubscribe"], /^<https:\/\/api\.sahasra-test\.in\/api\/email\/unsubscribe\?token=/)
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click")
})

test("the audience excludes unverified, unsubscribed, suppressed and inactive customers", async () => {
  await consenting({ phone: "+919000000021" })
  const unverified = await consenting({ phone: "+919000000022" })
  await pool.query(`UPDATE users SET email_verified = FALSE WHERE id = $1`, [unverified.id])
  const suppressed = await consenting({ phone: "+919000000023" })
  await pool.query(`INSERT INTO email_suppressions (email, reason) VALUES ($1, 'BOUNCE')`, [suppressed.email])
  const left = await consenting({ phone: "+919000000024" })
  await setMarketingConsent(pool, left.id, false, "profile")
  const pending = await consenting({ phone: "+919000000025" })
  await pool.query(`UPDATE users SET account_status = 'PENDING_VERIFICATION' WHERE id = $1`, [pending.id])
  assert.equal((await previewAudience({})).recipients, 1)
})

test("targeting narrows by membership, gender and visit history; unknown filters are dropped", async () => {
  const gold = await consenting({ phone: "+919000000031", segment: "GOLD" })
  await pool.query(`UPDATE users SET gender = 'FEMALE' WHERE id = $1`, [gold.id])
  await consenting({ phone: "+919000000032" })
  assert.equal((await previewAudience({ membershipSegments: ["gold"] })).recipients, 1)
  assert.equal((await previewAudience({ genders: ["FEMALE"] })).recipients, 1)
  const booking = await book(gold, 30)
  await pool.query(`UPDATE bookings SET status = 'COMPLETED', starts_at = NOW() - interval '5 days' WHERE id = $1`, [booking.id])
  assert.equal((await previewAudience({ visitedWithinDays: 30 })).recipients, 1)
  assert.equal((await previewAudience({ inactiveForDays: 30 })).recipients, 1)
  assert.equal((await previewAudience({ membershipSegments: ["'; DROP TABLE users; --"] })).recipients, 2)
})

test("a campaign is sent once however often send is pressed, and only drafts can start", async () => {
  await consenting({ phone: "+919000000041" })
  const campaign = await createCampaign(CAMPAIGN, null)
  await sendCampaign(campaign.id)
  await assert.rejects(sendCampaign(campaign.id), /already been sent/)
  await drainOutbox()
  assert.equal(sesApi.calls.length, 1)
})

test("consent is re-checked at send, so unsubscribing mid-campaign stops the mail", async () => {
  const person = await consenting({ phone: "+919000000051" })
  const campaign = await createCampaign(CAMPAIGN, null)
  await sendCampaign(campaign.id)
  await setMarketingConsent(pool, person.id, false, "profile")
  await drainOutbox()
  assert.equal(sesApi.calls.length, 0)
  assert.equal((await outbox(`campaign_id = $1`, [campaign.id]))[0].last_error, "no marketing consent")
})

test("marketing off: nothing can start, nothing queued goes out", async () => {
  await consenting({ phone: "+919000000052" })
  const campaign = await createCampaign(CAMPAIGN, null)
  await sendCampaign(campaign.id)
  process.env.EMAIL_MARKETING_ENABLED = "false"
  await drainOutbox()
  assert.equal(sesApi.calls.length, 0)
  const second = await createCampaign(CAMPAIGN, null)
  await assert.rejects(sendCampaign(second.id), /switched off/)
})

test("the daily ceiling makes promotions wait while service mail still goes", async () => {
  await consenting({ phone: "+919000000053" })
  const service = await customer({ phone: "+919000000054" })
  process.env.EMAIL_MARKETING_DAILY_LIMIT = "0"
  const campaign = await createCampaign(CAMPAIGN, null)
  await sendCampaign(campaign.id)
  await enqueueEmail(pool, { template: "welcome", recipient: service.email, dedupeKey: "svc", userId: service.id, payload: {} })
  await drainOutbox()
  delete process.env.EMAIL_MARKETING_DAILY_LIMIT
  assert.deepEqual(sesApi.calls.map(call => call.to), [service.email])
  assert.equal((await outbox(`campaign_id = $1`, [campaign.id]))[0].status, "PENDING")
})

test("cancelling a campaign stops what is still queued", async () => {
  await consenting({ phone: "+919000000055" })
  const campaign = await createCampaign(CAMPAIGN, null)
  await sendCampaign(campaign.id)
  assert.deepEqual(await cancelCampaign(campaign.id), { cancelled: 1 })
  await drainOutbox()
  assert.equal(sesApi.calls.length, 0)
})

test("campaign content is validated and links must stay on the site", async () => {
  await assert.rejects(createCampaign({ ...CAMPAIGN, subject: "" }, null), /subject is required/)
  await assert.rejects(createCampaign({ ...CAMPAIGN, ctaPath: "https://evil.example" }, null), /path on the Sahasra site/)
})

test("unsubscribe: signed links only, works without sign-in, one-click and page, repeatable", async () => {
  const person = await consenting({ phone: "+919000000061" })
  const secret = TEST_EMAIL_ENV.EMAIL_LINK_SECRET
  const token = signUnsubscribeToken(person.id, secret)
  assert.equal(verifyUnsubscribeToken(token, secret), person.id)
  assert.equal(verifyUnsubscribeToken(`${person.id}.forged`, secret), null)
  assert.equal(verifyUnsubscribeToken(token, "another-secret"), null)

  const forged = await app.post("/api/email/unsubscribe", { token: `${person.id}.forged` })
  assert.equal(forged.status, 400)
  assert.equal((await userByEmail(person.email)).marketing_email_consent, true)

  const campaign = await createCampaign(CAMPAIGN, null)
  await sendCampaign(campaign.id)
  // What a mail provider sends for RFC 8058 one-click.
  const oneClick = await fetch(`${app.base}/api/email/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  })
  assert.equal(oneClick.status, 200)
  const user = await userByEmail(person.email)
  assert.equal(user.marketing_email_consent, false)
  assert.ok(user.marketing_email_unsubscribed_at)
  assert.equal(user.marketing_email_consent_source, "one_click")
  assert.equal((await outbox(`campaign_id = $1`, [campaign.id]))[0].status, "CANCELLED")
  assert.equal((await app.post("/api/email/unsubscribe", { token })).status, 200, "repeating is harmless")
  assert.equal((await previewAudience({})).recipients, 0)
  await drainOutbox()
  assert.equal(sesApi.calls.length, 0)
})

test("turning consent back on clears the unsubscribe and records when", async () => {
  const person = await consenting({ phone: "+919000000062" })
  await updateEmailPreferences(person.id, { marketingEmails: false })
  const on = await updateEmailPreferences(person.id, { marketingEmails: true })
  assert.equal(on.marketingEmails, true)
  assert.equal(on.marketingUnsubscribedAt, null)
  assert.ok(on.marketingConsentAt)
  assert.equal(on.bookingEmails, true)
})

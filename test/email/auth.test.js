// Registration by email link, login, resend, password reset, and what must stay untouched.
import { sesApi, TEST_EMAIL_ENV } from "../helpers/setup.js"
import test from "node:test"
import assert from "node:assert/strict"
import bcrypt from "bcryptjs"
import { randomUUID } from "node:crypto"
import admin from "firebase-admin"
import { createUser, pool, prepareDatabase, resetData } from "../helpers/fixtures.js"
import { drainOutbox, linkToken, outbox, registration, startApp, userByEmail } from "./helpers.js"
import { claimPendingSignup } from "../../src/auth/email-accounts.js"
import { hashToken } from "../../src/email/tokens.js"
import { runEmailMaintenance } from "../../src/email/service.js"

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
})

async function registerAndGetLink(overrides) {
  const form = registration(overrides)
  const response = await app.post("/api/auth/register", form)
  assert.equal(response.status, 202)
  await drainOutbox()
  const mail = sesApi.calls.at(-1)
  return { form, mail, token: linkToken(mail) }
}

/** Replaces token verification, so a test decides what a Firebase session proves. */
function stubFirebase(claims) {
  const real = admin.auth
  Object.defineProperty(admin, "auth", { configurable: true, writable: true, value: () => ({ ...real.call(admin), verifyIdToken: async () => claims() }) })
  return () => Object.defineProperty(admin, "auth", { configurable: true, writable: true, value: real })
}

const login = (email, password) => app.post("/api/auth/login", { email, password })

test("registration creates a pending, unverified account and mails a link", async () => {
  const { form, mail, token } = await registerAndGetLink()
  const user = await userByEmail(form.email)
  assert.equal(user.account_status, "PENDING_VERIFICATION")
  assert.equal(user.email_verified, false)
  assert.equal(user.phone_verified, false)
  assert.ok(user.pending_email_signup_at)
  assert.ok(await bcrypt.compare(form.password, user.password_hash))
  assert.equal(mail.to, form.email)
  assert.match(mail.subject, /Confirm your email/)
  assert.ok(mail.text.includes(`https://sahasra-test.in/auth/verify-email?token=${token}`))
  assert.ok(mail.html.includes("/auth/verify-email?token="))
  assert.equal(mail.configurationSet, "test-transactional")
  assert.equal(mail.from, '"Sahasra Family Salon" <support@sahasra-test.in>')
})

test("only the token's hash is stored, and neither table holds the raw value", async () => {
  const { token } = await registerAndGetLink()
  const { rows } = await pool.query(`SELECT token_hash FROM email_tokens`)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].token_hash, hashToken(token))
  assert.notEqual(rows[0].token_hash, token)
  const [message] = await outbox()
  assert.ok(!JSON.stringify(message).includes(token))
})

test("validation rejects bad input and creates nothing", async () => {
  for (const bad of [{ email: "nope" }, { password: "short" }, { password: "x".repeat(73) }, { name: "A" }, { phone: "123" }, { gender: "" }]) {
    const response = await app.post("/api/auth/register", registration(bad))
    assert.equal(response.status, 400, JSON.stringify(bad))
  }
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n, 0)
})

test("a duplicate email gets the same answer and a note to the mailbox, not a new account", async () => {
  const { form, token } = await registerAndGetLink()
  await app.post("/api/auth/verify-email", { token })
  await drainOutbox()
  sesApi.reset()
  const fresh = await app.post("/api/auth/register", registration({ email: "someone-new@customer-mail.in", phone: "+919876500002" }))
  const duplicate = await app.post("/api/auth/register", registration({ email: form.email.toUpperCase(), phone: "+919876500003", password: "another-pass-9" }))
  assert.equal(duplicate.status, fresh.status)
  assert.deepEqual(duplicate.body, fresh.body)
  await drainOutbox()
  const note = sesApi.calls.find(call => call.to === form.email)
  assert.match(note.subject, /Sign-in help/)
  const user = await userByEmail(form.email)
  assert.ok(await bcrypt.compare(form.password, user.password_hash), "existing password must not change")
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE phone = '+919876500003'`)).rows[0].n, 0)
})

test("a phone number already in use is refused without saying anything about the email", async () => {
  await createUser({ phone: "+919876500009" })
  const response = await app.post("/api/auth/register", registration({ phone: "+919876500009" }))
  assert.equal(response.status, 409)
  assert.equal(response.body.error, "PHONE_IN_USE")
})

test("login before verification is refused; a wrong password looks like any other", async () => {
  const { form } = await registerAndGetLink()
  const right = await login(form.email, form.password)
  assert.equal(right.status, 403)
  assert.equal(right.body.error, "EMAIL_NOT_VERIFIED")
  assert.equal(right.headers.get("set-cookie"), null)
  const wrong = await login(form.email, "not-the-password")
  const unknown = await login("nobody@customer-mail.in", "not-the-password")
  assert.equal(wrong.status, 401)
  assert.deepEqual(wrong.body, unknown.body)
})

test("verification activates the account, sends a welcome, and login then works", async () => {
  const { form, token } = await registerAndGetLink()
  const verified = await app.post("/api/auth/verify-email", { token })
  assert.equal(verified.status, 200)
  assert.equal(verified.body.status, "VERIFIED")
  const user = await userByEmail(form.email)
  assert.equal(user.account_status, "ACTIVE")
  assert.equal(user.email_verified, true)
  assert.equal(user.phone_verified, false, "phone must not be marked verified")
  assert.equal(user.pending_email_signup_at, null)
  await drainOutbox()
  assert.match(sesApi.calls.at(-1).subject, /Welcome to Sahasra/)
  const session = await login(form.email, form.password)
  assert.equal(session.status, 200)
  assert.match(session.headers.get("set-cookie"), /app_access_token=/)
})

test("a used link says already verified and changes nothing; garbage is invalid", async () => {
  const { token } = await registerAndGetLink()
  await app.post("/api/auth/verify-email", { token })
  const again = await app.post("/api/auth/verify-email", { token })
  assert.equal(again.body.status, "ALREADY_VERIFIED")
  assert.equal(sesApi.calls.filter(call => /Welcome/.test(call.subject)).length, 0)
  const garbage = await app.post("/api/auth/verify-email", { token: "not-a-token" })
  assert.equal(garbage.status, 400)
  assert.equal(garbage.body.status, "INVALID")
})

test("an expired link is refused and the account stays pending", async () => {
  const { form, token } = await registerAndGetLink()
  await pool.query(`UPDATE email_tokens SET expires_at = NOW() - interval '1 minute'`)
  const response = await app.post("/api/auth/verify-email", { token })
  assert.equal(response.status, 400)
  assert.equal(response.body.status, "EXPIRED")
  assert.equal((await userByEmail(form.email)).account_status, "PENDING_VERIFICATION")
})

test("simultaneous clicks activate once and welcome once", async () => {
  const { token } = await registerAndGetLink()
  const results = await Promise.all(Array.from({ length: 6 }, () => app.post("/api/auth/verify-email", { token })))
  assert.equal(results.filter(result => result.body.status === "VERIFIED").length, 1)
  assert.equal(results.filter(result => result.body.status === "ALREADY_VERIFIED").length, 5)
  assert.equal((await outbox(`template = 'welcome'`)).length, 1)
})

test("resend issues a new link and retires the old one; unknown addresses look identical", async () => {
  const { form, token: first } = await registerAndGetLink()
  const resent = await app.post("/api/auth/resend-verification", { email: form.email })
  const unknown = await app.post("/api/auth/resend-verification", { email: "nobody@customer-mail.in" })
  assert.equal(resent.status, 202)
  assert.deepEqual(resent.body, unknown.body)
  await drainOutbox()
  const second = linkToken(sesApi.calls.at(-1))
  assert.notEqual(second, first)
  assert.equal((await app.post("/api/auth/verify-email", { token: first })).body.status, "EXPIRED")
  assert.equal((await app.post("/api/auth/verify-email", { token: second })).body.status, "VERIFIED")
})

test("per-account limits stop a mailbox being flooded", async () => {
  process.env.EMAIL_REQUEST_COOLDOWN_SECONDS = "60"
  const { form } = await registerAndGetLink()
  for (let i = 0; i < 3; i += 1) await app.post("/api/auth/resend-verification", { email: form.email })
  assert.equal((await outbox(`template = 'verify_email'`)).length, 1)
})

test("registering again before confirming replaces the details and sends a fresh link", async () => {
  const { form } = await registerAndGetLink()
  await app.post("/api/auth/register", registration({ password: "second-password-2", name: "Asha Devi Rao" }))
  await drainOutbox()
  const user = await userByEmail(form.email)
  assert.equal(user.name, "Asha Devi Rao")
  assert.ok(await bcrypt.compare("second-password-2", user.password_hash))
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n, 1)
})

test("consent from the signup form is applied only when the address is confirmed", async () => {
  const { form, token } = await registerAndGetLink({ marketingConsent: true })
  assert.equal((await userByEmail(form.email)).marketing_email_consent, false)
  await app.post("/api/auth/verify-email", { token })
  const user = await userByEmail(form.email)
  assert.equal(user.marketing_email_consent, true)
  assert.equal(user.marketing_email_consent_source, "signup")
  assert.ok(user.marketing_email_consent_at)
})

test("password reset: same answer for any address, single use, sessions revoked", async () => {
  const { form, token } = await registerAndGetLink()
  await app.post("/api/auth/verify-email", { token })
  await drainOutbox()
  await pool.query(`UPDATE users SET app_session_epoch = 3 WHERE lower(email) = $1`, [form.email])
  sesApi.reset()

  const known = await app.post("/api/auth/request-password-reset", { email: form.email })
  const unknown = await app.post("/api/auth/request-password-reset", { email: "nobody@customer-mail.in" })
  assert.equal(known.status, 200)
  assert.deepEqual(known.body, unknown.body)
  await drainOutbox()
  assert.equal(sesApi.calls.length, 1)
  const resetToken = linkToken(sesApi.calls[0])
  assert.match(sesApi.calls[0].subject, /Reset your/)
  assert.ok(sesApi.calls[0].text.includes("/auth/reset-password?token="))

  const check = await app.post("/api/auth/password-reset/validate", { token: resetToken })
  assert.equal(check.body.valid, true)
  assert.ok(!`${check.body.emailHint}`.includes("asha@"))

  assert.equal((await app.post("/api/auth/password-reset/complete", { token: resetToken, newPassword: "short" })).status, 400)
  const done = await app.post("/api/auth/password-reset/complete", { token: resetToken, newPassword: "brand-new-pass-3" })
  assert.equal(done.status, 200)
  const user = await userByEmail(form.email)
  assert.ok(await bcrypt.compare("brand-new-pass-3", user.password_hash))
  assert.equal(user.app_session_epoch, 4, "existing sessions must be revoked")
  assert.equal((await login(form.email, form.password)).status, 401)
  assert.equal((await login(form.email, "brand-new-pass-3")).status, 200)

  const reused = await app.post("/api/auth/password-reset/complete", { token: resetToken, newPassword: "yet-another-pass-4" })
  assert.equal(reused.status, 400)
  assert.equal(reused.body.error, "RESET_LINK_INVALID")
  assert.equal((await app.post("/api/auth/password-reset/validate", { token: resetToken })).body.valid, false)
})

test("password reset: an expired token is refused and the password stays", async () => {
  const { form, token } = await registerAndGetLink()
  await app.post("/api/auth/verify-email", { token })
  await app.post("/api/auth/request-password-reset", { email: form.email })
  await drainOutbox()
  const resetToken = linkToken(sesApi.calls.at(-1))
  await pool.query(`UPDATE email_tokens SET expires_at = NOW() - interval '1 minute' WHERE purpose = 'RESET_PASSWORD'`)
  assert.equal((await app.post("/api/auth/password-reset/validate", { token: resetToken })).body.valid, false)
  assert.equal((await app.post("/api/auth/password-reset/complete", { token: resetToken, newPassword: "brand-new-pass-3" })).status, 400)
  assert.ok(await bcrypt.compare(form.password, (await userByEmail(form.email)).password_hash))
})

test("password reset: simultaneous submits cannot both win", async () => {
  const { form, token } = await registerAndGetLink()
  await app.post("/api/auth/verify-email", { token })
  await app.post("/api/auth/request-password-reset", { email: form.email })
  await drainOutbox()
  const resetToken = linkToken(sesApi.calls.at(-1))
  const results = await Promise.all(
    ["racing-pass-one1", "racing-pass-two2", "racing-pass-three3"].map(newPassword =>
      app.post("/api/auth/password-reset/complete", { token: resetToken, newPassword })
    )
  )
  assert.equal(results.filter(result => result.status === 200).length, 1)
})

test("a reset finishes a pending signup and replaces the unproven password", async () => {
  const { form } = await registerAndGetLink()
  await app.post("/api/auth/request-password-reset", { email: form.email })
  await drainOutbox()
  await app.post("/api/auth/password-reset/complete", { token: linkToken(sesApi.calls.at(-1)), newPassword: "owner-chose-this-1" })
  const user = await userByEmail(form.email)
  assert.equal(user.account_status, "ACTIVE")
  assert.equal(user.pending_email_signup_at, null)
  assert.equal((await login(form.email, form.password)).status, 401)
})

test("walk-in accounts: not blocked as signups, never purged, activated by a reset", async () => {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO users (id, name, email, phone, role, account_status, latitude, longitude) VALUES ($1, 'Walk In', 'walkin@customer-mail.in', '+919876500077', 'USER', 'PENDING_VERIFICATION', 0, 0)`,
    [id]
  )
  await pool.query(`UPDATE users SET created_at = NOW() - interval '60 days'`)
  await runEmailMaintenance({ config: { pendingSignupRetentionHours: 24 } })
  assert.ok(await userByEmail("walkin@customer-mail.in"), "maintenance must not delete a walk-in")
  const attempt = await login("walkin@customer-mail.in", "whatever-pass")
  assert.equal(attempt.body.error, "SET_PASSWORD_REQUIRED")
  await app.post("/api/auth/request-password-reset", { email: "walkin@customer-mail.in" })
  await drainOutbox()
  await app.post("/api/auth/password-reset/complete", { token: linkToken(sesApi.calls.at(-1)), newPassword: "first-password-1" })
  assert.equal((await userByEmail("walkin@customer-mail.in")).account_status, "ACTIVE")
  assert.equal((await login("walkin@customer-mail.in", "first-password-1")).status, 200)
})

test("abandoned signups are removed after the retention window, recent ones stay", async () => {
  const { form } = await registerAndGetLink()
  await runEmailMaintenance({ config: { pendingSignupRetentionHours: 24 } })
  assert.ok(await userByEmail(form.email))
  await pool.query(`UPDATE users SET pending_email_signup_at = NOW() - interval '2 days'`)
  await runEmailMaintenance({ config: { pendingSignupRetentionHours: 24 } })
  assert.equal(await userByEmail(form.email), null)
})

test("existing verified customers can still sign in", async () => {
  const hash = await bcrypt.hash("old-customer-pass", 4)
  await pool.query(
    `INSERT INTO users (id, name, email, phone, role, account_status, latitude, longitude, password_hash, email_verified, phone_verified, auth_provider)
     VALUES ($1, 'Old Customer', 'old@customer-mail.in', '+919876500055', 'USER', 'ACTIVE', 0, 0, $2, TRUE, TRUE, 'PASSWORD')`,
    [randomUUID(), hash]
  )
  assert.equal((await login("old@customer-mail.in", "old-customer-pass")).status, 200)
})

test("Google arriving at a pending signup claims it and erases the unproven password", async () => {
  const { form, token } = await registerAndGetLink({ marketingConsent: true })
  const before = await userByEmail(form.email)
  await claimPendingSignup(before.id, {
    uid: "firebase-uid-1",
    email: form.email,
    email_verified: true,
    name: "Asha Rao",
    firebase: { sign_in_provider: "google.com" },
  })
  const user = await userByEmail(form.email)
  assert.equal(user.account_status, "ACTIVE")
  assert.equal(user.email_verified, true)
  assert.equal(user.password_hash, null, "a password set before the mailbox was proven must not survive")
  assert.equal(user.auth_provider, "GOOGLE")
  assert.equal(user.firebase_uid, "firebase-uid-1")
  assert.equal(user.marketing_email_consent, false, "consent typed by an unproven registrant must not apply")
  assert.equal((await app.post("/api/auth/verify-email", { token })).body.status, "EXPIRED")
  assert.equal((await login(form.email, form.password)).body.error, "GOOGLE_ACCOUNT")
})

test("/session: Google sign-in still works, and phone rules follow the flag", async () => {
  const claims = {}
  const restore = stubFirebase(() => claims.value)
  const session = async headers => {
    const response = await fetch(`${app.base}/api/auth/session`, { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json", ...headers }, body: "{}" })
    return { status: response.status, body: await response.json() }
  }
  try {
    claims.value = { uid: "g-1", email: "google.user@gmail-test.in", email_verified: true, firebase: { sign_in_provider: "google.com" } }
    const signupHeaders = { "x-user-name": "Google User", "x-user-phone": "+919876500021", "x-user-gender": "MALE" }

    process.env.PHONE_VERIFICATION_ENABLED = "true"
    const blocked = await session(signupHeaders)
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.error, "PHONE_NOT_VERIFIED")

    process.env.PHONE_VERIFICATION_ENABLED = "false"
    const created = await session(signupHeaders)
    assert.equal(created.status, 200)
    assert.equal(created.body.user.phoneVerified, false, "an unconfirmed number must stay unverified")
    assert.equal(created.body.user.emailVerified, true)
    assert.equal(created.body.user.phone, "+919876500021")

    const returning = await session({})
    assert.equal(returning.status, 200)
    assert.equal(returning.body.user.id, created.body.user.id)

    claims.value = { uid: "g-2", email: "other@gmail-test.in", email_verified: true, firebase: { sign_in_provider: "google.com" } }
    const taken = await session({ ...signupHeaders })
    assert.equal(taken.status, 409)
    assert.equal(taken.body.error, "PHONE_IN_USE")

    claims.value = { uid: "g-3", email: "unconfirmed@gmail-test.in", email_verified: false, firebase: { sign_in_provider: "password" } }
    const unverified = await session({ ...signupHeaders, "x-user-phone": "+919876500022" })
    assert.equal(unverified.status, 403)
    assert.equal(unverified.body.error, "EMAIL_NOT_VERIFIED")
  } finally {
    restore()
  }
})

test("/session: a verified phone cannot open a pending signup", async () => {
  await registerAndGetLink({ phone: "+919876500031" })
  const restore = stubFirebase(() => ({ uid: "p-1", phone_number: "+919876500031", firebase: { sign_in_provider: "phone" } }))
  try {
    const response = await fetch(`${app.base}/api/auth/session`, { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: "{}" })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error, "EMAIL_NOT_VERIFIED")
  } finally {
    restore()
  }
})

test("email-exists stops answering once email registration is on; config reports the flags", async () => {
  const { form } = await registerAndGetLink()
  const response = await fetch(`${app.base}/api/auth/email-exists?email=${encodeURIComponent(form.email)}`)
  assert.deepEqual(await response.json(), { exists: false })
  const config = await (await fetch(`${app.base}/api/auth/config`)).json()
  assert.deepEqual(config, { emailVerificationEnabled: true, phoneVerificationEnabled: false })
})

test("with the flag off, /register does not exist", async () => {
  process.env.EMAIL_VERIFICATION_ENABLED = "false"
  process.env.PHONE_VERIFICATION_ENABLED = "true"
  const response = await app.post("/api/auth/register", registration())
  assert.equal(response.status, 404)
})

/**
 * Registration and password recovery by email, without Firebase in the path.
 *
 * A registration creates a `users` row marked by `pending_email_signup_at`, and that marker, not
 * `account_status`, is what "waiting for the email link" means. Reception also creates accounts
 * as PENDING_VERIFICATION, and those are real customers: they must not be blocked at login as
 * unconfirmed signups, and the cleanup job must never delete them.
 *
 * The HTTP answers never say whether an address is registered. Every path hashes the password,
 * so timing does not tell either, and what differs (a link, or a note that an account exists)
 * goes to the mailbox, which only its owner can read.
 */
import admin from "firebase-admin"
import { randomUUID } from "node:crypto"
import bcrypt from "bcryptjs"
import { pool } from "../lib/db-pool.js"
import { auditAuthAsync } from "../lib/audit-log.js"
import { AUTH_PROVIDER_PASSWORD, resolveSignupAuthProvider } from "../lib/auth-provider.js"
import { parseSelectableGender } from "../lib/gender.js"
import { isValidFullName, normalizeName } from "../lib/validation.js"
import { applyReferralOnSignup } from "../loyalty/service.js"
import { emailConfig } from "../email/config.js"
import { setMarketingConsent } from "../email/marketing.js"
import { enqueueEmail, kickEmailWorker, maskEmail, normalizeEmailAddress } from "../email/service.js"
import {
  TOKEN_RESET_PASSWORD,
  TOKEN_VERIFY_EMAIL,
  consumeEmailToken,
  inspectEmailToken,
  invalidateUserTokens,
} from "../email/tokens.js"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const E164_RE = /^\+[1-9]\d{7,14}$/
const BCRYPT_ROUNDS = 12

function reject(status, error) {
  return Object.assign(new Error(error), { status, expose: true })
}

export function isValidPhoneNumber(phone) {
  return E164_RE.test(`${phone ?? ""}`)
}

/** Same rule as staff setup. bcrypt ignores everything past 72 bytes, so longer is refused. */
export function isAcceptablePassword(password) {
  return `${password ?? ""}`.length >= 8 && Buffer.byteLength(`${password ?? ""}`) <= 72
}

async function inTransaction(run) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await run(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/**
 * Per-account ceiling on mail triggered from an unauthenticated form. The IP limiters stop one
 * attacker hammering; this stops many addresses being used to flood one person's inbox.
 */
async function mayEmailAccount(db, userId, templates, config) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS hourly,
            COUNT(*) FILTER (WHERE created_at > NOW() - make_interval(secs => $3))::int AS recent
       FROM email_messages
      WHERE user_id = $1 AND template = ANY($2::text[]) AND created_at > NOW() - interval '1 hour'`,
    [userId, templates, config.requestCooldownSeconds]
  )
  return rows[0].recent === 0 && rows[0].hourly < config.requestHourlyLimit
}

function enqueueVerification(db, user) {
  return enqueueEmail(db, { template: "verify_email", recipient: user.email, dedupeKey: `verify:${user.id}:${randomUUID()}`, userId: user.id })
}

function enqueueWelcome(db, user) {
  return enqueueEmail(db, {
    template: "welcome",
    recipient: user.email,
    dedupeKey: `welcome:${user.id}`,
    userId: user.id,
    payload: { name: user.name },
  })
}

/** For a Firebase (Google) registration, which needs no link: the address is already proven. */
export async function welcomeNewAccount(user) {
  await enqueueWelcome(pool, user)
  kickEmailWorker()
}

/**
 * Validates and stores a registration, then queues the right mail. Resolves the same way
 * whether or not the address was new. The one refusal is a phone number already in use, which
 * the public phone-exists check tells anyone anyway and which says nothing about the email.
 */
export async function registerCustomer({ name, email, password, phone, gender, marketingConsent, referralCode, deviceId, ip }, config = emailConfig()) {
  const cleanName = normalizeName(name)
  const cleanEmail = normalizeEmailAddress(email)
  const cleanPhone = `${phone ?? ""}`.trim()
  const cleanGender = parseSelectableGender(gender)
  if (!isValidFullName(cleanName)) throw reject(400, "Please enter your full name (at least 4 valid letters).")
  if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 254) throw reject(400, "Please enter a valid email address.")
  if (!isAcceptablePassword(password)) throw reject(400, "Password must be between 8 and 72 characters")
  if (!isValidPhoneNumber(cleanPhone)) throw reject(400, "Please enter a valid phone number.")
  if (!cleanGender) throw reject(400, "Please select your gender to complete registration")

  // Before any lookup, so a known address and an unknown one take the same time.
  const passwordHash = await bcrypt.hash(`${password}`, BCRYPT_ROUNDS)
  const meta = JSON.stringify({
    marketingConsent: marketingConsent === true,
    referralCode: `${referralCode ?? ""}`.trim().toUpperCase().slice(0, 64),
    deviceId: `${deviceId ?? ""}`.trim().slice(0, 255),
    ip,
  })

  try {
    await inTransaction(async client => {
      const { rows } = await client.query(
        `SELECT id, name, email, phone, pending_email_signup_at
           FROM users WHERE lower(btrim(email)) = $1 OR phone = $2
          FOR UPDATE`,
        [cleanEmail, cleanPhone]
      )
      const byEmail = rows.find(row => normalizeEmailAddress(row.email) === cleanEmail) ?? null
      const byPhone = rows.find(row => row.phone === cleanPhone) ?? null
      if (byPhone && !(byPhone.id === byEmail?.id && byEmail.pending_email_signup_at)) {
        throw reject(409, "PHONE_IN_USE")
      }
      if (byEmail?.pending_email_signup_at) {
        // Trying again before confirming: the newest details win, and the link goes out again.
        await client.query(
          `UPDATE users SET name = $2, phone = $3, gender = $4, password_hash = $5, pending_signup_meta = $6,
                            pending_email_signup_at = NOW(), updated_at = NOW()
            WHERE id = $1`,
          [byEmail.id, cleanName, cleanPhone, cleanGender, passwordHash, meta]
        )
        if (await mayEmailAccount(client, byEmail.id, ["verify_email"], config)) {
          await enqueueVerification(client, { id: byEmail.id, email: cleanEmail })
        }
        return
      }
      if (byEmail) {
        if (await mayEmailAccount(client, byEmail.id, ["account_exists"], config)) {
          await enqueueEmail(client, {
            template: "account_exists",
            recipient: byEmail.email,
            dedupeKey: `account-exists:${byEmail.id}:${randomUUID()}`,
            userId: byEmail.id,
            payload: { name: byEmail.name },
          })
        }
        return
      }
      const id = randomUUID()
      await client.query(
        `INSERT INTO users (
           id, name, email, phone, gender, role, latitude, longitude, account_status,
           email_verified, phone_verified, password_hash, auth_provider, pending_email_signup_at, pending_signup_meta
         )
         VALUES ($1, $2, $3, $4, $5, 'USER', 0, 0, 'PENDING_VERIFICATION', FALSE, FALSE, $6, $7, NOW(), $8)`,
        [id, cleanName, cleanEmail, cleanPhone, cleanGender, passwordHash, AUTH_PROVIDER_PASSWORD, meta]
      )
      await enqueueVerification(client, { id, email: cleanEmail })
    })
  } catch (error) {
    if (error?.code !== "23505") throw error
    // Lost a race with a simultaneous registration: same outcome as finding the row above.
    if (`${error.constraint ?? ""}`.includes("phone")) throw reject(409, "PHONE_IN_USE")
  }
  auditAuthAsync("auth", "register_requested", { ip, emailHint: maskEmail(cleanEmail) })
  kickEmailWorker()
}

/** Sends a fresh link if the address has a pending signup. Silent either way. */
export async function resendVerification({ email, ip }, config = emailConfig()) {
  const cleanEmail = normalizeEmailAddress(email)
  if (!EMAIL_RE.test(cleanEmail)) return
  const { rows } = await pool.query(
    `SELECT id, email FROM users WHERE lower(btrim(email)) = $1 AND pending_email_signup_at IS NOT NULL LIMIT 1`,
    [cleanEmail]
  )
  if (rows[0] && (await mayEmailAccount(pool, rows[0].id, ["verify_email"], config))) {
    await enqueueVerification(pool, rows[0])
    kickEmailWorker()
  }
  auditAuthAsync("auth", "verification_resend_requested", { ip, emailHint: maskEmail(cleanEmail) })
}

/**
 * Turns a pending signup into an active account: the single place that happens.
 *
 * @returns {Promise<object | null>} what was stored at signup, or null if it was not pending
 */
async function activatePendingAccount(client, userId, { applyConsent = true } = {}) {
  const { rows } = await client.query(
    `SELECT id, name, email, pending_email_signup_at, pending_signup_meta FROM users WHERE id = $1 FOR UPDATE`,
    [userId]
  )
  const user = rows[0]
  if (!user?.pending_email_signup_at) return null
  await client.query(
    `UPDATE users
        SET account_status = 'ACTIVE', email_verified = TRUE, pending_email_signup_at = NULL, pending_signup_meta = NULL, updated_at = NOW()
      WHERE id = $1`,
    [userId]
  )
  const meta = user.pending_signup_meta ?? {}
  if (applyConsent && meta.marketingConsent === true) await setMarketingConsent(client, userId, true, "signup")
  await enqueueWelcome(client, user)
  return meta
}

function settleReferral(userId, meta) {
  // Runs for every signup, code or not: later referrals are scored against this device history.
  applyReferralOnSignup({ newUserId: userId, referralCodeInput: meta.referralCode ?? "", ip: meta.ip, deviceId: meta.deviceId ?? "" }).catch(error =>
    console.error("apply_referral_on_activation_failed", error)
  )
}

/**
 * Confirms an address from its emailed link.
 *
 * @returns {Promise<"VERIFIED" | "ALREADY_VERIFIED" | "EXPIRED" | "INVALID">}
 */
export async function verifyEmailToken({ token, ip }) {
  const raw = `${token ?? ""}`.trim()
  if (!raw) return "INVALID"
  const activated = await inTransaction(async client => {
    const userId = await consumeEmailToken(client, { raw, purpose: TOKEN_VERIFY_EMAIL })
    if (!userId) return null
    const meta = await activatePendingAccount(client, userId)
    await invalidateUserTokens(client, userId)
    return { userId, meta }
  })
  if (activated) {
    if (activated.meta) settleReferral(activated.userId, activated.meta)
    auditAuthAsync("auth", "email_verified", { ip, userId: activated.userId })
    kickEmailWorker()
    return "VERIFIED"
  }
  const { state } = await inspectEmailToken(pool, { raw, purpose: TOKEN_VERIFY_EMAIL })
  if (state === "USED") return "ALREADY_VERIFIED"
  return state === "EXPIRED" ? "EXPIRED" : "INVALID"
}

/**
 * A Firebase session whose token proves the mailbox has arrived at a pending signup: the owner
 * has turned up through Google. Whatever password was typed at registration was never proven, and
 * could be someone else's, set in advance to take the account over. So it is erased, along with
 * the consent and referral details that came with it, and the owner signs in with Google.
 */
export async function claimPendingSignup(userId, firebase) {
  const provider = resolveSignupAuthProvider(firebase)
  const googleName = normalizeName(firebase.name ?? "")
  await inTransaction(async client => {
    const meta = await activatePendingAccount(client, userId, { applyConsent: false })
    if (!meta) return
    await client.query(
      `UPDATE users SET password_hash = NULL, firebase_uid = $2, auth_provider = $3, name = CASE WHEN $4 <> '' THEN $4 ELSE name END, updated_at = NOW() WHERE id = $1`,
      [userId, firebase.uid, provider, isValidFullName(googleName) ? googleName : ""]
    )
    await invalidateUserTokens(client, userId)
  })
  kickEmailWorker()
}

/** Queues a reset link for any account with this address. Silent either way. */
export async function requestPasswordReset({ email }, config = emailConfig()) {
  const cleanEmail = normalizeEmailAddress(email)
  const { rows } = await pool.query(`SELECT id, email FROM users WHERE lower(btrim(email)) = $1 LIMIT 1`, [cleanEmail])
  if (rows[0] && (await mayEmailAccount(pool, rows[0].id, ["password_reset"], config))) {
    await enqueueEmail(pool, { template: "password_reset", recipient: rows[0].email, dedupeKey: `reset:${rows[0].id}:${randomUUID()}`, userId: rows[0].id })
    kickEmailWorker()
  }
}

/** Lets the reset page refuse a dead link before the customer types anything. */
export async function checkPasswordResetToken(token) {
  const raw = `${token ?? ""}`.trim()
  if (!raw) return { valid: false }
  const { state, userId } = await inspectEmailToken(pool, { raw, purpose: TOKEN_RESET_PASSWORD })
  if (state !== "VALID") return { valid: false }
  const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId])
  return { valid: Boolean(rows[0]), emailHint: rows[0] ? maskEmail(rows[0].email) : undefined }
}

/**
 * Sets the new password. The token, the password and the session revocation commit together, so
 * a failure leaves the link usable, and two simultaneous submits cannot both win.
 *
 * Opening the link proves the mailbox, so this also finishes a pending signup and activates a
 * walk-in account setting its first password; the stored password of a pending signup is
 * replaced, which is what closes the pre-registration takeover on this path.
 */
export async function completePasswordReset({ token, newPassword, ip }) {
  const raw = `${token ?? ""}`.trim()
  if (!raw) throw reject(400, "RESET_LINK_INVALID")
  if (!isAcceptablePassword(newPassword)) throw reject(400, "Password must be between 8 and 72 characters")
  const passwordHash = await bcrypt.hash(`${newPassword}`, BCRYPT_ROUNDS)
  const result = await inTransaction(async client => {
    const userId = await consumeEmailToken(client, { raw, purpose: TOKEN_RESET_PASSWORD })
    if (!userId) return null
    const meta = await activatePendingAccount(client, userId)
    const { rows } = await client.query(
      `UPDATE users
          SET password_hash = $2, auth_provider = $3, email_verified = TRUE,
              account_status = CASE WHEN role = 'USER' THEN 'ACTIVE'::account_status ELSE account_status END,
              app_session_epoch = app_session_epoch + 1, staff_session_jti = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING email, firebase_uid`,
      // Setting a password is what makes an account a password account, as it always has been
      // here: a Google customer who adds one keeps Google too, through their linked uid.
      [userId, passwordHash, AUTH_PROVIDER_PASSWORD]
    )
    await invalidateUserTokens(client, userId)
    return { userId, meta, email: rows[0]?.email, firebaseUid: rows[0]?.firebase_uid }
  })
  if (!result) throw reject(400, "RESET_LINK_INVALID")
  if (result.meta) settleReferral(result.userId, result.meta)
  if (result.firebaseUid) {
    admin
      .auth()
      .revokeRefreshTokens(result.firebaseUid)
      .catch(error => console.error("revoke_firebase_sessions_failed", { error: error?.message }))
  }
  auditAuthAsync("auth", "password_reset_complete_success", { ip, userId: result.userId, emailHint: maskEmail(result.email) })
  kickEmailWorker()
  return { email: result.email }
}

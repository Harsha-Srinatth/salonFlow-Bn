/**
 * Authentication and session HTTP routes for customers, staff, and password lifecycle.
 * Security controls applied here: IP rate limits (see `middleware/rate-limiters.js`), per-IP+email login lockout
 * after repeated bad passwords (`lib/login-lockout.js`), structured audit lines (`lib/audit-log.js`), and short-lived
 * staff setup tokens (`STAFF_SETUP_TOKEN_TTL`, default 5m). Multi-factor authentication is not implemented yet.
 */
import express from "express"
import { randomBytes, randomUUID } from "node:crypto"
import { pool } from "../lib/db-pool.js"
import { getClientIp } from "../lib/client-ip.js"
import { auditAuthAsync } from "../lib/audit-log.js"
import {
  assertPasswordLoginNotLocked,
  clearPasswordLoginFailures,
  recordPasswordLoginFailure,
} from "../lib/login-lockout.js"
import {
  verifyPasswordResetOobCode,
  consumePasswordResetOobWithPassword,
  sendPasswordResetEmailToolkit,
} from "../lib/firebase-identity-toolkit.js"
import { requireFirebaseAuth, requireFreshFirebaseToken } from "../middleware/auth.js"
import { ensureUserProfileSchema } from "../auth/schema-init.js"
import { GENDER_UNSPECIFIED, normalizeCustomerGender, parseSelectableGender } from "../lib/gender.js"
import {
  AUTH_PROVIDER_GOOGLE,
  AUTH_PROVIDER_PASSWORD,
  AUTH_PROVIDER_UNKNOWN,
  lookupAuthProviderByEmail,
  normalizeAuthProvider,
  resolveSignupAuthProvider,
} from "../lib/auth-provider.js"
import { isValidFullName, normalizeName } from "../lib/validation.js"
import { USER_PROFILE_COLUMNS, toAppUserDto } from "../lib/user-dto.js"
import { applyReferralOnSignup, registerDeviceForUser } from "../loyalty/service.js"
import {
  loginRateLimit,
  staffLoginRateLimit,
  sessionSyncRateLimit,
  phoneExistsRateLimit,
  emailExistsRateLimit,
  passwordResetCompleteRateLimit,
  passwordResetRequestRateLimit,
  staffFirebaseVerifyRateLimit,
  staffSetPasswordRateLimit,
  whatsappOtpRequestRateLimit,
  whatsappOtpVerifyRateLimit,
} from "../middleware/rate-limiters.js"
import {
  consumeOtpChallenge,
  issuePhoneProof,
  loadUsablePhoneProof,
  normalizeOtpPhone,
  OtpError,
  requestWhatsAppOtp,
  verifyWhatsAppOtp,
} from "../whatsapp/otp.js"
import { ensureWhatsAppSchema } from "../whatsapp/schema-init.js"
import { maskPhone, phoneLookupCandidates } from "../whatsapp/phone.js"
import { queueWelcomeMessage } from "../whatsapp/notifications.js"
import { whatsappConfig } from "../whatsapp/config.js"
import bcrypt from "bcryptjs"
import { invalidateStylistRoster } from "../lib/catalog-cache.js"
import { isSessionTokenLive } from "../middleware/auth.js"
import { signStaffAccessToken, signStaffSetupToken, verifyStaffAccessToken, verifyStaffSetupToken } from "../lib/tokens.js"
import { verifyFirebaseToken } from "../lib/firebase-admin.js"
const isProduction = process.env.NODE_ENV === "production"
const router = express.Router()

/**
 * Normalizes email for comparisons so DB rows with accidental spaces still match Firebase / login input.
 *
 * @param {string} email
 * @returns {string}
 */
function normalizeEmailForLookup(email) {
  return `${email ?? ""}`.trim().toLowerCase()
}

/**
 * Looks up a single `users` row by any known identifier (Firebase uid, email, or phone).
 * Used after Firebase sign-in / session sync to attach app profile data.
 *
 * @param {{ firebaseUid?: string, email?: string, phone?: string }} params
 * @returns {Promise<object | null>}
 */
async function findDbUser({ firebaseUid, email, phone }) {
  const conditions = []
  const values = []
  if (firebaseUid) {
    values.push(firebaseUid)
    conditions.push(`firebase_uid = $${values.length}`)
  }
  if (email) {
    values.push(normalizeEmailForLookup(email))
    conditions.push(`lower(btrim(email)) = $${values.length}`)
  }
  if (phone) {
    values.push(phone)
    conditions.push(`phone = $${values.length}`)
  }
  if (!conditions.length) return null
  const sql = `
    SELECT ${USER_PROFILE_COLUMNS}, firebase_uid, password_hash
    FROM users
    WHERE ${conditions.join(" OR ")}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1
  `
  const { rows } = await pool.query(sql, values)
  return rows[0] ?? null
}

/**
 * Returns whether a phone number is already tied to a user (signup uniqueness check).
 *
 * @param {string} phone E.164
 * @returns {Promise<boolean>}
 */
async function phoneExistsInDb(phone) {
  if (!phone) return false
  const { rows } = await pool.query("SELECT 1 FROM users WHERE phone = $1 LIMIT 1", [phone])
  return rows.length > 0
}

/**
 * Decides whether a decoded Firebase ID token proves the two things registration requires.
 *
 * Both signals are claims Firebase itself signs, and neither can be produced without the
 * user completing the corresponding challenge:
 *
 *  - `email_verified` flips to true only after the recipient opens the link in the mailbox.
 *  - `phone_number` appears on the token only after an SMS code from that number is confirmed.
 *
 * Checking them here rather than in the browser is the whole point. The client used to send
 * the verification email and then walk straight on to the next step, so an address nobody
 * could read — a typo, or someone else's — became a permanent account identity, and any
 * caller posting a bare Firebase token to this endpoint skipped the SMS step entirely.
 *
 * The phone equality check closes the matching hole on the other side: the row's phone is
 * taken from the claim, and a header that disagrees with it means the browser verified one
 * number and asked to register another.
 *
 * The phone factor is now normally a WhatsApp OTP: the browser carries a signed, single-use
 * proof from `/api/auth/whatsapp-otp/verify` and `verifiedPhone` is the number in it. A
 * Firebase `phone_number` claim is still accepted so an older client keeps working.
 *
 * @param {{ email_verified?: boolean, phone_number?: string }} firebase Decoded claims
 * @param {string} requestedPhone E.164 the client asked to register
 * @param {string} verifiedPhone E.164 proven by the WhatsApp OTP proof or the Firebase claim
 * @returns {{ status: number, error: string, reason: string } | null} null when both factors hold
 */
function describeRegistrationVerificationFailure(firebase, requestedPhone, verifiedPhone) {
  if (!verifiedPhone) {
    return { status: 403, error: "PHONE_NOT_VERIFIED", reason: "phone_not_verified" }
  }
  if (requestedPhone && requestedPhone.trim() !== verifiedPhone) {
    return { status: 400, error: "PHONE_MISMATCH", reason: "phone_claim_mismatch" }
  }
  if (!firebase.email) {
    return { status: 400, error: "EMAIL_REQUIRED", reason: "missing_email" }
  }
  if (firebase.email_verified !== true) {
    return { status: 403, error: "EMAIL_NOT_VERIFIED", reason: "email_not_verified" }
  }
  return null
}

/**
 * Loads a user row by primary key (no password hash returned in API responses).
 *
 * @param {string} id
 * @returns {Promise<object | null>}
 */
async function getDbUserById(id) {
  const { rows } = await pool.query(
    `
      SELECT ${USER_PROFILE_COLUMNS}, staff_session_jti, app_session_epoch
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  )
  return rows[0] ?? null
}

/**
 * Resolves the DB user for an existing HTTP-only cookie session (app or staff JWT).
 *
 * @param {string | null} token JWT from cookie
 * @returns {Promise<object | null>}
 */
async function getDbUserFromSessionToken(token) {
  if (!token) return null
  try {
    const payload = await verifyStaffAccessToken(token)
    const user = await getDbUserById(payload.sub)
    return isSessionTokenLive(payload, user) ? user : null
  } catch {
    return null
  }
}

/**
 * Returns the account's sign-in provider, classifying and persisting it on first ask.
 *
 * Rows created before `auth_provider` existed carry UNKNOWN, and so do accounts
 * reception created on a customer's behalf. Asking Firebase settles it, and writing
 * the answer back means each such account costs that round trip exactly once. Only
 * reached once a login has already established the account has no app password, so
 * it never sits in the path of a successful sign-in.
 *
 * @param {{ id: string, email: string, auth_provider?: string }} user
 * @returns {Promise<string>} one of `AUTH_PROVIDERS`
 */
async function resolveStoredAuthProvider(user) {
  const stored = normalizeAuthProvider(user.auth_provider)
  if (stored !== AUTH_PROVIDER_UNKNOWN) return stored
  const resolved = await lookupAuthProviderByEmail(user.email)
  if (resolved === AUTH_PROVIDER_UNKNOWN) return resolved
  await pool
    .query("UPDATE users SET auth_provider = $2, updated_at = NOW() WHERE id = $1 AND auth_provider = $3", [
      user.id,
      resolved,
      AUTH_PROVIDER_UNKNOWN,
    ])
    .catch(error => console.error("persist_auth_provider_failed", error))
  return resolved
}

/**
 * POST /api/auth/session
 * After Firebase client sign-in / phone verification, syncs Firebase identity into `users`.
 * Rate-limited per IP to slow mass fake registrations. Inserts a row on first registration.
 *
 * Registration is gated on the Firebase ID token proving *both* factors:
 * `email_verified === true` and a `phone_number` claim (only present once an SMS
 * code has actually been confirmed). Both are signed claims minted by Firebase,
 * so unlike the previous client-side sequencing they cannot be skipped by
 * calling this endpoint directly. See `assertRegistrationIsVerified`.
 *
 * @type {import("express").RequestHandler}
 */
async function handlePostSession(req, res) {
  const ip = getClientIp(req)
  const requestedRole = "USER"
  const requestedPhone = typeof req.headers["x-user-phone"] === "string" ? req.headers["x-user-phone"] : ""
  const requestedNameRaw = typeof req.headers["x-user-name"] === "string" ? req.headers["x-user-name"] : ""
  // Body first, header second: the header rides on sessionStorage, which does not
  // survive a reload or a second tab mid-signup. `null` here means "not supplied",
  // and registration refuses it rather than inventing a gender for the account.
  const requestedGenderRaw =
    req.body?.gender ?? (typeof req.headers["x-user-gender"] === "string" ? req.headers["x-user-gender"] : "")
  const requestedGender = parseSelectableGender(requestedGenderRaw)
  const requestedName = normalizeName(requestedNameRaw)
  const requestedReferralCode = typeof req.headers["x-referral-code"] === "string" ? req.headers["x-referral-code"] : ""
  // Client-generated, stored in the browser. Survives a network change (the
  // airplane-mode trick), which is what makes it the strongest referral-abuse
  // signal available without fingerprinting the user.
  const requestedDeviceId = typeof req.headers["x-device-id"] === "string" ? req.headers["x-device-id"].trim() : ""
  const firebase = req.firebaseUser
  const claimPhone = typeof firebase.phone_number === "string" ? firebase.phone_number.trim() : ""
  // WhatsApp OTP proof (signed by this server, checked against an unconsumed VERIFIED challenge).
  let phoneProof = null
  if (!claimPhone && req.body?.phoneProof) {
    await ensureWhatsAppSchema()
    phoneProof = await loadUsablePhoneProof(req.body.phoneProof)
  }
  const verifiedPhone = claimPhone || phoneProof?.phone || ""
  // Identify the account only from facts the signed token proves: its uid, a mailbox
  // Firebase marked verified, and the phone number it actually delivered an SMS to.
  // The `x-user-phone` header and an unverified e-mail are whatever the caller typed;
  // matching on them let anyone with *any* valid Firebase token read — and, below,
  // attach their own uid to — another customer's account.
  const dbUser = await findDbUser({
    firebaseUid: firebase.uid,
    email: firebase.email_verified === true ? firebase.email ?? "" : "",
    phone: verifiedPhone,
  })

  if (dbUser && !dbUser.firebase_uid) {
    await pool.query("UPDATE users SET firebase_uid = $1, updated_at = NOW() WHERE id = $2 AND firebase_uid IS NULL", [
      firebase.uid,
      dbUser.id,
    ])
  }

  if (!dbUser) {
    if (!requestedPhone && !verifiedPhone) {
      auditAuthAsync("auth", "session_register_denied", { ip, reason: "missing_phone", firebaseUid: firebase.uid })
      return res.status(400).json({ error: "Phone number is required for registration" })
    }
    if (!requestedName) {
      // No name header means this came from the login-only phone/OTP flow, not guided signup —
      // there is genuinely no account for this phone yet, so tell the client to send the user to sign up.
      auditAuthAsync("auth", "session_register_denied", { ip, reason: "no_account_for_phone", firebaseUid: firebase.uid })
      return res.status(404).json({ error: "ACCOUNT_NOT_FOUND" })
    }
    // Both factors, checked against signed token claims, before anything is written.
    const verificationFailure = describeRegistrationVerificationFailure(firebase, requestedPhone, verifiedPhone)
    if (verificationFailure) {
      auditAuthAsync("auth", "session_register_denied", {
        ip,
        reason: verificationFailure.reason,
        firebaseUid: firebase.uid,
      })
      return res.status(verificationFailure.status).json({ error: verificationFailure.error })
    }
    if (!isValidFullName(requestedName)) {
      auditAuthAsync("auth", "session_register_denied", { ip, reason: "invalid_name", firebaseUid: firebase.uid })
      return res.status(400).json({ error: "Please enter your full name (at least 4 valid letters)." })
    }
    if (!requestedGender) {
      // Gender drives which reward cards and stylists a customer is offered.
      // Guessing it here is what showed women's services to men, so registration
      // stops instead and the client re-asks.
      auditAuthAsync("auth", "session_register_denied", { ip, reason: "missing_gender", firebaseUid: firebase.uid })
      return res.status(400).json({ error: "Please select your gender to complete registration" })
    }
    const resolvedEmail = firebase.email ?? ""
    // The signup password reaches Postgres here and nowhere else. Without it the
    // row lands with a NULL `password_hash`, and the account the customer just
    // created rejects its own password at login with SET_PASSWORD_REQUIRED —
    // which is what forced every new email/password signup through a
    // "forgot password" round trip before their first sign-in.
    const signupPassword = `${req.body?.password ?? ""}`
    // Same rule as password reset and staff setup. A password that is supplied but too short
    // used to be dropped silently, leaving an account that could never log in with it.
    // bcrypt ignores everything past 72 bytes, so longer input is refused rather than truncated.
    if (signupPassword && (signupPassword.length < 8 || Buffer.byteLength(signupPassword) > 72)) {
      return res.status(400).json({ error: "Password must be between 8 and 72 characters" })
    }
    const signupPasswordHash = signupPassword ? await bcrypt.hash(signupPassword, 12) : null
    // Recorded now, while the token that authorized this signup is in hand. After
    // this request the only trace of *how* they signed up would be a NULL
    // password_hash, which cannot tell a Google customer apart from one whose
    // password was never set — see lib/auth-provider.js.
    const authProvider = resolveSignupAuthProvider(firebase, { hasPassword: Boolean(signupPasswordHash) })
    const insertSql = `
        INSERT INTO users (
          name, email, phone, gender, firebase_uid, role, latitude, longitude, account_status,
          email_verified, phone_verified, password_hash, auth_provider
        )
        VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'ACTIVE', TRUE, TRUE, $7, $8)
        RETURNING ${USER_PROFILE_COLUMNS}
      `
    // `verifiedPhone` over the client header: the header is whatever the browser
    // typed, the proof/claim is the number a code was actually delivered to.
    const insertValues = [requestedName, resolvedEmail, verifiedPhone, requestedGender, firebase.uid, requestedRole, signupPasswordHash, authProvider]
    let rows
    if (phoneProof) {
      // The WhatsApp proof is spent in the same transaction as the INSERT: one verified
      // code creates at most one account, even if the request is replayed concurrently.
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const consumed = await consumeOtpChallenge(client, phoneProof.challengeId, { phone: phoneProof.phone, purpose: "SIGNUP" })
        if (!consumed) {
          await client.query("ROLLBACK")
          auditAuthAsync("auth", "session_register_denied", { ip, reason: "phone_proof_used", firebaseUid: firebase.uid })
          return res.status(403).json({ error: "PHONE_NOT_VERIFIED" })
        }
        ;({ rows } = await client.query(insertSql, insertValues))
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw error
      } finally {
        client.release()
      }
    } else {
      ;({ rows } = await pool.query(insertSql, insertValues))
    }
    auditAuthAsync("auth", "session_register_success", {
      ip,
      userId: rows[0].id,
      firebaseUid: firebase.uid,
      emailHint: `${resolvedEmail.slice(0, 2)}…`,
    })
    // Runs for every signup, referral code or not: the device history it records
    // is what later referrals are scored against.
    applyReferralOnSignup({
      newUserId: rows[0].id,
      referralCodeInput: requestedReferralCode,
      ip,
      deviceId: requestedDeviceId,
    }).catch(error => console.error("apply_referral_on_signup_route_failed", error))
    // Only on this first-registration path: returning customers never reach here, and the
    // outbox key is the user id, so a retried registration cannot queue a second welcome.
    queueWelcomeMessage(pool, rows[0]).catch(error => console.error("queue_welcome_failed", { error: error?.message }))
    return res.json({ user: toAppUserDto(rows[0]) })
  }

  // A walk-in account created at reception has no gender until its owner signs
  // up online. Fill it the first time they do — but never overwrite a gender the
  // customer has already stated.
  if (requestedGender && normalizeCustomerGender(dbUser.gender) === GENDER_UNSPECIFIED) {
    await pool.query("UPDATE users SET gender = $1, updated_at = NOW() WHERE id = $2 AND gender = $3", [
      requestedGender,
      dbUser.id,
      GENDER_UNSPECIFIED,
    ])
    dbUser.gender = requestedGender
  }

  // Promote-only, never demote. A returning customer signing in with phone OTP
  // holds a token with no `email` claim at all; reading that as "email no longer
  // verified" would strip a flag they already earned. The flags only ever move
  // false → true, on fresh proof.
  const provesEmail = firebase.email_verified === true && !dbUser.email_verified
  // A WhatsApp proof only counts for the number it proves, and is spent here too.
  const proofMatchesAccount = Boolean(phoneProof) && phoneLookupCandidates(phoneProof.phone).includes(dbUser.phone)
  if (proofMatchesAccount) {
    await consumeOtpChallenge(pool, phoneProof.challengeId, { phone: phoneProof.phone, purpose: "SIGNUP" })
  }
  const provesPhone = (Boolean(claimPhone) || proofMatchesAccount) && !dbUser.phone_verified
  // Fill in the provider for accounts that predate the column, using the token that
  // just proved who they are. Guarded on there being no password_hash: an account
  // that can already be signed into with an app password must not be relabelled
  // GOOGLE just because this particular session came in through Google.
  if (normalizeAuthProvider(dbUser.auth_provider) === AUTH_PROVIDER_UNKNOWN && !dbUser.password_hash) {
    const observed = resolveSignupAuthProvider(firebase)
    if (observed !== AUTH_PROVIDER_UNKNOWN) {
      await pool
        .query("UPDATE users SET auth_provider = $2, updated_at = NOW() WHERE id = $1 AND auth_provider = $3", [
          dbUser.id,
          observed,
          AUTH_PROVIDER_UNKNOWN,
        ])
        .catch(error => console.error("backfill_auth_provider_on_sync_failed", error))
      dbUser.auth_provider = observed
    }
  }
  if (provesEmail || provesPhone) {
    await pool.query(
      `
        UPDATE users
        SET email_verified = email_verified OR $2,
            phone_verified = phone_verified OR $3,
            updated_at = NOW()
        WHERE id = $1
      `,
      [dbUser.id, provesEmail, provesPhone]
    )
    dbUser.email_verified = dbUser.email_verified || provesEmail
    dbUser.phone_verified = dbUser.phone_verified || provesPhone
  }

  // Keep the device's last-seen IP current for returning users too, so a
  // referrer's "where they are" stays fresh rather than frozen at signup.
  registerDeviceForUser({ deviceId: requestedDeviceId, userId: dbUser.id, ip }).catch(error =>
    console.error("register_device_on_session_failed", error)
  )
  auditAuthAsync("auth", "session_sync_success", { ip, userId: dbUser.id, firebaseUid: firebase.uid })
  return res.json({ user: toAppUserDto(dbUser) })
}

/**
 * GET /api/auth/phone-exists
 * Used by signup UI; rate-limited to reduce phone enumeration.
 *
 * @type {import("express").RequestHandler}
 */
async function handlePhoneExists(req, res) {
  const phone = `${req.query.phone ?? ""}`.trim()
  const existsInDb = await phoneExistsInDb(phone)
  return res.json({ exists: existsInDb })
}

/**
 * GET /api/auth/email-exists
 * Lets signup reject a duplicate address on the details step, before a Firebase user
 * is created for it. Without this the collision only surfaces as `auth/email-already-in-use`
 * *after* the account exists, which is the point where the old flow dead-ended.
 * Shares the phone-enumeration limiter's shape for the same reason.
 *
 * @type {import("express").RequestHandler}
 */
async function handleEmailExists(req, res) {
  const email = normalizeEmailForLookup(req.query.email)
  if (!email || !email.includes("@")) return res.json({ exists: false })
  const { rows } = await pool.query("SELECT 1 FROM users WHERE lower(btrim(email)) = $1 LIMIT 1", [email])
  return res.json({ exists: rows.length > 0 })
}

/**
 * POST /api/auth/login
 * Cookie session for customers/admins using bcrypt `password_hash` only (not Firebase password).
 * Combines IP rate limit + per-IP+email lockout after repeated bad passwords.
 *
 * @type {import("express").RequestHandler}
 */
async function handleAppLogin(req, res) {
  const ip = getClientIp(req)
  const { email, password } = req.body ?? {}
  const normalizedEmail = normalizeEmailForLookup(email)
  if (!normalizedEmail || !password) {
    return res.status(400).json({ error: "Email and password are required" })
  }
  try {
    assertPasswordLoginNotLocked(ip, normalizedEmail)
  } catch (e) {
    if (e.code === "LOCKED") {
      auditAuthAsync("auth", "login_locked", { ip, emailHint: `${normalizedEmail.slice(0, 2)}…`, retryAfterSeconds: e.retryAfterSeconds })
      return res.status(429).json({
        error: "TOO_MANY_ATTEMPTS",
        retryAfterSeconds: e.retryAfterSeconds,
        message: e.message,
      })
    }
    throw e
  }
  const { rows } = await pool.query(
    `
      SELECT ${USER_PROFILE_COLUMNS}, password_hash
      FROM users
      WHERE lower(btrim(email)) = $1
      LIMIT 1
    `,
    [normalizedEmail]
  )
  const user = rows[0]
  if (!user) {
    recordPasswordLoginFailure(ip, normalizedEmail)
    auditAuthAsync("auth", "login_failure", { ip, reason: "unknown_user", emailHint: `${normalizedEmail.slice(0, 2)}…` })
    return res.status(401).json({ error: "Invalid credentials" })
  }
  if (user.account_status !== "ACTIVE") {
    auditAuthAsync("auth", "login_failure", { ip, reason: "account_not_active", userId: user.id })
    return res.status(401).json({ error: "VERIFY_PHONE_FIRST" })
  }
  if (!user.password_hash) {
    // No app password can mean two different things, and answering with the wrong
    // one sends the customer somewhere that cannot help them. A Google account has
    // no password to set — its credential lives with Google — so it is told to use
    // Google. Everything else (a reception-created walk-in, a staff row mid-setup)
    // genuinely does need to set one.
    const provider = await resolveStoredAuthProvider(user)
    if (provider === AUTH_PROVIDER_GOOGLE) {
      auditAuthAsync("auth", "login_failure", { ip, reason: "google_account_password_login", userId: user.id })
      return res.status(401).json({ error: "GOOGLE_ACCOUNT" })
    }
    auditAuthAsync("auth", "login_failure", { ip, reason: "password_not_set", userId: user.id })
    return res.status(401).json({ error: "SET_PASSWORD_REQUIRED" })
  }
  const isValidPassword = await bcrypt.compare(`${password ?? ""}`, user.password_hash)
  if (!isValidPassword) {
    recordPasswordLoginFailure(ip, normalizedEmail)
    auditAuthAsync("auth", "login_failure", { ip, reason: "bad_password", userId: user.id })
    return res.status(401).json({ error: "Invalid credentials" })
  }
  clearPasswordLoginFailures(ip, normalizedEmail)
  const { rows: epochRows } = await pool.query("SELECT app_session_epoch FROM users WHERE id = $1", [user.id])
  const accessToken = await signStaffAccessToken(user.id, undefined, { sessionEpoch: Number(epochRows[0]?.app_session_epoch ?? 0) })
  auditAuthAsync("auth", "login_success", {
    ip,
    userId: user.id,
    role: user.role,
    sessionPolicy: "single_active_cookie",
  })
  res.cookie("staff_access_token", "", {
    maxAge: 0,
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
  })
  
  res.cookie("app_access_token", accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
  return res.json({ user: toAppUserDto(user) })
}

/**
 * GET /api/auth/me
 * Returns current user from JWT cookie if still valid.
 *
 * @type {import("express").RequestHandler}
 */
async function handleMe(req, res) {
  const token = req.cookies?.app_access_token ?? req.cookies?.staff_access_token ?? null
  const user = await getDbUserFromSessionToken(token)
  if (!user) return res.json({ user: null })
  return res.json({ user: toAppUserDto(user) })
}

/**
 * POST /api/auth/logout
 * Clears app cookie and server-side session map entry.
 *
 * @type {import("express").RequestHandler}
 */
async function handleLogout(req, res) {
  const token = req.cookies?.app_access_token
  if (token) {
    // Revoke server-side too: bump the epoch this cookie was issued under, so a copy of the
    // cookie (another tab, a stolen value) stops working, not just the one in this browser.
    try {
      const payload = await verifyStaffAccessToken(token)
      if (payload?.sub && !payload.jti) {
        await pool.query(
          "UPDATE users SET app_session_epoch = app_session_epoch + 1 WHERE id = $1 AND app_session_epoch = $2",
          [payload.sub, Number(payload.sv ?? 0)]
        )
      }
    } catch {
      // Expired/invalid cookie: nothing to revoke.
    }
  }
  res.cookie("app_access_token", "", {
    maxAge: 0,
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
  })
  auditAuthAsync("auth", "logout", { ip: getClientIp(req) })
  return res.json({ success: true })
}

/**
 * POST /api/auth/staff/login
 * Staff/receptionist login; same lockout model as app login but separate rate limit bucket.
 *
 * @type {import("express").RequestHandler}
 */
async function handleStaffLogin(req, res) {
  const ip = getClientIp(req)
  const { email, password } = req.body ?? {}
  const normalizedEmail = normalizeEmailForLookup(email)
  if (!normalizedEmail || !password) {
    return res.status(400).json({ error: "Email and password are required" })
  }
  try {
    assertPasswordLoginNotLocked(ip, normalizedEmail)
  } catch (e) {
    if (e.code === "LOCKED") {
      auditAuthAsync("auth", "staff_login_locked", { ip, retryAfterSeconds: e.retryAfterSeconds })
      return res.status(429).json({
        error: "TOO_MANY_ATTEMPTS",
        retryAfterSeconds: e.retryAfterSeconds,
        message: e.message,
      })
    }
    throw e
  }
  const { rows } = await pool.query(
    `
      SELECT id, name, email, role, phone, account_status, password_hash
      FROM users
      WHERE lower(btrim(email)) = $1
      LIMIT 1
    `,
    [normalizedEmail]
  )
  const user = rows[0]
  if (!user || !["STAFF", "RECEPTIONIST"].includes(user.role)) {
    // Only an unknown address counts as a failed attempt here. The customer sign-in
    // form tries this endpoint first and falls back to /api/auth/login, so counting
    // "this is a customer, not staff" as a failure spent the shared IP+email lockout
    // budget on every ordinary customer login — five correct sign-ins in a row would
    // lock the account out with TOO_MANY_ATTEMPTS. A genuinely wrong password is
    // still recorded, by whichever handler actually checks it.
    if (!user && normalizedEmail) recordPasswordLoginFailure(ip, normalizedEmail)
    auditAuthAsync("auth", "staff_login_failure", { ip, reason: user ? "not_staff_role" : "unknown_user" })
    return res.status(401).json({ error: "Invalid credentials" })
  }
  if (user.account_status !== "ACTIVE") {
    auditAuthAsync("auth", "staff_login_failure", { ip, reason: "not_active", userId: user.id })
    return res.status(401).json({ error: "VERIFY_PHONE_FIRST" })
  }
  if (!user.password_hash) {
    auditAuthAsync("auth", "staff_login_failure", { ip, reason: "needs_password", userId: user.id })
    return res.status(401).json({ error: "NEEDS_PASSWORD" })
  }
  const isValidPassword = await bcrypt.compare(`${password ?? ""}`, user.password_hash)
  if (!isValidPassword) {
    recordPasswordLoginFailure(ip, normalizedEmail)
    auditAuthAsync("auth", "staff_login_failure", { ip, reason: "bad_password", userId: user.id })
    return res.status(401).json({ error: "Invalid credentials" })
  }
  clearPasswordLoginFailures(ip, normalizedEmail)
  // One valid session per staff account: the new id replaces any previous one.
  const sessionJti = randomUUID()
  await pool.query("UPDATE users SET staff_session_jti = $2 WHERE id = $1", [user.id, sessionJti])
  const accessToken = await signStaffAccessToken(user.id, sessionJti)
  auditAuthAsync("auth", "staff_login_success", { ip, userId: user.id, role: user.role })
  res.cookie("app_access_token", "", {
  maxAge: 0,
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  path: "/",
})
  res.cookie("staff_access_token", accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
  return res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } })
}

/**
 * POST /api/auth/staff/logout
 *
 * @type {import("express").RequestHandler}
 */
async function handleStaffLogout(req, res) {
  const token = req.cookies?.staff_access_token
  if (token) {
    try {
      const payload = await verifyStaffAccessToken(token)
      // Revoke server-side too, so a copied cookie stops working immediately.
      if (payload.jti) {
        await pool.query("UPDATE users SET staff_session_jti = NULL WHERE id = $1 AND staff_session_jti = $2", [payload.sub, payload.jti])
      }
    } catch {
      // ignore invalid token
    }
  }
  res.cookie("staff_access_token", "", {
  maxAge: 0,
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  path: "/",
})
  auditAuthAsync("auth", "staff_logout", { ip: getClientIp(req) })
  return res.json({ success: true })
}

/**
 * GET /api/auth/staff/me
 *
 * @type {import("express").RequestHandler}
 */
async function handleStaffMe(req, res) {
  const token = req.cookies?.staff_access_token
  if (!token) return res.json({ user: null })
  try {
    const payload = await verifyStaffAccessToken(token)
    const { rows: staffRows } = await pool.query(
      `SELECT ${USER_PROFILE_COLUMNS}, staff_session_jti FROM users WHERE id = $1 LIMIT 1`,
      [payload.sub]
    )
    const user = staffRows[0]
    if (!user || !payload.jti || payload.jti !== user.staff_session_jti) return res.json({ user: null })
    return res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, accountStatus: user.account_status } })
  } catch {
    return res.json({ user: null })
  }
}

/**
 * POST /api/auth/staff/verify-firebase-phone
 * Exchanges a Firebase SMS ID token for a short setup JWT (now 5m TTL by default).
 *
 * @type {import("express").RequestHandler}
 */
async function handleStaffVerifyFirebasePhone(req, res) {
  const ip = getClientIp(req)
  try {
    const auth = req.headers.authorization ?? ""
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
    if (!token) return res.status(400).json({ error: "Missing Firebase ID token" })
    const decoded = await verifyFirebaseToken(token)
    const phone = decoded.phone_number
    if (!phone) return res.status(400).json({ error: "Phone not present in Firebase token" })
    const { rows } = await pool.query(
      `
        SELECT id, role
        FROM users
        WHERE phone = $1
        LIMIT 1
      `,
      [phone]
    )
    const user = rows[0]
    if (!user) {
      auditAuthAsync("auth", "staff_firebase_verify_failure", { ip, reason: "no_user_for_phone" })
      return res.status(404).json({ error: "No staff account found for this phone" })
    }
    if (!["STAFF", "RECEPTIONIST"].includes(user.role)) {
      auditAuthAsync("auth", "staff_firebase_verify_failure", { ip, reason: "not_staff", userId: user.id })
      return res.status(403).json({ error: "Not a staff account" })
    }
    const setupToken = await signStaffSetupToken({ sub: user.id, phone })
    auditAuthAsync("auth", "staff_firebase_verify_success", { ip, userId: user.id })
    return res.json({ setupToken })
  } catch (error) {
    auditAuthAsync("auth", "staff_firebase_verify_failure", { ip, reason: "token_or_server", message: error instanceof Error ? error.message : "error" })
    return res.status(400).json({ error: error instanceof Error ? error.message : "Verification failed" })
  }
}

/**
 * POST /api/auth/request-password-reset
 * Server-side trigger for Firebase reset email so rate limits and audits apply.
 * Returns 502 when Firebase refuses to send (wrong Action URL / continueUrl domain, API key, etc.) so the client can retry or show the error.
 *
 * @type {import("express").RequestHandler}
 */
async function handleRequestPasswordReset(req, res) {
  const ip = getClientIp(req)
  const { email, continueUrl } = req.body ?? {}
  const normalized = normalizeEmailForLookup(email)
  if (!normalized || !normalized.includes("@")) {
    return res.status(400).json({ error: "Valid email is required" })
  }
  const url = typeof continueUrl === "string" && continueUrl.startsWith("http") ? continueUrl : undefined
  try {
    await sendPasswordResetEmailToolkit(normalized, url)
    auditAuthAsync("auth", "password_reset_email_sent", { ip, emailHint: `${normalized.slice(0, 2)}…` })
    return res.json({ ok: true, message: "If an account exists for this email, a reset link was sent." })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not send reset email"
    auditAuthAsync("auth", "password_reset_email_failed", {
      ip,
      emailHint: `${normalized.slice(0, 2)}…`,
      message,
    })
    return res.status(502).json({
      ok: false,
      error: message,
      hint: "Check Firebase Authorized domains include your continueUrl host (e.g. localhost). Template Action URL must match.",
    })
  }
}

/**
 * POST /api/auth/complete-db-password-reset
 * Validates Firebase OOB, updates bcrypt in Postgres, burns OOB with random Firebase password.
 *
 * @type {import("express").RequestHandler}
 */
async function handleCompleteDbPasswordReset(req, res) {
  const ip = getClientIp(req)
  try {
    const { oobCode, newPassword } = req.body ?? {}
    const code = `${oobCode ?? ""}`.trim()
    if (!code) return res.status(400).json({ error: "Reset code is required" })
    if (!newPassword || `${newPassword}`.length < 8 || Buffer.byteLength(`${newPassword}`) > 72) {
      return res.status(400).json({ error: "Password must be between 8 and 72 characters" })
    }
    const { email } = await verifyPasswordResetOobCode(code)
    const hashedPassword = await bcrypt.hash(`${newPassword}`, 12)
    const lookupEmail = normalizeEmailForLookup(email)
    const { rows } = await pool.query(
      `
        SELECT id FROM users
        WHERE lower(btrim(email)) = $1
        LIMIT 1
      `,
      [lookupEmail]
    )
    const row = rows[0]
    if (!row) {
      auditAuthAsync("auth", "password_reset_complete_failure", { ip, reason: "no_db_user", emailHint: `${lookupEmail.slice(0, 2)}…` })
      return res.status(404).json({ error: "No app account found for this email" })
    }
    const updateResult = await pool.query(
      `
        UPDATE users
        SET password_hash = $2, auth_provider = $3, updated_at = NOW()
        WHERE id = $1
      `,
      // Setting a password is what makes an account a password account. A Google
      // customer who comes through this flow to add one must stop being told to
      // sign in with Google, and a row still labelled UNKNOWN is now answerable.
      [row.id, hashedPassword, AUTH_PROVIDER_PASSWORD]
    )
    if (updateResult.rowCount !== 1) {
      auditAuthAsync("auth", "password_reset_complete_failure", { ip, reason: "update_rowcount", userId: row.id, rowCount: updateResult.rowCount })
      return res.status(500).json({ error: "Could not persist new password" })
    }
    const disposableFirebasePassword = randomBytes(24).toString("base64url")
    await consumePasswordResetOobWithPassword(code, disposableFirebasePassword)
    auditAuthAsync("auth", "password_reset_complete_success", { ip, userId: row.id, emailHint: `${lookupEmail.slice(0, 2)}…` })
    return res.json({ success: true })
  } catch (error) {
    auditAuthAsync("auth", "password_reset_complete_failure", { ip, message: error instanceof Error ? error.message : "error" })
    return res.status(400).json({ error: error instanceof Error ? error.message : "Could not reset password" })
  }
}

/**
 * POST /api/auth/staff/set-password
 * Consumes setup JWT and writes bcrypt hash; account becomes ACTIVE.
 *
 * @type {import("express").RequestHandler}
 */
async function handleStaffSetPassword(req, res) {
  const ip = getClientIp(req)
  try {
    const auth = req.headers.authorization ?? ""
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
    const { password } = req.body ?? {}
    if (!token) return res.status(400).json({ error: "Missing setup token" })
    if (!password || `${password}`.length < 8 || Buffer.byteLength(`${password}`) > 72) {
      return res.status(400).json({ error: "Password must be between 8 and 72 characters" })
    }
    const payload = await verifyStaffSetupToken(token)
    const hashedPassword = await bcrypt.hash(`${password}`, 12)
    const { rowCount } = await pool.query(
      `
        UPDATE users
        SET password_hash = $2, account_status = 'ACTIVE', auth_provider = $3, updated_at = NOW()
        WHERE id = $1
      `,
      [payload.sub, hashedPassword, AUTH_PROVIDER_PASSWORD]
    )
    if (!rowCount) {
      auditAuthAsync("auth", "staff_set_password_failure", { ip, reason: "user_not_found" })
      return res.status(404).json({ error: "User not found" })
    }
    auditAuthAsync("auth", "staff_set_password_success", { ip, userId: payload.sub })
    // The stylist just became ACTIVE, so they now belong in the cached booking roster.
    void invalidateStylistRoster()
    return res.json({ success: true })
  } catch (error) {
    auditAuthAsync("auth", "staff_set_password_failure", { ip, message: error instanceof Error ? error.message : "error" })
    return res.status(400).json({ error: error instanceof Error ? error.message : "Could not set password" })
  }
}

// ---------------------------------------------------------------------------------------
// WhatsApp OTP (replaces Firebase SMS for phone verification)

const CUSTOMER_PHONE_LOGIN_ROLES = ["USER", "ADMIN"]
const STAFF_ROLES = ["STAFF", "RECEPTIONIST"]

function sendOtpError(res, error) {
  if (!(error instanceof OtpError)) throw error
  if (error.retryAfterSeconds) res.set("Retry-After", `${error.retryAfterSeconds}`)
  return res.status(error.status).json({
    error: error.code,
    message: error.message,
    ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(error.attemptsRemaining !== undefined ? { attemptsRemaining: error.attemptsRemaining } : {}),
  })
}

/** Accounts holding this number (E.164 or a legacy stored form), newest first. */
async function findAccountsByPhone(phone) {
  const { rows } = await pool.query(
    `SELECT ${USER_PROFILE_COLUMNS}, app_session_epoch FROM users WHERE phone = ANY($1::text[])
     ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST LIMIT 5`,
    [phoneLookupCandidates(phone)]
  )
  return rows
}

function parseCustomerOtpPurpose(value) {
  const purpose = `${value ?? ""}`.trim().toUpperCase()
  if (purpose !== "LOGIN" && purpose !== "SIGNUP") {
    throw new OtpError(400, "INVALID_PURPOSE", "purpose must be LOGIN or SIGNUP")
  }
  return purpose
}

/**
 * POST /api/auth/whatsapp-otp/request  { phone, purpose: "LOGIN" | "SIGNUP" }
 * LOGIN only sends to a number with a customer account; SIGNUP only to an unregistered one
 * (each message costs money, and the answer is already public via /phone-exists).
 */
async function handleWhatsAppOtpRequest(req, res) {
  const ip = getClientIp(req)
  try {
    const purpose = parseCustomerOtpPurpose(req.body?.purpose)
    const phone = normalizeOtpPhone(req.body?.phone)
    if (purpose === "LOGIN" && !whatsappConfig().otpLoginEnabled) {
      return res.status(403).json({ error: "PHONE_LOGIN_DISABLED", message: "Phone sign-in is not available. Please sign in with email or Google." })
    }
    await ensureWhatsAppSchema()
    const accounts = await findAccountsByPhone(phone)
    if (purpose === "LOGIN" && !accounts.some(user => CUSTOMER_PHONE_LOGIN_ROLES.includes(user.role))) {
      auditAuthAsync("auth", "whatsapp_otp_request_denied", { ip, purpose, reason: "no_account", phone: maskPhone(phone) })
      return res.status(404).json({ error: "ACCOUNT_NOT_FOUND", message: "No account found for this phone number. Please sign up first." })
    }
    if (purpose === "SIGNUP" && accounts.length) {
      auditAuthAsync("auth", "whatsapp_otp_request_denied", { ip, purpose, reason: "phone_registered", phone: maskPhone(phone) })
      return res.status(409).json({ error: "PHONE_ALREADY_REGISTERED", message: "This phone number is already registered. Sign in instead." })
    }
    const result = await requestWhatsAppOtp({ phone, purpose, ip })
    auditAuthAsync("auth", "whatsapp_otp_requested", { ip, purpose, phone: maskPhone(phone), deduplicated: result.deduplicated })
    return res.json({
      ok: true,
      phone,
      channel: "WHATSAPP",
      expiresInSeconds: result.expiresInSeconds,
      resendAvailableInSeconds: result.resendAvailableInSeconds,
      deduplicated: result.deduplicated,
    })
  } catch (error) {
    if (error instanceof OtpError) auditAuthAsync("auth", "whatsapp_otp_request_failed", { ip, code: error.code })
    return sendOtpError(res, error)
  }
}

/**
 * POST /api/auth/whatsapp-otp/verify  { phone, purpose, code }
 *  - LOGIN: signs the customer in (HTTP-only app cookie, same as password login).
 *  - SIGNUP: returns a short-lived single-use `phoneProof` for `/api/auth/session`.
 */
async function handleWhatsAppOtpVerify(req, res) {
  const ip = getClientIp(req)
  try {
    const purpose = parseCustomerOtpPurpose(req.body?.purpose)
    const phone = normalizeOtpPhone(req.body?.phone)
    await ensureWhatsAppSchema()
    const verified = await verifyWhatsAppOtp({ phone, purpose, code: req.body?.code })
    if (purpose === "SIGNUP") {
      const phoneProof = await issuePhoneProof(verified)
      auditAuthAsync("auth", "whatsapp_otp_verified", { ip, purpose, phone: maskPhone(phone) })
      return res.json({ ok: true, phone, phoneProof })
    }
    const user = (await findAccountsByPhone(phone)).find(row => CUSTOMER_PHONE_LOGIN_ROLES.includes(row.role))
    if (!user) {
      await consumeOtpChallenge(pool, verified.challengeId)
      return res.status(404).json({ error: "ACCOUNT_NOT_FOUND", message: "No account found for this phone number. Please sign up first." })
    }
    if (!(await consumeOtpChallenge(pool, verified.challengeId, { phone, purpose: "LOGIN" }))) {
      return res.status(400).json({ error: "OTP_NOT_FOUND", message: "That code was already used. Request a new code." })
    }
    if (!user.phone_verified) {
      await pool.query("UPDATE users SET phone_verified = TRUE, updated_at = NOW() WHERE id = $1", [user.id])
      user.phone_verified = true
    }
    const accessToken = await signStaffAccessToken(user.id, undefined, { sessionEpoch: Number(user.app_session_epoch ?? 0) })
    res.cookie("staff_access_token", "", { maxAge: 0, httpOnly: true, secure: isProduction, sameSite: isProduction ? "none" : "lax", path: "/" })
    res.cookie("app_access_token", accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
    auditAuthAsync("auth", "whatsapp_otp_login_success", { ip, userId: user.id, role: user.role })
    return res.json({ ok: true, user: toAppUserDto(user) })
  } catch (error) {
    if (error instanceof OtpError) auditAuthAsync("auth", "whatsapp_otp_verify_failed", { ip, code: error.code })
    return sendOtpError(res, error)
  }
}

/** POST /api/auth/staff/whatsapp-otp/request { phone } — only for numbers on a staff account. */
async function handleStaffWhatsAppOtpRequest(req, res) {
  const ip = getClientIp(req)
  try {
    const phone = normalizeOtpPhone(req.body?.phone)
    await ensureWhatsAppSchema()
    const staff = (await findAccountsByPhone(phone)).find(row => STAFF_ROLES.includes(row.role))
    if (!staff) {
      auditAuthAsync("auth", "staff_whatsapp_otp_denied", { ip, reason: "no_staff_for_phone" })
      return res.status(404).json({ error: "No staff account found for this phone" })
    }
    const result = await requestWhatsAppOtp({ phone, purpose: "STAFF_SETUP", ip })
    auditAuthAsync("auth", "staff_whatsapp_otp_requested", { ip, userId: staff.id, deduplicated: result.deduplicated })
    return res.json({ ok: true, phone, channel: "WHATSAPP", expiresInSeconds: result.expiresInSeconds, resendAvailableInSeconds: result.resendAvailableInSeconds })
  } catch (error) {
    return sendOtpError(res, error)
  }
}

/** POST /api/auth/staff/whatsapp-otp/verify { phone, code } — exchanges the code for the password-setup token. */
async function handleStaffWhatsAppOtpVerify(req, res) {
  const ip = getClientIp(req)
  try {
    const phone = normalizeOtpPhone(req.body?.phone)
    await ensureWhatsAppSchema()
    const verified = await verifyWhatsAppOtp({ phone, purpose: "STAFF_SETUP", code: req.body?.code })
    const staff = (await findAccountsByPhone(phone)).find(row => STAFF_ROLES.includes(row.role))
    const consumed = await consumeOtpChallenge(pool, verified.challengeId, { phone, purpose: "STAFF_SETUP" })
    if (!staff) return res.status(404).json({ error: "No staff account found for this phone" })
    if (!consumed) return res.status(400).json({ error: "OTP_NOT_FOUND", message: "That code was already used. Request a new code." })
    const setupToken = await signStaffSetupToken({ sub: staff.id, phone: staff.phone })
    auditAuthAsync("auth", "staff_whatsapp_verify_success", { ip, userId: staff.id })
    return res.json({ setupToken })
  } catch (error) {
    if (error instanceof OtpError) auditAuthAsync("auth", "staff_whatsapp_verify_failure", { ip, code: error.code })
    return sendOtpError(res, error)
  }
}

/**
 * GET /api/auth/users/me — placeholder route behind Firebase auth.
 *
 * @type {import("express").RequestHandler}
 */
function handleUsersMePlaceholder(req, res) {
  return res.json({ user: null })
}

router.use(async (_req, _res, next) => {
  try {
    await ensureUserProfileSchema()
    next()
  } catch (error) {
    next(error)
  }
})

router.post("/session", sessionSyncRateLimit, requireFreshFirebaseToken, handlePostSession)
router.get("/phone-exists", phoneExistsRateLimit, handlePhoneExists)
router.get("/email-exists", emailExistsRateLimit, handleEmailExists)
router.post("/login", loginRateLimit, handleAppLogin)
router.get("/me", handleMe)
router.post("/logout", handleLogout)
router.post("/staff/login", staffLoginRateLimit, handleStaffLogin)
router.post("/staff/logout", handleStaffLogout)
router.get("/staff/me", handleStaffMe)
router.post("/staff/verify-firebase-phone", staffFirebaseVerifyRateLimit, handleStaffVerifyFirebasePhone)
router.post("/whatsapp-otp/request", whatsappOtpRequestRateLimit, handleWhatsAppOtpRequest)
router.post("/whatsapp-otp/verify", whatsappOtpVerifyRateLimit, handleWhatsAppOtpVerify)
router.post("/staff/whatsapp-otp/request", whatsappOtpRequestRateLimit, handleStaffWhatsAppOtpRequest)
router.post("/staff/whatsapp-otp/verify", whatsappOtpVerifyRateLimit, handleStaffWhatsAppOtpVerify)
router.post("/request-password-reset", passwordResetRequestRateLimit, handleRequestPasswordReset)
router.post("/complete-db-password-reset", passwordResetCompleteRateLimit, handleCompleteDbPasswordReset)
router.post("/staff/set-password", staffSetPasswordRateLimit, handleStaffSetPassword)
router.get("/users/me", requireFirebaseAuth, handleUsersMePlaceholder)

export default router

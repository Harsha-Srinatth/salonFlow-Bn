/**
 * Authentication and session HTTP routes for customers, staff, and password lifecycle.
 * Security controls applied here: IP rate limits (see `middleware/rate-limiters.js`), per-IP+email login lockout
 * after repeated bad passwords (`lib/login-lockout.js`), structured audit lines (`lib/audit-log.js`), and short-lived
 * staff setup tokens (`STAFF_SETUP_TOKEN_TTL`, default 5m). Multi-factor authentication is not implemented yet.
 */
import express from "express"
import { randomBytes } from "node:crypto"
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
import { requireFirebaseAuth } from "../middleware/auth.js"
import {
  loginRateLimit,
  staffLoginRateLimit,
  sessionSyncRateLimit,
  phoneExistsRateLimit,
  passwordResetCompleteRateLimit,
  passwordResetRequestRateLimit,
  staffFirebaseVerifyRateLimit,
  staffSetPasswordRateLimit,
} from "../middleware/rate-limiters.js"
import bcrypt from "bcryptjs"
import { acceptStaffSessionToken, createStaffSession, clearStaffSession } from "../lib/store.js"
import { signStaffAccessToken, signStaffSetupToken, verifyStaffAccessToken, verifyStaffSetupToken } from "../lib/tokens.js"
import { verifyFirebaseToken } from "../lib/firebase-admin.js"

const router = express.Router()
let authSchemaEnsured = false

async function ensureAuthSchema() {
  if (authSchemaEnsured) return
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(16) NOT NULL DEFAULT 'OTHER'`)
  authSchemaEnsured = true
}

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
    SELECT id, name, email, role, phone, gender, account_status, firebase_uid, password_hash, membership_segment
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
 * Validates full name rules for customer self-registration (letters, length, anti-gibberish heuristics).
 *
 * @param {string} name
 * @returns {boolean}
 */
function isValidFullName(name) {
  const normalized = `${name ?? ""}`.trim().replace(/\s+/g, " ")
  if (normalized.length < 4) return false
  const tokens = normalized.split(" ")
  if (tokens.length < 2) return false
  if (!/^[A-Za-z][A-Za-z\s'.-]+$/.test(normalized)) return false
  const lettersOnly = normalized.replace(/[^A-Za-z]/g, "").toLowerCase()
  if (lettersOnly.length < 4) return false
  let maxRun = 1
  let run = 1
  for (let i = 1; i < lettersOnly.length; i += 1) {
    run = lettersOnly[i] === lettersOnly[i - 1] ? run + 1 : 1
    if (run > maxRun) maxRun = run
  }
  if (maxRun >= 4) return false
  const uniqueChars = new Set(lettersOnly).size
  if (uniqueChars <= 3) return false
  return true
}

/**
 * Normalizes whitespace for persisted display name.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return `${name ?? ""}`.trim().replace(/\s+/g, " ")
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
      SELECT id, name, email, role, phone, gender, account_status, membership_segment
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
    return getDbUserById(payload.sub)
  } catch {
    return null
  }
}

/**
 * POST /api/auth/session
 * After Firebase client sign-in / phone verification, syncs Firebase identity into `users`.
 * Rate-limited per IP to slow mass fake registrations. Inserts a row on first registration.
 *
 * @type {import("express").RequestHandler}
 */
async function handlePostSession(req, res) {
  const ip = getClientIp(req)
  const requestedRole = "USER"
  const requestedPhone = typeof req.headers["x-user-phone"] === "string" ? req.headers["x-user-phone"] : ""
  const requestedNameRaw = typeof req.headers["x-user-name"] === "string" ? req.headers["x-user-name"] : ""
  const requestedGenderRaw = typeof req.headers["x-user-gender"] === "string" ? req.headers["x-user-gender"] : "OTHER"
  const requestedGender = ["MALE", "FEMALE", "OTHER"].includes(`${requestedGenderRaw}`.trim().toUpperCase())
    ? `${requestedGenderRaw}`.trim().toUpperCase()
    : "OTHER"
  const requestedName = normalizeName(requestedNameRaw)
  const firebase = req.firebaseUser
  const dbUser = await findDbUser({
    firebaseUid: firebase.uid,
    email: firebase.email ?? "",
    phone: requestedPhone,
  })

  if (dbUser && !dbUser.firebase_uid) {
    await pool.query("UPDATE users SET firebase_uid = $1, updated_at = NOW() WHERE id = $2", [firebase.uid, dbUser.id])
  }

  if (!dbUser) {
    if (!requestedPhone) {
      auditAuthAsync("auth", "session_register_denied", { ip, reason: "missing_phone", firebaseUid: firebase.uid })
      return res.status(400).json({ error: "Phone number is required for registration" })
    }
    if (!isValidFullName(requestedName)) {
      auditAuthAsync("auth", "session_register_denied", { ip, reason: "invalid_name", firebaseUid: firebase.uid })
      return res.status(400).json({ error: "Please enter your full name (at least 4 valid letters)." })
    }
    const resolvedEmail = firebase.email ?? ""
    if (!resolvedEmail) {
      auditAuthAsync("auth", "session_register_denied", { ip, reason: "missing_email", firebaseUid: firebase.uid })
      return res.status(400).json({ error: "Email is required to complete registration" })
    }
    const { rows } = await pool.query(
      `
        INSERT INTO users (name, email, phone, gender, firebase_uid, role, latitude, longitude, account_status)
        VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'ACTIVE')
        RETURNING id, name, email, role, phone, gender, account_status, membership_segment
      `,
      [requestedName, resolvedEmail, requestedPhone, requestedGender, firebase.uid, requestedRole]
    )
    auditAuthAsync("auth", "session_register_success", {
      ip,
      userId: rows[0].id,
      firebaseUid: firebase.uid,
      emailHint: `${resolvedEmail.slice(0, 2)}…`,
    })
    return res.json({
      user: {
        id: rows[0].id,
        name: rows[0].name,
        email: rows[0].email,
        role: rows[0].role,
        phone: rows[0].phone,
        gender: rows[0].gender,
        accountStatus: rows[0].account_status,
        membershipSegment: `${rows[0].membership_segment ?? "FREE"}`.trim().toUpperCase() || "FREE",
      },
    })
  }

  auditAuthAsync("auth", "session_sync_success", { ip, userId: dbUser.id, firebaseUid: firebase.uid })
  return res.json({
    user: {
      id: dbUser.id,
      name: dbUser.name,
      email: dbUser.email,
      role: dbUser.role,
      phone: dbUser.phone,
      gender: dbUser.gender,
      accountStatus: dbUser.account_status,
      membershipSegment: `${dbUser.membership_segment ?? "FREE"}`.trim().toUpperCase() || "FREE",
    },
  })
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
      SELECT id, name, email, role, phone, gender, account_status, password_hash
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
  const accessToken = await signStaffAccessToken(user.id)
  createStaffSession(user.id, accessToken)
  auditAuthAsync("auth", "login_success", {
    ip,
    userId: user.id,
    role: user.role,
    sessionPolicy: "single_active_cookie",
  })
  res.cookie("staff_access_token", "", { maxAge: 0, httpOnly: true, secure: false, sameSite: "lax", path: "/" })
  res.cookie("app_access_token", accessToken, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
  return res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      gender: user.gender,
      accountStatus: user.account_status,
    },
  })
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
  return res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      gender: user.gender,
      accountStatus: user.account_status,
      membershipSegment: `${user.membership_segment ?? "FREE"}`.trim().toUpperCase() || "FREE",
    },
  })
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
    try {
      const payload = await verifyStaffAccessToken(token)
      clearStaffSession(payload.sub)
    } catch {
      // ignore invalid token
    }
  }
  res.cookie("app_access_token", "", { maxAge: 0, httpOnly: true, secure: false, sameSite: "lax", path: "/" })
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
    if (normalizedEmail) recordPasswordLoginFailure(ip, normalizedEmail)
    auditAuthAsync("auth", "staff_login_failure", { ip, reason: "invalid_role_or_user" })
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
  const accessToken = await signStaffAccessToken(user.id)
  createStaffSession(user.id, accessToken)
  auditAuthAsync("auth", "staff_login_success", { ip, userId: user.id, role: user.role })
  res.cookie("app_access_token", "", { maxAge: 0, httpOnly: true, secure: false, sameSite: "lax", path: "/" })
  res.cookie("staff_access_token", accessToken, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
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
      clearStaffSession(payload.sub)
    } catch {
      // ignore invalid token
    }
  }
  res.cookie("staff_access_token", "", { maxAge: 0, httpOnly: true, secure: false, sameSite: "lax", path: "/" })
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
    if (!acceptStaffSessionToken(payload.sub, token)) return res.json({ user: null })
    const user = await getDbUserById(payload.sub)
    if (!user) return res.json({ user: null })
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
    if (!newPassword || `${newPassword}`.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" })
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
        SET password_hash = $2, updated_at = NOW()
        WHERE id = $1
      `,
      [row.id, hashedPassword]
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
    if (!password || `${password}`.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" })
    const payload = await verifyStaffSetupToken(token)
    const hashedPassword = await bcrypt.hash(`${password}`, 12)
    const { rowCount } = await pool.query(
      `
        UPDATE users
        SET password_hash = $2, account_status = 'ACTIVE', updated_at = NOW()
        WHERE id = $1
      `,
      [payload.sub, hashedPassword]
    )
    if (!rowCount) {
      auditAuthAsync("auth", "staff_set_password_failure", { ip, reason: "user_not_found" })
      return res.status(404).json({ error: "User not found" })
    }
    auditAuthAsync("auth", "staff_set_password_success", { ip, userId: payload.sub })
    return res.json({ success: true })
  } catch (error) {
    auditAuthAsync("auth", "staff_set_password_failure", { ip, message: error instanceof Error ? error.message : "error" })
    return res.status(400).json({ error: error instanceof Error ? error.message : "Could not set password" })
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
    await ensureAuthSchema()
    next()
  } catch (error) {
    next(error)
  }
})

router.post("/session", sessionSyncRateLimit, requireFirebaseAuth, handlePostSession)
router.get("/phone-exists", phoneExistsRateLimit, handlePhoneExists)
router.post("/login", loginRateLimit, handleAppLogin)
router.get("/me", handleMe)
router.post("/logout", handleLogout)
router.post("/staff/login", staffLoginRateLimit, handleStaffLogin)
router.post("/staff/logout", handleStaffLogout)
router.get("/staff/me", handleStaffMe)
router.post("/staff/verify-firebase-phone", staffFirebaseVerifyRateLimit, handleStaffVerifyFirebasePhone)
router.post("/request-password-reset", passwordResetRequestRateLimit, handleRequestPasswordReset)
router.post("/complete-db-password-reset", passwordResetCompleteRateLimit, handleCompleteDbPasswordReset)
router.post("/staff/set-password", staffSetPasswordRateLimit, handleStaffSetPassword)
router.get("/users/me", requireFirebaseAuth, handleUsersMePlaceholder)

export default router

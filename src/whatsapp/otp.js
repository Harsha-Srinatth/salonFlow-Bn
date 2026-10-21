/**
 * Phone verification by a one-time code delivered on WhatsApp (replaces Firebase SMS).
 *
 * Security properties, and where each one comes from:
 *  - Codes come from `crypto.randomInt` and are stored only as HMAC-SHA256(server key,
 *    challenge id + phone + purpose + code). A database leak does not reveal live codes,
 *    and a hash cannot be replayed against another challenge.
 *  - One ACTIVE challenge per (phone, purpose), enforced by a unique partial index. A new
 *    code supersedes the previous one, so an old code stops working the moment a new one
 *    is issued.
 *  - Brute force: `max_attempts` wrong guesses lock the challenge; per-phone and per-IP
 *    hourly caps are counted in the database (shared by every instance), on top of the
 *    express-rate-limit per-IP limiter on the routes.
 *  - Duplicate requests (double click, retry, re-render) within the resend cooldown get
 *    the existing challenge back instead of a second WhatsApp message. Requests for the
 *    same number are serialised with an advisory lock so two concurrent ones cannot both
 *    send.
 *  - Reuse: a verified challenge is consumed exactly once (`VERIFIED -> CONSUMED` is a
 *    conditional UPDATE), whether by a login, a staff setup or a registration.
 *  - Comparison is constant-time.
 */
import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto"
import { SignJWT, jwtVerify } from "jose"
import { pool } from "../lib/db-pool.js"
import { TEMPLATE_KEYS, isWhatsAppSendingAvailable, templateFor, whatsappConfig } from "./config.js"
import { authenticationTemplateComponents, sendTemplateMessage } from "./client.js"
import { isAllowedCountry, maskPhone, normalizePhone } from "./phone.js"
import { BUDGETS, remainingThisMonth } from "./budget.js"

export const OTP_PURPOSES = ["LOGIN", "SIGNUP", "STAFF_SETUP"]

const KEY = createHmac("sha256", `${process.env.STAFF_SETUP_SECRET ?? "staff-setup-dev-secret"}`)
  .update("sahasra-whatsapp-otp-v1")
  .digest()
const PROOF_KEY = createHmac("sha256", KEY).update("phone-proof").digest()
const PROOF_AUDIENCE = "sahasra:phone-proof"

export class OtpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.expose = true
    Object.assign(this, extra)
  }
}

function hashCode(challengeId, phone, purpose, code) {
  return createHmac("sha256", KEY).update(`${challengeId}:${phone}:${purpose}:${code}`).digest("hex")
}

export function hashIp(ip) {
  return createHmac("sha256", KEY).update(`ip:${ip ?? ""}`).digest("hex")
}

function generateCode(length) {
  return `${randomInt(0, 10 ** length)}`.padStart(length, "0")
}

function assertPurpose(purpose) {
  if (!OTP_PURPOSES.includes(purpose)) throw new OtpError(400, "INVALID_PURPOSE", "Unknown verification purpose")
}

/**
 * Validates and normalises the number a code is requested for.
 * @returns {string} E.164
 */
export function normalizeOtpPhone(input, config = whatsappConfig()) {
  const phone = normalizePhone(input, config.defaultCountryCode)
  if (!phone) throw new OtpError(400, "INVALID_PHONE", "Enter a valid mobile number")
  if (!isAllowedCountry(phone, config.otp.allowedCountryCodes)) {
    throw new OtpError(400, "PHONE_COUNTRY_NOT_SUPPORTED", "Verification codes can only be sent to supported country codes")
  }
  return phone
}

/** How this process delivers codes right now: real WhatsApp, the dev fixed code, or not at all. */
export function otpDeliveryMode(config = whatsappConfig()) {
  if (isWhatsAppSendingAvailable(config) && templateFor(TEMPLATE_KEYS.OTP, config)) return "WHATSAPP"
  if (!config.production && /^\d{4,8}$/.test(config.otp.devFixedCode)) return "DEV_FIXED_CODE"
  return "UNAVAILABLE"
}

/**
 * Issues (or re-uses, inside the cooldown) a code for `phone` and sends it on WhatsApp.
 * Callers decide beforehand whether this purpose is allowed for the number (account exists
 * for LOGIN, not yet registered for SIGNUP, staff account for STAFF_SETUP).
 *
 * @returns {Promise<{ challengeId: string, expiresInSeconds: number, resendAvailableInSeconds: number, deduplicated: boolean }>}
 */
export async function requestWhatsAppOtp({ phone, purpose, ip, config = whatsappConfig(), db = pool }) {
  assertPurpose(purpose)
  const mode = otpDeliveryMode(config)
  if (mode === "UNAVAILABLE") {
    throw new OtpError(503, "WHATSAPP_OTP_UNAVAILABLE", "Phone verification by WhatsApp is not available right now. Please try again later.")
  }
  const { otp } = config
  const ipHash = hashIp(ip)
  const challengeId = randomUUID()
  const code = mode === "DEV_FIXED_CODE" ? config.otp.devFixedCode : generateCode(otp.length)

  const client = await db.connect()
  let reused = null
  try {
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wa-otp:${phone}`])
    // Expire stale ACTIVE rows first so they neither block the unique index nor count as live.
    await client.query(
      `UPDATE whatsapp_otp_challenges SET status = 'EXPIRED' WHERE phone = $1 AND status = 'ACTIVE' AND expires_at <= NOW()`,
      [phone]
    )
    const { rows: active } = await client.query(
      `SELECT id, expires_at, created_at,
              GREATEST(0, CEIL(EXTRACT(EPOCH FROM (created_at + make_interval(secs => $3) - NOW()))))::int AS cooldown_left,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - NOW()))))::int AS expires_in
         FROM whatsapp_otp_challenges
        WHERE phone = $1 AND purpose = $2 AND status = 'ACTIVE'
        LIMIT 1`,
      [phone, purpose, otp.resendCooldownSeconds]
    )
    if (active[0] && active[0].cooldown_left > 0) {
      reused = active[0]
    } else {
      if (mode === "WHATSAPP" && (await remainingThisMonth(BUDGETS.OTP, config, client)) <= 0) {
        console.warn("whatsapp_monthly_limit_reached", { budget: BUDGETS.OTP })
        throw new OtpError(503, "WHATSAPP_MONTHLY_LIMIT", "WhatsApp verification is paused for now. Please sign in with email or Google, or try again later.")
      }
      const { rows: counts } = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE phone = $1)::int AS phone_count,
           COUNT(*) FILTER (WHERE ip_hash = $2)::int AS ip_count,
           MIN(created_at) FILTER (WHERE phone = $1) AS phone_oldest
         FROM whatsapp_otp_challenges
         WHERE created_at > NOW() - interval '1 hour' AND (phone = $1 OR ip_hash = $2)`,
        [phone, ipHash]
      )
      const { phone_count: phoneCount, ip_count: ipCount, phone_oldest: phoneOldest } = counts[0]
      if (phoneCount >= otp.maxPerPhonePerHour) {
        const retryAfterSeconds = phoneOldest ? Math.max(60, Math.ceil((new Date(phoneOldest).getTime() + 3600_000 - Date.now()) / 1000)) : 3600
        throw new OtpError(429, "OTP_RATE_LIMITED", "Too many codes requested for this number. Please try again later.", { retryAfterSeconds })
      }
      if (ipCount >= otp.maxPerIpPerHour) {
        throw new OtpError(429, "OTP_RATE_LIMITED", "Too many codes requested from this network. Please try again later.", { retryAfterSeconds: 3600 })
      }
      await client.query(
        `UPDATE whatsapp_otp_challenges SET status = 'SUPERSEDED' WHERE phone = $1 AND purpose = $2 AND status = 'ACTIVE'`,
        [phone, purpose]
      )
      await client.query(
        `INSERT INTO whatsapp_otp_challenges (id, phone, purpose, code_hash, max_attempts, ip_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(secs => $7))`,
        [challengeId, phone, purpose, hashCode(challengeId, phone, purpose, code), otp.maxAttempts, ipHash, otp.ttlSeconds]
      )
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }

  if (reused) {
    return {
      challengeId: reused.id,
      expiresInSeconds: reused.expires_in,
      resendAvailableInSeconds: reused.cooldown_left,
      deduplicated: true,
    }
  }

  if (mode === "WHATSAPP") {
    const template = templateFor(TEMPLATE_KEYS.OTP, config)
    try {
      const { messageId } = await sendTemplateMessage(
        { to: phone, name: template.name, language: template.language, components: authenticationTemplateComponents(code) },
        config
      )
      await db.query(`UPDATE whatsapp_otp_challenges SET wa_message_id = $2 WHERE id = $1`, [challengeId, messageId])
    } catch (error) {
      // The code never reached the customer: retire it so a retry is not blocked by the
      // cooldown. It still counts towards the hourly caps (that is the abuse control).
      await db
        .query(`UPDATE whatsapp_otp_challenges SET status = 'DELIVERY_FAILED', delivery_error = $2 WHERE id = $1 AND status = 'ACTIVE'`, [
          challengeId,
          `${error?.kind ?? "ERROR"}:${error?.code ?? ""}`.slice(0, 160),
        ])
        .catch(() => {})
      console.error("whatsapp_otp_send_failed", { phone: maskPhone(phone), purpose, kind: error?.kind, code: error?.code ?? null })
      const recipientProblem = error?.kind === "PERMANENT" && [131026, 131045, 133010].includes(Number(error?.code))
      throw new OtpError(
        recipientProblem ? 400 : 502,
        recipientProblem ? "WHATSAPP_NOT_AVAILABLE_FOR_NUMBER" : "OTP_DELIVERY_FAILED",
        recipientProblem
          ? "We couldn't deliver a WhatsApp message to this number. Check that WhatsApp is installed and active on it."
          : "We couldn't send the code right now. Please try again in a moment.",
        { retryable: !recipientProblem }
      )
    }
  }

  return {
    challengeId,
    expiresInSeconds: otp.ttlSeconds,
    resendAvailableInSeconds: otp.resendCooldownSeconds,
    deduplicated: false,
  }
}

/**
 * Checks a code. Success moves the challenge to VERIFIED (it still has to be consumed by
 * whatever the verification was for). Wrong guesses are committed before the error is
 * thrown, so a failing request cannot roll its own attempt counter back.
 *
 * @returns {Promise<{ challengeId: string, phone: string, purpose: string }>}
 */
export async function verifyWhatsAppOtp({ phone, purpose, code, db = pool }) {
  assertPurpose(purpose)
  const cleanCode = `${code ?? ""}`.trim()
  if (!/^\d{4,8}$/.test(cleanCode)) throw new OtpError(400, "OTP_INVALID", "Enter the code from WhatsApp")
  const client = await db.connect()
  let outcome
  try {
    await client.query("BEGIN")
    const { rows } = await client.query(
      `SELECT id, code_hash, attempts, max_attempts, expires_at <= NOW() AS expired
         FROM whatsapp_otp_challenges
        WHERE phone = $1 AND purpose = $2 AND status = 'ACTIVE'
        FOR UPDATE`,
      [phone, purpose]
    )
    const challenge = rows[0]
    if (!challenge) {
      outcome = { error: new OtpError(400, "OTP_NOT_FOUND", "No active code for this number. Request a new code.") }
    } else if (challenge.expired) {
      await client.query(`UPDATE whatsapp_otp_challenges SET status = 'EXPIRED' WHERE id = $1`, [challenge.id])
      outcome = { error: new OtpError(400, "OTP_EXPIRED", "That code has expired. Request a new code.") }
    } else {
      const expected = Buffer.from(challenge.code_hash, "hex")
      const actual = Buffer.from(hashCode(challenge.id, phone, purpose, cleanCode), "hex")
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
        await client.query(`UPDATE whatsapp_otp_challenges SET status = 'VERIFIED', verified_at = NOW(), attempts = attempts + 1 WHERE id = $1`, [challenge.id])
        outcome = { ok: { challengeId: challenge.id, phone, purpose } }
      } else {
        const attempts = challenge.attempts + 1
        const locked = attempts >= challenge.max_attempts
        await client.query(`UPDATE whatsapp_otp_challenges SET attempts = $2, status = $3 WHERE id = $1`, [
          challenge.id,
          attempts,
          locked ? "LOCKED" : "ACTIVE",
        ])
        outcome = {
          error: locked
            ? new OtpError(429, "OTP_LOCKED", "Too many wrong codes. Request a new code.")
            : new OtpError(400, "OTP_INVALID", "That code isn't right. Check WhatsApp and try again.", {
                attemptsRemaining: challenge.max_attempts - attempts,
              }),
        }
      }
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
  if (outcome.error) throw outcome.error
  return outcome.ok
}

/**
 * Marks a VERIFIED challenge as used. Returns false when it was already consumed (reuse)
 * or never verified. Pass a transaction client to make it atomic with what it authorises.
 */
export async function consumeOtpChallenge(db, challengeId, { phone, purpose } = {}) {
  const { rowCount } = await db.query(
    `UPDATE whatsapp_otp_challenges SET status = 'CONSUMED', consumed_at = NOW()
      WHERE id = $1 AND status = 'VERIFIED'
        AND ($2::text IS NULL OR phone = $2) AND ($3::text IS NULL OR purpose = $3)`,
    [challengeId, phone ?? null, purpose ?? null]
  )
  return rowCount === 1
}

/**
 * Signup verifies the phone before the account exists, so the proof has to be carried to
 * `/api/auth/session`. It is a short-lived signed token naming the challenge; registration
 * consumes that challenge in the same transaction as the INSERT, so one proof makes at
 * most one account.
 */
export async function issuePhoneProof({ challengeId, phone, purpose }, config = whatsappConfig()) {
  return new SignJWT({ pur: purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(phone)
    .setJti(challengeId)
    .setAudience(PROOF_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.otp.proofTtlSeconds}s`)
    .sign(PROOF_KEY)
}

/** Verifies a proof's signature and expiry. @returns {Promise<{ phone: string, challengeId: string, purpose: string } | null>} */
export async function readPhoneProof(token) {
  if (typeof token !== "string" || !token || token.length > 2048) return null
  try {
    const { payload } = await jwtVerify(token, PROOF_KEY, { audience: PROOF_AUDIENCE })
    if (!payload.sub || !payload.jti) return null
    return { phone: payload.sub, challengeId: payload.jti, purpose: payload.pur }
  } catch {
    return null
  }
}

/** Retention: challenges are evidence for a few days, not forever. */
export async function pruneOtpChallenges({ days = 7, db = pool } = {}) {
  const { rowCount } = await db.query(
    `DELETE FROM whatsapp_otp_challenges WHERE created_at < NOW() - make_interval(days => $1)`,
    [days]
  )
  return rowCount
}

/**
 * A signup proof that is genuine, unexpired and not yet used.
 * @returns {Promise<{ phone: string, challengeId: string } | null>}
 */
export async function loadUsablePhoneProof(token, { purpose = "SIGNUP", db = pool } = {}) {
  const proof = await readPhoneProof(token)
  if (!proof || proof.purpose !== purpose) return null
  const { rows } = await db.query(
    `SELECT 1 FROM whatsapp_otp_challenges WHERE id = $1 AND phone = $2 AND purpose = $3 AND status = 'VERIFIED'`,
    [proof.challengeId, proof.phone, purpose]
  )
  return rows[0] ? { phone: proof.phone, challengeId: proof.challengeId } : null
}

/**
 * Single-use tokens for email verification and password reset.
 *
 * The raw value exists only in the email; the database keeps its SHA-256. A fast hash is right
 * here because the token is 256 random bits, so there is nothing to brute-force, and it lets a
 * link be looked up directly. Consuming is one conditional UPDATE, so two simultaneous clicks
 * cannot both succeed: the second finds `consumed_at` already set.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

export const TOKEN_VERIFY_EMAIL = "VERIFY_EMAIL"
export const TOKEN_RESET_PASSWORD = "RESET_PASSWORD"

export function hashToken(raw) {
  return createHash("sha256").update(`${raw ?? ""}`).digest("hex")
}

/**
 * Issues a token and retires any earlier one of the same purpose, so only the newest email's
 * link works.
 *
 * @returns {Promise<string>} the raw token, to be put in the email and nowhere else
 */
export async function issueEmailToken(db, { userId, purpose, ttlMinutes }) {
  const raw = randomBytes(32).toString("base64url")
  await db.query(
    `UPDATE email_tokens SET invalidated_at = NOW()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND invalidated_at IS NULL`,
    [userId, purpose]
  )
  await db.query(
    `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5))`,
    [randomUUID(), userId, purpose, hashToken(raw), ttlMinutes]
  )
  return raw
}

/**
 * Burns a token. Run it inside the transaction that applies what the token authorises, so a
 * failure later in that transaction also puts the token back.
 *
 * @returns {Promise<string | null>} the user id, or null when the token cannot be used
 */
export async function consumeEmailToken(db, { raw, purpose }) {
  const { rows } = await db.query(
    `UPDATE email_tokens SET consumed_at = NOW()
      WHERE token_hash = $1 AND purpose = $2
        AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > NOW()
      RETURNING user_id`,
    [hashToken(raw), purpose]
  )
  return rows[0]?.user_id ?? null
}

/** Why a token cannot be used, or that it can: VALID, USED, EXPIRED or INVALID. Changes nothing. */
export async function inspectEmailToken(db, { raw, purpose }) {
  const { rows } = await db.query(
    `SELECT user_id, consumed_at, invalidated_at, expires_at <= NOW() AS expired
       FROM email_tokens WHERE token_hash = $1 AND purpose = $2`,
    [hashToken(raw), purpose]
  )
  const row = rows[0]
  if (!row) return { state: "INVALID" }
  if (row.consumed_at) return { state: "USED", userId: row.user_id }
  if (row.invalidated_at) return { state: "EXPIRED", userId: row.user_id }
  if (row.expired) return { state: "EXPIRED", userId: row.user_id }
  return { state: "VALID", userId: row.user_id }
}

export async function invalidateUserTokens(db, userId) {
  await db.query(
    `UPDATE email_tokens SET invalidated_at = NOW()
      WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
    [userId]
  )
}

function unsubscribeSignature(userId, secret) {
  return createHmac("sha256", secret).update(`unsubscribe:${userId}`).digest("base64url")
}

/** A signed, non-expiring link token: an unsubscribe must keep working in an old email. */
export function signUnsubscribeToken(userId, secret) {
  return `${userId}.${unsubscribeSignature(userId, secret)}`
}

/** @returns {string | null} the user id when the signature is genuine */
export function verifyUnsubscribeToken(token, secret) {
  const [userId, signature, extra] = `${token ?? ""}`.split(".")
  if (!userId || !signature || extra !== undefined || !secret) return null
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null
  const expected = Buffer.from(unsubscribeSignature(userId, secret))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given) ? userId : null
}

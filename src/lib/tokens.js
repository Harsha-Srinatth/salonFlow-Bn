import { SignJWT, jwtVerify } from "jose"

const encoder = new TextEncoder()
const ACCESS_SECRET = encoder.encode(process.env.STAFF_ACCESS_SECRET ?? "staff-access-dev-secret")
const SETUP_SECRET = encoder.encode(process.env.STAFF_SETUP_SECRET ?? "staff-setup-dev-secret")

/**
 * Issues the HTTP-only cookie JWT for app + staff sessions (`sub` = `users.id`).
 * One active token per user is tracked in memory (`store.js`); new login replaces the previous server-side session.
 *
 * @param {string} userId Database user primary key
 * @returns {Promise<string>} Signed JWT
 */
export async function signStaffAccessToken(userId) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`${userId}`)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(ACCESS_SECRET)
}

/**
 * Validates access JWT and returns claims (`sub` is app user id).
 *
 * @param {string} token Raw JWT from Cookie or Authorization header
 * @returns {Promise<import("jose").JWTPayload>}
 */
export async function verifyStaffAccessToken(token) {
  const verified = await jwtVerify(token, ACCESS_SECRET)
  return verified.payload
}

/**
 * Short-lived token issued after staff phone OTP so they can POST /staff/set-password once.
 * Default 5 minutes (`STAFF_SETUP_TOKEN_TTL` like `5m`, `300s`, per jose); aligns with “verify window” policy.
 */
export async function signStaffSetupToken(payload) {
  const ttl = process.env.STAFF_SETUP_TOKEN_TTL ?? "5m"
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(SETUP_SECRET)
}

/**
 * Validates the setup token from `signStaffSetupToken`; on success `payload.sub` is the staff user id.
 *
 * @param {string} token
 * @returns {Promise<import("jose").JWTPayload>}
 */
export async function verifyStaffSetupToken(token) {
  const verified = await jwtVerify(token, SETUP_SECRET)
  return verified.payload
}

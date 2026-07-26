import { pool } from "../lib/db-pool.js"
import { verifyFirebaseToken } from "../lib/firebase-admin.js"
import { acceptStaffSessionToken } from "../lib/store.js"
import { verifyStaffAccessToken } from "../lib/tokens.js"

/**
 * Loads app user by Firebase uid or email (whichever is present on the token).
 * Used when the request is authenticated with a Firebase ID token rather than the app cookie.
 *
 * @param {{ uid?: string, email?: string }} firebaseUser Decoded Firebase claims
 * @returns {Promise<object | null>}
 */
async function findDbUserByFirebase(firebaseUser) {
  const uid = firebaseUser?.uid
  const email = firebaseUser?.email
  if (!uid && !email) return null
  const values = []
  const conditions = []
  if (uid) {
    values.push(uid)
    conditions.push(`firebase_uid = $${values.length}`)
  }
  if (email) {
    const e = `${email ?? ""}`.trim().toLowerCase()
    values.push(e)
    conditions.push(`lower(btrim(email)) = $${values.length}`)
  }
  const sql = `
    SELECT id, name, email, role, phone, gender, account_status, membership_segment
    FROM users
    WHERE ${conditions.join(" OR ")}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1
  `
  const { rows } = await pool.query(sql, values)
  return rows[0] ?? null
}

/**
 * Loads user row by primary key for session cookie resolution.
 *
 * @param {string} id
 * @returns {Promise<object | null>}
 */
async function findDbUserById(id) {
  if (!id) return null
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
 * Maps a DB row to the shape exposed on `req.appUser`.
 *
 * @param {object | null} row
 */
function toAppUser(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    phone: row.phone,
    gender: row.gender,
    accountStatus: row.account_status,
    membershipSegment: `${row.membership_segment ?? "FREE"}`.trim().toUpperCase() || "FREE",
  }
}

/**
 * Express middleware: authenticate either (1) existing staff/app cookie JWT, or (2) `Authorization: Bearer` Firebase ID token.
 * Sets `req.appUser` when the cookie path succeeds, or `req.firebaseUser` when only Firebase is used.
 * Used by `/api/auth/session` and other routes that must run right after client Firebase sign-in.
 *
 * @type {import("express").RequestHandler}
 */
async function resolveAppUserFromSessionCookie(sessionToken, { requireActiveSession = false } = {}) {
  if (!sessionToken) return null
  try {
    const payload = await verifyStaffAccessToken(sessionToken)
    if (requireActiveSession) {
      if (!acceptStaffSessionToken(payload.sub, sessionToken)) return null
    }
    const user = await findDbUserById(payload.sub)
    return user ? toAppUser(user) : null
  } catch {
    return null
  }
}

/**
 * Reception/staff portal routes: authenticate only via `staff_access_token` so a stale
 * `app_access_token` (e.g. admin) cannot shadow the receptionist session (403 Forbidden).
 *
 * @type {import("express").RequestHandler}
 */
export async function requireStaffSessionAuth(req, res, next) {
  try {
    const appUser = await resolveAppUserFromSessionCookie(req.cookies?.staff_access_token ?? null, {
      requireActiveSession: true,
    })
    if (appUser) {
      req.appUser = appUser
      return next()
    }
    return res.status(401).json({ error: "Missing authorization token" })
  } catch (error) {
    console.error("Staff session auth failed:", error instanceof Error ? error.message : error)
    res.status(401).json({ error: "Invalid token" })
  }
}

export async function requireFirebaseAuth(req, res, next) {
  try {
    const sessionToken = req.cookies?.app_access_token ?? req.cookies?.staff_access_token ?? null
    const appUser = await resolveAppUserFromSessionCookie(sessionToken, { requireActiveSession: false })
    if (appUser) {
      req.appUser = appUser
      return next()
    }
    const auth = req.headers.authorization ?? ""
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null
    if (!token) return res.status(401).json({ error: "Missing authorization token" })
    req.firebaseUser = await verifyFirebaseToken(token)
    next()
  } catch (error) {
    console.error("Firebase auth failed:", error instanceof Error ? error.message : error)
    res.status(401).json({ error: "Invalid token" })
  }
}

/**
 * Factory: requires `req.appUser` or resolved DB user to have a specific `role` (e.g. ADMIN).
 * Must run after `requireFirebaseAuth`.
 *
 * @param {string} role
 * @returns {import("express").RequestHandler}
 */
export function requireAppRole(role) {
  return async (req, res, next) => {
    try {
      const appUser = req.appUser ?? toAppUser(await findDbUserByFirebase(req.firebaseUser))
      if (!appUser || appUser.role !== role) {
        return res.status(403).json({ error: "Forbidden" })
      }
      req.appUser = appUser
      next()
    } catch {
      res.status(403).json({ error: "Forbidden" })
    }
  }
}

/**
 * Per-IP+email brute-force mitigation for password login endpoints.
 * After `LOGIN_FAILS_BEFORE_LOCKOUT` consecutive failed password checks, further attempts
 * receive HTTP 429 until `LOGIN_LOCKOUT_MS` elapses (default 5 minutes).
 * In-memory only — use Redis for multi-instance deployments.
 */

const store = new Map()

function keyFor(ip, email) {
  return `${ip}::${`${email ?? ""}`.trim().toLowerCase()}`
}

/**
 * @param {string} ip From getClientIp
 * @param {string} email Normalized email used in login attempt
 * @returns {{ blockedUntil: number, failCount: number }}
 */
function getRecord(ip, email) {
  return store.get(keyFor(ip, email)) ?? { failCount: 0, blockedUntil: 0 }
}

/**
 * Throws an Error with `code: "LOCKED"` and `retryAfterSeconds` if the pair is in lockout window.
 * Call at the start of each password login attempt.
 *
 * @param {string} ip
 * @param {string} email
 */
export function assertPasswordLoginNotLocked(ip, email) {
  const now = Date.now()
  const rec = getRecord(ip, email)
  if (rec.blockedUntil > now) {
    const err = new Error("Too many failed attempts. Try again later.")
    err.code = "LOCKED"
    err.retryAfterSeconds = Math.ceil((rec.blockedUntil - now) / 1000)
    throw err
  }
}

/**
 * Increment failure count; when threshold reached, start lockout window.
 *
 * @param {string} ip
 * @param {string} email
 */
export function recordPasswordLoginFailure(ip, email) {
  const now = Date.now()
  const k = keyFor(ip, email)
  let rec = getRecord(ip, email)
  if (rec.blockedUntil > now) return
  if (rec.blockedUntil > 0 && rec.blockedUntil <= now) {
    rec = { failCount: 0, blockedUntil: 0 }
  }
  const maxFails = Number(process.env.LOGIN_FAILS_BEFORE_LOCKOUT ?? 5)
  const lockMs = Number(process.env.LOGIN_LOCKOUT_MS ?? 300000)
  rec.failCount += 1
  if (rec.failCount >= maxFails) {
    rec.blockedUntil = now + lockMs
    rec.failCount = 0
  }
  store.set(k, rec)
}

/**
 * Clear counters after a successful password verification (same IP+email key).
 *
 * @param {string} ip
 * @param {string} email
 */
export function clearPasswordLoginFailures(ip, email) {
  store.delete(keyFor(ip, email))
}

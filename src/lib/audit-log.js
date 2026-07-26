import { appendFile } from "node:fs/promises"

/**
 * Append-only security / auth audit trail.
 * Never pass raw passwords or OTP codes — only outcomes, coarse identifiers, and IP.
 * When `AUDIT_LOG_PATH` is set, JSON lines are appended to that file in addition to stdout.
 *
 * @param {"auth"} category
 * @param {string} action Short verb phrase, e.g. `login_success`, `password_reset_requested`
 * @param {object} fields Extra structured fields (no secrets)
 */
export async function auditAuth(category, action, fields = {}) {
  const line = {
    ts: new Date().toISOString(),
    category,
    action,
    ...fields,
  }
  const serialized = `${JSON.stringify(line)}\n`
  console.log(`[AUDIT] ${serialized.trim()}`)
  const path = process.env.AUDIT_LOG_PATH
  if (path) {
    try {
      await appendFile(path, serialized, { encoding: "utf8" })
    } catch (err) {
      console.error("[AUDIT] appendFile failed:", err instanceof Error ? err.message : err)
    }
  }
}

/**
 * Fire-and-forget audit (avoids blocking response if disk is slow).
 * @param {"auth"} category
 * @param {string} action
 * @param {object} fields
 */
export function auditAuthAsync(category, action, fields = {}) {
  void auditAuth(category, action, fields).catch(() => undefined)
}

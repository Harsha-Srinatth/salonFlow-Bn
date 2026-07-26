/**
 * Firebase Auth Identity Toolkit REST (Web API key).
 * resetPassword with only oobCode returns email without mutating the account.
 * resetPassword with oobCode + newPassword consumes the code and sets the Firebase password.
 */

const RESET_PASSWORD_URL = "https://identitytoolkit.googleapis.com/v1/accounts:resetPassword"
const SEND_OOB_CODE_URL = "https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode"

function getWebApiKey() {
  const key = process.env.FIREBASE_WEB_API_KEY
  if (!key) {
    throw new Error("FIREBASE_WEB_API_KEY is not set (Firebase project Web API key)")
  }
  return key
}

/**
 * Validates a password-reset OOB code without changing the Firebase account (oob-only request).
 * Returns the email on success so the API can update Postgres.
 *
 * @param {string} oobCode From the email link query string
 * @returns {Promise<{ email: string, requestType?: string }>}
 */
export async function verifyPasswordResetOobCode(oobCode) {
  const key = getWebApiKey()
  const res = await fetch(`${RESET_PASSWORD_URL}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oobCode }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data.error?.message ?? "Invalid or expired reset link"
    throw new Error(msg)
  }
  const email = `${data.email ?? ""}`.trim().toLowerCase()
  if (!email) throw new Error("Could not resolve email from reset code")
  const rt = data.requestType != null ? String(data.requestType) : ""
  if (rt && rt !== "PASSWORD_RESET") {
    throw new Error("This link is not a password reset link")
  }
  return { email, requestType: data.requestType }
}

/**
 * Triggers Firebase to send the same password-reset email as the client SDK.
 * Lets the backend apply rate limits and audit logging. May fail if Firebase requires reCAPTCHA (abuse).
 *
 * @param {string} email
 * @param {string} [continueUrl] Your `/auth/reset-password` URL (with origin); optional but recommended for custom handler.
 */
export async function sendPasswordResetEmailToolkit(email, continueUrl) {
  const key = getWebApiKey()
  const trimmed = `${email ?? ""}`.trim()
  if (!trimmed) throw new Error("Email is required")
  const body = {
    requestType: "PASSWORD_RESET",
    email: trimmed,
  }
  if (continueUrl) {
    body.continueUrl = continueUrl
    body.canHandleCodeInApp = false
  }
  const res = await fetch(`${SEND_OOB_CODE_URL}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data.error?.message ?? "Could not send reset email"
    const err = new Error(msg)
    err.firebaseCode = data.error?.message
    throw err
  }
}

/**
 * Consumes the OOB code and sets the Firebase password to `newPassword` (we use a random value to invalidate the link).
 *
 * @param {string} oobCode
 * @param {string} newPassword
 */
export async function consumePasswordResetOobWithPassword(oobCode, newPassword) {
  const key = getWebApiKey()
  const res = await fetch(`${RESET_PASSWORD_URL}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oobCode, newPassword }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data.error?.message ?? "Could not invalidate reset link in Firebase"
    throw new Error(msg)
  }
}

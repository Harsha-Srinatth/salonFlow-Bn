/**
 * Which credential a customer account actually signs in with.
 *
 * The app stores its own bcrypt password in `users.password_hash` and treats a NULL
 * there as "no app password". That single NULL was being asked to mean two different
 * things at login: "this account signs in with Google and never had a password", and
 * "this account was created at reception and has not set one yet". Both produced the
 * same SET_PASSWORD_REQUIRED response, so a Google customer typing their Google
 * password on the email form was told to go set a password — advice that leads
 * nowhere, since the account they want is already sitting in Firebase under Google.
 *
 * Recording the provider separates the two cases so each gets the answer that
 * actually unblocks the person reading it.
 */
import admin from "firebase-admin"

/** Email + app password. */
export const AUTH_PROVIDER_PASSWORD = "PASSWORD"
/** Google OAuth, with no app password of its own. */
export const AUTH_PROVIDER_GOOGLE = "GOOGLE"
/** Pre-dates this column, or was created by reception rather than by signing up. */
export const AUTH_PROVIDER_UNKNOWN = "UNKNOWN"

export const AUTH_PROVIDERS = [AUTH_PROVIDER_PASSWORD, AUTH_PROVIDER_GOOGLE, AUTH_PROVIDER_UNKNOWN]

/** Firebase's provider id for Google, as it appears in token claims and `providerData`. */
const GOOGLE_PROVIDER_ID = "google.com"
const PASSWORD_PROVIDER_ID = "password"

/**
 * Normalizes anything read back from the database or a request into a known value.
 *
 * @param {unknown} value
 * @returns {string} one of `AUTH_PROVIDERS`
 */
export function normalizeAuthProvider(value) {
  const normalized = `${value ?? ""}`.trim().toUpperCase()
  return AUTH_PROVIDERS.includes(normalized) ? normalized : AUTH_PROVIDER_UNKNOWN
}

/**
 * Decides the provider to record for a brand-new account, from the ID token that
 * authorized the registration.
 *
 * `firebase.sign_in_provider` says how *this* session was authenticated, which is
 * exactly the question at signup: the customer either came through the Google popup
 * or through email and password. A supplied signup password settles it either way —
 * an account that ships a password is a password account regardless of the claim.
 *
 * @param {{ firebase?: { sign_in_provider?: string } }} decodedToken
 * @param {{ hasPassword?: boolean }} [options]
 * @returns {string} one of `AUTH_PROVIDERS`
 */
export function resolveSignupAuthProvider(decodedToken, { hasPassword = false } = {}) {
  if (hasPassword) return AUTH_PROVIDER_PASSWORD
  const signInProvider = `${decodedToken?.firebase?.sign_in_provider ?? ""}`.trim().toLowerCase()
  if (signInProvider === GOOGLE_PROVIDER_ID) return AUTH_PROVIDER_GOOGLE
  if (signInProvider === PASSWORD_PROVIDER_ID) return AUTH_PROVIDER_PASSWORD
  return AUTH_PROVIDER_UNKNOWN
}

/**
 * Asks Firebase which providers are attached to an address.
 *
 * Only used to classify accounts created before the column existed, and only on the
 * login path that has already established there is no app password — a rare, already
 * failing request, which is the one place a network round trip is affordable. Callers
 * persist what comes back so the same account never needs asking twice.
 *
 * Returns UNKNOWN rather than throwing: a Firebase outage should downgrade the error
 * message a customer sees, never turn a login attempt into a 500.
 *
 * @param {string} email
 * @returns {Promise<string>} one of `AUTH_PROVIDERS`
 */
export async function lookupAuthProviderByEmail(email) {
  const normalized = `${email ?? ""}`.trim().toLowerCase()
  if (!normalized) return AUTH_PROVIDER_UNKNOWN
  try {
    const user = await admin.auth().getUserByEmail(normalized)
    const providerIds = (user.providerData ?? []).map(entry => `${entry.providerId ?? ""}`.toLowerCase())
    // Password wins when both are linked: the account can be signed into with an
    // app password, so telling its owner to use Google would be wrong.
    if (providerIds.includes(PASSWORD_PROVIDER_ID)) return AUTH_PROVIDER_PASSWORD
    if (providerIds.includes(GOOGLE_PROVIDER_ID)) return AUTH_PROVIDER_GOOGLE
    return AUTH_PROVIDER_UNKNOWN
  } catch {
    // No Firebase user at all (a reception-created walk-in), or the lookup failed.
    return AUTH_PROVIDER_UNKNOWN
  }
}

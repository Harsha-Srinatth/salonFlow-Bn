import { normalizeAuthProvider } from "./auth-provider.js"
import { normalizeCustomerGender } from "./gender.js"
import { calculateAge } from "./validation.js"

/**
 * The `users` columns every "who am I" response is built from, and the single
 * mapping to the client-facing shape.
 *
 * These were spelled out separately in seven queries across routes/auth.js and
 * middleware/auth.js. Adding a profile column meant editing all seven, and
 * missing one produced a field that is present after login but undefined after
 * a session sync — which is exactly how `gender` ended up unreliable.
 *
 * `date_of_birth` is read with `to_char`, not as a DATE. node-postgres turns a
 * DATE into a local-midnight `Date`, and serializing that to JSON in any zone
 * behind UTC shifts the birthday back a day.
 */
export const USER_PROFILE_COLUMNS = `
  id, name, email, role, phone, gender, account_status, membership_segment,
  email_verified, phone_verified, auth_provider,
  to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth
`

/**
 * Maps a `users` row to the shape exposed on `req.appUser` and in auth responses.
 *
 * @param {object | null} row
 * @returns {object | null}
 */
export function toAppUserDto(row) {
  if (!row) return null
  const dateOfBirth = row.date_of_birth ?? null
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    phone: row.phone,
    gender: normalizeCustomerGender(row.gender),
    dateOfBirth,
    // Derived, never stored — see calculateAge.
    age: calculateAge(dateOfBirth),
    authProvider: normalizeAuthProvider(row.auth_provider),
    emailVerified: row.email_verified === true,
    phoneVerified: row.phone_verified === true,
    accountStatus: row.account_status,
    membershipSegment: `${row.membership_segment ?? "FREE"}`.trim().toUpperCase() || "FREE",
  }
}

import { salonDateString } from "./salon-time.js"

/**
 * Shared field validation for user-supplied profile data.
 *
 * `isValidFullName` / `normalizeName` were copy-pasted in routes/auth.js and
 * routes/admin.js; the customer profile editor made it three. One copy, so the
 * rules a name has to pass at signup are the same ones it has to pass on edit.
 */

/**
 * Full-name rules for self-registration and profile edits: at least two words,
 * letters (plus ' . -) only, and a few anti-gibberish heuristics — no run of 4+
 * identical letters, and more than 3 distinct letters overall.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidFullName(name) {
  const normalized = normalizeName(name)
  if (normalized.length < 4) return false
  if (normalized.split(" ").length < 2) return false
  if (!/^[A-Za-z][A-Za-z\s'.-]+$/.test(normalized)) return false
  const lettersOnly = normalized.replace(/[^A-Za-z]/g, "").toLowerCase()
  if (lettersOnly.length < 4) return false
  let run = 1
  let maxRun = 1
  for (let index = 1; index < lettersOnly.length; index += 1) {
    run = lettersOnly[index] === lettersOnly[index - 1] ? run + 1 : 1
    if (run > maxRun) maxRun = run
  }
  if (maxRun >= 4) return false
  return new Set(lettersOnly).size > 3
}

/**
 * Collapses whitespace for the persisted display name.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeName(name) {
  return `${name ?? ""}`.trim().replace(/\s+/g, " ")
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Today as `YYYY-MM-DD` in the server's local zone.
 *
 * Dates of birth are handled as plain calendar strings end to end — never as
 * `Date` objects. `new Date("2000-05-15")` is parsed as UTC midnight, so in any
 * zone behind UTC it formats back as the 14th, and a birthday quietly lands a
 * day early. Comparing strings sidesteps that entirely.
 */
function todayIsoDate() {
  return salonDateString(new Date())
}

/**
 * Validates a date of birth. Sanity only — a real calendar date, not in the
 * future, not before 1900. Deliberately not a minimum-age policy: the salon
 * books children, and inventing an age floor here isn't this function's call.
 *
 * @param {unknown} value expected `YYYY-MM-DD`
 * @returns {string | null} the normalized date, or null if unusable
 */
export function parseDateOfBirth(value) {
  const raw = `${value ?? ""}`.trim()
  if (!ISO_DATE_PATTERN.test(raw)) return null
  const [year, month, day] = raw.split("-").map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  // Round-trip check: rejects impossible dates like 2024-02-31, which
  // Date.UTC would silently roll forward to March 2nd.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null
  }
  if (raw < "1900-01-01") return null
  if (raw > todayIsoDate()) return null
  return raw
}

/**
 * Age in whole years from a `YYYY-MM-DD` date of birth.
 *
 * Derived on read rather than stored: an `age` column is correct for at most a
 * year and then silently lies, and nothing can tell a stale value from a true one.
 *
 * @param {unknown} dateOfBirth
 * @returns {number | null}
 */
export function calculateAge(dateOfBirth) {
  const dob = `${dateOfBirth ?? ""}`.trim()
  if (!ISO_DATE_PATTERN.test(dob)) return null
  const today = todayIsoDate()
  let age = Number(today.slice(0, 4)) - Number(dob.slice(0, 4))
  // Birthday not reached yet this year — compare the MM-DD tails.
  if (today.slice(5) < dob.slice(5)) age -= 1
  return age >= 0 ? age : null
}

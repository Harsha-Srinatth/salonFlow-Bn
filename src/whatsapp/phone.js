/**
 * Phone numbers for WhatsApp.
 *
 * `users.phone` and booking phones are stored as E.164 ("+919876543210"), which is also
 * what Firebase used to write. The Cloud API wants the same digits without the "+", and
 * webhooks report the customer as a bare `wa_id` ("919876543210").
 */

const E164_RE = /^\+[1-9]\d{7,14}$/
const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/

/**
 * Normalises whatever a person typed into E.164, or returns null.
 *
 * Indian input is the common case and is accepted in its usual shapes: "98765 43210",
 * "098765-43210", "919876543210", "+91 98765 43210", "0091 98765 43210". Anything with an
 * explicit "+" or "00" prefix is treated as international and only shape-checked.
 *
 * @param {string} input
 * @param {string} [defaultCountryCode] calling code used for bare national numbers
 * @returns {string | null}
 */
export function normalizePhone(input, defaultCountryCode = "91") {
  const raw = `${input ?? ""}`.trim()
  if (!raw) return null
  let digits = raw.replace(/[\s\-().]/g, "")
  if (!/^\+?\d+$/.test(digits)) return null
  let international = false
  if (digits.startsWith("+")) {
    international = true
    digits = digits.slice(1)
  } else if (digits.startsWith("00")) {
    international = true
    digits = digits.slice(2)
  }
  if (!international) {
    if (defaultCountryCode === "91") {
      if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1)
      if (digits.length === 12 && digits.startsWith("91") && INDIAN_MOBILE_RE.test(digits.slice(2))) digits = digits.slice(2)
      if (!INDIAN_MOBILE_RE.test(digits)) return null
      digits = `91${digits}`
    } else if (!digits.startsWith(defaultCountryCode)) {
      digits = `${defaultCountryCode}${digits.replace(/^0+/, "")}`
    }
  }
  const e164 = `+${digits}`
  if (!E164_RE.test(e164)) return null
  if (digits.startsWith("91") && !INDIAN_MOBILE_RE.test(digits.slice(2))) return null
  return e164
}

/** "+919876543210" -> "919876543210" (the `to` field of the Cloud API). */
export function toWaRecipient(e164) {
  return `${e164 ?? ""}`.replace(/^\+/, "")
}

/** Webhook `wa_id` / `from` -> E.164, or null when it is not a plausible number. */
export function fromWaId(waId) {
  const digits = `${waId ?? ""}`.replace(/\D/g, "")
  const e164 = `+${digits}`
  return E164_RE.test(e164) ? e164 : null
}

/** True when the E.164 number belongs to one of the allowed calling codes. */
export function isAllowedCountry(e164, allowedCountryCodes) {
  if (!e164 || !Array.isArray(allowedCountryCodes)) return false
  return allowedCountryCodes.some(code => e164.startsWith(`+${code}`))
}

/** "+919876543210" -> "+91******3210", for logs and admin screens. */
export function maskPhone(e164) {
  const value = `${e164 ?? ""}`
  if (value.length < 8) return "***"
  return `${value.slice(0, 3)}${"*".repeat(Math.max(0, value.length - 7))}${value.slice(-4)}`
}

/**
 * Stored forms a number may have in `users.phone`: E.164 is the norm, but a few older rows
 * hold the bare 10-digit Indian number. Used for lookups only; writes always use E.164.
 */
export function phoneLookupCandidates(e164) {
  const candidates = new Set([e164])
  if (e164?.startsWith("+91") && e164.length === 13) {
    candidates.add(e164.slice(3))
    candidates.add(e164.slice(1))
  }
  return [...candidates]
}

/**
 * Phone numbers for SMS. `users.phone` and booking phones are normally E.164
 * ("+919876543210"), but older walk-in rows can hold a bare 10-digit number.
 * The reminder template is registered for India, so only Indian mobiles are accepted.
 */
const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/

/** Any common Indian format -> "919876543210" (the form MSG91 expects), or null. */
export function toIndianSmsRecipient(input) {
  let digits = `${input ?? ""}`.trim().replace(/[\s\-().]/g, "")
  if (!/^\+?\d+$/.test(digits)) return null
  digits = digits.replace(/^\+/, "").replace(/^00/, "")
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1)
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2)
  return INDIAN_MOBILE_RE.test(digits) ? `91${digits}` : null
}

/** "919876543210" -> "91******3210", for logs. */
export function maskPhone(phone) {
  const value = `${phone ?? ""}`
  if (value.length < 8) return "***"
  return `${value.slice(0, 2)}${"*".repeat(value.length - 6)}${value.slice(-4)}`
}

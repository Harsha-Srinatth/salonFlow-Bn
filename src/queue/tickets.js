import crypto from "node:crypto"

/**
 * Stable, non-reversible identifiers for the live queue.
 *
 * The salon-wide board is visible to every signed-in customer, so it must not
 * carry booking ids, names, emails or phone numbers. Instead each waiting
 * booking gets a short `ticket` derived with HMAC from its id: two people
 * looking at the board see the same anonymous codes, and a customer can spot
 * their own row because their personal endpoint returns the same code.
 *
 * The owner hashes exist for the same reason — they let the server match "is
 * this queue entry mine?" against a cached row set that contains no PII.
 */

let cachedSecret = null
let warnedMissingSecret = false

function getSecret() {
  if (cachedSecret) return cachedSecret
  const configured =
    `${process.env.QUEUE_TICKET_SECRET ?? ""}`.trim() ||
    `${process.env.JWT_SECRET ?? ""}`.trim() ||
    `${process.env.STAFF_ACCESS_SECRET ?? ""}`.trim()
  if (configured) {
    cachedSecret = configured
    return cachedSecret
  }
  // Every instance must derive identical hashes or ownership matching breaks
  // across a load-balanced fleet, so a random per-process fallback would be
  // worse than useless. Use a fixed development value and make the gap loud.
  if (!warnedMissingSecret) {
    warnedMissingSecret = true
    console.warn("queue_ticket_secret_missing", {
      message: "Set QUEUE_TICKET_SECRET (or JWT_SECRET) — falling back to a non-secret development value.",
    })
  }
  cachedSecret = "sahasra-development-queue-secret"
  return cachedSecret
}

function hmac(value) {
  return crypto.createHmac("sha256", getSecret()).update(`${value ?? ""}`).digest("hex")
}

/**
 * Short display code for a queue position, e.g. `Q-7F3A9C`.
 *
 * @param {string} bookingId
 * @returns {string}
 */
export function bookingTicketCode(bookingId) {
  return `Q-${hmac(`ticket:${bookingId}`).slice(0, 6).toUpperCase()}`
}

/**
 * @param {string | null | undefined} email
 * @returns {string | null}
 */
export function ownerEmailHash(email) {
  const normalized = `${email ?? ""}`.trim().toLowerCase()
  if (!normalized) return null
  return hmac(`email:${normalized}`)
}

/**
 * @param {string | null | undefined} phone
 * @returns {string | null}
 */
export function ownerPhoneHash(phone) {
  const normalized = `${phone ?? ""}`.trim()
  if (!normalized) return null
  return hmac(`phone:${normalized}`)
}

import { randomBytes } from "node:crypto"

/**
 * Invoice number: date + random suffix. `INV-${Date.now()}` repeats when two bookings are
 * created in the same millisecond; 32 random bits per day make a clash practically impossible
 * without needing a counter (a DB sequence is the next step if gap-free numbering is required).
 */
export function generateInvoiceNumber(now = new Date()) {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "")
  return `INV-${day}-${randomBytes(4).toString("hex").toUpperCase()}`
}

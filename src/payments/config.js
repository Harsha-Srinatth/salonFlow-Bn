/**
 * Razorpay configuration. Everything comes from the environment; nothing is hardcoded and the
 * secret never leaves this process (only the public key id is ever sent to the browser).
 */

export function razorpayConfig(env = process.env) {
  const keyId = `${env.RAZORPAY_KEY_ID ?? ""}`.trim()
  const keySecret = `${env.RAZORPAY_KEY_SECRET ?? ""}`.trim()
  const webhookSecret = `${env.RAZORPAY_WEBHOOK_SECRET ?? ""}`.trim()
  const mode = keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : "unknown"
  return { keyId, keySecret, webhookSecret, mode }
}

export function isRazorpayConfigured() {
  const { keyId, keySecret } = razorpayConfig()
  return Boolean(keyId && keySecret)
}

/**
 * When true, `POST /api/customer/bookings` refuses to confirm a booking that still has money
 * owed: the only way to pay is through Razorpay. Defaults to on whenever Razorpay is configured
 * (otherwise anyone could skip checkout by calling the old endpoint directly). Set
 * ONLINE_PAYMENT_REQUIRED=false to restore the old "confirm without paying" behaviour.
 */
export function isOnlinePaymentRequired() {
  return isRazorpayConfigured() && `${process.env.ONLINE_PAYMENT_REQUIRED ?? ""}`.trim().toLowerCase() !== "false"
}

/** How long an unpaid checkout stays open before the sweep may mark it EXPIRED. */
export function orderTtlMinutes() {
  const value = Number(process.env.RAZORPAY_ORDER_TTL_MINUTES)
  return Number.isFinite(value) && value >= 1 ? value : 30
}

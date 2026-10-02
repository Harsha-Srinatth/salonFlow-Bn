import { createHmac, timingSafeEqual } from "node:crypto"
import { razorpayConfig } from "./config.js"

/**
 * Minimal Razorpay REST client (Orders / Payments / Refunds) over `fetch`.
 *
 * Not the official SDK on purpose: the project has no payment dependency yet and these five
 * calls are all that is needed. Credentials come from the environment on every call, and
 * errors carry only Razorpay's public error code/description — never the request headers.
 */

const API_BASE = "https://api.razorpay.com/v1"
const REQUEST_TIMEOUT_MS = Number(process.env.RAZORPAY_HTTP_TIMEOUT_MS ?? 15_000)

export class RazorpayApiError extends Error {
  constructor(message, { status = 0, code = null, description = null, network = false } = {}) {
    super(message)
    this.name = "RazorpayApiError"
    this.status = status
    this.code = code
    this.description = description
    this.network = network
  }
}

async function call(method, path, body) {
  const { keyId, keySecret } = razorpayConfig()
  if (!keyId || !keySecret) throw new RazorpayApiError("Razorpay is not configured", { code: "NOT_CONFIGURED" })
  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new RazorpayApiError(`Razorpay request failed: ${error?.name ?? "error"}`, { network: true })
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const apiError = data?.error ?? {}
    throw new RazorpayApiError(`Razorpay ${method} ${path.split("?")[0]} -> ${response.status}`, {
      status: response.status,
      code: apiError.code ?? null,
      description: apiError.description ?? null,
    })
  }
  return data
}

export const razorpay = {
  createOrder: ({ amountPaise, receipt, notes }) =>
    call("POST", "/orders", { amount: amountPaise, currency: "INR", receipt, notes }),
  fetchOrder: orderId => call("GET", `/orders/${encodeURIComponent(orderId)}`),
  fetchOrderPayments: orderId => call("GET", `/orders/${encodeURIComponent(orderId)}/payments`),
  fetchPayment: paymentId => call("GET", `/payments/${encodeURIComponent(paymentId)}`),
  capturePayment: ({ paymentId, amountPaise }) =>
    call("POST", `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency: "INR" }),
  fetchPaymentRefunds: paymentId => call("GET", `/payments/${encodeURIComponent(paymentId)}/refunds`),
  fetchRefund: refundId => call("GET", `/refunds/${encodeURIComponent(refundId)}`),
  refundPayment: ({ paymentId, amountPaise, notes }) =>
    call("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { amount: amountPaise, speed: "normal", notes }),
}

function safeEqualHex(expectedHex, givenHex) {
  const a = Buffer.from(`${expectedHex}`, "utf8")
  const b = Buffer.from(`${givenHex ?? ""}`, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Checkout signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  const { keySecret } = razorpayConfig()
  if (!keySecret || !orderId || !paymentId || !signature) return false
  const expected = createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex")
  return safeEqualHex(expected, signature)
}

/** Webhook signature: HMAC_SHA256(raw request body, webhook_secret). Must be given the RAW bytes. */
export function verifyWebhookSignature({ rawBody, signature }) {
  const { webhookSecret } = razorpayConfig()
  if (!webhookSecret || !signature || !rawBody) return false
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex")
  return safeEqualHex(expected, signature)
}

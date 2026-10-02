import express from "express"
import { requireAppRole, requireFirebaseAuth } from "../middleware/auth.js"
import { paymentCreateRateLimit, paymentStatusRateLimit } from "../middleware/rate-limiters.js"
import { isRazorpayConfigured } from "../payments/config.js"
import {
  ensurePaymentsRuntime,
  getPaymentFunnel,
  getPaymentStatus,
  markCheckoutOpened,
  processRazorpayWebhook,
  recordClientEvent,
  startCheckout,
  verifyCheckoutPayment,
} from "../payments/service.js"

const ORDER_ID = /^order_[A-Za-z0-9]{6,40}$/
const PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/
const SIGNATURE = /^[a-f0-9]{64}$/

function badRequest(res, message = "Invalid request") {
  return res.status(400).json({ error: message })
}

/** Maps service errors to HTTP. Anything unexpected is logged server-side and returned generically. */
function sendError(req, res, error, label) {
  switch (error?.code) {
    case "NOT_FOUND":
      return res.status(404).json({ error: "Payment not found" })
    case "BAD_REQUEST":
      return res.status(400).json({ error: error.message })
    case "STYLIST_UNAVAILABLE":
      return res.status(409).json({ error: error.message, alternatives: error.alternatives ?? [] })
    case "INVALID_SIGNATURE":
    case "ORDER_MISMATCH":
    case "AMOUNT_MISMATCH":
      return res.status(400).json({ error: "We could not verify this payment.", code: "VERIFICATION_FAILED" })
    case "IN_PROGRESS":
      return res.status(409).json({ error: error.message, code: "IN_PROGRESS" })
    case "GATEWAY_UNAVAILABLE":
      return res.status(502).json({ error: error.message, code: "GATEWAY_UNAVAILABLE" })
    default:
      console.error(`${label}_failed`, { requestId: req.requestId, error: error instanceof Error ? error.stack ?? error.message : error })
      return res.status(500).json({ error: "Something went wrong. Please try again.", requestId: req.requestId })
  }
}

/**
 * Razorpay webhook. Mounted in server.js with `express.raw` *before* the JSON parser: the
 * signature is an HMAC of the exact bytes Razorpay sent, so the body must not be re-serialised.
 */
export async function razorpayWebhookHandler(req, res) {
  try {
    const { status, body } = await processRazorpayWebhook({
      rawBody: req.body,
      signature: req.get("x-razorpay-signature"),
      eventIdHeader: req.get("x-razorpay-event-id"),
    })
    return res.status(status).json(body)
  } catch (error) {
    console.error("razorpay_webhook_failed", { requestId: req.requestId, error: error instanceof Error ? error.stack ?? error.message : error })
    return res.status(500).json({ error: "processing_failed" })
  }
}

const router = express.Router()

router.use((req, res, next) => {
  if (!isRazorpayConfigured()) return res.status(503).json({ error: "Online payments are not available right now." })
  next()
})

const customerOnly = [requireFirebaseAuth, requireAppRole("USER")]
const ensureReady = async (_req, _res, next) => {
  try {
    await ensurePaymentsRuntime()
    next()
  } catch (error) {
    next(error)
  }
}

// Create (or reuse) the Razorpay order for a booking request. The client sends the booking
// request, never an amount: the price is computed here.
router.post("/razorpay/orders", paymentCreateRateLimit, ...customerOnly, ensureReady, async (req, res) => {
  try {
    const body = req.body ?? {}
    if (!Array.isArray(body.serviceIds) || body.serviceIds.length > 20) return badRequest(res, "At least one service is required")
    const result = await startCheckout({ actorUser: req.appUser, payload: body })
    return res.status(result.paymentRequired ? 201 : 200).json(result)
  } catch (error) {
    return sendError(req, res, error, "razorpay_create_order")
  }
})

// Checkout window actually opened in the browser (analytics for drop-off; changes no money state).
router.post("/razorpay/:orderId/opened", paymentStatusRateLimit, ...customerOnly, ensureReady, async (req, res) => {
  try {
    if (!ORDER_ID.test(req.params.orderId)) return badRequest(res)
    return res.json(await markCheckoutOpened({ userId: req.appUser.id, orderId: req.params.orderId }))
  } catch (error) {
    return sendError(req, res, error, "razorpay_checkout_opened")
  }
})

// The browser reports a dismissal or a failed attempt. Treated as a hint, never as truth.
router.post("/razorpay/:orderId/client-event", paymentStatusRateLimit, ...customerOnly, ensureReady, async (req, res) => {
  try {
    const { orderId } = req.params
    const type = `${req.body?.type ?? ""}`
    if (!ORDER_ID.test(orderId) || !["DISMISSED", "FAILED"].includes(type)) return badRequest(res)
    return res.json(
      await recordClientEvent({ userId: req.appUser.id, orderId, type, paymentId: req.body?.paymentId, error: req.body?.error })
    )
  } catch (error) {
    return sendError(req, res, error, "razorpay_client_event")
  }
})

// Checkout success callback: verify signature, read the payment from Razorpay, then settle.
router.post("/razorpay/verify", paymentStatusRateLimit, ...customerOnly, ensureReady, async (req, res) => {
  try {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body ?? {}
    if (!ORDER_ID.test(`${orderId}`) || !PAYMENT_ID.test(`${paymentId}`) || !SIGNATURE.test(`${signature}`)) {
      return badRequest(res, "We could not verify this payment.")
    }
    return res.json(await verifyCheckoutPayment({ userId: req.appUser.id, orderId, paymentId, signature }))
  } catch (error) {
    return sendError(req, res, error, "razorpay_verify")
  }
})

// Backend-owned payment/booking state. Owner only (someone else's order id is a plain 404).
router.get("/razorpay/:orderId/status", paymentStatusRateLimit, ...customerOnly, ensureReady, async (req, res) => {
  try {
    if (!ORDER_ID.test(req.params.orderId)) return badRequest(res)
    return res.json(await getPaymentStatus({ userId: req.appUser.id, orderId: req.params.orderId }))
  } catch (error) {
    return sendError(req, res, error, "razorpay_status")
  }
})

// Admin: where do customers drop off, and which checkouts were abandoned.
router.get("/razorpay/admin/funnel", requireFirebaseAuth, requireAppRole("ADMIN"), ensureReady, async (req, res) => {
  try {
    return res.json(await getPaymentFunnel({ days: req.query.days }))
  } catch (error) {
    return sendError(req, res, error, "razorpay_funnel")
  }
})

export default router

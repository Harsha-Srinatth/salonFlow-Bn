import { createHash } from "node:crypto"
import { v4 as uuid } from "uuid"
import { pool } from "../lib/db-pool.js"
import { roundMoney } from "../lib/money.js"
import { USER_PROFILE_COLUMNS, toAppUserDto } from "../lib/user-dto.js"
import { ensureUserProfileSchema } from "../auth/schema-init.js"
import { ensureBookingsSchema } from "../bookings/schema-init.js"
import { createPaidCustomerBookingInTransaction, quoteCustomerBooking, runPostBookingEffects } from "../bookings/service.js"
import { ensureFeedbackSchema } from "../feedback/service.js"
import { ensureLoyaltySchema } from "../loyalty/service.js"
import { ensureMembershipSchema } from "../membership/service.js"
import { ensureOfferSchema } from "../offers/service.js"
import { ensureQueueSchema } from "../queue/schema-init.js"
import { publishBookingEvent, publishPaymentEvent } from "../realtime/socket-gateway.js"
import { orderTtlMinutes, razorpayConfig } from "./config.js"
import { RazorpayApiError, razorpay, verifyCheckoutSignature, verifyWebhookSignature } from "./razorpay-client.js"
import { applyCancellationRefundWebhook, reconcileCancellationRefunds } from "./cancel-refund.js"
import { ensurePaymentsSchema } from "./schema-init.js"

/**
 * Razorpay payment flow. The database is the source of truth: a booking exists only after a
 * *verified captured* payment has been settled by `settleCapturedPayment`, which is the single
 * place a booking is created for a payment. Every entry point (checkout callback, webhook,
 * status poll, sweep) funnels into it, and it serialises on the payment row, so the same
 * payment arriving twice — or through two routes at once — books exactly once.
 *
 * Statuses (razorpay_payments.status): CREATED, PENDING, SUCCESS, FAILED, CANCELLED, EXPIRED.
 * Fulfilment (razorpay_payments.fulfillment): NONE, BOOKED, REFUND_PENDING, REFUND_INITIATED,
 * REFUNDED, REFUND_FAILED. A payment can be SUCCESS without a booking only when the slot or
 * price changed while the customer was paying — then it is refunded, never silently kept.
 */

const OPEN_STATUSES = ["CREATED", "PENDING"]
// Errors from the booking transaction that mean "this payment cannot become this booking".
const BUSINESS_BOOKING_ERRORS = new Set(["BAD_REQUEST", "STYLIST_UNAVAILABLE", "PRICE_CHANGED", "PAYMENT_REQUIRED"])
const MAX_SETTLE_ATTEMPTS = 5
const RECONCILE_MIN_INTERVAL_MS = 4000

function plog(event, fields = {}) {
  // IDs and states only: never keys, signatures, card/UPI details, or raw webhook bodies.
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: "payments", event, ...fields }))
}

function paymentError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

export async function ensurePaymentsRuntime() {
  await ensureUserProfileSchema()
  await ensureBookingsSchema()
  await ensureOfferSchema()
  await ensureMembershipSchema()
  await ensureFeedbackSchema()
  await ensureLoyaltySchema()
  await ensureQueueSchema()
  await ensurePaymentsSchema()
}

// ---------------------------------------------------------------------------------------
// helpers

async function addEvent(db, paymentId, eventType, source, detail = {}) {
  await db.query(
    `INSERT INTO razorpay_payment_events (payment_id, event_type, source, detail) VALUES ($1, $2, $3, $4::jsonb)`,
    [paymentId, eventType, source, JSON.stringify(detail)]
  )
}

async function getRowByOrderId(orderId, db = pool) {
  const { rows } = await db.query(`SELECT * FROM razorpay_payments WHERE razorpay_order_id = $1`, [orderId])
  return rows[0] ?? null
}

async function getOwnedRow(userId, orderId) {
  const { rows } = await pool.query(`SELECT * FROM razorpay_payments WHERE razorpay_order_id = $1 AND user_id = $2`, [`${orderId ?? ""}`, userId])
  return rows[0] ?? null
}

function isFinalRow(row) {
  return row.fulfillment !== "NONE"
}

/** Only the fields this flow needs from a Razorpay payment entity; method details (vpa, card) are dropped. */
function pickGatewayPayment(entity) {
  return {
    id: `${entity?.id ?? ""}`,
    order_id: `${entity?.order_id ?? ""}`,
    status: `${entity?.status ?? ""}`,
    amount: Number(entity?.amount ?? 0),
    currency: `${entity?.currency ?? ""}`,
    method: entity?.method ? `${entity.method}`.slice(0, 32) : null,
    captured: entity?.captured === true,
    error_code: entity?.error_code ? `${entity.error_code}`.slice(0, 128) : null,
    error_description: entity?.error_description ? `${entity.error_description}`.slice(0, 500) : null,
    error_source: entity?.error_source ? `${entity.error_source}`.slice(0, 64) : null,
    error_step: entity?.error_step ? `${entity.error_step}`.slice(0, 64) : null,
    error_reason: entity?.error_reason ? `${entity.error_reason}`.slice(0, 128) : null,
  }
}

function snapshotPayload(payload, quote) {
  const serviceIds = [...new Set((Array.isArray(payload?.serviceIds) ? payload.serviceIds : []).map(id => `${id ?? ""}`.trim()).filter(Boolean))]
  return {
    serviceIds,
    stylistId: `${payload?.stylistId ?? ""}`.trim(),
    startsAt: quote.startsAt,
    comboId: `${payload?.comboId ?? ""}`.trim() || undefined,
    useWalletCredit: Boolean(payload?.useWalletCredit),
    redeemRewardServiceId: `${payload?.redeemRewardServiceId ?? ""}`.trim() || undefined,
  }
}

function intentKeyFor(userId, snapshot, amountPaise) {
  const canonical = JSON.stringify([
    userId,
    [...snapshot.serviceIds].sort(),
    snapshot.stylistId,
    snapshot.startsAt,
    snapshot.comboId ?? "",
    snapshot.useWalletCredit,
    snapshot.redeemRewardServiceId ?? "",
    amountPaise,
  ])
  return createHash("sha256").update(canonical).digest("hex")
}

// ---------------------------------------------------------------------------------------
// 1. checkout start / order creation

/**
 * Prices the booking on the server and creates (or reuses) a Razorpay order for it.
 * Nothing the client sends is an amount: it sends the booking request and the server derives
 * the payable total. Returns `{ paymentRequired: false }` when nothing is owed.
 */
export async function startCheckout({ actorUser, payload }) {
  const quote = await quoteCustomerBooking({ payload, actorUser })
  const amountPaise = Math.round(roundMoney(quote.payableAmount) * 100)
  if (amountPaise <= 0) return { paymentRequired: false, quote }
  if (amountPaise < 100) throw paymentError("BAD_REQUEST", "The amount payable is below the minimum online payment of ₹1.")

  const snapshot = snapshotPayload(payload, quote)
  const intentKey = intentKeyFor(actorUser.id, snapshot, amountPaise)
  const ttlMinutes = orderTtlMinutes()

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const paymentRowId = uuid()
    const { rows: inserted } = await pool.query(
      `
        INSERT INTO razorpay_payments (id, user_id, intent_key, request_payload, amount, amount_paise, currency, status, expires_at)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'INR', 'CREATED', NOW() + make_interval(mins => $7::int))
        ON CONFLICT (intent_key) WHERE status IN ('CREATED', 'PENDING') AND fulfillment = 'NONE' DO NOTHING
        RETURNING *
      `,
      [paymentRowId, actorUser.id, intentKey, JSON.stringify(snapshot), amountPaise / 100, amountPaise, ttlMinutes]
    )

    if (!inserted[0]) {
      // Same customer, same booking, same price already has an open checkout: reuse it, so a
      // double click / second tab / retry never creates a second order.
      let existing = await findOpenByIntent(intentKey)
      for (let i = 0; existing && !existing.razorpay_order_id && i < 6; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 500))
        existing = await findOpenByIntent(intentKey)
      }
      if (!existing) continue
      if (!existing.razorpay_order_id) throw paymentError("IN_PROGRESS", "A payment for this booking is already being prepared. Please try again in a moment.")
      if (new Date(existing.expires_at).getTime() <= Date.now()) {
        await reconcileRow(existing, "SERVER")
        const refreshed = await getRowByOrderId(existing.razorpay_order_id)
        if (refreshed && isFinalRow(refreshed)) return checkoutResponse(refreshed, quote, true)
        await expireIfOpen(existing.id, "SERVER")
        continue
      }
      plog("order_reused", { paymentRef: existing.id, orderId: existing.razorpay_order_id, userId: actorUser.id })
      return checkoutResponse(existing, quote, true, actorUser)
    }

    const row = inserted[0]
    await addEvent(pool, row.id, "CHECKOUT_STARTED", "SERVER", { amountPaise })
    try {
      const order = await razorpay.createOrder({
        amountPaise,
        receipt: `sah_${row.id.replace(/-/g, "").slice(0, 32)}`,
        notes: { payment_ref: row.id },
      })
      if (Number(order.amount) !== amountPaise || order.currency !== "INR") {
        throw new RazorpayApiError("Order amount mismatch", { code: "ORDER_MISMATCH" })
      }
      const { rows } = await pool.query(
        `UPDATE razorpay_payments SET razorpay_order_id = $2, gateway_status = $3, order_created_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
        [row.id, order.id, `${order.status ?? "created"}`]
      )
      await addEvent(pool, row.id, "ORDER_CREATED", "SERVER", { orderId: order.id })
      plog("order_created", { paymentRef: row.id, orderId: order.id, userId: actorUser.id, amountPaise })
      return checkoutResponse(rows[0], quote, false, actorUser)
    } catch (error) {
      await pool
        .query(
          `UPDATE razorpay_payments SET status = 'FAILED', failure_code = 'ORDER_CREATE_FAILED', failure_reason = $2, failure_source = 'server', failure_step = 'order_creation', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [row.id, `${error?.description ?? error?.code ?? error?.message ?? "order creation failed"}`.slice(0, 300)]
        )
        .catch(() => undefined)
      await addEvent(pool, row.id, "ORDER_CREATE_FAILED", "SERVER", { code: error?.code ?? null, status: error?.status ?? null, network: Boolean(error?.network) }).catch(() => undefined)
      plog("order_create_failed", { paymentRef: row.id, userId: actorUser.id, code: error?.code ?? null, status: error?.status ?? null, network: Boolean(error?.network) })
      throw paymentError("GATEWAY_UNAVAILABLE", "We could not start the payment right now. Please try again.")
    }
  }
  throw paymentError("IN_PROGRESS", "A payment for this booking is already being prepared. Please try again in a moment.")
}

async function findOpenByIntent(intentKey) {
  const { rows } = await pool.query(
    `SELECT * FROM razorpay_payments WHERE intent_key = $1 AND status IN ('CREATED', 'PENDING') AND fulfillment = 'NONE' LIMIT 1`,
    [intentKey]
  )
  return rows[0] ?? null
}

function checkoutResponse(row, quote, reused, actorUser = null) {
  if (isFinalRow(row)) return { paymentRequired: true, reused: true, ...toStatusDto(row) }
  const config = razorpayConfig()
  return {
    paymentRequired: true,
    reused,
    orderId: row.razorpay_order_id,
    keyId: config.keyId, // public key id only; the secret never leaves the server
    amount: Number(row.amount_paise),
    currency: row.currency,
    description: quote?.serviceName ? `${quote.serviceName}`.slice(0, 250) : "Salon booking",
    prefill: actorUser ? { name: actorUser.name ?? "", email: actorUser.email ?? "", contact: actorUser.phone ?? "" } : undefined,
    expiresAt: row.expires_at,
    timeoutSeconds: Math.max(60, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
    quote,
  }
}

// ---------------------------------------------------------------------------------------
// 2. client lifecycle events (checkout opened / dismissed / failed)

export async function markCheckoutOpened({ userId, orderId }) {
  const row = await getOwnedRow(userId, orderId)
  if (!row) throw paymentError("NOT_FOUND", "Payment not found")
  if (OPEN_STATUSES.includes(row.status) && !row.checkout_opened_at) {
    const { rowCount } = await pool.query(
      `UPDATE razorpay_payments SET checkout_opened_at = NOW(), updated_at = NOW() WHERE id = $1 AND checkout_opened_at IS NULL`,
      [row.id]
    )
    if (rowCount) {
      await addEvent(pool, row.id, "CHECKOUT_OPENED", "CLIENT")
      plog("checkout_opened", { paymentRef: row.id, orderId, userId })
    }
  }
  return toStatusDto((await getOwnedRow(userId, orderId)) ?? row)
}

/**
 * The browser tells us the customer closed the checkout window or that an attempt failed.
 * Neither claim is trusted: a failure is re-read from Razorpay by payment id, and a dismissal
 * only marks the checkout CANCELLED when no payment attempt has started (a customer can close the
 * window while a UPI approval is still on its way). Either way we then reconcile with Razorpay.
 */
export async function recordClientEvent({ userId, orderId, type, paymentId, error }) {
  const row = await getOwnedRow(userId, orderId)
  if (!row) throw paymentError("NOT_FOUND", "Payment not found")
  if (isFinalRow(row) || row.status === "SUCCESS") return toStatusDto(row)

  if (type === "DISMISSED") {
    await addEvent(pool, row.id, "CHECKOUT_DISMISSED", "CLIENT")
    const { rowCount } = await pool.query(
      `UPDATE razorpay_payments SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1 AND status = 'CREATED' AND payment_attempted_at IS NULL`,
      [row.id]
    )
    plog("checkout_dismissed", { paymentRef: row.id, orderId, userId, markedCancelled: rowCount > 0 })
  } else if (type === "FAILED") {
    await addEvent(pool, row.id, "CLIENT_REPORTED_FAILURE", "CLIENT", {
      paymentId: typeof paymentId === "string" ? paymentId.slice(0, 64) : null,
      code: `${error?.code ?? ""}`.slice(0, 64) || null,
    })
    if (typeof paymentId === "string" && /^pay_[A-Za-z0-9]+$/.test(paymentId)) {
      try {
        const gp = pickGatewayPayment(await razorpay.fetchPayment(paymentId))
        if (gp.order_id === orderId) await handleGatewayPayment({ gp, source: "CLIENT" })
      } catch (fetchError) {
        plog("client_failure_lookup_failed", { paymentRef: row.id, orderId, code: fetchError?.code ?? null })
      }
    }
  }
  // The window being closed (or an attempt failing) does not mean no money moved: ask Razorpay.
  const refreshed = await getOwnedRow(userId, orderId)
  if (refreshed && !isFinalRow(refreshed)) await reconcileRow(refreshed, "CLIENT").catch(() => undefined)
  return toStatusDto((await getOwnedRow(userId, orderId)) ?? row)
}

// ---------------------------------------------------------------------------------------
// 3. checkout verification

export async function verifyCheckoutPayment({ userId, orderId, paymentId, signature }) {
  const row = await getOwnedRow(userId, orderId)
  if (!row) throw paymentError("NOT_FOUND", "Payment not found")

  if (!verifyCheckoutSignature({ orderId, paymentId, signature })) {
    await addEvent(pool, row.id, "SIGNATURE_INVALID", "CLIENT", { paymentId: `${paymentId ?? ""}`.slice(0, 64) }).catch(() => undefined)
    plog("verify_signature_invalid", { paymentRef: row.id, orderId, userId })
    throw paymentError("INVALID_SIGNATURE", "We could not verify this payment.")
  }

  // Signature is valid: this payment id belongs to this order. Read the payment itself from
  // Razorpay server-to-server so amount/currency/status come from the gateway, not the browser.
  let gp
  try {
    gp = pickGatewayPayment(await razorpay.fetchPayment(paymentId))
  } catch (error) {
    // Cannot reach Razorpay right now. Do NOT confirm on the signature alone and do not fail:
    // record the attempt as pending; the webhook / status poll / sweep will settle it.
    await markPending(row.id, paymentId, "CHECKOUT")
    plog("verify_gateway_lookup_failed", { paymentRef: row.id, orderId, userId, code: error?.code ?? null, network: Boolean(error?.network) })
    return toStatusDto((await getOwnedRow(userId, orderId)) ?? row)
  }
  if (gp.order_id !== orderId) {
    await addEvent(pool, row.id, "ORDER_MISMATCH", "CLIENT", { paymentId: gp.id }).catch(() => undefined)
    plog("verify_order_mismatch", { paymentRef: row.id, orderId, userId })
    throw paymentError("ORDER_MISMATCH", "We could not verify this payment.")
  }
  plog("verify_started", { paymentRef: row.id, orderId, userId, gatewayStatus: gp.status })
  const outcome = await handleGatewayPayment({ gp, source: "CHECKOUT" })
  if (outcome?.result === "MISMATCH") throw paymentError("AMOUNT_MISMATCH", "We could not verify this payment.")
  return toStatusDto((await getOwnedRow(userId, orderId)) ?? row)
}

async function markPending(rowId, paymentId, source) {
  await pool.query(
    `UPDATE razorpay_payments SET status = 'PENDING', payment_attempted_at = COALESCE(payment_attempted_at, NOW()), updated_at = NOW() WHERE id = $1 AND status IN ('CREATED', 'CANCELLED', 'EXPIRED', 'FAILED') AND fulfillment = 'NONE'`,
    [rowId]
  )
  await addEvent(pool, rowId, "PAYMENT_PENDING", source, { paymentId: `${paymentId ?? ""}`.slice(0, 64) }).catch(() => undefined)
}

// ---------------------------------------------------------------------------------------
// 4. gateway payment -> our state (shared by checkout, webhook, reconcile)

export async function handleGatewayPayment({ gp, source }) {
  if (!gp?.order_id) return { result: "IGNORED" }
  if (gp.status === "captured") return settleCapturedPayment({ gp, source })
  if (gp.status === "authorized") {
    // Authorized is not paid. If the account is not on auto-capture, capture it (for exactly the
    // order amount) and settle on the captured entity; with auto-capture Razorpay does it itself.
    const row = await getRowByOrderId(gp.order_id)
    if (!row) return { result: "UNKNOWN_ORDER" }
    if (gp.amount !== Number(row.amount_paise) || gp.currency !== "INR") return recordMismatch(row, gp, source)
    await applyPending(row, gp, source)
    try {
      const captured = pickGatewayPayment(await razorpay.capturePayment({ paymentId: gp.id, amountPaise: Number(row.amount_paise) }))
      if (captured.status === "captured") return settleCapturedPayment({ gp: captured, source })
    } catch (error) {
      // "already captured" etc.: re-read the payment and use what the gateway says now.
      try {
        const fresh = pickGatewayPayment(await razorpay.fetchPayment(gp.id))
        if (fresh.status === "captured") return settleCapturedPayment({ gp: fresh, source })
      } catch {
        /* fall through: stays PENDING and is reconciled later */
      }
      plog("capture_failed", { paymentRef: row.id, orderId: gp.order_id, code: error?.code ?? null, status: error?.status ?? null })
    }
    return { result: "PENDING" }
  }
  if (gp.status === "failed") return recordFailure({ gp, source })
  // created / pending: an attempt exists but nothing is settled yet
  const row = await getRowByOrderId(gp.order_id)
  if (!row) return { result: "UNKNOWN_ORDER" }
  await applyPending(row, gp, source)
  return { result: "PENDING" }
}

async function applyPending(row, gp, source) {
  if (row.status === "SUCCESS" || isFinalRow(row)) return
  const { rowCount } = await pool.query(
    `
      UPDATE razorpay_payments
      SET status = 'PENDING', gateway_status = $2, payment_method = COALESCE($3, payment_method),
          payment_attempted_at = COALESCE(payment_attempted_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND status <> 'SUCCESS' AND fulfillment = 'NONE' AND (status <> 'PENDING' OR gateway_status IS DISTINCT FROM $2)
    `,
    [row.id, gp.status, gp.method]
  )
  if (rowCount) {
    await addEvent(pool, row.id, "PAYMENT_PENDING", source, { paymentId: gp.id, gatewayStatus: gp.status, method: gp.method })
    plog("payment_status_changed", { paymentRef: row.id, orderId: gp.order_id, to: "PENDING", gatewayStatus: gp.status, source })
  }
}

async function recordMismatch(row, gp, source) {
  await addEvent(pool, row.id, "AMOUNT_MISMATCH", source, { paymentId: gp.id, gatewayAmount: gp.amount, expected: Number(row.amount_paise), currency: gp.currency }).catch(() => undefined)
  plog("payment_amount_mismatch", { paymentRef: row.id, orderId: gp.order_id, paymentId: gp.id, gatewayAmount: gp.amount, expected: Number(row.amount_paise), currency: gp.currency, source })
  return { result: "MISMATCH" }
}

async function recordFailure({ gp, source }) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const { rows } = await client.query(`SELECT * FROM razorpay_payments WHERE razorpay_order_id = $1 FOR UPDATE`, [gp.order_id])
    const row = rows[0]
    if (!row) {
      await client.query("ROLLBACK")
      return { result: "UNKNOWN_ORDER" }
    }
    if (row.status === "SUCCESS" || isFinalRow(row)) {
      await client.query("ROLLBACK")
      return { result: "IGNORED_AFTER_SUCCESS" }
    }
    if (row.status === "FAILED" && row.razorpay_payment_id === gp.id) {
      await client.query("ROLLBACK")
      return { result: "DUPLICATE" }
    }
    await client.query(
      `
        UPDATE razorpay_payments
        SET status = 'FAILED', gateway_status = 'failed', razorpay_payment_id = $2, payment_method = COALESCE($3, payment_method),
            failure_code = $4, failure_reason = $5, failure_source = $6, failure_step = $7,
            payment_attempted_at = COALESCE(payment_attempted_at, NOW()), updated_at = NOW()
        WHERE id = $1
      `,
      [row.id, gp.id, gp.method, gp.error_code, gp.error_description ?? gp.error_reason, gp.error_source, gp.error_step]
    )
    await addEvent(client, row.id, "PAYMENT_FAILED", source, {
      paymentId: gp.id,
      method: gp.method,
      code: gp.error_code,
      reason: gp.error_reason,
      step: gp.error_step,
      errorSource: gp.error_source,
    })
    await client.query("COMMIT")
    plog("payment_failed", { paymentRef: row.id, orderId: gp.order_id, paymentId: gp.id, method: gp.method, code: gp.error_code, step: gp.error_step, source })
    return { result: "FAILED" }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------------------
// 5. settlement: the only place a paid booking is created

async function loadActor(client, userId) {
  if (!userId) return null
  const { rows } = await client.query(`SELECT ${USER_PROFILE_COLUMNS} FROM users WHERE id = $1`, [userId])
  return toAppUserDto(rows[0] ?? null)
}

export async function settleCapturedPayment({ gp, source }) {
  const client = await pool.connect()
  let effects = null
  let refundRowId = null
  let duplicateOf = null
  try {
    await client.query("BEGIN")
    // Row lock: concurrent settlement attempts for this order (checkout callback, webhook,
    // status poll, sweep) queue here; the first one books, the rest see BOOKED and return.
    const { rows } = await client.query(`SELECT * FROM razorpay_payments WHERE razorpay_order_id = $1 FOR UPDATE`, [gp.order_id])
    const row = rows[0]
    if (!row) {
      await client.query("ROLLBACK")
      return { result: "UNKNOWN_ORDER" }
    }
    if (gp.amount !== Number(row.amount_paise) || gp.currency !== "INR") {
      await client.query("ROLLBACK")
      return recordMismatch(row, gp, source)
    }

    if (row.status === "SUCCESS" && row.razorpay_payment_id === gp.id) {
      await client.query("ROLLBACK")
      return { result: "ALREADY_SETTLED" }
    }
    if (row.status === "SUCCESS" && row.razorpay_payment_id && row.razorpay_payment_id !== gp.id) {
      // A second, different payment captured against an order that is already paid.
      await addEvent(client, row.id, "DUPLICATE_PAYMENT", source, { paymentId: gp.id, keptPaymentId: row.razorpay_payment_id })
      await client.query("COMMIT")
      duplicateOf = { row, gp }
    } else {
      await client.query(
        `
          UPDATE razorpay_payments
          SET status = 'SUCCESS', gateway_status = 'captured', razorpay_payment_id = $2, payment_method = COALESCE($3, payment_method),
              captured_at = NOW(), payment_attempted_at = COALESCE(payment_attempted_at, NOW()),
              failure_code = NULL, failure_reason = NULL, failure_source = NULL, failure_step = NULL,
              verified_via = $4, updated_at = NOW()
          WHERE id = $1
        `,
        [row.id, gp.id, gp.method, source]
      )
      await addEvent(client, row.id, "PAYMENT_CAPTURED", source, { paymentId: gp.id, method: gp.method })
      plog("payment_captured", { paymentRef: row.id, orderId: gp.order_id, paymentId: gp.id, method: gp.method, source })

      await client.query("SAVEPOINT booking")
      try {
        const actorUser = await loadActor(client, row.user_id)
        if (!actorUser) throw paymentError("BAD_REQUEST", "Customer account no longer exists")
        const { created, stylistId } = await createPaidCustomerBookingInTransaction(client, {
          payload: row.request_payload,
          actorUser,
          expectedPayableAmount: Number(row.amount),
        })
        await client.query(
          `
            UPDATE razorpay_payments
            SET booking_id = $2, payment_transaction_id = $3, fulfillment = 'BOOKED', completed_at = NOW(), updated_at = NOW()
            WHERE id = $1
          `,
          [row.id, created.booking.id, created.paymentId]
        )
        await addEvent(client, row.id, "BOOKING_CONFIRMED", source, { bookingId: created.booking.id })
        await client.query("RELEASE SAVEPOINT booking")
        await client.query("COMMIT")
        effects = { created, actorUser, stylistId }
        plog("booking_confirmed", { paymentRef: row.id, orderId: gp.order_id, paymentId: gp.id, bookingId: created.booking.id, userId: row.user_id, source })
      } catch (bookingError) {
        await client.query("ROLLBACK TO SAVEPOINT booking")
        if (BUSINESS_BOOKING_ERRORS.has(bookingError?.code)) {
          // Paid, but the slot was taken / the price moved while the customer was paying.
          // Never keep money without a booking: queue a refund.
          await client.query(
            `UPDATE razorpay_payments SET fulfillment = 'REFUND_PENDING', booking_failure_code = $2, completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [row.id, `${bookingError.code}`]
          )
          await addEvent(client, row.id, "BOOKING_FAILED_AFTER_PAYMENT", source, { code: bookingError.code, message: `${bookingError.message}`.slice(0, 200) })
          await client.query("COMMIT")
          refundRowId = row.id
          plog("booking_failed_after_payment", { paymentRef: row.id, orderId: gp.order_id, paymentId: gp.id, code: bookingError.code, source })
        } else {
          // Unexpected (database hiccup, bug): leave the row exactly as it was before this attempt
          // so the next trigger (webhook retry, status poll, sweep) tries again. After
          // MAX_SETTLE_ATTEMPTS the payment is refunded instead of being left in limbo.
          await client.query("ROLLBACK")
          const attempts = await bumpSettleAttempts(gp.order_id)
          plog("settlement_error", { paymentRef: row.id, orderId: gp.order_id, paymentId: gp.id, attempts, error: bookingError?.code ?? bookingError?.message ?? "error", source })
          if (attempts >= MAX_SETTLE_ATTEMPTS) await abandonSettlement(row.id, gp, source)
          throw bookingError
        }
      }
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }

  if (effects) {
    await runPostBookingEffects({
      created: effects.created,
      actorUser: effects.actorUser,
      stylistId: effects.stylistId,
      publishEvent: publishBookingEvent,
      publishPaymentEvent,
    }).catch(error => plog("post_booking_effects_failed", { error: error?.message ?? "error" }))
    return { result: "BOOKED" }
  }
  if (duplicateOf) {
    await refundDuplicate(duplicateOf.row, duplicateOf.gp)
    return { result: "DUPLICATE_PAYMENT" }
  }
  if (refundRowId) {
    await initiateRefund(refundRowId).catch(error => plog("refund_initiation_failed", { paymentRef: refundRowId, error: error?.code ?? error?.message ?? "error" }))
    return { result: "REFUNDING" }
  }
  return { result: "UNKNOWN" }
}

async function bumpSettleAttempts(orderId) {
  // Stored in the event journal rather than a column: it is diagnostic and bounded.
  const row = await getRowByOrderId(orderId)
  if (!row) return 0
  await addEvent(pool, row.id, "SETTLEMENT_ERROR", "SERVER", {})
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM razorpay_payment_events WHERE payment_id = $1 AND event_type = 'SETTLEMENT_ERROR'`, [row.id])
  return rows[0]?.n ?? 1
}

async function abandonSettlement(rowId, gp, source) {
  // Commit the capture (so the money is accounted for) and queue the refund.
  await pool.query(
    `
      UPDATE razorpay_payments
      SET status = 'SUCCESS', gateway_status = 'captured', razorpay_payment_id = $2, payment_method = COALESCE($3, payment_method),
          captured_at = COALESCE(captured_at, NOW()), verified_via = $4,
          fulfillment = 'REFUND_PENDING', booking_failure_code = 'INTERNAL_ERROR', completed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND fulfillment = 'NONE'
    `,
    [rowId, gp.id, gp.method, source]
  )
  await addEvent(pool, rowId, "BOOKING_FAILED_AFTER_PAYMENT", source, { code: "INTERNAL_ERROR" }).catch(() => undefined)
  plog("settlement_abandoned_refunding", { paymentRef: rowId, paymentId: gp.id })
  await initiateRefund(rowId).catch(() => undefined)
}

// ---------------------------------------------------------------------------------------
// 6. refunds (only for payments we cannot turn into a booking)

export async function initiateRefund(rowId) {
  const { rows: claimed } = await pool.query(
    `
      UPDATE razorpay_payments SET refund_status = 'REQUESTING', updated_at = NOW()
      WHERE id = $1 AND fulfillment = 'REFUND_PENDING' AND razorpay_payment_id IS NOT NULL AND refund_status IS DISTINCT FROM 'REQUESTING'
      RETURNING *
    `,
    [rowId]
  )
  const row = claimed[0]
  if (!row) return
  try {
    const refund = await razorpay.refundPayment({
      paymentId: row.razorpay_payment_id,
      amountPaise: Number(row.amount_paise),
      notes: { payment_ref: row.id, reason: row.booking_failure_code ?? "booking_unavailable" },
    })
    const processed = refund.status === "processed"
    await pool.query(
      `UPDATE razorpay_payments SET refund_id = $2, refund_status = $3, fulfillment = $4, updated_at = NOW() WHERE id = $1`,
      [row.id, refund.id, `${refund.status ?? "pending"}`, processed ? "REFUNDED" : "REFUND_INITIATED"]
    )
    await addEvent(pool, row.id, "REFUND_INITIATED", "SERVER", { refundId: refund.id, status: refund.status })
    plog("refund_initiated", { paymentRef: row.id, paymentId: row.razorpay_payment_id, refundId: refund.id, status: refund.status })
  } catch (error) {
    await pool.query(`UPDATE razorpay_payments SET refund_status = NULL, updated_at = NOW() WHERE id = $1`, [row.id])
    await addEvent(pool, row.id, "REFUND_REQUEST_FAILED", "SERVER", { code: error?.code ?? null, status: error?.status ?? null }).catch(() => undefined)
    plog("refund_request_failed", { paymentRef: row.id, code: error?.code ?? null, status: error?.status ?? null })
    throw error
  }
}

async function refundDuplicate(row, gp) {
  try {
    const refund = await razorpay.refundPayment({ paymentId: gp.id, amountPaise: gp.amount, notes: { payment_ref: row.id, reason: "duplicate_payment" } })
    await addEvent(pool, row.id, "DUPLICATE_PAYMENT_REFUNDED", "SERVER", { paymentId: gp.id, refundId: refund.id })
    plog("duplicate_payment_refunded", { paymentRef: row.id, paymentId: gp.id, refundId: refund.id })
  } catch (error) {
    plog("duplicate_payment_refund_failed", { paymentRef: row.id, paymentId: gp.id, code: error?.code ?? null })
  }
}

async function applyRefundWebhook({ refund, eventType }) {
  const paymentId = `${refund?.payment_id ?? ""}`
  if (!paymentId) return "IGNORED"
  const row = (await pool.query(`SELECT * FROM razorpay_payments WHERE razorpay_payment_id = $1`, [paymentId])).rows[0]
  if (!row) return "IGNORED_UNKNOWN_PAYMENT"
  if (row.fulfillment === "BOOKED") {
    // Booked payments only get refunds through cancellation; anything else (a manual dashboard
    // refund) is not ours to change.
    return (await applyCancellationRefundWebhook(row, refund, eventType)) ? "OK" : "IGNORED_BOOKED_REFUND"
  }
  if (eventType === "refund.processed") {
    await pool.query(`UPDATE razorpay_payments SET fulfillment = 'REFUNDED', refund_id = COALESCE(refund_id, $2), refund_status = 'processed', updated_at = NOW() WHERE id = $1 AND fulfillment IN ('REFUND_PENDING', 'REFUND_INITIATED', 'REFUNDED')`, [row.id, `${refund.id ?? ""}` || null])
    await addEvent(pool, row.id, "REFUND_PROCESSED", "WEBHOOK", { refundId: refund.id })
    plog("refund_processed", { paymentRef: row.id, refundId: refund.id })
  } else if (eventType === "refund.failed") {
    await pool.query(`UPDATE razorpay_payments SET fulfillment = 'REFUND_FAILED', refund_status = 'failed', updated_at = NOW() WHERE id = $1 AND fulfillment IN ('REFUND_PENDING', 'REFUND_INITIATED')`, [row.id])
    await addEvent(pool, row.id, "REFUND_FAILED", "WEBHOOK", { refundId: refund.id })
    plog("refund_failed_needs_attention", { paymentRef: row.id, refundId: refund.id })
  }
  return "OK"
}

// ---------------------------------------------------------------------------------------
// 7. reconciliation / expiry / status

/**
 * Ask Razorpay what really happened to this order and feed it through the normal path. This is
 * what makes "payment succeeded but the browser never reported back", "webhook is late" and
 * "customer refreshed the page" converge on the right state.
 */
export async function reconcileRow(row, source) {
  if (!row?.razorpay_order_id || isFinalRow(row)) return
  await pool.query(`UPDATE razorpay_payments SET last_reconciled_at = NOW() WHERE id = $1`, [row.id])
  let payments
  try {
    payments = (await razorpay.fetchOrderPayments(row.razorpay_order_id)).items ?? []
  } catch (error) {
    plog("reconcile_lookup_failed", { paymentRef: row.id, orderId: row.razorpay_order_id, code: error?.code ?? null, network: Boolean(error?.network) })
    return
  }
  const entities = payments.map(pickGatewayPayment)
  const captured = entities.find(p => p.status === "captured")
  const authorized = entities.find(p => p.status === "authorized")
  const pendingAttempt = entities.find(p => p.status === "created")
  const failed = [...entities].reverse().find(p => p.status === "failed")
  const chosen = captured ?? authorized ?? pendingAttempt ?? failed
  if (chosen) await handleGatewayPayment({ gp: chosen, source })
}

async function expireIfOpen(rowId, source) {
  const { rowCount } = await pool.query(
    `UPDATE razorpay_payments SET status = 'EXPIRED', completed_at = NOW(), updated_at = NOW() WHERE id = $1 AND status IN ('CREATED', 'PENDING') AND fulfillment = 'NONE' AND expires_at <= NOW()`,
    [rowId]
  )
  if (rowCount) {
    await addEvent(pool, rowId, "EXPIRED", source, {})
    plog("checkout_expired", { paymentRef: rowId })
  }
  return rowCount > 0
}

export async function getPaymentStatus({ userId, orderId }) {
  let row = await getOwnedRow(userId, orderId)
  if (!row) throw paymentError("NOT_FOUND", "Payment not found")
  const stale = !row.last_reconciled_at || Date.now() - new Date(row.last_reconciled_at).getTime() > RECONCILE_MIN_INTERVAL_MS
  if (!isFinalRow(row) && stale && row.razorpay_order_id) {
    await reconcileRow(row, "STATUS_POLL").catch(error => plog("status_reconcile_failed", { orderId, error: error?.code ?? error?.message ?? "error" }))
    row = (await getOwnedRow(userId, orderId)) ?? row
    if (!isFinalRow(row)) {
      await expireIfOpen(row.id, "SERVER")
      row = (await getOwnedRow(userId, orderId)) ?? row
    }
  }
  return toStatusDto(row, await bookingSummary(row.booking_id))
}

async function bookingSummary(bookingId) {
  if (!bookingId) return null
  const { rows } = await pool.query(
    `SELECT b.id, b.service_name, b.starts_at, b.status, b.payable_amount, u.name AS stylist_name FROM bookings b LEFT JOIN users u ON u.id = b.stylist_id WHERE b.id = $1`,
    [bookingId]
  )
  const b = rows[0]
  return b ? { id: b.id, service: b.service_name, startsAt: b.starts_at, status: b.status, stylistName: b.stylist_name ?? null, payableAmount: Number(b.payable_amount) } : null
}

/** What the browser is allowed to know. No gateway internals, no raw failure text. */
export function toStatusDto(row, booking = null) {
  let state
  let message
  if (row.fulfillment === "BOOKED") {
    state = "CONFIRMED"
    message = "Payment received. Your booking is confirmed."
  } else if (row.fulfillment === "REFUNDED") {
    state = "REFUNDED"
    message = "Your payment was received but this slot could no longer be booked, so it has been refunded."
  } else if (row.fulfillment !== "NONE") {
    state = "REFUNDING"
    message = "Your payment was received but this slot could no longer be booked. A full refund is on its way; it can take a few working days to appear."
  } else if (row.status === "SUCCESS") {
    state = "PROCESSING"
    message = "Payment received. We are confirming your booking."
  } else if (row.status === "PENDING") {
    state = "PENDING"
    message = "We are waiting for your bank or UPI app to confirm the payment. Your booking is not confirmed yet."
  } else if (row.status === "FAILED") {
    state = "FAILED"
    message = "Your payment did not go through. If any money was deducted, your bank will return it automatically."
  } else if (row.status === "CANCELLED") {
    state = "CANCELLED"
    message = "Payment was cancelled. Your booking has not been made."
  } else if (row.status === "EXPIRED") {
    state = "EXPIRED"
    message = "This payment session expired. Your booking has not been made."
  } else {
    state = "AWAITING_PAYMENT"
    message = "Waiting for payment."
  }
  return {
    orderId: row.razorpay_order_id,
    state,
    status: row.status,
    fulfillment: row.fulfillment,
    message,
    amount: Number(row.amount),
    currency: row.currency,
    bookingId: row.booking_id ?? null,
    booking,
    failureCode: row.status === "FAILED" ? row.failure_code : null,
    terminal: row.fulfillment !== "NONE" || ["FAILED", "CANCELLED", "EXPIRED"].includes(row.status),
    expiresAt: row.expires_at,
  }
}

// ---------------------------------------------------------------------------------------
// 8. webhooks

function summarizeWebhook(body) {
  const payment = body?.payload?.payment?.entity ?? null
  const order = body?.payload?.order?.entity ?? null
  const refund = body?.payload?.refund?.entity ?? null
  return {
    orderId: `${payment?.order_id ?? order?.id ?? ""}` || null,
    paymentId: `${payment?.id ?? refund?.payment_id ?? ""}` || null,
    summary: {
      paymentStatus: payment?.status ?? null,
      method: payment?.method ?? null,
      amount: payment?.amount ?? order?.amount ?? refund?.amount ?? null,
      currency: payment?.currency ?? order?.currency ?? null,
      errorCode: payment?.error_code ?? null,
      refundStatus: refund?.status ?? null,
      createdAt: body?.created_at ?? null,
    },
  }
}

/**
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function processRazorpayWebhook({ rawBody, signature, eventIdHeader }) {
  const config = razorpayConfig()
  if (!config.webhookSecret) {
    plog("webhook_rejected_not_configured")
    return { status: 503, body: { error: "webhook_not_configured" } }
  }
  if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature({ rawBody, signature })) {
    plog("webhook_signature_invalid", { hasSignature: Boolean(signature), bytes: Buffer.isBuffer(rawBody) ? rawBody.length : 0 })
    return { status: 400, body: { error: "invalid_signature" } }
  }
  let body
  try {
    body = JSON.parse(rawBody.toString("utf8"))
  } catch {
    return { status: 400, body: { error: "invalid_json" } }
  }
  const eventType = `${body?.event ?? ""}`.slice(0, 64)
  const eventId = `${eventIdHeader ?? ""}`.trim().slice(0, 128) || createHash("sha256").update(rawBody).digest("hex")
  const meta = summarizeWebhook(body)

  const { rows } = await pool.query(
    `
      INSERT INTO razorpay_webhook_events (event_id, event_type, razorpay_order_id, razorpay_payment_id, summary)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (event_id) DO UPDATE SET attempts = razorpay_webhook_events.attempts + 1
      RETURNING (xmax = 0) AS inserted, processed_at, id
    `,
    [eventId, eventType, meta.orderId, meta.paymentId, JSON.stringify(meta.summary)]
  )
  const record = rows[0]
  if (!record.inserted && record.processed_at) {
    plog("webhook_duplicate", { eventId, eventType })
    return { status: 200, body: { ok: true, duplicate: true } }
  }
  plog("webhook_received", { eventId, eventType, orderId: meta.orderId, paymentId: meta.paymentId, redelivery: !record.inserted })

  let result
  try {
    if (["payment.authorized", "payment.captured", "payment.failed", "order.paid"].includes(eventType)) {
      const entity = body?.payload?.payment?.entity
      if (!entity?.order_id) {
        result = "IGNORED_NO_ORDER"
      } else {
        const outcome = await handleGatewayPayment({ gp: pickGatewayPayment(entity), source: "WEBHOOK" })
        result = outcome?.result ?? "OK"
      }
    } else if (eventType === "refund.processed" || eventType === "refund.failed") {
      result = await applyRefundWebhook({ refund: body?.payload?.refund?.entity, eventType })
    } else {
      result = "IGNORED_EVENT_TYPE"
    }
  } catch (error) {
    await pool.query(`UPDATE razorpay_webhook_events SET result = $2 WHERE id = $1`, [record.id, `ERROR:${error?.code ?? "internal"}`.slice(0, 48)]).catch(() => undefined)
    plog("webhook_processing_failed", { eventId, eventType, error: error?.code ?? error?.message ?? "error" })
    // 500 makes Razorpay redeliver; processing is idempotent, so a retry is always safe.
    return { status: 500, body: { error: "processing_failed" } }
  }
  await pool.query(`UPDATE razorpay_webhook_events SET processed_at = NOW(), result = $2 WHERE id = $1`, [record.id, `${result}`.slice(0, 48)])
  plog("webhook_processed", { eventId, eventType, result })
  return { status: 200, body: { ok: true, result } }
}

// ---------------------------------------------------------------------------------------
// 9. background sweep + admin funnel

export async function runRazorpaySweep() {
  // Rows that never got an order (process died between inserting the row and calling Razorpay).
  await pool.query(
    `UPDATE razorpay_payments SET status = 'FAILED', failure_code = 'ORDER_CREATE_INTERRUPTED', failure_step = 'order_creation', completed_at = NOW(), updated_at = NOW()
     WHERE razorpay_order_id IS NULL AND status = 'CREATED' AND created_at < NOW() - interval '2 minutes'`
  )
  // Refund attempts that crashed mid-flight, then refunds still waiting to be sent.
  await pool.query(`UPDATE razorpay_payments SET refund_status = NULL WHERE refund_status = 'REQUESTING' AND updated_at < NOW() - interval '2 minutes'`)
  const { rows: refunds } = await pool.query(`SELECT id FROM razorpay_payments WHERE fulfillment = 'REFUND_PENDING' LIMIT 20`)
  for (const { id } of refunds) await initiateRefund(id).catch(() => undefined)

  // Refunds we started: normally closed by the refund.processed webhook, but if that webhook is
  // late or lost, ask Razorpay directly so the row does not stay REFUND_INITIATED forever.
  const { rows: initiated } = await pool.query(
    `SELECT id, refund_id FROM razorpay_payments WHERE fulfillment = 'REFUND_INITIATED' AND refund_id IS NOT NULL AND updated_at < NOW() - interval '1 minute' LIMIT 20`
  )
  for (const row of initiated) {
    try {
      const refund = await razorpay.fetchRefund(row.refund_id)
      if (refund.status === "processed") {
        await pool.query(`UPDATE razorpay_payments SET fulfillment = 'REFUNDED', refund_status = 'processed', updated_at = NOW() WHERE id = $1 AND fulfillment = 'REFUND_INITIATED'`, [row.id])
        await addEvent(pool, row.id, "REFUND_PROCESSED", "SWEEP", { refundId: row.refund_id })
        plog("refund_processed", { paymentRef: row.id, refundId: row.refund_id, source: "SWEEP" })
      } else if (refund.status === "failed") {
        await pool.query(`UPDATE razorpay_payments SET fulfillment = 'REFUND_FAILED', refund_status = 'failed', updated_at = NOW() WHERE id = $1 AND fulfillment = 'REFUND_INITIATED'`, [row.id])
        await addEvent(pool, row.id, "REFUND_FAILED", "SWEEP", { refundId: row.refund_id })
        plog("refund_failed_needs_attention", { paymentRef: row.id, refundId: row.refund_id })
      }
    } catch (error) {
      plog("refund_status_lookup_failed", { paymentRef: row.id, code: error?.code ?? null })
    }
  }

  await reconcileCancellationRefunds().catch(error => plog("cancel_refund_sweep_failed", { error: error?.code ?? error?.message ?? "error" }))

  // Open checkouts past their TTL, attempts with no result yet, and recently closed checkouts that
  // might still have been paid (webhook missing/late): ask Razorpay, then expire what is truly unpaid.
  const { rows } = await pool.query(
    `
      SELECT * FROM razorpay_payments
      WHERE fulfillment = 'NONE' AND razorpay_order_id IS NOT NULL
        AND (
          (status IN ('CREATED', 'PENDING') AND (expires_at <= NOW()
            OR (payment_attempted_at IS NOT NULL AND COALESCE(last_reconciled_at, 'epoch') < NOW() - interval '2 minutes')
            -- UPI Intent: the customer tapped an app, so Razorpay has a payment we have not heard about yet
            -- (no webhook, browser gone). Checking every few minutes finds it long before the TTL.
            OR (checkout_opened_at IS NOT NULL AND checkout_opened_at < NOW() - interval '3 minutes' AND COALESCE(last_reconciled_at, 'epoch') < NOW() - interval '3 minutes')))
          OR (status IN ('FAILED', 'CANCELLED', 'EXPIRED') AND created_at > NOW() - interval '2 hours' AND COALESCE(last_reconciled_at, 'epoch') < NOW() - interval '10 minutes')
        )
      ORDER BY COALESCE(last_reconciled_at, 'epoch') ASC
      LIMIT 25
    `
  )
  for (const row of rows) {
    await reconcileRow(row, "SWEEP").catch(error => plog("sweep_reconcile_failed", { paymentRef: row.id, error: error?.code ?? error?.message ?? "error" }))
    await expireIfOpen(row.id, "SWEEP")
  }
  if (rows.length || refunds.length) plog("sweep_done", { reconciled: rows.length, refundsAttempted: refunds.length })
}

/**
 * Where do customers drop off? Counts by furthest step reached, plus the abandoned checkouts.
 * "Abandoned" here means: a checkout was opened (or started) and ended CANCELLED or EXPIRED
 * without any payment attempt. A FAILED row is a payment that was attempted and rejected, which is
 * a different problem (gateway/bank), so it is reported separately.
 */
export async function getPaymentFunnel({ days = 7 } = {}) {
  const window = Math.min(Math.max(Number(days) || 7, 1), 90)
  const { rows: counts } = await pool.query(
    `
      SELECT
        COUNT(*)::int AS checkout_started,
        COUNT(razorpay_order_id)::int AS order_created,
        COUNT(checkout_opened_at)::int AS checkout_opened,
        COUNT(payment_attempted_at)::int AS payment_attempted,
        COUNT(*) FILTER (WHERE status = 'SUCCESS' AND fulfillment = 'BOOKED')::int AS booked,
        COUNT(*) FILTER (WHERE status = 'SUCCESS' AND fulfillment <> 'BOOKED')::int AS paid_not_booked,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
        COUNT(*) FILTER (WHERE status = 'EXPIRED')::int AS expired,
        COUNT(*) FILTER (WHERE status IN ('CREATED', 'PENDING'))::int AS in_progress,
        COUNT(*) FILTER (WHERE status IN ('CANCELLED', 'EXPIRED') AND payment_attempted_at IS NULL)::int AS abandoned
      FROM razorpay_payments
      WHERE created_at > NOW() - make_interval(days => $1::int)
    `,
    [window]
  )
  const { rows: abandoned } = await pool.query(
    `
      SELECT p.id, p.razorpay_order_id, p.status, p.amount, p.checkout_opened_at, p.created_at, p.expires_at, u.name AS customer_name, u.email AS customer_email
      FROM razorpay_payments p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.created_at > NOW() - make_interval(days => $1::int)
        AND p.status IN ('CANCELLED', 'EXPIRED') AND p.payment_attempted_at IS NULL
      ORDER BY p.created_at DESC LIMIT 100
    `,
    [window]
  )
  return { days: window, counts: counts[0], abandoned }
}

import { v4 as uuid } from "uuid"
import { pool } from "../lib/db-pool.js"
import { roundMoney } from "../lib/money.js"
import { createPaymentTransaction } from "../bookings/repository.js"
import { isRazorpayConfigured, razorpayConfig } from "../payments/config.js"
import { razorpay, verifyCheckoutSignature } from "../payments/razorpay-client.js"
import { publishPaymentEvent } from "../realtime/socket-gateway.js"
import { ensureMembershipSchema } from "./service.js"

/**
 * Membership plans paid through Razorpay Orders.
 *
 * The plan price lives in `membership_plans` (set by the admin) and is read on the server when the
 * order is created, so the browser can never choose the amount. A paid period (1/3/6/12 months)
 * is bought per checkout; renewing before expiry extends from the current expiry. The database is
 * the source of truth: a membership is activated only from a *verified captured* payment, and every
 * entry point (checkout callback, webhook, sweep, admin reconcile) funnels into `settleMembership`,
 * which serialises on the purchase row, so one payment can only ever activate once.
 *
 * membership_purchases.status: CREATED (checkout open), PAID, FAILED, EXPIRED,
 * MISMATCH (money captured but amount/currency differ from the order: needs a human), REFUNDED.
 */

const RANK = { FREE: 0, BASIC: 1, PREMIUM: 2 }
const PAID_SEGMENTS = ["BASIC", "PREMIUM"]
const MAX_SWEEP_ROWS = 50

function ttlMinutes() {
  const value = Number(process.env.MEMBERSHIP_CHECKOUT_TTL_MINUTES)
  return Number.isFinite(value) && value >= 5 ? value : 30
}

function mlog(event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: "membership", event, ...fields }))
}

function membershipError(code, message) {
  return Object.assign(new Error(message), { code })
}

function pickGatewayPayment(entity) {
  return {
    id: `${entity?.id ?? ""}`,
    order_id: `${entity?.order_id ?? ""}`,
    status: `${entity?.status ?? ""}`,
    amount: Number(entity?.amount ?? 0),
    currency: `${entity?.currency ?? ""}`,
    method: entity?.method ? `${entity.method}`.slice(0, 32) : null,
    error_description: entity?.error_description ? `${entity.error_description}`.slice(0, 300) : null,
  }
}

async function getPurchaseByOrder(orderId, db = pool) {
  const { rows } = await db.query(`SELECT * FROM membership_purchases WHERE razorpay_order_id = $1`, [orderId])
  return rows[0] ?? null
}

export async function isMembershipOrder(orderId) {
  if (!orderId) return false
  await ensureMembershipSchema()
  return Boolean(await getPurchaseByOrder(orderId))
}

export async function isMembershipPayment(paymentId) {
  if (!paymentId) return false
  await ensureMembershipSchema()
  const { rows } = await pool.query(`SELECT 1 FROM membership_purchases WHERE razorpay_payment_id = $1`, [paymentId])
  return rows.length > 0
}

export function toPurchaseStatusDto(row) {
  const state = { PAID: "ACTIVE", CREATED: "PENDING", FAILED: "FAILED", EXPIRED: "EXPIRED", MISMATCH: "REVIEW", REFUNDED: "REFUNDED" }[row.status] ?? "PENDING"
  const message = {
    ACTIVE: `${row.plan_name} is active.`,
    PENDING: "We have not received confirmation of your payment yet. Your membership is not active until we do.",
    FAILED: "The payment did not go through. You have not been charged.",
    EXPIRED: "This checkout expired. You have not been charged.",
    REVIEW: "Your payment needs a manual check. Please contact the salon.",
    REFUNDED: "This payment was refunded.",
  }[state]
  return {
    state,
    message,
    orderId: row.razorpay_order_id,
    plan: { segment: row.segment, name: row.plan_name, durationMonths: Number(row.duration_months) },
    expiresAt: row.expires_at,
  }
}

// ---------------------------------------------------------------------------------------
// customer: start checkout

export async function startMembershipCheckout({ actorUser, segment }) {
  const target = `${segment ?? ""}`.trim().toUpperCase()
  if (!PAID_SEGMENTS.includes(target)) throw membershipError("BAD_REQUEST", "Choose the Basic or Premium plan.")
  if (!isRazorpayConfigured()) throw membershipError("GATEWAY_UNAVAILABLE", "Online payments are not available right now.")
  await ensureMembershipSchema()

  const { rows: planRows } = await pool.query(`SELECT * FROM membership_plans WHERE segment = $1 AND is_active = TRUE`, [target])
  const plan = planRows[0]
  if (!plan) throw membershipError("BAD_REQUEST", "This plan is not available.")
  const amountPaise = Math.round(roundMoney(Number(plan.price_amount)) * 100)
  if (amountPaise < 100) throw membershipError("BAD_REQUEST", "This plan has no online price yet. Please ask the salon.")

  const { rows: userRows } = await pool.query(`SELECT membership_segment, membership_expires_at FROM users WHERE id = $1`, [actorUser.id])
  const current = `${userRows[0]?.membership_segment ?? "FREE"}`.toUpperCase()
  const expires = userRows[0]?.membership_expires_at
  const active = current !== "FREE" && (!expires || new Date(expires).getTime() > Date.now())
  if (active && RANK[current] > RANK[target]) throw membershipError("BAD_REQUEST", "You already have a higher plan.")

  // Same customer, same plan, same price, checkout still open: reuse it (double click / second tab).
  const { rows: openRows } = await pool.query(
    `SELECT * FROM membership_purchases WHERE user_id = $1 AND segment = $2 AND status = 'CREATED' AND razorpay_order_id IS NOT NULL
       AND amount_paise = $3 AND checkout_expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
    [actorUser.id, target, amountPaise]
  )
  if (openRows[0]) return checkoutResponse(openRows[0], actorUser)

  const id = uuid()
  await pool.query(
    `INSERT INTO membership_purchases (id, user_id, segment, plan_name, duration_months, amount, amount_paise, checkout_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(mins => $8::int)) RETURNING *`,
    [id, actorUser.id, target, plan.name, Number(plan.duration_months ?? 1), amountPaise / 100, amountPaise, ttlMinutes()]
  )
  try {
    const order = await razorpay.createOrder({
      amountPaise,
      receipt: `mem_${id.replace(/-/g, "").slice(0, 32)}`,
      notes: { purpose: "membership", purchase_ref: id, segment: target },
    })
    if (Number(order.amount) !== amountPaise || order.currency !== "INR") throw new Error("order amount mismatch")
    const updated = await pool.query(`UPDATE membership_purchases SET razorpay_order_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, order.id])
    mlog("order_created", { purchaseRef: id, orderId: order.id, userId: actorUser.id, segment: target, amountPaise })
    return checkoutResponse(updated.rows[0], actorUser)
  } catch (error) {
    await pool.query(`UPDATE membership_purchases SET status = 'FAILED', failure_reason = 'ORDER_CREATE_FAILED', updated_at = NOW() WHERE id = $1`, [id]).catch(() => undefined)
    mlog("order_create_failed", { purchaseRef: id, userId: actorUser.id, code: error?.code ?? null })
    throw membershipError("GATEWAY_UNAVAILABLE", "We could not start the payment right now. Please try again.")
  }
}

function checkoutResponse(row, actorUser) {
  const config = razorpayConfig()
  return {
    orderId: row.razorpay_order_id,
    keyId: config.keyId, // public key id only
    amount: Number(row.amount_paise),
    currency: row.currency,
    description: `${row.plan_name} (${Number(row.duration_months)} month${Number(row.duration_months) === 1 ? "" : "s"})`.slice(0, 250),
    prefill: { name: actorUser?.name ?? "", email: actorUser?.email ?? "", contact: actorUser?.phone ?? "" },
    timeoutSeconds: Math.max(60, Math.floor((new Date(row.checkout_expires_at).getTime() - Date.now()) / 1000)),
    plan: { segment: row.segment, name: row.plan_name, durationMonths: Number(row.duration_months) },
  }
}

// ---------------------------------------------------------------------------------------
// verify (checkout callback), webhook and sweep all end in settleMembership

export async function verifyMembershipPayment({ userId, orderId, paymentId, signature }) {
  await ensureMembershipSchema()
  const row = await getPurchaseByOrder(orderId)
  if (!row || row.user_id !== userId) throw membershipError("NOT_FOUND", "Payment not found")
  if (!verifyCheckoutSignature({ orderId, paymentId, signature })) {
    mlog("verify_signature_invalid", { purchaseRef: row.id, userId })
    throw membershipError("INVALID_SIGNATURE", "We could not verify this payment.")
  }
  let gp
  try {
    gp = pickGatewayPayment(await razorpay.fetchPayment(paymentId))
  } catch {
    // Razorpay unreachable: neither confirm on the signature alone nor fail. Webhook/sweep settle it.
    return toPurchaseStatusDto(row)
  }
  if (gp.order_id !== orderId) throw membershipError("ORDER_MISMATCH", "We could not verify this payment.")
  await handleMembershipGatewayPayment({ gp, source: "CHECKOUT" })
  return toPurchaseStatusDto((await getPurchaseByOrder(orderId)) ?? row)
}

export async function getMembershipPurchaseStatus({ userId, orderId }) {
  await ensureMembershipSchema()
  let row = await getPurchaseByOrder(orderId)
  if (!row || row.user_id !== userId) throw membershipError("NOT_FOUND", "Payment not found")
  if (row.status === "CREATED") {
    await reconcilePurchase(row, "STATUS").catch(() => undefined)
    row = (await getPurchaseByOrder(orderId)) ?? row
  }
  return toPurchaseStatusDto(row)
}

export async function handleMembershipGatewayPayment({ gp, source }) {
  if (!gp?.order_id) return { result: "IGNORED" }
  if (gp.status === "captured") return settleMembership({ gp, source })
  if (gp.status === "authorized") {
    // Authorized is not paid: capture for exactly the order amount, then settle on the captured entity.
    const row = await getPurchaseByOrder(gp.order_id)
    if (!row) return { result: "UNKNOWN_ORDER" }
    if (gp.amount !== Number(row.amount_paise) || gp.currency !== "INR") return markMismatch(row, gp)
    try {
      const captured = pickGatewayPayment(await razorpay.capturePayment({ paymentId: gp.id, amountPaise: Number(row.amount_paise) }))
      if (captured.status === "captured") return settleMembership({ gp: captured, source })
    } catch {
      try {
        const fresh = pickGatewayPayment(await razorpay.fetchPayment(gp.id))
        if (fresh.status === "captured") return settleMembership({ gp: fresh, source })
      } catch {
        /* stays open; the sweep reconciles it */
      }
    }
    return { result: "PENDING" }
  }
  if (gp.status === "failed") {
    // Checkout lets the customer retry inside the same order, so a failed attempt is a note, not an end.
    await pool.query(`UPDATE membership_purchases SET failure_reason = $2, updated_at = NOW() WHERE razorpay_order_id = $1 AND status = 'CREATED'`, [gp.order_id, gp.error_description ?? "Payment attempt failed"])
    return { result: "FAILED_ATTEMPT" }
  }
  return { result: "PENDING" }
}

async function markMismatch(row, gp) {
  await pool.query(
    `UPDATE membership_purchases SET status = 'MISMATCH', razorpay_payment_id = COALESCE(razorpay_payment_id, $2), failure_reason = 'Amount or currency differs from the order', updated_at = NOW()
     WHERE id = $1 AND status = 'CREATED'`,
    [row.id, gp.id]
  )
  mlog("amount_mismatch", { purchaseRef: row.id, orderId: row.razorpay_order_id })
  return { result: "MISMATCH" }
}

async function settleMembership({ gp, source }) {
  const client = await pool.connect()
  let activated = null
  try {
    await client.query("BEGIN")
    const { rows } = await client.query(`SELECT * FROM membership_purchases WHERE razorpay_order_id = $1 FOR UPDATE`, [gp.order_id])
    const row = rows[0]
    if (!row) {
      await client.query("ROLLBACK")
      return { result: "UNKNOWN_ORDER" }
    }
    if (row.status === "PAID" || row.status === "REFUNDED") {
      await client.query("ROLLBACK")
      return { result: "ALREADY_PAID" }
    }
    if (gp.amount !== Number(row.amount_paise) || gp.currency !== "INR") {
      await client.query("ROLLBACK")
      return markMismatch(row, gp)
    }
    const { rows: userRows } = await client.query(`SELECT name, email, phone, membership_segment, membership_expires_at FROM users WHERE id = $1 FOR UPDATE`, [row.user_id])
    const user = userRows[0]
    if (!user) {
      await client.query("ROLLBACK")
      return markMismatch(row, gp)
    }
    // Renewing the same plan before it lapses extends from the current expiry; a new or upgraded
    // plan starts now.
    const sameActive = user.membership_segment === row.segment && user.membership_expires_at && new Date(user.membership_expires_at).getTime() > Date.now()
    const { rows: periodRows } = await client.query(
      `SELECT COALESCE($1::timestamptz, NOW()) AS starts_at, COALESCE($1::timestamptz, NOW()) + make_interval(months => $2::int) AS expires_at`,
      [sameActive ? user.membership_expires_at : null, row.duration_months]
    )
    const { starts_at: startsAt, expires_at: expiresAt } = periodRows[0]
    // Cash ledger: revenue reports and the live revenue chart sum this table.
    const ledger = await createPaymentTransaction({
      bookingId: null,
      sourceType: "MEMBERSHIP",
      customerName: user.name || user.email || "Customer",
      customerEmail: user.email,
      customerPhone: user.phone,
      amount: Number(row.amount),
      paymentMode: "ONLINE",
      collectedBy: null,
      db: client,
    })
    await client.query(`UPDATE users SET membership_segment = $2, membership_expires_at = $3 WHERE id = $1`, [row.user_id, row.segment, expiresAt])
    await client.query(
      `UPDATE membership_purchases SET status = 'PAID', razorpay_payment_id = $2, payment_method = $3, failure_reason = NULL, payment_transaction_id = $4,
         starts_at = $5, expires_at = $6, paid_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [row.id, gp.id, gp.method, ledger?.id ?? null, startsAt, expiresAt]
    )
    await client.query("COMMIT")
    activated = { purchaseRef: row.id, userId: row.user_id, segment: row.segment, expiresAt }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    mlog("settle_failed", { orderId: gp.order_id, source, code: error?.code ?? error?.message })
    throw error
  } finally {
    client.release()
  }
  mlog("activated", { ...activated, source })
  publishPaymentEvent("membership.purchased.v1", { purchaseId: activated.purchaseRef, segment: activated.segment })
  return { result: "ACTIVATED" }
}

// ---------------------------------------------------------------------------------------
// refunds started from the Razorpay dashboard

export async function applyMembershipRefund({ refund, eventType }) {
  const paymentId = `${refund?.payment_id ?? ""}`
  if (!paymentId) return null
  await ensureMembershipSchema()
  const { rows } = await pool.query(`SELECT * FROM membership_purchases WHERE razorpay_payment_id = $1`, [paymentId])
  const row = rows[0]
  if (!row) return null
  if (eventType !== "refund.processed") return "MEMBERSHIP_REFUND_NOT_PROCESSED"
  // Only a refund of the whole payment ends the membership; a partial refund is just recorded.
  if (Number(refund.amount) < Number(row.amount_paise)) return "MEMBERSHIP_PARTIAL_REFUND"
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(`UPDATE membership_purchases SET status = 'REFUNDED', updated_at = NOW() WHERE id = $1`, [row.id])
    // Drop back to Free only if this purchase is what the account currently runs on.
    await client.query(
      `UPDATE users SET membership_segment = 'FREE', membership_expires_at = NULL
       WHERE id = $1 AND membership_segment = $2 AND membership_expires_at = $3`,
      [row.user_id, row.segment, row.expires_at]
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
  mlog("refunded", { purchaseRef: row.id })
  return "MEMBERSHIP_REFUNDED"
}

// ---------------------------------------------------------------------------------------
// reconcile with Razorpay (sweep and the admin "Check with Razorpay" button)

async function reconcilePurchase(row, source) {
  if (!row.razorpay_order_id) return { result: "NO_ORDER" }
  const items = (await razorpay.fetchOrderPayments(row.razorpay_order_id))?.items ?? []
  const payments = items.map(pickGatewayPayment)
  const paid = payments.find(p => p.status === "captured") ?? payments.find(p => p.status === "authorized")
  if (paid) return handleMembershipGatewayPayment({ gp: paid, source })
  if (row.status === "CREATED" && new Date(row.checkout_expires_at).getTime() <= Date.now()) {
    const failed = payments.filter(p => p.status === "failed").at(-1)
    await pool.query(
      `UPDATE membership_purchases SET status = $2, failure_reason = COALESCE($3, failure_reason), updated_at = NOW() WHERE id = $1 AND status = 'CREATED'`,
      [row.id, failed ? "FAILED" : "EXPIRED", failed?.error_description ?? null]
    )
    return { result: failed ? "FAILED" : "EXPIRED" }
  }
  return { result: "PENDING" }
}

export async function reconcileMembershipPurchase(id) {
  await ensureMembershipSchema()
  const { rows } = await pool.query(`SELECT * FROM membership_purchases WHERE id = $1`, [id])
  if (!rows[0]) throw membershipError("NOT_FOUND", "Purchase not found")
  const result = await reconcilePurchase(rows[0], "ADMIN")
  const { rows: fresh } = await pool.query(`SELECT * FROM membership_purchases WHERE id = $1`, [id])
  return { result: result?.result ?? "OK", purchase: await toAdminDto(fresh[0]) }
}

/** Safe on every instance: every change is row-locked or conditional. */
export async function runMembershipSweep() {
  await ensureMembershipSchema()
  const { rows } = await pool.query(
    `SELECT * FROM membership_purchases WHERE status = 'CREATED' AND razorpay_order_id IS NOT NULL
       AND created_at < NOW() - interval '2 minutes' AND created_at > NOW() - interval '3 days'
     ORDER BY created_at ASC LIMIT $1`,
    [MAX_SWEEP_ROWS]
  )
  for (const row of rows) {
    try {
      await reconcilePurchase(row, "SWEEP")
    } catch (error) {
      mlog("sweep_row_failed", { purchaseRef: row.id, code: error?.code ?? null })
    }
  }
  // Rows with no order id (order creation crashed mid-way) can never be paid: close them.
  await pool.query(`UPDATE membership_purchases SET status = 'EXPIRED', updated_at = NOW() WHERE status = 'CREATED' AND razorpay_order_id IS NULL AND created_at < NOW() - interval '10 minutes'`)
  // Lapsed paid memberships go back to Free. Memberships with no expiry (granted at the desk) stay.
  const lapsed = await pool.query(
    `UPDATE users SET membership_segment = 'FREE', membership_expires_at = NULL
     WHERE membership_segment <> 'FREE' AND membership_expires_at IS NOT NULL AND membership_expires_at <= NOW() RETURNING id`
  )
  if (lapsed.rowCount) mlog("memberships_lapsed", { count: lapsed.rowCount })
}

// ---------------------------------------------------------------------------------------
// admin: tracking

async function toAdminDto(row) {
  if (!row) return null
  let customer = { id: row.user_id, name: "", email: "", phone: "" }
  if (row.user_id) {
    const { rows } = await pool.query(`SELECT id, name, email, phone FROM users WHERE id = $1`, [row.user_id])
    if (rows[0]) customer = rows[0]
  }
  return mapAdminRow({ ...row, customer_name: customer.name, customer_email: customer.email, customer_phone: customer.phone })
}

function mapAdminRow(row) {
  const paymentId = row.razorpay_payment_id
  const orderId = row.razorpay_order_id
  return {
    id: row.id,
    status: row.status,
    segment: row.segment,
    planName: row.plan_name,
    durationMonths: Number(row.duration_months),
    amount: Number(row.amount),
    currency: row.currency,
    paymentMethod: row.payment_method,
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId,
    razorpayUrl: paymentId ? `https://dashboard.razorpay.com/app/payments/${paymentId}` : orderId ? `https://dashboard.razorpay.com/app/orders/${orderId}` : null,
    failureReason: row.failure_reason,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    customer: { id: row.user_id, name: row.customer_name ?? "", email: row.customer_email ?? "", phone: row.customer_phone ?? "" },
  }
}

export async function listMembershipPurchases({ status, search, limit = 25, offset = 0 } = {}) {
  await ensureMembershipSchema()
  const where = []
  const values = []
  const wanted = `${status ?? ""}`.trim().toUpperCase()
  if (["CREATED", "PAID", "FAILED", "EXPIRED", "MISMATCH", "REFUNDED"].includes(wanted)) {
    values.push(wanted)
    where.push(`p.status = $${values.length}`)
  }
  const q = `${search ?? ""}`.trim().slice(0, 80)
  if (q) {
    values.push("%" + q.replace(/[\\%_]/g, (match) => "\\" + match) + "%")
    where.push(`(u.name ILIKE $${values.length} OR u.email ILIKE $${values.length} OR u.phone ILIKE $${values.length} OR p.razorpay_order_id ILIKE $${values.length} OR p.razorpay_payment_id ILIKE $${values.length})`)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 25, 1), 100)
  const safeOffset = Math.max(Math.trunc(Number(offset)) || 0, 0)
  const { rows } = await pool.query(
    `SELECT p.*, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
     FROM membership_purchases p LEFT JOIN users u ON u.id = p.user_id
     ${whereSql} ORDER BY p.created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, safeLimit, safeOffset]
  )
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM membership_purchases p LEFT JOIN users u ON u.id = p.user_id ${whereSql}`, values)
  return { purchases: rows.map(mapAdminRow), total: Number(countRows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset }
}

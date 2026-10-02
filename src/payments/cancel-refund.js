import { pool } from "../lib/db-pool.js"
import { razorpay } from "./razorpay-client.js"

/**
 * Gateway refunds for bookings the customer (or staff) cancels after paying online.
 *
 * The amount is whatever the cancellation policy decided (100% / 50% / 0%), recorded on the
 * payment row *inside the cancellation transaction* (`cancel_refund_paise`, status PENDING), so a
 * cancelled booking can never exist without its refund being owed. The Razorpay call happens right
 * after commit, and the sweep retries anything that did not go through:
 *
 *   cancel_refund_status: PENDING -> REQUESTING -> INITIATED -> PROCESSED   (or FAILED)
 */

function plog(event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: "payments", event, ...fields }))
}

async function addEvent(paymentId, eventType, source, detail = {}) {
  await pool
    .query(`INSERT INTO razorpay_payment_events (payment_id, event_type, source, detail) VALUES ($1, $2, $3, $4::jsonb)`, [paymentId, eventType, source, JSON.stringify(detail)])
    .catch(() => undefined)
}

export async function initiateCancellationRefund(rowId, source = "SERVER") {
  const { rows } = await pool.query(
    `UPDATE razorpay_payments SET cancel_refund_status = 'REQUESTING', updated_at = NOW()
     WHERE id = $1 AND cancel_refund_status = 'PENDING' AND razorpay_payment_id IS NOT NULL AND cancel_refund_paise > 0
     RETURNING *`,
    [rowId]
  )
  const row = rows[0]
  if (!row) return null
  try {
    // A previous attempt may have reached Razorpay and then crashed before we saved the id. Razorpay
    // happily takes a second partial refund, so look for ours first instead of refunding twice.
    const existing = ((await razorpay.fetchPaymentRefunds(row.razorpay_payment_id)).items ?? []).find(
      item => item.notes?.payment_ref === row.id && item.notes?.reason === "customer_cancellation"
    )
    const refund =
      existing ??
      (await razorpay.refundPayment({
        paymentId: row.razorpay_payment_id,
        amountPaise: Number(row.cancel_refund_paise),
        notes: { payment_ref: row.id, reason: "customer_cancellation", booking_id: row.booking_id ?? "" },
      }))
    await pool.query(`UPDATE razorpay_payments SET cancel_refund_id = $2, cancel_refund_status = $3, updated_at = NOW() WHERE id = $1`, [
      row.id,
      refund.id,
      refund.status === "processed" ? "PROCESSED" : "INITIATED",
    ])
    await addEvent(row.id, "CANCEL_REFUND_INITIATED", source, { refundId: refund.id, amountPaise: Number(row.cancel_refund_paise), status: refund.status, adopted: Boolean(existing) })
    plog("cancel_refund_initiated", { paymentRef: row.id, bookingId: row.booking_id, refundId: refund.id, amountPaise: Number(row.cancel_refund_paise), status: refund.status })
    return refund
  } catch (error) {
    await pool.query(`UPDATE razorpay_payments SET cancel_refund_status = 'PENDING', updated_at = NOW() WHERE id = $1`, [row.id])
    await addEvent(row.id, "CANCEL_REFUND_REQUEST_FAILED", source, { code: error?.code ?? null, status: error?.status ?? null })
    plog("cancel_refund_request_failed", { paymentRef: row.id, code: error?.code ?? null, status: error?.status ?? null })
    throw error
  }
}

/** refund.processed / refund.failed webhook for a cancellation refund. Returns true when it was ours. */
export async function applyCancellationRefundWebhook(row, refund, eventType) {
  if (!row.cancel_refund_status || (row.cancel_refund_id && row.cancel_refund_id !== refund.id)) return false
  if (eventType === "refund.processed") {
    await pool.query(`UPDATE razorpay_payments SET cancel_refund_id = COALESCE(cancel_refund_id, $2), cancel_refund_status = 'PROCESSED', updated_at = NOW() WHERE id = $1`, [row.id, refund.id])
    await addEvent(row.id, "CANCEL_REFUND_PROCESSED", "WEBHOOK", { refundId: refund.id })
    plog("cancel_refund_processed", { paymentRef: row.id, refundId: refund.id, source: "WEBHOOK" })
  } else if (eventType === "refund.failed") {
    await pool.query(`UPDATE razorpay_payments SET cancel_refund_status = 'FAILED', updated_at = NOW() WHERE id = $1`, [row.id])
    await addEvent(row.id, "CANCEL_REFUND_FAILED", "WEBHOOK", { refundId: refund.id })
    plog("cancel_refund_failed_needs_attention", { paymentRef: row.id, refundId: refund.id })
  }
  return true
}

/** Sweep: unstick crashed attempts, retry pending refunds, and close INITIATED ones Razorpay has finished. */
export async function reconcileCancellationRefunds() {
  await pool.query(`UPDATE razorpay_payments SET cancel_refund_status = 'PENDING' WHERE cancel_refund_status = 'REQUESTING' AND updated_at < NOW() - interval '2 minutes'`)
  const { rows: pending } = await pool.query(`SELECT id FROM razorpay_payments WHERE cancel_refund_status = 'PENDING' LIMIT 20`)
  for (const { id } of pending) await initiateCancellationRefund(id, "SWEEP").catch(() => undefined)
  const { rows: initiated } = await pool.query(
    `SELECT id, cancel_refund_id FROM razorpay_payments WHERE cancel_refund_status = 'INITIATED' AND cancel_refund_id IS NOT NULL AND updated_at < NOW() - interval '1 minute' LIMIT 20`
  )
  for (const row of initiated) {
    try {
      const refund = await razorpay.fetchRefund(row.cancel_refund_id)
      if (refund.status === "processed") {
        await pool.query(`UPDATE razorpay_payments SET cancel_refund_status = 'PROCESSED', updated_at = NOW() WHERE id = $1 AND cancel_refund_status = 'INITIATED'`, [row.id])
        await addEvent(row.id, "CANCEL_REFUND_PROCESSED", "SWEEP", { refundId: row.cancel_refund_id })
        plog("cancel_refund_processed", { paymentRef: row.id, refundId: row.cancel_refund_id, source: "SWEEP" })
      } else if (refund.status === "failed") {
        await pool.query(`UPDATE razorpay_payments SET cancel_refund_status = 'FAILED', updated_at = NOW() WHERE id = $1 AND cancel_refund_status = 'INITIATED'`, [row.id])
        await addEvent(row.id, "CANCEL_REFUND_FAILED", "SWEEP", { refundId: row.cancel_refund_id })
        plog("cancel_refund_failed_needs_attention", { paymentRef: row.id, refundId: row.cancel_refund_id })
      }
    } catch (error) {
      plog("cancel_refund_status_lookup_failed", { paymentRef: row.id, code: error?.code ?? null })
    }
  }
}

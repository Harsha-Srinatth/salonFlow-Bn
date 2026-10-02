// Prints the latest Razorpay payment rows and their event journal (debug helper).
import "dotenv/config"
const { pool } = await import("../src/lib/db-pool.js")
const limit = Number(process.argv[2] ?? 3)
const { rows } = await pool.query(
  `SELECT id, razorpay_order_id, status, fulfillment, amount, payment_method, failure_code, failure_reason, failure_step, razorpay_payment_id, verified_via, booking_id FROM razorpay_payments ORDER BY created_at DESC LIMIT $1`,
  [limit]
)
for (const r of rows) {
  const ev = await pool.query(`SELECT event_type, source FROM razorpay_payment_events WHERE payment_id = $1 ORDER BY id`, [r.id])
  console.log({ ...r, id: undefined, events: ev.rows.map(e => `${e.event_type}(${e.source})`).join(" > ") })
}
const b = await pool.query(`SELECT COUNT(*) n FROM bookings WHERE created_by IN (SELECT user_id FROM razorpay_payments)`)
const l = await pool.query(`SELECT COUNT(*) n FROM payment_transactions WHERE booking_id IN (SELECT booking_id FROM razorpay_payments)`)
console.log("bookings from these users:", b.rows[0].n, "| ledger rows for paid bookings:", l.rows[0].n)
await pool.end()

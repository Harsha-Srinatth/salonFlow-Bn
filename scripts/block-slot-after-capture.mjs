// Waits until the newest open order has a REAL captured payment at Razorpay, then books the same
// stylist/slot for someone else (a blocker row). Used with the harness "delay verify" option to
// force: paid -> slot gone -> refund. Cleaned up by the harness /teardown (same created_by).
import "dotenv/config"
import { v4 as uuid } from "uuid"
const { pool } = await import("../src/lib/db-pool.js")
const { razorpay } = await import("../src/payments/razorpay-client.js")
const deadline = Date.now() + 120000
while (Date.now() < deadline) {
  const { rows } = await pool.query(`SELECT razorpay_order_id, user_id, request_payload FROM razorpay_payments WHERE status IN ('CREATED','PENDING') AND razorpay_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
  const row = rows[0]
  if (row) {
    const items = (await razorpay.fetchOrderPayments(row.razorpay_order_id)).items ?? []
    const cap = items.find(p => p.status === "captured")
    if (cap) {
      await pool.query(
        `INSERT INTO bookings (id, customer_name, service_name, stylist_id, starts_at, duration_minutes, status, created_by) VALUES ($1, 'Slot Blocker', 'Blocker', $2, $3, 45, 'CONFIRMED', $4)`,
        [uuid(), row.request_payload.stylistId, row.request_payload.startsAt, row.user_id]
      )
      console.log(`payment ${cap.id} captured at Razorpay; slot ${row.request_payload.startsAt} now blocked`)
      break
    }
  }
  await new Promise(r => setTimeout(r, 500))
}
await pool.end()

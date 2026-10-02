// Waits for a REAL captured payment on the newest open Razorpay order, then POSTs a signed
// `payment.captured` webhook built from Razorpay's real payment entity to the local backend.
// Stands in for Razorpay's webhook delivery when no public tunnel/dashboard webhook is set up.
import "dotenv/config"
import { createHmac } from "node:crypto"
const { pool } = await import("../src/lib/db-pool.js")
const { razorpay } = await import("../src/payments/razorpay-client.js")
const API = process.env.HARSHA_API ?? "http://localhost:18081"
const times = Number(process.argv[2] ?? 1)
const deadline = Date.now() + 120000
while (Date.now() < deadline) {
  const { rows } = await pool.query(`SELECT razorpay_order_id FROM razorpay_payments WHERE status IN ('CREATED','PENDING') AND razorpay_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
  const orderId = rows[0]?.razorpay_order_id
  if (orderId) {
    const items = (await razorpay.fetchOrderPayments(orderId)).items ?? []
    const cap = items.find(p => p.status === "captured")
    if (cap) {
      for (let i = 0; i < times; i += 1) {
        const raw = JSON.stringify({ entity: "event", account_id: "acc_x", event: "payment.captured", contains: ["payment"], payload: { payment: { entity: cap } }, created_at: Math.floor(Date.now() / 1000) })
        const res = await fetch(`${API}/api/payments/razorpay/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-razorpay-event-id": `evt_inj_${cap.id}_${i % 2}`, "x-razorpay-signature": createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex") },
          body: raw,
        })
        console.log(`webhook #${i + 1} for ${cap.id} ->`, res.status, await res.text())
      }
      break
    }
  }
  await new Promise(r => setTimeout(r, 1000))
}
await pool.end()

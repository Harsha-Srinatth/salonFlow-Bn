/**
 * Local harness for exercising the REAL Razorpay Checkout (test mode) without Firebase login.
 *
 *   1. start the backend:            npm run dev            (port 18081)
 *   2. start the harness (from bn/): node scripts/checkout-harness-server.mjs
 *   3. open                          http://localhost:5173/
 *
 * It serves checkout-harness.html and the *same* fn/src/lib/razorpay-checkout.js the app uses, creates
 * a throwaway customer (cookie session), and removes everything again on /teardown.
 * Port 5173 is already in the backend's CORS allow-list. Test keys only.
 */
import "dotenv/config"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { v4 as uuid } from "uuid"

if (!`${process.env.RAZORPAY_KEY_ID ?? ""}`.startsWith("rzp_test_")) {
  console.error("Refusing to run: not a rzp_test_ key")
  process.exit(2)
}
const { pool } = await import("../src/lib/db-pool.js")
const { signStaffAccessToken } = await import("../src/lib/tokens.js")
const API = process.env.HARNESS_API ?? "http://localhost:18081"
const state = { userId: null, recepId: null }

function send(res, status, body, type = "application/json", headers = {}) {
  res.writeHead(status, { "Content-Type": type, ...headers })
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

async function setup() {
  if (!state.userId) {
    state.userId = uuid()
    const tag = randomBytes(3).toString("hex")
    await pool.query(
      `INSERT INTO users (id, name, email, phone, role, gender, latitude, longitude, email_verified, account_status)
       VALUES ($1, 'Checkout Harness', $2, $3, 'USER', 'MALE', 0, 0, TRUE, 'ACTIVE')`,
      [state.userId, `harness-${tag}@example.test`, `+9188${Math.floor(10000000 + Math.random() * 89999999)}`]
    )
  }
  const token = await signStaffAccessToken(state.userId)
  const [service] = (await pool.query(`SELECT id, name, base_price FROM service_catalog WHERE is_active AND target_gender IN ('MEN','UNISEX') AND base_price BETWEEN 50 AND 500 ORDER BY base_price LIMIT 1`)).rows
  return { userId: state.userId, token, service, api: API }
}

async function setupReception() {
  if (!state.recepId) {
    state.recepId = uuid()
    state.recepJti = uuid()
    const tag = randomBytes(3).toString("hex")
    await pool.query(
      `INSERT INTO users (id, name, email, phone, role, gender, latitude, longitude, email_verified, account_status, staff_session_jti)
       VALUES ($1, 'Harness Receptionist', $2, $3, 'RECEPTIONIST', 'FEMALE', 0, 0, TRUE, 'ACTIVE', $4)`,
      [state.recepId, `harness-recep-${tag}@example.test`, `+9177${Math.floor(10000000 + Math.random() * 89999999)}`, state.recepJti]
    )
  }
  return { token: await signStaffAccessToken(state.recepId, state.recepJti) }
}

async function teardown() {
  if (state.recepId) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [state.recepId]).catch(() => undefined)
    state.recepId = null
  }
  const id = state.userId
  if (!id) return { removed: false }
  await pool.query(`DELETE FROM razorpay_payments WHERE user_id = $1`, [id])
  await pool.query(`DELETE FROM payment_transactions WHERE booking_id IN (SELECT id FROM bookings WHERE created_by = $1)`, [id])
  await pool.query(`DELETE FROM bookings WHERE created_by = $1`, [id])
  await pool.query(`DELETE FROM notifications WHERE user_id = $1`, [id]).catch(() => undefined)
  await pool.query(`DELETE FROM users WHERE id = $1`, [id])
  state.userId = null
  return { removed: true }
}

createServer(async (req, res) => {
  try {
    if (req.url === "/" || req.url === "/index.html") return send(res, 200, readFileSync(new URL("./checkout-harness.html", import.meta.url)), "text/html")
    if (req.url === "/razorpay-checkout.js") return send(res, 200, readFileSync(new URL("../../fn/src/lib/razorpay-checkout.js", import.meta.url)), "text/javascript")
    if (req.url === "/setup" && req.method === "POST") {
      const info = await setup()
      return send(res, 200, info, "application/json", { "Set-Cookie": `app_access_token=${info.token}; Path=/; SameSite=Lax` })
    }
    if (req.url === "/setup-reception" && req.method === "POST") return send(res, 200, await setupReception())
    if (req.url === "/setup-admin" && req.method === "POST") {
      // Signs a session cookie for the existing admin account; nothing is created or changed in the database.
      const admin = (await pool.query(`SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1`)).rows[0]
      return send(res, 200, { token: await signStaffAccessToken(admin.id) })
    }
    if (req.url === "/teardown" && req.method === "POST") return send(res, 200, await teardown())
    send(res, 404, { error: "not found" })
  } catch (error) {
    console.error(error)
    send(res, 500, { error: String(error?.message ?? error) })
  }
}).listen(5173, "127.0.0.1", () => console.log("harness on http://localhost:5173/  (API " + API + ")"))

process.on("SIGINT", async () => {
  await teardown().catch(() => undefined)
  process.exit(0)
})

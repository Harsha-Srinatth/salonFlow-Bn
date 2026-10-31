import express from "express"
import cookieParser from "cookie-parser"
import "../../src/lib/async-routes.js"
import authRoutes from "../../src/routes/auth.js"
import emailRoutes from "../../src/routes/email.js"
import { sesWebhookHandler } from "../../src/email/events.js"
import { runEmailWorkerOnce } from "../../src/email/service.js"
import { emailConfig } from "../../src/email/config.js"
import { pool } from "../helpers/fixtures.js"

/** The real routers behind the same parsers and error handling as server.js. */
export async function startApp() {
  const app = express()
  app.post("/api/webhooks/ses", express.text({ type: "*/*", limit: "256kb" }), sesWebhookHandler)
  app.use(express.json())
  app.use(cookieParser())
  app.use("/api/auth", authRoutes)
  app.use("/api/email", emailRoutes)
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status) || 500
    res.status(status).json({ error: err?.expose ? err.message : "Internal server error" })
  })
  const server = await new Promise(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
    return { status: response.status, body: await response.json().catch(() => ({})), headers: response.headers }
  }
  return { server, base, post, stop: () => new Promise(resolve => server.close(resolve)) }
}

export function registration(overrides = {}) {
  return {
    name: "Asha Rao",
    email: "asha@customer-mail.in",
    password: "correct-horse-1",
    phone: "+919876500001",
    gender: "FEMALE",
    ...overrides,
  }
}

/** Runs the worker until nothing more is due. */
export async function drainOutbox(options = {}) {
  const totals = {}
  for (let pass = 0; pass < 5; pass += 1) {
    const counts = await runEmailWorkerOnce({ config: emailConfig(), ...options })
    if (!Object.keys(counts).length) break
    for (const [key, value] of Object.entries(counts)) totals[key] = (totals[key] ?? 0) + value
  }
  return totals
}

export function linkToken(mail) {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(mail.text)
  return match?.[1] ?? null
}

export async function outbox(where = "TRUE", values = []) {
  const { rows } = await pool.query(`SELECT * FROM email_messages WHERE ${where} ORDER BY scheduled_for, created_at`, values)
  return rows
}

export async function userByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email])
  return rows[0] ?? null
}

/** Moves due messages to now, as if the clock had reached them. */
export async function makeEmailsDue() {
  await pool.query(`UPDATE email_messages SET next_attempt_at = NOW() - interval '1 second' WHERE status = 'PENDING'`)
}

import "dotenv/config"
import cookieParser from "cookie-parser"
import cors from "cors"
import express from "express"
import helmet from "helmet"
import { createServer } from "node:http"

import { tryAcquireSlot } from "./lib/redis.js"
import { assertProductionEnv } from "./lib/env-check.js"
import "./lib/async-routes.js"
import { pool } from "./lib/db-pool.js"
import { attachRequestId } from "./middleware/request-id.js"

import adminRoutes from "./routes/admin.js"
import authRoutes from "./routes/auth.js"
import customerRoutes from "./routes/customer.js"
import notificationRoutes from "./routes/notifications.js"
import paymentRoutes, { razorpayWebhookHandler } from "./routes/payments.js"
import receptionRoutes from "./routes/reception.js"
import staffRoutes from "./routes/staff.js"

import {
  initSocketGateway,
  publishBookingEvent,
  publishQueueSnapshotEvent,
} from "./realtime/socket-gateway.js"

import {
  autoCompleteOverdueStartedBookings,
  autoMarkNoShowBookings,
} from "./bookings/service.js"

import { ensureBookingsSchema } from "./bookings/schema-init.js"
import { queueConfig } from "./queue/constants.js"
import { ensureQueueSchema } from "./queue/schema-init.js"
import { ensureUserProfileSchema } from "./auth/schema-init.js"
import { broadcastQueueSnapshot, runQueueReminderSweep } from "./queue/service.js"
import { ensureLoyaltySchema, runReferralSettlementSweep } from "./loyalty/service.js"
import { isRazorpayConfigured, razorpayConfig } from "./payments/config.js"
import { ensurePaymentsRuntime, runRazorpaySweep } from "./payments/service.js"

assertProductionEnv()

let shuttingDown = false
const BOOKING_SWEEP_SLOT_KEY = "sahasra:bookings:sweep-slot"

const app = express()

const port = Number(process.env.PORT || 18081)
const host = "0.0.0.0"

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5178",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5178",
  "https://salonflow-eta.vercel.app",
]

// Allow additional origins from env
if (process.env.FRONTEND_ORIGIN) {
  process.env.FRONTEND_ORIGIN
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .forEach((origin) => {
      if (!allowedOrigins.includes(origin)) {
        allowedOrigins.push(origin)
      }
    })
}

if (
  process.env.TRUST_PROXY === "1" ||
  process.env.TRUST_PROXY === "true"
) {
  app.set("trust proxy", 1)
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
  })
)

app.use(
  cors({
    origin(origin, callback) {
      // Allow Postman/server-side requests
      if (!origin) {
        return callback(null, true)
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true)
      }

      console.log("Blocked Origin:", origin)
      return callback(Object.assign(new Error(`CORS blocked for origin: ${origin}`), { status: 403 }))
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      // Custom headers used in auth-client.js for session sync
      "x-signup-role",
      "x-user-phone",
      "x-user-name",
      "x-user-gender",
      "x-referral-code",
      "x-device-id",
    ],
  })
)

// Service photos arrive as base64 inside JSON (the route allows 8 MB of image, ~11 MB encoded);
// everything else keeps a small cap so a large body cannot be used to burn memory.
// Razorpay signs the exact bytes it sends, so its webhook gets the raw body (no JSON parsing)
// and must be registered before the global JSON parser below.
app.post("/api/payments/razorpay/webhook", express.raw({ type: "*/*", limit: "256kb" }), attachRequestId, razorpayWebhookHandler)

app.use("/api/admin/services/upload-image", express.json({ limit: "12mb" }))
app.use(express.json({ limit: "256kb" }))
app.use(cookieParser())
app.use(attachRequestId)

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    message: "Backend is running",
  })
})

// Readiness: unlike /health (process is alive) this proves the database answers, so a
// load balancer can stop routing to an instance whose pool is wedged or whose DB is gone.
app.get("/ready", async (_req, res) => {
  if (shuttingDown) return res.status(503).json({ ok: false, error: "shutting_down" })
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("db_timeout")), 3000)),
    ])
    res.status(200).json({ ok: true })
  } catch (error) {
    res.status(503).json({ ok: false, error: "database_unavailable" })
  }
})

app.use("/api/auth", authRoutes)
app.use("/api/admin", adminRoutes)
app.use("/api/customer", customerRoutes)
app.use("/api/payments", paymentRoutes)
app.use("/api/reception", receptionRoutes)
app.use("/api/staff", staffRoutes)
app.use("/api/notifications", notificationRoutes)

// Postgres errors that mean "the client sent something malformed" rather than
// "the server broke": invalid uuid/number/timestamp text, out-of-range values.
const CLIENT_INPUT_PG_CODES = new Set(["22P02", "22007", "22008", "22003", "22001", "23514"])

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)

  let status = Number(err?.status ?? err?.statusCode)
  if (!(status >= 400 && status < 600)) {
    // 23505 = unique violation (duplicate e-mail/phone/etc.): the client's conflict, not a crash.
    status = err?.code === "23505" ? 409 : CLIENT_INPUT_PG_CODES.has(err?.code) ? 400 : 500
  }

  if (status >= 500) {
    console.error("request_failed", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      error: err instanceof Error ? err.stack ?? err.message : err,
    })
  }

  const messages = {
    400: "Invalid request",
    403: "Forbidden",
    409: "That already exists",
    413: "Request body too large",
  }
  res.status(status).json({
    error: status >= 500 ? "Internal server error" : messages[status] ?? "Request failed",
    requestId: req.requestId,
  })
})

// Last line of defence: log and keep serving. A rejected promise outside a request
// (a background sweep, a fire-and-forget notification) must not take the API down.
process.on("unhandledRejection", reason => {
  console.error("unhandled_rejection", reason instanceof Error ? reason.stack ?? reason.message : reason)
})
process.on("uncaughtException", error => {
  console.error("uncaught_exception", error instanceof Error ? error.stack ?? error.message : error)
  // State may be inconsistent after a synchronous throw: exit and let the supervisor restart.
  setTimeout(() => process.exit(1), 100).unref()
})

const httpServer = createServer(app)

const io = await initSocketGateway(httpServer, {
  corsOrigin(origin, callback) {
    if (!origin) {
      return callback(null, true)
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true)
    }

    return callback(new Error(`Socket CORS blocked for origin: ${origin}`))
  },
})

httpServer.listen(port, host, () => {
  console.log(`Backend listening on http://${host}:${port}`)
})

// Orchestrators stop a container with SIGTERM and kill it after a grace period. Finish what is
// in flight (HTTP, sockets), release database connections, then exit, instead of dropping
// requests and leaving transactions to time out on the database side.
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log("shutdown_start", { signal })
  setTimeout(() => process.exit(1), Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000)).unref()
  try {
    await new Promise(resolve => io.close(resolve)) // also closes the underlying HTTP server
    await pool.end()
    console.log("shutdown_complete")
    process.exit(0)
  } catch (error) {
    console.error("shutdown_failed", error)
    process.exit(1)
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

const autoCompleteIntervalMs = Number(
  process.env.BOOKING_AUTO_COMPLETE_INTERVAL_MS ?? 60000
)

// These two sweeps used to run inside every booking-list request as well, which put
// writes and extra table scans on every read path. They now run only here, and are
// guarded twice: `running` stops a slow tick overlapping the next one in this process,
// and the Redis slot makes one instance per interval do the work fleet-wide (without
// Redis there is a single process by definition, so the slot is always granted).
let bookingSweepRunning = false

async function runBookingSweeps(label) {
  if (bookingSweepRunning) return
  bookingSweepRunning = true
  try {
    if (!(await tryAcquireSlot(BOOKING_SWEEP_SLOT_KEY, Math.max(1000, Math.round(autoCompleteIntervalMs * 0.9))))) return
    try {
      await autoCompleteOverdueStartedBookings({ publishEvent: publishBookingEvent })
    } catch (error) {
      console.error(`booking_auto_complete_${label}_failed`, error)
    }
    try {
      await autoMarkNoShowBookings({ publishEvent: publishBookingEvent })
    } catch (error) {
      console.error(`booking_auto_no_show_${label}_failed`, error)
    }
  } finally {
    bookingSweepRunning = false
  }
}

setInterval(() => void runBookingSweeps("tick"), autoCompleteIntervalMs)
void runBookingSweeps("startup")

// Live queue (SRS 4.7). Both workers are safe to run on every instance: the
// broadcaster holds a fleet-wide Redis slot so only one copy of each snapshot is
// pushed, and the reminder sweep claims each notification through a unique key
// so a customer can only ever be nudged once.
const { broadcastIntervalMs, reminderSweepIntervalMs } = queueConfig()

// Background workers start before any request has been served, so the tables
// they read cannot be assumed to exist yet. A failure here is logged rather than
// fatal — the per-route `ensure*Schema` middleware retries on the first request.
try {
  // First: `middleware/auth.js` selects the profile columns on every
  // authenticated request, including routes that mount no `ensure*Schema`
  // middleware of their own. Without this, the first such request after a
  // deploy that adds a profile column fails with "column does not exist"
  // instead of quietly migrating.
  await ensureUserProfileSchema()
  await ensureBookingsSchema()
  await ensureQueueSchema()
  await ensureLoyaltySchema()
  if (isRazorpayConfigured()) await ensurePaymentsRuntime()
} catch (error) {
  console.error("queue_schema_bootstrap_failed", error)
}

if (isRazorpayConfigured()) {
  console.log("razorpay_enabled", { mode: razorpayConfig().mode, webhookSecretConfigured: Boolean(razorpayConfig().webhookSecret) })
  // Reconciles open/late payments with Razorpay, expires truly unpaid checkouts, retries refunds.
  // Safe on every instance (all state changes are row-locked / conditional); the Redis slot just
  // avoids N instances asking Razorpay the same thing.
  const razorpaySweepIntervalMs = Number(process.env.RAZORPAY_SWEEP_INTERVAL_MS ?? 60_000)
  let razorpaySweepRunning = false
  setInterval(async () => {
    if (razorpaySweepRunning || shuttingDown) return
    razorpaySweepRunning = true
    try {
      if (await tryAcquireSlot("sahasra:payments:razorpay-sweep", Math.max(1000, Math.round(razorpaySweepIntervalMs * 0.9)))) await runRazorpaySweep()
    } catch (error) {
      console.error("razorpay_sweep_failed", error)
    } finally {
      razorpaySweepRunning = false
    }
  }, razorpaySweepIntervalMs)
}

setInterval(() => {
  void broadcastQueueSnapshot({ publish: publishQueueSnapshotEvent }).catch((error) => {
    console.error("queue_snapshot_broadcast_failed", error)
  })
}, broadcastIntervalMs)

setInterval(() => {
  void runQueueReminderSweep().catch((error) => {
    console.error("queue_reminder_sweep_failed", error)
  })
}, reminderSweepIntervalMs)

// Referral settlement: clears the cooling period, re-checks for abuse, and pays
// out approved rewards. Fleet-safe without a lock — every state change is a
// conditional UPDATE guarded on the status it is moving away from, so a second
// instance running the same tick simply matches no rows.
const referralSweepIntervalMs = Number(process.env.REFERRAL_SETTLEMENT_INTERVAL_MS ?? 5 * 60 * 1000)

setInterval(() => {
  void runReferralSettlementSweep().catch((error) => {
    console.error("referral_settlement_sweep_failed", error)
  })
}, referralSweepIntervalMs)

void runReferralSettlementSweep().catch((error) => {
  console.error("referral_settlement_startup_failed", error)
})
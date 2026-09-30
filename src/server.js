import "dotenv/config"
import cookieParser from "cookie-parser"
import cors from "cors"
import express from "express"
import helmet from "helmet"
import { createServer } from "node:http"

import { attachRequestId } from "./middleware/request-id.js"

import adminRoutes from "./routes/admin.js"
import authRoutes from "./routes/auth.js"
import customerRoutes from "./routes/customer.js"
import notificationRoutes from "./routes/notifications.js"
import publicRoutes from "./routes/public.js"
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
      return callback(new Error(`CORS blocked for origin: ${origin}`))
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

app.use(express.json())
app.use(cookieParser())
app.use(attachRequestId)

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    message: "Backend is running",
  })
})

app.use("/api/auth", authRoutes)
app.use("/api/admin", adminRoutes)
app.use("/api/customer", customerRoutes)
app.use("/api/reception", receptionRoutes)
app.use("/api/staff", staffRoutes)
app.use("/api/notifications", notificationRoutes)
app.use("/api", publicRoutes)

app.use((err, req, res, _next) => {
  console.error("request_failed", {
    requestId: req.requestId,
    error: err instanceof Error ? err.message : err,
  })

  res.status(500).json({
    error: "Internal server error",
    requestId: req.requestId,
  })
})

const httpServer = createServer(app)

await initSocketGateway(httpServer, {
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

const autoCompleteIntervalMs = Number(
  process.env.BOOKING_AUTO_COMPLETE_INTERVAL_MS ?? 60000
)

setInterval(async () => {
  try {
    await autoCompleteOverdueStartedBookings({
      publishEvent: publishBookingEvent,
    })
  } catch (error) {
    console.error("booking_auto_complete_failed", error)
  }
  try {
    await autoMarkNoShowBookings({
      publishEvent: publishBookingEvent,
    })
  } catch (error) {
    console.error("booking_auto_no_show_failed", error)
  }
}, autoCompleteIntervalMs)

void autoCompleteOverdueStartedBookings({
  publishEvent: publishBookingEvent,
}).catch((error) => {
  console.error("booking_auto_complete_startup_failed", error)
})

void autoMarkNoShowBookings({
  publishEvent: publishBookingEvent,
}).catch((error) => {
  console.error("booking_auto_no_show_startup_failed", error)
})

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
} catch (error) {
  console.error("queue_schema_bootstrap_failed", error)
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
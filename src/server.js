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
import publicRoutes from "./routes/public.js"
import receptionRoutes from "./routes/reception.js"
import staffRoutes from "./routes/staff.js"

import {
  initSocketGateway,
  publishBookingEvent,
} from "./realtime/socket-gateway.js"

import {
  autoCompleteOverdueStartedBookings,
} from "./bookings/service.js"

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
}, autoCompleteIntervalMs)

void autoCompleteOverdueStartedBookings({
  publishEvent: publishBookingEvent,
}).catch((error) => {
  console.error("booking_auto_complete_startup_failed", error)
})
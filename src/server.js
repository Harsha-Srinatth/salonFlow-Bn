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
import { initSocketGateway, publishBookingEvent } from "./realtime/socket-gateway.js"
import { autoCompleteOverdueStartedBookings } from "./bookings/service.js"

/**
 * HTTP API bootstrap.
 * - Helmet sets baseline security headers on JSON responses (CSP disabled for a pure API).
 * - Set TRUST_PROXY=1 when behind a reverse proxy so req.ip / rate limits use X-Forwarded-For correctly.
 * - Multi-factor auth (TOTP/WebAuthn) is not implemented here; audit logs and lockouts reduce brute-force risk until MFA is added.
 */
const app = express()
const host = process.env.HOST ?? "0.0.0.0"
const port = Number(process.env.PORT ?? 18081)
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:5178"
const configuredOrigins = frontendOrigin
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean)
const localDevOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

function isOriginAllowed(origin) {
  if (!origin) return true
  if (configuredOrigins.includes(origin)) return true
  return process.env.NODE_ENV !== "production" && localDevOriginPattern.test(origin)
}

if (process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1)
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
)

app.use(
  cors({
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true)
      return callback(new Error(`CORS blocked for origin: ${origin}`))
    },
    credentials: true,
  })
)
app.use(express.json())
app.use(cookieParser())
app.use(attachRequestId)

app.get("/health", (_req, res) => {
  res.json({ ok: true })
})

app.use("/api/auth", authRoutes)
app.use("/api/admin", adminRoutes)
app.use("/api/customer", customerRoutes)
app.use("/api/reception", receptionRoutes)
app.use("/api/staff", staffRoutes)
app.use("/api", publicRoutes)

app.use((err, _req, res, _next) => {
  console.error("request_failed", { requestId: _req.requestId, error: err instanceof Error ? err.message : err })
  res.status(500).json({ error: "Internal server error", requestId: _req.requestId })
})

const httpServer = createServer(app)
await initSocketGateway(httpServer, {
  corsOrigin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true)
    return callback(new Error(`Socket CORS blocked for origin: ${origin}`))
  },
})

httpServer.listen(port, host, () => {
  console.log(`bn backend listening on http://${host}:${port}`)
})

const autoCompleteIntervalMs = Number(process.env.BOOKING_AUTO_COMPLETE_INTERVAL_MS ?? 60_000)
setInterval(async () => {
  try {
    await autoCompleteOverdueStartedBookings({ publishEvent: publishBookingEvent })
  } catch (error) {
    console.error("booking_auto_complete_failed", error)
  }
}, autoCompleteIntervalMs)
void autoCompleteOverdueStartedBookings({ publishEvent: publishBookingEvent }).catch((error) => {
  console.error("booking_auto_complete_startup_failed", error)
})

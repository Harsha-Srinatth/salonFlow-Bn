import { Server } from "socket.io"
import { createAdapter } from "@socket.io/redis-adapter"
import Redis from "ioredis"
import { verifyFirebaseToken } from "../lib/firebase-admin.js"
import { pool } from "../lib/db-pool.js"
import { verifyStaffAccessToken } from "../lib/tokens.js"
import { QUEUE_LIVE_ROOM, QUEUE_SNAPSHOT_EVENT } from "../queue/constants.js"
import { markQueueMutated } from "../queue/cache-hooks.js"
import { decryptEnvelope, encryptEnvelope, hasEnvelopeCryptoEnabled } from "../security/crypto-envelope.js"

let ioRef = null
const handshakeWindowMs = Number(process.env.RATE_SOCKET_HANDSHAKE_WINDOW_MS ?? 60 * 1000)
const handshakeMax = Number(process.env.RATE_SOCKET_HANDSHAKE_MAX ?? 40)
const handshakeBuckets = new Map()

function canAcceptHandshake(key) {
  const now = Date.now()
  const bucket = handshakeBuckets.get(key) ?? { start: now, count: 0 }
  if (now - bucket.start > handshakeWindowMs) {
    handshakeBuckets.set(key, { start: now, count: 1 })
    return true
  }
  if (bucket.count >= handshakeMax) return false
  bucket.count += 1
  handshakeBuckets.set(key, bucket)
  return true
}

async function resolveUserFromToken(token) {
  if (!token) return null
  try {
    const staffPayload = await verifyStaffAccessToken(token)
    const { rows } = await pool.query(
      `
        SELECT id, role, email, phone
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [staffPayload.sub]
    )
    return rows[0] ?? null
  } catch {
    try {
      const firebaseUser = await verifyFirebaseToken(token)
      const { rows } = await pool.query(
        `
          SELECT id, role, email, phone
          FROM users
          WHERE firebase_uid = $1 OR lower(btrim(email)) = $2
          ORDER BY updated_at DESC NULLS LAST
          LIMIT 1
        `,
        [firebaseUser.uid, `${firebaseUser.email ?? ""}`.trim().toLowerCase()]
      )
      return rows[0] ?? null
    } catch {
      return null
    }
  }
}

function parseHandshakeToken(socket) {
  const authHeader = socket.handshake.auth?.token ?? socket.handshake.headers.authorization ?? ""
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) return authHeader.slice("Bearer ".length)
  if (typeof authHeader === "string" && authHeader.length > 20) return authHeader
  const cookieHeader = `${socket.handshake.headers.cookie ?? ""}`
  if (cookieHeader) {
    const cookies = Object.fromEntries(
      cookieHeader
        .split(";")
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
          const idx = part.indexOf("=")
          if (idx < 0) return [part, ""]
          return [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))]
        })
    )
    const sessionToken = cookies.staff_access_token ?? cookies.app_access_token ?? null
    if (typeof sessionToken === "string" && sessionToken.length > 20) return sessionToken
  }
  return null
}

export async function initSocketGateway(httpServer, { corsOrigin }) {
  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
    path: "/socket.io",
  })
  if (process.env.REDIS_URL) {
    const pubClient = new Redis(process.env.REDIS_URL)
    const subClient = pubClient.duplicate()
    io.adapter(createAdapter(pubClient, subClient))
  }

  io.use(async (socket, next) => {
    const ip = socket.handshake.address ?? "unknown"
    if (!canAcceptHandshake(ip)) return next(new Error("Too many socket handshake attempts"))
    const token = parseHandshakeToken(socket)
    const user = await resolveUserFromToken(token)
    if (!user || !["ADMIN", "RECEPTIONIST", "USER", "STAFF"].includes(user.role)) return next(new Error("Forbidden"))
    socket.data.user = user
    return next()
  })

  io.on("connection", socket => {
    socket.join("staff:bookings")
    if (socket.data.user?.role === "ADMIN") socket.join("admin:bookings")
    if (socket.data.user?.role === "RECEPTIONIST") socket.join("reception:bookings")
    if (socket.data.user?.role === "STAFF") socket.join(`staff:${socket.data.user.id}:bookings`)
    if (socket.data.user?.role === "USER") socket.join(`user:${socket.data.user.id}:bookings`)
    // Notification center: every authenticated socket gets its own inbox room
    // plus its role's broadcast room, independent of which booking rooms it joined above.
    if (socket.data.user?.id) socket.join(`notify:user:${socket.data.user.id}`)
    if (socket.data.user?.role) socket.join(`notify:role:${socket.data.user.role}`)
    // Live queue: one anonymised snapshot serves every role, so every authenticated
    // socket joins the same room and the server serialises the payload once per tick
    // no matter how many clients are watching.
    socket.join(QUEUE_LIVE_ROOM)
    socket.on("booking.subscribe.v1", payload => {
      try {
        const decoded = hasEnvelopeCryptoEnabled() && payload?.encrypted ? decryptEnvelope(payload.encrypted) : payload
        if (decoded?.room) socket.join(decoded.room)
      } catch {
        // ignore malformed payload
      }
    })
  })
  ioRef = io
  return io
}

export function publishBookingEvent(eventName, payload) {
  // Every booking mutation funnels through here, which makes it the one place
  // that can keep the live-queue cache from serving a queue that no longer exists.
  markQueueMutated()
  if (!ioRef) return
  const body = hasEnvelopeCryptoEnabled() ? { encrypted: encryptEnvelope(payload) } : payload
  ioRef.to("staff:bookings").emit(eventName, body)
  ioRef.to("admin:bookings").emit(eventName, body)
  ioRef.to("reception:bookings").emit(eventName, body)
  ioRef.to("bookings:global").emit(eventName, body)
  if (payload?.stylistId) {
    ioRef.to(`staff:${payload.stylistId}:bookings`).emit(eventName, body)
  }
  if (payload?.createdBy) {
    ioRef.to(`user:${payload.createdBy}:bookings`).emit(eventName, body)
  }
}

export function publishServiceCatalogEvent(eventName, payload) {
  if (!ioRef) return
  const body = hasEnvelopeCryptoEnabled() ? { encrypted: encryptEnvelope(payload) } : payload
  ioRef.to("staff:bookings").emit(eventName, body)
  ioRef.to("admin:bookings").emit(eventName, body)
  ioRef.to("reception:bookings").emit(eventName, body)
  ioRef.to("bookings:global").emit(eventName, body)
}

export function publishPaymentEvent(eventName, payload) {
  if (!ioRef) return
  const body = hasEnvelopeCryptoEnabled() ? { encrypted: encryptEnvelope(payload) } : payload
  ioRef.to("admin:bookings").emit(eventName, body)
  ioRef.to("reception:bookings").emit(eventName, body)
}

export function publishOfferEvent(eventName, payload) {
  if (!ioRef) return
  const body = hasEnvelopeCryptoEnabled() ? { encrypted: encryptEnvelope(payload) } : payload
  ioRef.to("admin:bookings").emit(eventName, body)
  ioRef.to("reception:bookings").emit(eventName, body)
}

/**
 * Fans the anonymised live-queue snapshot out to every authenticated socket.
 *
 * With the Redis adapter attached this single call reaches sockets on every
 * instance, so the caller broadcasts once for the whole fleet rather than once
 * per process (see `broadcastQueueSnapshot`, which holds the fleet-wide slot).
 *
 * @param {object} board Public queue board payload
 */
export function publishQueueSnapshotEvent(board) {
  if (!ioRef || !board) return
  const body = hasEnvelopeCryptoEnabled() ? { encrypted: encryptEnvelope(board) } : board
  ioRef.to(QUEUE_LIVE_ROOM).emit(QUEUE_SNAPSHOT_EVENT, body)
}

/**
 * Pushes a single notification row to whoever should see it right now:
 * a specific user's inbox (`userId`), or an entire role's inbox (`role`)
 * for cases where every recipient already got their own persisted row
 * (see notifications/service.js `notifyRole`, which fans out per-user).
 */
export function publishNotificationEvent(notification) {
  if (!ioRef || !notification) return
  const body = hasEnvelopeCryptoEnabled() ? { encrypted: encryptEnvelope(notification) } : notification
  if (notification.userId) ioRef.to(`notify:user:${notification.userId}`).emit("notification.created.v1", body)
}

import { Server } from "socket.io"
import { createAdapter } from "@socket.io/redis-adapter"
import Redis from "ioredis"
import { verifyFirebaseToken } from "../lib/firebase-admin.js"
import { pool } from "../lib/db-pool.js"
import { verifyStaffAccessToken } from "../lib/tokens.js"
import { isSessionTokenLive } from "../middleware/auth.js"
import { QUEUE_LIVE_ROOM, QUEUE_SNAPSHOT_EVENT } from "../queue/constants.js"
import { getSocketClientIp } from "../lib/client-ip.js"
import { markQueueMutated } from "../queue/cache-hooks.js"
import { decryptEnvelope, encryptEnvelope, hasEnvelopeCryptoEnabled } from "../security/crypto-envelope.js"

let ioRef = null

/** Room for events that carry no personal data (e.g. service catalog changes). */
const PUBLIC_UPDATES_ROOM = "public:updates"
const handshakeWindowMs = Number(process.env.RATE_SOCKET_HANDSHAKE_WINDOW_MS ?? 60 * 1000)
const handshakeMax = Number(process.env.RATE_SOCKET_HANDSHAKE_MAX ?? 40)
const handshakeBuckets = new Map()

// Expired buckets are otherwise never removed, so the map grows by one entry per distinct IP forever.
setInterval(() => {
  const cutoff = Date.now() - handshakeWindowMs
  for (const [key, bucket] of handshakeBuckets) if (bucket.start < cutoff) handshakeBuckets.delete(key)
}, 60_000).unref()

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
        SELECT id, role, email, phone, staff_session_jti, app_session_epoch
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [staffPayload.sub]
    )
    const row = rows[0] ?? null
    // A staff cookie carries a session id; once it is replaced or revoked (new login, logout)
    // the old cookie must not keep a live socket either.
    if (row && !isSessionTokenLive(staffPayload, row)) return null
    return row
  } catch {
    try {
      const firebaseUser = await verifyFirebaseToken(token)
      const { rows } = await pool.query(
        `
          SELECT id, role, email, phone
          FROM users
          WHERE firebase_uid = $1 OR ($3::boolean AND lower(btrim(email)) = $2)
          ORDER BY updated_at DESC NULLS LAST
          LIMIT 1
        `,
        // E-mail only counts when Firebase verified the mailbox (see middleware/auth.js).
        [firebaseUser.uid, `${firebaseUser.email ?? ""}`.trim().toLowerCase(), firebaseUser.email_verified === true]
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
    const ip = getSocketClientIp(socket.handshake)
    if (!canAcceptHandshake(ip)) return next(new Error("Too many socket handshake attempts"))
    const token = parseHandshakeToken(socket)
    const user = await resolveUserFromToken(token)
    if (!user || !["ADMIN", "RECEPTIONIST", "USER", "STAFF"].includes(user.role)) return next(new Error("Forbidden"))
    socket.data.user = user
    return next()
  })

  io.on("connection", socket => {
    // Rooms are decided here, from the authenticated identity, and nowhere else. A client
    // must never choose its own rooms: room names are guessable (`admin:bookings`,
    // `user:<id>:bookings`, `notify:user:<id>`), so letting a socket join what it asks for
    // would hand every customer the admin feed and every other customer's inbox.
    const user = socket.data.user
    if (user?.role === "ADMIN") socket.join("admin:bookings")
    if (user?.role === "RECEPTIONIST") socket.join("reception:bookings")
    if (user?.role === "STAFF") socket.join(`staff:${user.id}:bookings`)
    if (user?.role === "USER") socket.join(`user:${user.id}:bookings`)
    // Notification center: the caller's own inbox only.
    if (user?.id) socket.join(`notify:user:${user.id}`)
    if (user?.role) socket.join(`notify:role:${user.role}`)
    // Non-personal broadcasts (service catalog changes) every signed-in role may see.
    socket.join(PUBLIC_UPDATES_ROOM)
    // Live queue: one anonymised snapshot serves every role, so every authenticated
    // socket joins the same room and the server serialises the payload once per tick
    // no matter how many clients are watching.
    socket.join(QUEUE_LIVE_ROOM)
    // Older clients still announce the room they want. It is accepted and ignored so they
    // keep working; membership above is the only thing that grants events.
    socket.on("booking.subscribe.v1", () => {})
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
  // Booking payloads carry customer name/email/phone and amounts, so they go only to the
  // people entitled to them: admin, reception, the assigned stylist and the booking's
  // own customer. A single `to(...)` with all rooms also delivers each event once per
  // socket even when a socket sits in more than one of them.
  const rooms = ["admin:bookings", "reception:bookings"]
  if (payload?.stylistId) rooms.push(`staff:${payload.stylistId}:bookings`)
  if (payload?.createdBy) rooms.push(`user:${payload.createdBy}:bookings`)
  ioRef.to(rooms).emit(eventName, body)
}

export function publishServiceCatalogEvent(eventName, payload) {
  if (!ioRef) return
  const body = hasEnvelopeCryptoEnabled() ? { encrypted: encryptEnvelope(payload) } : payload
  ioRef.to(PUBLIC_UPDATES_ROOM).emit(eventName, body)
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

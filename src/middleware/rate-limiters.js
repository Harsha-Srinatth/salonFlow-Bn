import rateLimit from "express-rate-limit"

/**
 * Shared factory: returns a standard JSON 429 body when the limiter trips.
 * Uses in-memory store by default; for multiple server instances, configure a shared store (Redis) per express-rate-limit docs.
 *
 * @param {import("express-rate-limit").Options} options express-rate-limit options
 * @returns {import("express").RequestHandler}
 */
function createLimiter(options) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    handler(req, res) {
      res.status(429).json({
        error: "TOO_MANY_REQUESTS",
        message: "Too many requests from this address. Please wait and try again.",
      })
    },
    ...options,
  })
}

/**
 * Brute-force / credential-stuffing throttle for customer + admin email login (`POST /api/auth/login`).
 * Keyed by IP; pairs with per-email lockout inside the handler after failures exceed threshold.
 */
export const loginRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_LOGIN_WINDOW_MS ?? 15 * 60 * 1000),
  limit: Number(process.env.RATE_LOGIN_MAX ?? 25),
})

/**
 * Same pattern as `loginRateLimit` for `POST /api/auth/staff/login` (isolated bucket so staff traffic does not starve customers).
 */
export const staffLoginRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_STAFF_LOGIN_WINDOW_MS ?? 15 * 60 * 1000),
  limit: Number(process.env.RATE_STAFF_LOGIN_MAX ?? 25),
})

/**
 * Limits `POST /api/auth/session` (Firebase token → DB user create/sync) to reduce automated fake signups.
 */
export const sessionSyncRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_SESSION_WINDOW_MS ?? 60 * 60 * 1000),
  limit: Number(process.env.RATE_SESSION_MAX ?? 60),
})

/**
 * Throttles `GET /api/auth/phone-exists` to slow phone enumeration during signup.
 */
export const phoneExistsRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_PHONE_EXISTS_WINDOW_MS ?? 60 * 60 * 1000),
  limit: Number(process.env.RATE_PHONE_EXISTS_MAX ?? 120),
})

/**
 * Throttles `GET /api/auth/email-exists`, the signup-step duplicate check.
 * Same intent as `phoneExistsRateLimit` — an unauthenticated yes/no on whether an
 * address is registered is an enumeration oracle, so it gets its own ceiling.
 */
export const emailExistsRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_EMAIL_EXISTS_WINDOW_MS ?? 60 * 60 * 1000),
  limit: Number(process.env.RATE_EMAIL_EXISTS_MAX ?? 120),
})

/**
 * Protects `POST /api/auth/complete-db-password-reset` (OOB verification + DB write + Firebase consume).
 */
export const passwordResetCompleteRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_PWRESET_COMPLETE_WINDOW_MS ?? 60 * 60 * 1000),
  limit: Number(process.env.RATE_PWRESET_COMPLETE_MAX ?? 10),
})

/**
 * Protects `POST /api/auth/request-password-reset` so attackers cannot spam Firebase outbound email.
 */
export const passwordResetRequestRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_PWRESET_REQUEST_WINDOW_MS ?? 60 * 60 * 1000),
  limit: Number(process.env.RATE_PWRESET_REQUEST_MAX ?? 5),
})

/**
 * Limits `POST /api/auth/staff/verify-firebase-phone` (Firebase ID token validation + setup JWT issuance).
 */
export const staffFirebaseVerifyRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_STAFF_FIREBASE_VERIFY_WINDOW_MS ?? 60 * 60 * 1000),
  limit: Number(process.env.RATE_STAFF_FIREBASE_VERIFY_MAX ?? 40),
})

/**
 * Limits `POST /api/auth/staff/set-password` (setup JWT → bcrypt write).
 */
export const staffSetPasswordRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_STAFF_SETPW_WINDOW_MS ?? 60 * 60 * 1000),
  limit: Number(process.env.RATE_STAFF_SETPW_MAX ?? 20),
})

/**
 * Throttles `GET /api/admin/bookings` list/filter endpoint.
 */
export const adminBookingsListRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_ADMIN_BOOKINGS_LIST_WINDOW_MS ?? 60 * 1000),
  limit: Number(process.env.RATE_ADMIN_BOOKINGS_LIST_MAX ?? 180),
})

/**
 * Throttles `PATCH /api/admin/bookings/:id/status` mutation endpoint.
 */
export const adminBookingsUpdateRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_ADMIN_BOOKINGS_UPDATE_WINDOW_MS ?? 60 * 1000),
  limit: Number(process.env.RATE_ADMIN_BOOKINGS_UPDATE_MAX ?? 90),
})

export const receptionBookingsListRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_RECEPTION_BOOKINGS_LIST_WINDOW_MS ?? 60 * 1000),
  limit: Number(process.env.RATE_RECEPTION_BOOKINGS_LIST_MAX ?? 180),
})

export const receptionBookingsCreateRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_RECEPTION_BOOKINGS_CREATE_WINDOW_MS ?? 60 * 1000),
  limit: Number(process.env.RATE_RECEPTION_BOOKINGS_CREATE_MAX ?? 90),
})

/**
 * Guards the live queue endpoints (`/queue/live`, `/queue/me`).
 *
 * These are cache-backed and cheap, and clients are expected to hold a websocket
 * rather than poll — the ceiling is deliberately generous so a genuine burst
 * (everyone opening the app at once) is served, while a client stuck in a tight
 * polling loop is still capped instead of multiplying across a million users.
 */
export const queueLiveRateLimit = createLimiter({
  windowMs: Number(process.env.RATE_QUEUE_LIVE_WINDOW_MS ?? 60 * 1000),
  limit: Number(process.env.RATE_QUEUE_LIVE_MAX ?? 240),
})

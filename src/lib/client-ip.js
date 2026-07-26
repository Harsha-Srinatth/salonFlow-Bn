/**
 * Best-effort client IP for rate limiting and audit logs.
 * When the app runs behind a reverse proxy, set `app.set("trust proxy", n)` in server.js so `req.ip` reflects X-Forwarded-For.
 * We prefer `req.ip` (Express-normalized) and fall back to socket remote address for bare Node tests.
 *
 * @param {import("express").Request} req
 * @returns {string}
 */
export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"]
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim()
  }
  if (req.ip) return req.ip
  return req.socket?.remoteAddress ?? "unknown"
}

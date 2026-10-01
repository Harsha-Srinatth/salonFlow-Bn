/**
 * Client IP for rate limiting, lockout and audit logs.
 *
 * Uses Express's `req.ip` only. `X-Forwarded-For` is a header the *client* can set to
 * anything; reading its first value (as this used to) let an attacker pick a fresh "IP"
 * per request and walk straight past the login lockout. With `app.set("trust proxy", n)`
 * (see TRUST_PROXY in server.js) Express resolves the real client from the proxy chain
 * and ignores whatever the client claimed.
 *
 * @param {import("express").Request} req
 * @returns {string}
 */
export function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown"
}

/**
 * Same idea for socket handshakes, which have no Express `req.ip`: honour
 * `X-Forwarded-For` only when a trusted proxy is configured, and take the LAST entry
 * (the hop our own proxy appended), never the first (client-supplied).
 *
 * @param {import("socket.io").Socket["handshake"]} handshake
 * @returns {string}
 */
export function getSocketClientIp(handshake) {
  const trusted = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true"
  const forwarded = handshake?.headers?.["x-forwarded-for"]
  if (trusted && typeof forwarded === "string" && forwarded.length > 0) {
    const hops = forwarded.split(",").map(part => part.trim()).filter(Boolean)
    if (hops.length) return hops[hops.length - 1]
  }
  return handshake?.address ?? "unknown"
}

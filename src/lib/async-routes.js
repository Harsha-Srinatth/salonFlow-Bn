import Layer from "express/lib/router/layer.js"

/**
 * Express 4 does not look at the promise an async route handler returns, so a
 * rejection (a bad UUID reaching Postgres, a dropped connection, ...) becomes an
 * unhandled rejection and Node exits. This forwards those rejections to `next(err)`
 * so the central error handler answers the request and the process stays up.
 *
 * Applied once, process-wide, to the router Layer; no per-route changes needed.
 * Error-handling middleware (4 args) is left untouched.
 */
const original = Layer.prototype.handle_request

Layer.prototype.handle_request = function handleRequest(req, res, next) {
  const fn = this.handle
  if (fn.length > 3) return next()
  try {
    const result = fn(req, res, next)
    if (result && typeof result.catch === "function") result.catch(next)
  } catch (error) {
    next(error)
  }
}

export const asyncRoutesPatched = original !== Layer.prototype.handle_request

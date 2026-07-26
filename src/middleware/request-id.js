import { randomUUID } from "node:crypto"

export function attachRequestId(req, res, next) {
  const requestId = req.headers["x-request-id"] || randomUUID()
  req.requestId = requestId
  res.setHeader("x-request-id", requestId)
  next()
}
import { encryptEnvelope, hasEnvelopeCryptoEnabled } from "../security/crypto-envelope.js"
import { getMyQueueStatus, getOperationalQueueBoard, getPublicQueueBoard } from "./service.js"

function isEncryptedRequest(req) {
  return `${req.headers["x-payload-encrypted"] ?? ""}`.toLowerCase() === "1"
}

function sendPayload(req, res, statusCode, value) {
  if (!isEncryptedRequest(req) || !hasEnvelopeCryptoEnabled()) return res.status(statusCode).json(value)
  return res.status(statusCode).json({ encrypted: encryptEnvelope(value) })
}

/**
 * Anonymised salon-wide board. Read-only, cache-backed and identical for every
 * caller, so it is also the payload pushed over websockets — a client that has a
 * live socket never needs to call this more than once.
 */
export async function getLiveQueueBoardController(req, res) {
  try {
    const board = await getPublicQueueBoard()
    return sendPayload(req, res, 200, board)
  } catch (error) {
    console.error("Failed to load live queue board", error)
    return sendPayload(req, res, 500, { error: "Could not load the live queue" })
  }
}

/** The signed-in customer's own position, ticket and estimated start time. */
export async function getMyQueuePositionController(req, res) {
  try {
    const status = await getMyQueueStatus({ appUser: req.appUser })
    return sendPayload(req, res, 200, status)
  } catch (error) {
    console.error("Failed to load customer queue position", error)
    return sendPayload(req, res, 500, { error: "Could not load your queue position" })
  }
}

/** Timing overlay for reception, admin and stylists (scoped to own lane for STAFF). */
export async function getOperationalQueueBoardController(req, res) {
  try {
    const board = await getOperationalQueueBoard({
      role: req.appUser.role,
      userId: req.appUser.id,
    })
    return sendPayload(req, res, 200, board)
  } catch (error) {
    console.error("Failed to load operational queue board", error)
    return sendPayload(req, res, 500, { error: "Could not load the queue board" })
  }
}

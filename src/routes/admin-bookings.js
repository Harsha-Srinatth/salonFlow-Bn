import express from "express"
import { listBookingsController, updateBookingStatusController } from "../bookings/controller.js"
import { ensureBookingsSchema } from "../bookings/schema-init.js"
import { adminBookingsListRateLimit, adminBookingsUpdateRateLimit } from "../middleware/rate-limiters.js"
import { publishBookingEvent } from "../realtime/socket-gateway.js"

const router = express.Router()

router.use(async (_req, _res, next) => {
  try {
    await ensureBookingsSchema()
    next()
  } catch (error) {
    next(error)
  }
})

router.get("/", adminBookingsListRateLimit, listBookingsController)
router.patch("/:id/status", adminBookingsUpdateRateLimit, (req, res) =>
  updateBookingStatusController(req, res, { publishEvent: publishBookingEvent })
)

export default router

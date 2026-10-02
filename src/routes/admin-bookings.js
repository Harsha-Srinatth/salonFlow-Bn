import express from "express"
import { getReceptionCancellationPreviewController, listBookingsController, updateBookingStatusController } from "../bookings/controller.js"
import { ensureBookingsSchema } from "../bookings/schema-init.js"
import { adminBookingsListRateLimit, adminBookingsUpdateRateLimit } from "../middleware/rate-limiters.js"
import { publishBookingEvent, publishPaymentEvent } from "../realtime/socket-gateway.js"

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
// Same preview the reception desk uses: what is held, the policy suggestion, and the refund choices.
router.get("/:id/cancellation-preview", adminBookingsListRateLimit, getReceptionCancellationPreviewController)
router.patch("/:id/status", adminBookingsUpdateRateLimit, (req, res) =>
  updateBookingStatusController(req, res, { publishEvent: publishBookingEvent, publishPaymentEvent })
)

export default router

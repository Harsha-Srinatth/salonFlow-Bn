import express from "express"
import {
  completeStylistBookingController,
  downloadBookingInvoiceController,
  listQueueController,
  startStylistBookingController,
} from "../bookings/controller.js"
import { ensureBookingsSchema } from "../bookings/schema-init.js"
import { requireAppRole, requireStaffSessionAuth } from "../middleware/auth.js"
import { publishBookingEvent } from "../realtime/socket-gateway.js"

const router = express.Router()

router.use(requireStaffSessionAuth, requireAppRole("STAFF"))
router.use(async (_req, _res, next) => {
  try {
    await ensureBookingsSchema()
    next()
  } catch (error) {
    next(error)
  }
})

router.get("/queue", (req, res) => listQueueController(req, res, { publishEvent: publishBookingEvent }))
router.get("/bookings/:id/invoice.pdf", downloadBookingInvoiceController)
router.post("/bookings/:id/start", (req, res) => startStylistBookingController(req, res, { publishEvent: publishBookingEvent }))
router.post("/bookings/:id/complete", (req, res) =>
  completeStylistBookingController(req, res, { publishEvent: publishBookingEvent })
)

export default router

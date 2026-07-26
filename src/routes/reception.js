import express from "express"
import {
  createReceptionPaymentController,
  createReceptionBookingController,
  downloadBookingInvoiceController,
  listAvailableSlotsController,
  listBookingsController,
  listBookableServicesController,
  listQueueController,
  lookupReceptionCustomerController,
  listReceptionOffersController,
  listReceptionStylistsController,
  updateReceptionBookingController,
} from "../bookings/controller.js"
import { ensureBookingsSchema } from "../bookings/schema-init.js"
import { ensureMembershipSchema } from "../membership/service.js"
import { ensureOfferSchema } from "../offers/service.js"
import { requireAppRole, requireStaffSessionAuth } from "../middleware/auth.js"
import { receptionBookingsCreateRateLimit, receptionBookingsListRateLimit } from "../middleware/rate-limiters.js"
import { publishBookingEvent } from "../realtime/socket-gateway.js"
import { publishPaymentEvent } from "../realtime/socket-gateway.js"

const router = express.Router()

router.use(requireStaffSessionAuth, requireAppRole("RECEPTIONIST"))
router.use(async (_req, _res, next) => {
  try {
    await ensureBookingsSchema()
    await ensureOfferSchema()
    await ensureMembershipSchema()
    next()
  } catch (error) {
    next(error)
  }
})

router.get("/bookings", receptionBookingsListRateLimit, listBookingsController)
router.post("/bookings", receptionBookingsCreateRateLimit, (req, res) =>
  createReceptionBookingController(req, res, {
    publishEvent: publishBookingEvent,
    publishPaymentEvent,
  })
)
router.get("/stylists", receptionBookingsListRateLimit, listReceptionStylistsController)
router.get("/customers/lookup", receptionBookingsListRateLimit, lookupReceptionCustomerController)
router.get("/offers", receptionBookingsListRateLimit, listReceptionOffersController)
router.get("/services", receptionBookingsListRateLimit, listBookableServicesController)
router.get("/slots", receptionBookingsListRateLimit, listAvailableSlotsController)
router.get("/queue", receptionBookingsListRateLimit, listQueueController)
router.patch("/bookings/:id", receptionBookingsCreateRateLimit, (req, res) =>
  updateReceptionBookingController(req, res, { publishEvent: publishBookingEvent })
)
router.post("/payments", receptionBookingsCreateRateLimit, (req, res) =>
  createReceptionPaymentController(req, res, { publishPaymentEvent })
)
router.get("/bookings/:id/invoice.pdf", receptionBookingsListRateLimit, downloadBookingInvoiceController)

export default router

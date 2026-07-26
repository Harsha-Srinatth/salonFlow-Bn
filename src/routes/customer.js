import express from "express"
import { ensureMembershipSchema, getCustomerMembershipView } from "../membership/service.js"
import {
  ensureOfferSchema,
  getCustomerOffersForUser,
  getMembershipSegmentForUser,
} from "../offers/service.js"
import {
  createCustomerBookingController,
  cancelCustomerBookingController,
  getCustomerCancellationPreviewController,
  removeCustomerBookingFromHistoryController,
  downloadBookingInvoiceController,
  listAvailableSlotsController,
  listBookableServicesController,
  listCustomerBookingsController,
  listQueueController,
  listRecommendedStylistsController,
  listReceptionStylistsController,
} from "../bookings/controller.js"
import { ensureBookingsSchema } from "../bookings/schema-init.js"
import { requireAppRole, requireFirebaseAuth } from "../middleware/auth.js"
import { publishBookingEvent, publishPaymentEvent } from "../realtime/socket-gateway.js"

const router = express.Router()

router.use(requireFirebaseAuth, requireAppRole("USER"))
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

router.get("/bookings", (req, res) => listCustomerBookingsController(req, res, { publishEvent: publishBookingEvent }))
router.post("/bookings", (req, res) =>
  createCustomerBookingController(req, res, {
    publishEvent: publishBookingEvent,
    publishPaymentEvent,
  })
)
router.get("/bookings/:id/cancellation-preview", getCustomerCancellationPreviewController)
router.post("/bookings/:id/cancel", (req, res) =>
  cancelCustomerBookingController(req, res, {
    publishEvent: publishBookingEvent,
    publishPaymentEvent,
  })
)
router.delete("/bookings/:id", (req, res) =>
  removeCustomerBookingFromHistoryController(req, res, { publishEvent: publishBookingEvent })
)
router.get("/stylists", listReceptionStylistsController)
router.get("/services", listBookableServicesController)
router.get("/offers", async (req, res) => {
  try {
    const segment = req.appUser?.membershipSegment ?? (await getMembershipSegmentForUser(req.appUser?.id))
    const offers = await getCustomerOffersForUser({ membershipSegment: segment })
    return res.json(offers)
  } catch (error) {
    console.error("Failed to load customer offers", error)
    return res.status(500).json({ error: "Could not load offers" })
  }
})
router.get("/membership", async (req, res) => {
  try {
    const segment = req.appUser?.membershipSegment ?? (await getMembershipSegmentForUser(req.appUser?.id))
    const membership = await getCustomerMembershipView({ membershipSegment: segment })
    return res.json(membership)
  } catch (error) {
    console.error("Failed to load customer membership", error)
    return res.status(500).json({ error: "Could not load membership" })
  }
})
router.get("/stylists/recommendations", listRecommendedStylistsController)
router.get("/slots", listAvailableSlotsController)
router.get("/queue", listQueueController)
router.get("/bookings/:id/invoice.pdf", downloadBookingInvoiceController)

export default router

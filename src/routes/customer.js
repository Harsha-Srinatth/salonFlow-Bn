import express from "express"
import { pool } from "../lib/db-pool.js"
import { parseSelectableGender } from "../lib/gender.js"
import { isValidFullName, normalizeName, parseDateOfBirth } from "../lib/validation.js"
import { USER_PROFILE_COLUMNS, toAppUserDto } from "../lib/user-dto.js"
import { ensureMembershipSchema, getCustomerMembershipView } from "../membership/service.js"
import {
  ensureOfferSchema,
  getCustomerOffersForUser,
  getMembershipSegmentForUser,
} from "../offers/service.js"
import { createCustomerFeedback, ensureFeedbackSchema, listCustomerFeedback } from "../feedback/service.js"
import { drawRewardCard, ensureLoyaltySchema, getCustomerLoyaltyOverview, getCustomerRewardVault } from "../loyalty/service.js"
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
import { ensureUserProfileSchema } from "../auth/schema-init.js"
import { getLiveQueueBoardController, getMyQueuePositionController } from "../queue/controller.js"
import { ensureQueueSchema } from "../queue/schema-init.js"
import { requireAppRole, requireFirebaseAuth } from "../middleware/auth.js"
import { queueLiveRateLimit } from "../middleware/rate-limiters.js"
import { publishBookingEvent, publishPaymentEvent } from "../realtime/socket-gateway.js"

const router = express.Router()

router.use(requireFirebaseAuth, requireAppRole("USER"))
router.use(async (_req, _res, next) => {
  try {
    await ensureUserProfileSchema()
    await ensureBookingsSchema()
    await ensureOfferSchema()
    await ensureMembershipSchema()
    await ensureFeedbackSchema()
    await ensureLoyaltySchema()
    await ensureQueueSchema()
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
router.get("/queue/live", queueLiveRateLimit, getLiveQueueBoardController)
router.get("/queue/me", queueLiveRateLimit, getMyQueuePositionController)
router.get("/bookings/:id/invoice.pdf", downloadBookingInvoiceController)

router.get("/feedback", async (req, res) => {
  try {
    const feedback = await listCustomerFeedback(req.appUser)
    return res.json({ feedback })
  } catch (error) {
    console.error("Failed to load customer feedback", error)
    return res.status(500).json({ error: "Could not load feedback" })
  }
})
router.post("/bookings/:id/feedback", async (req, res) => {
  try {
    const feedback = await createCustomerFeedback({
      bookingId: `${req.params.id ?? ""}`.trim(),
      actorUser: req.appUser,
      rating: req.body?.rating,
      comment: req.body?.comment,
      type: req.body?.type,
    })
    return res.status(201).json({ feedback })
  } catch (error) {
    if (error?.code === "FORBIDDEN") return res.status(403).json({ error: error.message })
    if (error?.code === "NOT_FOUND") return res.status(404).json({ error: error.message })
    if (error?.code === "BAD_REQUEST") return res.status(400).json({ error: error.message })
    console.error("Failed to create customer feedback", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

/**
 * PATCH /api/customer/profile — partial update of name, gender and date of birth.
 *
 * Partial by design: the reward-vault prompt sends only `gender`, the profile
 * editor sends all three, and a field that isn't in the body is left alone
 * rather than being cleared. Email and phone are excluded — both are verified
 * identity, tied to the Firebase account, and are not editable here.
 */
router.patch("/profile", async (req, res) => {
  try {
    const updates = []
    const values = []

    if (req.body?.name !== undefined) {
      const name = normalizeName(req.body.name)
      if (!isValidFullName(name)) {
        return res.status(400).json({ error: "Enter your full name (first and last, letters only)." })
      }
      values.push(name)
      updates.push(`name = $${values.length}`)
    }

    if (req.body?.gender !== undefined) {
      const gender = parseSelectableGender(req.body.gender)
      if (!gender) return res.status(400).json({ error: "Select Male, Female or Other" })
      values.push(gender)
      updates.push(`gender = $${values.length}`)
    }

    if (req.body?.dateOfBirth !== undefined) {
      // Empty string is an explicit "clear it", distinct from omitting the key.
      const raw = `${req.body.dateOfBirth ?? ""}`.trim()
      if (!raw) {
        updates.push(`date_of_birth = NULL`)
      } else {
        const dateOfBirth = parseDateOfBirth(raw)
        if (!dateOfBirth) {
          return res.status(400).json({ error: "Enter a real date of birth that isn't in the future." })
        }
        values.push(dateOfBirth)
        updates.push(`date_of_birth = $${values.length}`)
      }
    }

    if (!updates.length) return res.status(400).json({ error: "Nothing to update" })

    values.push(req.appUser.id)
    const { rows } = await pool.query(
      `
        UPDATE users
        SET ${updates.join(", ")}, updated_at = NOW()
        WHERE id = $${values.length}
        RETURNING ${USER_PROFILE_COLUMNS}
      `,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: "Account not found" })
    return res.json({ user: toAppUserDto(rows[0]) })
  } catch (error) {
    console.error("Failed to update customer profile", error)
    return res.status(500).json({ error: "Could not save your profile" })
  }
})

router.get("/loyalty", async (req, res) => {
  try {
    const overview = await getCustomerLoyaltyOverview(req.appUser.id)
    return res.json(overview)
  } catch (error) {
    console.error("Failed to load customer loyalty overview", error)
    return res.status(500).json({ error: "Could not load your rewards" })
  }
})
router.get("/loyalty/vault", async (req, res) => {
  try {
    const vault = await getCustomerRewardVault({ userId: req.appUser.id, gender: req.appUser.gender })
    return res.json(vault)
  } catch (error) {
    console.error("Failed to load reward vault", error)
    return res.status(500).json({ error: "Could not load your reward vault" })
  }
})
router.post("/loyalty/vault/draw", async (req, res) => {
  try {
    const result = await drawRewardCard({
      userId: req.appUser.id,
      referralId: `${req.body?.referralId ?? ""}`.trim(),
      gender: req.appUser.gender,
    })
    return res.status(201).json(result)
  } catch (error) {
    if (error?.message === "GENDER_REQUIRED") {
      return res.status(400).json({
        error: "Add your gender to your profile first, so your reward matches the services you can book.",
        code: "GENDER_REQUIRED",
      })
    }
    if (error?.code === "BAD_REQUEST") return res.status(400).json({ error: error.message })
    if (error?.code === "NOT_FOUND") return res.status(404).json({ error: error.message })
    console.error("Failed to draw reward card", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

export default router

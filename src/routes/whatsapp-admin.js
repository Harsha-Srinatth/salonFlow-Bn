/**
 * Admin WhatsApp endpoints, mounted under `/api/admin/whatsapp` (admin auth is applied by
 * the parent router). Promotions only go to customers who opted in; see whatsapp/campaigns.js.
 */
import express from "express"
import { rejectMalformedId } from "../lib/validation.js"
import { createOfferCampaign, getCampaignStats, listCampaigns, previewOfferAudience } from "../whatsapp/campaigns.js"
import { describeWhatsAppConfig, validateWhatsAppConfig, whatsappConfig } from "../whatsapp/config.js"
import { otpDeliveryMode } from "../whatsapp/otp.js"
import { budgetReport } from "../whatsapp/budget.js"
import { ensureWhatsAppSchema } from "../whatsapp/schema-init.js"

const router = express.Router()
router.param("id", rejectMalformedId)

function sendError(res, error, label) {
  const status = Number(error?.status)
  if (status >= 400 && status < 600 && error?.expose) return res.status(status).json({ error: error.message })
  console.error(label, error)
  return res.status(500).json({ error: "Internal server error" })
}

/** Which WhatsApp features are switched on (presence of values only, never the values). */
router.get("/status", async (_req, res) => {
  const config = whatsappConfig()
  let usageThisMonth = null
  try {
    await ensureWhatsAppSchema()
    usageThisMonth = await budgetReport(config)
  } catch (error) {
    console.error("whatsapp_budget_report_failed", { error: error?.message })
  }
  res.json({ ...describeWhatsAppConfig(config), otpDelivery: otpDeliveryMode(config), problems: validateWhatsAppConfig(config), usageThisMonth })
})

router.get("/campaigns", async (req, res) => {
  try {
    return res.json({ campaigns: await listCampaigns({ limit: req.query.limit }) })
  } catch (error) {
    return sendError(res, error, "whatsapp_campaigns_list_failed")
  }
})

router.get("/campaigns/:id", async (req, res) => {
  try {
    return res.json(await getCampaignStats(`${req.params.id}`))
  } catch (error) {
    if (error?.code === "22P02") return res.status(404).json({ error: "Campaign not found" })
    return sendError(res, error, "whatsapp_campaign_stats_failed")
  }
})

/** How many opted-in customers an offer would reach, and the exact text they would get. */
router.get("/campaigns-preview", async (req, res) => {
  try {
    return res.json(await previewOfferAudience({ offerType: req.query.offerType, offerId: req.query.offerId }))
  } catch (error) {
    return sendError(res, error, "whatsapp_campaign_preview_failed")
  }
})

/** Body: { offerType: GLOBAL|SERVICE|MEMBERSHIP|COMBO, offerId, idempotencyKey } */
router.post("/campaigns", async (req, res) => {
  try {
    const result = await createOfferCampaign({
      offerType: req.body?.offerType,
      offerId: req.body?.offerId,
      idempotencyKey: req.body?.idempotencyKey ?? req.headers["idempotency-key"],
      actorUserId: req.appUser.id,
    })
    return res.status(result.duplicateRequest ? 200 : 201).json(result)
  } catch (error) {
    return sendError(res, error, "whatsapp_campaign_create_failed")
  }
})

export default router

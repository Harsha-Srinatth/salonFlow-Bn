import express from "express"
import { pool } from "../lib/db-pool.js"
import { rejectMalformedId } from "../lib/validation.js"
import { emailConfig } from "../email/config.js"
import {
  cancelCampaign,
  createCampaign,
  listCampaigns,
  previewAudience,
  sendCampaign,
  sendCampaignTest,
} from "../email/marketing.js"
import { ensureEmailSchema } from "../email/schema.js"
import { readSesAccount } from "../email/ses-provider.js"

/** Admin view of email health and promotional campaigns. Mounted behind the ADMIN guard. */
const router = express.Router()

router.param("id", rejectMalformedId)
router.use(async (_req, _res, next) => {
  try {
    await ensureEmailSchema()
    next()
  } catch (error) {
    next(error)
  }
})

/** Delivery and reputation at a glance. SES pauses accounts over about 10 % bounces or 0.5 % complaints. */
router.get("/overview", async (_req, res) => {
  const config = emailConfig()
  const [{ rows: stats }, { rows: suppressions }, { rows: consent }, ses] = await Promise.all([
    pool.query(`
      SELECT COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
             COUNT(delivered_at)::int AS delivered,
             COUNT(bounced_at)::int AS bounced,
             COUNT(complained_at)::int AS complained,
             COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
             COUNT(*) FILTER (WHERE status IN ('PENDING', 'SENDING') AND next_attempt_at <= NOW())::int AS due
        FROM email_messages
       WHERE created_at >= NOW() - interval '30 days'
    `),
    pool.query(`SELECT reason, COUNT(*)::int AS total FROM email_suppressions GROUP BY reason`),
    pool.query(`SELECT COUNT(*)::int AS total FROM users WHERE marketing_email_consent = TRUE`),
    readSesAccount(config),
  ])
  res.json({
    flags: {
      sendingEnabled: config.enabled,
      remindersEnabled: config.remindersEnabled,
      marketingEnabled: config.marketingEnabled,
      restrictedToAllowlist: config.recipientAllowlist.length > 0,
    },
    last30Days: stats[0],
    suppressions: Object.fromEntries(suppressions.map(row => [row.reason, row.total])),
    marketingConsents: consent[0].total,
    ses,
  })
})

router.get("/campaigns", async (_req, res) => {
  res.json({ campaigns: await listCampaigns() })
})

router.post("/campaigns/audience", async (req, res) => {
  res.json(await previewAudience(req.body?.audience))
})

router.post("/campaigns", async (req, res) => {
  res.status(201).json({ campaign: await createCampaign(req.body, req.appUser.id) })
})

router.post("/campaigns/:id/test", async (req, res) => {
  res.json(await sendCampaignTest(req.params.id, req.appUser))
})

router.post("/campaigns/:id/send", async (req, res) => {
  res.json(await sendCampaign(req.params.id))
})

router.post("/campaigns/:id/cancel", async (req, res) => {
  res.json(await cancelCampaign(req.params.id))
})

export default router

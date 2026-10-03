import express from "express"
import { ensureAgentSchema } from "../agents/agent-log.js"
import { isLlmConfigured } from "../agents/llm.js"
import { runConversationalAgent } from "../agents/runner.js"
import { ensureBookingsSchema } from "../bookings/schema-init.js"
import { ensureBusinessSchema } from "../business/service.js"
import { attachOptionalAppUser } from "../middleware/auth.js"
import { assistantBurstRateLimit, assistantDailyRateLimit, assistantIpRateLimit } from "../middleware/rate-limiters.js"
import { ensureOfferSchema } from "../offers/service.js"

/**
 * Customer/visitor support assistant. Works signed in or not: guests get public business data,
 * signed-in customers additionally their own bookings (decided server-side from the session).
 */
const router = express.Router()

router.use(async (_req, _res, next) => {
  try {
    await ensureBookingsSchema()
    await ensureOfferSchema()
    await ensureBusinessSchema()
    await ensureAgentSchema()
    next()
  } catch (error) {
    next(error)
  }
})

router.get("/status", (_req, res) => {
  res.json({ available: true, mode: isLlmConfigured() ? "ai" : "basic" })
})

router.post("/chat", assistantIpRateLimit, attachOptionalAppUser, assistantBurstRateLimit, assistantDailyRateLimit, async (req, res) => {
  const result = await runConversationalAgent({
    agentId: "support-assistant",
    appUser: req.appUser,
    conversation: req.body?.messages,
  })
  res.set("Cache-Control", "no-store")
  res.json(result)
})

export default router

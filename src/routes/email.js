import express from "express"
import { unsubscribeRateLimit } from "../middleware/rate-limiters.js"
import { ensureEmailSchema } from "../email/schema.js"
import { unsubscribeWithToken } from "../email/marketing.js"

/**
 * Public email endpoints. Unsubscribing works without signing in: the signed token in the email
 * is the authority, and it can do nothing except turn promotional mail off.
 *
 * Mail providers POST here for one-click unsubscribe (RFC 8058) with the token in the query
 * string; the website's unsubscribe page POSTs it in the body.
 */
const router = express.Router()

router.post("/unsubscribe", unsubscribeRateLimit, express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
  await ensureEmailSchema()
  const fromHeaderLink = typeof req.query.token === "string" ? req.query.token : null
  const done = await unsubscribeWithToken(fromHeaderLink ?? req.body?.token, fromHeaderLink ? "one_click" : "unsubscribe_page")
  if (!done) return res.status(400).json({ error: "This unsubscribe link is not valid." })
  return res.json({ ok: true })
})

export default router

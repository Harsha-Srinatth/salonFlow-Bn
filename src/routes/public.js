import express from "express"
import { ensureBusinessSchema, getPublicBusinessInfo } from "../business/service.js"
import { getLegalDocument } from "../legal/service.js"
import { publicInfoRateLimit } from "../middleware/rate-limiters.js"

/** Unauthenticated, read-only endpoints for the public landing page. Nothing here is private. */
const router = express.Router()

router.get("/business", publicInfoRateLimit, async (_req, res) => {
  await ensureBusinessSchema()
  const info = await getPublicBusinessInfo()
  // Shared caches may hold it briefly; an admin edit shows up on the site within about a minute.
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
  res.json({ profile: info.profile, hours: info.hours, cancellationPolicy: info.cancellationPolicy })
})

// The salon's Privacy Policy and Terms & Conditions (/privacy, /terms on the website).
router.get("/legal/:slug", publicInfoRateLimit, async (req, res) => {
  try {
    const document = await getLegalDocument(`${req.params.slug ?? ""}`)
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600")
    res.json({ document })
  } catch (error) {
    if (error?.code === "NOT_FOUND") return res.status(404).json({ error: "Not found" })
    throw error
  }
})

export default router

import express from "express"
import { requireAnyAppRole, requireFirebaseAuth } from "../middleware/auth.js"
import {
  ensureNotificationsSchema,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../notifications/service.js"

const router = express.Router()

router.use(requireFirebaseAuth, requireAnyAppRole(["ADMIN", "RECEPTIONIST", "STAFF", "USER"]))
router.use(async (_req, _res, next) => {
  try {
    await ensureNotificationsSchema()
    next()
  } catch (error) {
    next(error)
  }
})

router.get("/", async (req, res) => {
  try {
    const notifications = await listNotifications({
      userId: req.appUser.id,
      limit: req.query.limit,
      offset: req.query.offset,
      unreadOnly: `${req.query.unreadOnly ?? ""}`.toLowerCase() === "true",
    })
    return res.json({ notifications })
  } catch (error) {
    console.error("Failed to load notifications", error)
    return res.status(500).json({ error: "Could not load notifications" })
  }
})

router.get("/unread-count", async (req, res) => {
  try {
    const count = await getUnreadCount(req.appUser.id)
    return res.json({ count })
  } catch (error) {
    console.error("Failed to load unread notification count", error)
    return res.status(500).json({ error: "Could not load unread count" })
  }
})

router.patch("/:id/read", async (req, res) => {
  try {
    const notification = await markNotificationRead({
      notificationId: `${req.params.id ?? ""}`.trim(),
      userId: req.appUser.id,
    })
    return res.json({ notification })
  } catch (error) {
    if (error?.code === "NOT_FOUND") return res.status(404).json({ error: error.message })
    console.error("Failed to mark notification read", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

router.post("/read-all", async (req, res) => {
  try {
    const result = await markAllNotificationsRead(req.appUser.id)
    return res.json(result)
  } catch (error) {
    console.error("Failed to mark all notifications read", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

export default router

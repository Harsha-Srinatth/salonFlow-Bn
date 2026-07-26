import express from "express"
import { listSalons } from "../lib/store.js"

const router = express.Router()

router.get("/salons", (_req, res) => {
  res.json({ salons: listSalons() })
})

export default router

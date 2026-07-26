import express from "express"
import { v4 as uuid } from "uuid"
import {
  createStaffLeaveController,
  createAdminServiceController,
  downloadBookingInvoiceController,
  getPayrollPolicyController,
  getAdminRevenueReportController,
  listAdminServicesController,
  listMonthlyDeductionsController,
  listQueueController,
  upsertStaffShiftController,
  updatePayrollPolicyController,
  updateAdminServiceController,
  updateAdminServiceDiscountsController,
  uploadAdminServiceImageController,
} from "../bookings/controller.js"
import { ensureBookingsSchema } from "../bookings/schema-init.js"
import { pool } from "../lib/db-pool.js"
import { requireAppRole, requireFirebaseAuth } from "../middleware/auth.js"
import { ensureOfferSchema, createComboOffer, createMembershipDiscount, createServiceDiscount, deleteOfferByType, getOfferCenterData, listOfferCalendarEvents, previewOffers, updateOfferByType, upsertGlobalDiscount } from "../offers/service.js"
import { ensureMembershipSchema, getAdminMembershipCenter, upsertMembershipPlan } from "../membership/service.js"
import { publishOfferEvent, publishServiceCatalogEvent } from "../realtime/socket-gateway.js"
import adminBookingRoutes from "./admin-bookings.js"

const router = express.Router()
const OFFER_SEGMENTS = ["FREE", "BASIC", "PREMIUM"]

function isValidFullName(name) {
  const normalized = `${name ?? ""}`.trim().replace(/\s+/g, " ")
  if (normalized.length < 4) return false
  const tokens = normalized.split(" ")
  if (tokens.length < 2) return false
  if (!/^[A-Za-z][A-Za-z\s'.-]+$/.test(normalized)) return false
  const lettersOnly = normalized.replace(/[^A-Za-z]/g, "").toLowerCase()
  if (lettersOnly.length < 4) return false
  let maxRun = 1
  let run = 1
  for (let i = 1; i < lettersOnly.length; i += 1) {
    run = lettersOnly[i] === lettersOnly[i - 1] ? run + 1 : 1
    if (run > maxRun) maxRun = run
  }
  if (maxRun >= 4) return false
  return new Set(lettersOnly).size > 3
}

function normalizeGender(gender) {
  const value = `${gender ?? ""}`.trim().toUpperCase()
  if (["MALE", "FEMALE", "OTHER"].includes(value)) return value
  return null
}

function normalizeStylistGenderType(value) {
  const normalized = `${value ?? ""}`.trim().toUpperCase()
  if (!normalized) return null
  if (["MEN", "WOMEN", "UNISEX"].includes(normalized)) return normalized
  return null
}

function normalizeAllowedServiceIds(value) {
  const list = Array.isArray(value) ? value : []
  const ids = list.map(item => `${item ?? ""}`.trim().toLowerCase()).filter(Boolean)
  const uuidLike = ids.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
  return Array.from(new Set(uuidLike))
}

function normalizeWorkingHours(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value
}

async function upsertStaffCapabilities(client, { staffId, genderType, allowedServiceIds, workingHours, isActive, replaceAllowedServices = true }) {
  const safeAllowedServiceIds = Array.isArray(allowedServiceIds) ? allowedServiceIds : []
  await client.query(
    `
      INSERT INTO stylist_profiles (stylist_id, target_segment, working_hours_json, is_active, updated_at)
      VALUES ($1, $2, $3::jsonb, $4, NOW())
      ON CONFLICT (stylist_id) DO UPDATE
      SET target_segment = EXCLUDED.target_segment,
          working_hours_json = EXCLUDED.working_hours_json,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
    `,
    [staffId, genderType, JSON.stringify(workingHours ?? {}), Boolean(isActive)]
  )
  if (replaceAllowedServices) {
    await client.query("DELETE FROM stylist_service_map WHERE stylist_id = $1", [staffId])
    if (!safeAllowedServiceIds.length) return
    const { rows: serviceRows } = await client.query("SELECT id FROM service_catalog WHERE id = ANY($1::uuid[])", [safeAllowedServiceIds])
    const validIds = new Set(serviceRows.map(row => row.id))
    if (validIds.size !== safeAllowedServiceIds.length) {
      const error = new Error("One or more allowed services are invalid")
      error.code = "BAD_REQUEST"
      throw error
    }
    for (const serviceId of safeAllowedServiceIds) {
      await client.query(
        `
          INSERT INTO stylist_service_map (id, stylist_id, service_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (stylist_id, service_id) DO NOTHING
        `,
        [uuid(), staffId, serviceId]
      )
    }
  }
}

router.use(requireFirebaseAuth, requireAppRole("ADMIN"))
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
router.use("/bookings", adminBookingRoutes)
router.get("/services", listAdminServicesController)
router.post("/services", (req, res) => createAdminServiceController(req, res, { publishServiceEvent: publishServiceCatalogEvent }))
router.patch("/services/:id", (req, res) => updateAdminServiceController(req, res, { publishServiceEvent: publishServiceCatalogEvent }))
router.post("/services/upload-image", uploadAdminServiceImageController)
router.patch("/services/discounts", (req, res) =>
  updateAdminServiceDiscountsController(req, res, { publishServiceEvent: publishServiceCatalogEvent })
)
router.get("/queue", listQueueController)
router.get("/bookings/:id/invoice.pdf", downloadBookingInvoiceController)
router.get("/payroll/policy", getPayrollPolicyController)
router.patch("/payroll/policy", updatePayrollPolicyController)
router.get("/payroll/deductions", listMonthlyDeductionsController)
router.get("/reports/payments", getAdminRevenueReportController)

router.get("/users/gender-pending", async (_req, res) => {
  const { rows } = await pool.query(
    `
      SELECT id, name, email, phone, role, gender, created_at, updated_at
      FROM users
      WHERE role = 'USER' AND (gender IS NULL OR gender = 'OTHER')
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 500
    `
  )
  const users = rows.map(row => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    gender: row.gender ?? "OTHER",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
  return res.json({ users })
})

router.patch("/users/:id/gender", async (req, res) => {
  const userId = `${req.params.id ?? ""}`.trim()
  const gender = normalizeGender(req.body?.gender)
  if (!userId) return res.status(400).json({ error: "User id is required" })
  if (!gender) return res.status(400).json({ error: "Invalid gender" })
  const { rows } = await pool.query(
    `
      UPDATE users
      SET gender = $2, updated_at = NOW()
      WHERE id = $1 AND role = 'USER'
      RETURNING id, name, email, phone, role, gender, created_at, updated_at
    `,
    [userId, gender]
  )
  if (!rows.length) return res.status(404).json({ error: "User not found" })
  const row = rows[0]
  return res.json({
    user: {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      role: row.role,
      gender: row.gender,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  })
})

router.get("/staff", async (_req, res) => {
  const { rows } = await pool.query(
    `
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u.phone,
        u.account_status,
        u.created_at,
        COALESCE(sp.target_segment, 'UNISEX') AS gender_type,
        COALESCE(sp.working_hours_json, '{}'::jsonb) AS working_hours_json,
        COALESCE(sp.is_active, TRUE) AS stylist_active,
        COALESCE(array_agg(m.service_id) FILTER (WHERE m.service_id IS NOT NULL), '{}') AS allowed_service_ids
      FROM users u
      LEFT JOIN stylist_profiles sp ON sp.stylist_id = u.id
      LEFT JOIN stylist_service_map m ON m.stylist_id = u.id
      WHERE role IN ('STAFF', 'RECEPTIONIST')
      GROUP BY u.id, u.name, u.email, u.role, u.phone, u.account_status, u.created_at, sp.target_segment, sp.working_hours_json, sp.is_active
      ORDER BY u.created_at DESC
    `
  )
  const staff = rows.map(row => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    phone: row.phone,
    accountStatus: row.account_status,
    genderType: row.gender_type,
    allowedServiceIds: Array.isArray(row.allowed_service_ids) ? row.allowed_service_ids : [],
    workingHours: row.working_hours_json ?? {},
    isActive: Boolean(row.stylist_active),
    createdAt: row.created_at,
  }))
  res.json({ staff })
})

router.post("/staff", async (req, res) => {
  const { name, email, phone, role } = req.body ?? {}
  const genderType = normalizeStylistGenderType(req.body?.genderType) ?? "UNISEX"
  const allowedServiceIds = normalizeAllowedServiceIds(req.body?.allowedServiceIds)
  const workingHours = normalizeWorkingHours(req.body?.workingHours)
  const stylistActive = req.body?.isActive === undefined ? true : Boolean(req.body?.isActive)
  if (!name || !email || !phone || !["STAFF", "RECEPTIONIST"].includes(role)) {
    return res.status(400).json({ error: "Invalid staff payload" })
  }
  if (req.body?.genderType !== undefined && !normalizeStylistGenderType(req.body?.genderType)) {
    return res.status(400).json({ error: "Invalid genderType. Use men, women, or unisex." })
  }
  if (!isValidFullName(name)) {
    return res.status(400).json({ error: "Please provide a valid full name." })
  }
  const duplicate = await pool.query("SELECT id FROM users WHERE email = $1 LIMIT 1", [email])
  if (duplicate.rows.length) {
    return res.status(409).json({ error: "Email already exists" })
  }
  try {
    const id = uuid()
    const client = await pool.connect()
    let rows
    try {
      await client.query("BEGIN")
      const inserted = await client.query(
        `
          INSERT INTO users (id, name, email, phone, role, latitude, longitude, account_status)
          VALUES ($1, $2, $3, $4, $5, 0, 0, 'PENDING_VERIFICATION')
          RETURNING id, name, email, role, phone, account_status, created_at
        `,
        [id, name, email, phone, role]
      )
      rows = inserted.rows
      await upsertStaffCapabilities(client, {
        staffId: id,
        genderType,
        allowedServiceIds,
        workingHours,
        isActive: stylistActive,
        replaceAllowedServices: true,
      })
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
    const row = rows[0]
    const user = {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      phone: row.phone,
      accountStatus: row.account_status,
      genderType,
      allowedServiceIds,
      workingHours,
      isActive: stylistActive,
      createdAt: row.created_at,
    }
    return res.status(201).json({ message: "Staff created", user })
  } catch (error) {
    if (error?.code === "23505") {
      if (error.constraint === "users_phone_unique") {
        return res.status(409).json({ error: "Phone already exists" })
      }
      if (error.constraint === "users_email_unique") {
        return res.status(409).json({ error: "Email already exists" })
      }
      return res.status(409).json({ error: "Staff already exists" })
    }
    console.error("Failed to create staff", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

router.patch("/staff/:id", async (req, res) => {
  const { id } = req.params
  const { name, email, phone, role } = req.body ?? {}
  const genderTypeProvided = req.body?.genderType !== undefined
  const genderType = normalizeStylistGenderType(req.body?.genderType)
  const allowedServicesProvided = req.body?.allowedServiceIds !== undefined
  const allowedServiceIds = normalizeAllowedServiceIds(req.body?.allowedServiceIds)
  const workingHoursProvided = req.body?.workingHours !== undefined
  const workingHours = normalizeWorkingHours(req.body?.workingHours)
  const stylistActiveProvided = req.body?.isActive !== undefined
  const stylistActive = Boolean(req.body?.isActive)
  if (role && !["STAFF", "RECEPTIONIST"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" })
  }
  if (genderTypeProvided && !genderType) {
    return res.status(400).json({ error: "Invalid genderType. Use men, women, or unisex." })
  }
  if (name && !isValidFullName(name)) {
    return res.status(400).json({ error: "Please provide a valid full name." })
  }

  const patch = {
    name: typeof name === "string" ? name : null,
    email: typeof email === "string" ? email : null,
    phone: typeof phone === "string" ? phone : null,
    role: typeof role === "string" ? role : null,
  }
  const client = await pool.connect()
  let rows
  try {
    await client.query("BEGIN")
    const updated = await client.query(
      `
        UPDATE users
        SET
          name = COALESCE($2, name),
          email = COALESCE($3, email),
          phone = COALESCE($4, phone),
          role = COALESCE($5, role),
          updated_at = NOW()
        WHERE id = $1 AND role IN ('STAFF', 'RECEPTIONIST')
        RETURNING id, name, email, role, phone, account_status, created_at
      `,
      [id, patch.name, patch.email, patch.phone, patch.role]
    )
    rows = updated.rows
    if (!rows.length) {
      await client.query("ROLLBACK")
      return res.status(404).json({ error: "Staff not found" })
    }
    const current = await client.query(
      `
        SELECT
          COALESCE(target_segment, 'UNISEX') AS gender_type,
          COALESCE(working_hours_json, '{}'::jsonb) AS working_hours_json,
          COALESCE(is_active, TRUE) AS is_active
        FROM stylist_profiles
        WHERE stylist_id = $1
      `,
      [id]
    )
    const profile = current.rows[0] ?? { gender_type: "UNISEX", working_hours_json: {}, is_active: true }
    await upsertStaffCapabilities(client, {
      staffId: id,
      genderType: genderTypeProvided ? genderType : profile.gender_type,
      allowedServiceIds,
      workingHours: workingHoursProvided ? workingHours : profile.working_hours_json,
      isActive: stylistActiveProvided ? stylistActive : profile.is_active,
      replaceAllowedServices: allowedServicesProvided,
    })
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  const row = rows[0]
  const user = {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    phone: row.phone,
    accountStatus: row.account_status,
    createdAt: row.created_at,
  }
  return res.json({ user })
})
router.patch("/staff/:id/shifts", upsertStaffShiftController)
router.post("/staff/:id/leaves", createStaffLeaveController)

router.delete("/staff/:id", async (req, res) => {
  await pool.query("DELETE FROM users WHERE id = $1 AND role IN ('STAFF', 'RECEPTIONIST')", [req.params.id])
  return res.json({ success: true })
})

router.get("/salons", async (_req, res) => {
  const { rows } = await pool.query(
    `
      SELECT id, name, address, pincode, latitude, longitude, owner_id
      FROM salons
      ORDER BY created_at DESC
    `
  )
  const salons = rows.map(row => ({
    id: row.id,
    name: row.name,
    address: row.address,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    ownerId: row.owner_id,
  }))
  res.json({ salons })
})

router.post("/salons", async (req, res) => {
  const { name, address, pincode, latitude, longitude } = req.body ?? {}
  if (!name || !address) return res.status(400).json({ error: "Name and address are required" })
  const id = uuid()
  const { rows } = await pool.query(
    `
      INSERT INTO salons (id, name, address, pincode, latitude, longitude, owner_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, name, address, pincode, latitude, longitude, owner_id
    `,
    [id, name, address, `${pincode ?? ""}`, Number(latitude ?? 0), Number(longitude ?? 0), req.appUser.id]
  )
  const row = rows[0]
  const salon = {
    id: row.id,
    name: row.name,
    address: row.address,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    ownerId: row.owner_id,
  }
  return res.status(201).json({ salon })
})

router.get("/offers/center", async (_req, res) => {
  const data = await getOfferCenterData()
  return res.json(data)
})

async function buildOfferRealtimePayload(action) {
  const [center, events] = await Promise.all([getOfferCenterData(), listOfferCalendarEvents()])
  const previews = {}
  for (const segment of OFFER_SEGMENTS) {
    previews[segment] = await previewOffers({ membershipSegment: segment })
  }
  return {
    action,
    center,
    events,
    previews,
    generatedAt: new Date().toISOString(),
  }
}

router.get("/offers/calendar", async (_req, res) => {
  const events = await listOfferCalendarEvents()
  return res.json({ events })
})

router.post("/offers/global", async (req, res) => {
  try {
    const result = await upsertGlobalDiscount({ payload: req.body ?? {}, actorUserId: req.appUser.id })
    publishOfferEvent("offers.updated.v1", await buildOfferRealtimePayload("GLOBAL_UPDATED"))
    return res.status(200).json(result)
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return res.status(400).json({ error: error.message })
    console.error("Failed to update global discount", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

router.post("/offers/service", async (req, res) => {
  try {
    const center = await createServiceDiscount({ payload: req.body ?? {}, actorUserId: req.appUser.id })
    publishOfferEvent("offers.updated.v1", await buildOfferRealtimePayload("SERVICE_DISCOUNT_UPDATED"))
    return res.status(201).json({ center })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return res.status(400).json({ error: error.message })
    console.error("Failed to create service discount", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

router.post("/offers/membership", async (req, res) => {
  try {
    const center = await createMembershipDiscount({ payload: req.body ?? {}, actorUserId: req.appUser.id })
    publishOfferEvent("offers.updated.v1", await buildOfferRealtimePayload("MEMBERSHIP_DISCOUNT_UPDATED"))
    return res.status(201).json({ center })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return res.status(400).json({ error: error.message })
    console.error("Failed to create membership discount", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

router.post("/offers/combos", async (req, res) => {
  try {
    const center = await createComboOffer({ payload: req.body ?? {}, actorUserId: req.appUser.id })
    publishOfferEvent("offers.updated.v1", await buildOfferRealtimePayload("COMBO_UPDATED"))
    return res.status(201).json({ center })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return res.status(400).json({ error: error.message })
    console.error("Failed to create combo offer", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

router.get("/offers/preview", async (req, res) => {
  const membershipSegment = `${req.query.membershipSegment ?? "FREE"}`
  const preview = await previewOffers({ membershipSegment })
  return res.json(preview)
})

router.delete("/offers/:type/:id", async (req, res) => {
  try {
    const result = await deleteOfferByType({ type: req.params.type, id: req.params.id })
    publishOfferEvent("offers.updated.v1", await buildOfferRealtimePayload("OFFER_DELETED"))
    return res.json(result)
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return res.status(400).json({ error: error.message })
    console.error("Failed to delete offer", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

router.patch("/offers/:type/:id", async (req, res) => {
  try {
    const result = await updateOfferByType({ type: req.params.type, id: req.params.id, payload: req.body ?? {}, actorUserId: req.appUser.id })
    publishOfferEvent("offers.updated.v1", await buildOfferRealtimePayload("OFFER_UPDATED"))
    return res.json(result)
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return res.status(400).json({ error: error.message })
    console.error("Failed to update offer", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})

router.get("/membership", async (_req, res) => {
  try {
    const center = await getAdminMembershipCenter()
    return res.json(center)
  } catch (error) {
    console.error("Failed to load membership center", error)
    return res.status(500).json({ error: "Could not load membership plans" })
  }
})

router.put("/membership/plans/:segment", async (req, res) => {
  try {
    const plan = await upsertMembershipPlan({ segment: req.params.segment, payload: req.body ?? {} })
    return res.json({ plan })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return res.status(400).json({ error: error.message })
    console.error("Failed to save membership plan", error)
    return res.status(500).json({ error: "Could not save membership plan" })
  }
})

export default router

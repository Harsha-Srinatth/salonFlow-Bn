import { v4 as uuid } from "uuid"
import { pool } from "../lib/db-pool.js"

const MEMBERSHIP_SEGMENTS = ["FREE", "BASIC", "PREMIUM"]
const COMBO_CATEGORIES = ["MEN", "WOMEN", "CHILDREN"]

function normalizeMembershipSegment(value) {
  const normalized = `${value ?? ""}`.trim().toUpperCase()
  if (MEMBERSHIP_SEGMENTS.includes(normalized)) return normalized
  return null
}

function toPercent(value) {
  const num = Number(value ?? 0)
  if (!Number.isFinite(num) || num < 0 || num > 100) return null
  return num
}

function toDate(value) {
  const raw = `${value ?? ""}`.trim()
  return raw || null
}

function isActiveNow(row, now = new Date()) {
  if (!row?.is_enabled) return false
  const start = row.start_at ? new Date(row.start_at) : null
  const end = row.end_at ? new Date(row.end_at) : null
  if (start && now < start) return false
  if (end && now > end) return false
  return true
}

async function listServicesMap() {
  const { rows } = await pool.query(
    `SELECT id, name, category, base_price, discount_percent FROM service_catalog WHERE is_active = TRUE ORDER BY name ASC`
  )
  return rows
}

export async function ensureOfferSchema() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_segment VARCHAR(16) NOT NULL DEFAULT 'FREE'`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offer_global_discounts (
      id UUID PRIMARY KEY,
      discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
      start_at TIMESTAMPTZ,
      end_at TIMESTAMPTZ,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offer_service_discounts (
      id UUID PRIMARY KEY,
      service_id UUID NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,
      discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
      start_at TIMESTAMPTZ,
      end_at TIMESTAMPTZ,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS offer_service_discounts_service_idx ON offer_service_discounts(service_id)`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offer_membership_service_discounts (
      id UUID PRIMARY KEY,
      service_id UUID NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,
      membership_segment VARCHAR(16) NOT NULL,
      discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
      start_at TIMESTAMPTZ,
      end_at TIMESTAMPTZ,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS offer_membership_service_unique_active_idx
    ON offer_membership_service_discounts(service_id, membership_segment, start_at, end_at)
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offer_combos (
      id UUID PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(16) NOT NULL DEFAULT 'MEN',
      offer_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      visible_segments TEXT[] NOT NULL DEFAULT ARRAY['FREE','BASIC','PREMIUM']::text[],
      start_at TIMESTAMPTZ,
      end_at TIMESTAMPTZ,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offer_combo_services (
      id UUID PRIMARY KEY,
      combo_id UUID NOT NULL REFERENCES offer_combos(id) ON DELETE CASCADE,
      service_id UUID NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(combo_id, service_id)
    )
  `)
}

export async function getOfferCenterData() {
  const now = new Date()
  const [services, globalRows, serviceRows, membershipRows, comboRows] = await Promise.all([
    listServicesMap(),
    pool.query(`SELECT * FROM offer_global_discounts ORDER BY created_at DESC LIMIT 1`),
    pool.query(`SELECT * FROM offer_service_discounts ORDER BY updated_at DESC`),
    pool.query(`SELECT * FROM offer_membership_service_discounts ORDER BY updated_at DESC`),
    pool.query(`
      SELECT
        c.*,
        COALESCE(array_agg(cs.service_id) FILTER (WHERE cs.service_id IS NOT NULL), '{}') AS service_ids
      FROM offer_combos c
      LEFT JOIN offer_combo_services cs ON cs.combo_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
    `),
  ])
  const activeGlobal = globalRows.rows[0] ?? null
  const expiringSoonCount = [...serviceRows.rows, ...membershipRows.rows, ...comboRows.rows]
    .filter(row => isActiveNow(row, now) && row.end_at && new Date(row.end_at).getTime() - now.getTime() <= 3 * 24 * 60 * 60 * 1000)
    .length
  return {
    services: services.map(row => ({
      id: row.id,
      name: row.name,
      category: row.category,
      basePrice: Number(row.base_price ?? 0),
      defaultDiscountPercent: Number(row.discount_percent ?? 0),
    })),
    globalDiscount: activeGlobal
      ? {
          id: activeGlobal.id,
          discountPercent: Number(activeGlobal.discount_percent ?? 0),
          startAt: activeGlobal.start_at,
          endAt: activeGlobal.end_at,
          isEnabled: Boolean(activeGlobal.is_enabled),
          isActiveNow: isActiveNow(activeGlobal, now),
        }
      : null,
    serviceDiscounts: serviceRows.rows.map(row => ({
      id: row.id,
      serviceId: row.service_id,
      discountPercent: Number(row.discount_percent ?? 0),
      startAt: row.start_at,
      endAt: row.end_at,
      isEnabled: Boolean(row.is_enabled),
      isActiveNow: isActiveNow(row, now),
    })),
    membershipDiscounts: membershipRows.rows.map(row => ({
      id: row.id,
      serviceId: row.service_id,
      membershipSegment: row.membership_segment,
      discountPercent: Number(row.discount_percent ?? 0),
      startAt: row.start_at,
      endAt: row.end_at,
      isEnabled: Boolean(row.is_enabled),
      isActiveNow: isActiveNow(row, now),
    })),
    combos: comboRows.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      category: row.category,
      offerPrice: Number(row.offer_price ?? 0),
      visibleSegments: Array.isArray(row.visible_segments) ? row.visible_segments : ["FREE", "BASIC", "PREMIUM"],
      serviceIds: Array.isArray(row.service_ids) ? row.service_ids : [],
      startAt: row.start_at,
      endAt: row.end_at,
      isEnabled: Boolean(row.is_enabled),
      isActiveNow: isActiveNow(row, now),
    })),
    dashboard: {
      activeDiscounts: serviceRows.rows.filter(row => isActiveNow(row, now)).length + (activeGlobal && isActiveNow(activeGlobal, now) ? 1 : 0),
      activeCombos: comboRows.rows.filter(row => isActiveNow(row, now)).length,
      premiumOffers: membershipRows.rows.filter(row => row.membership_segment === "PREMIUM" && isActiveNow(row, now)).length,
      basicOffers: membershipRows.rows.filter(row => row.membership_segment === "BASIC" && isActiveNow(row, now)).length,
      freeOffers: membershipRows.rows.filter(row => row.membership_segment === "FREE" && isActiveNow(row, now)).length,
      expiringSoon: expiringSoonCount,
    },
  }
}

export async function upsertGlobalDiscount({ payload, actorUserId }) {
  const discountPercent = toPercent(payload?.discountPercent)
  if (discountPercent === null) throw Object.assign(new Error("Discount must be between 0 and 100"), { code: "BAD_REQUEST" })
  const startAt = toDate(payload?.startAt)
  const endAt = toDate(payload?.endAt)
  const isEnabled = payload?.isEnabled === undefined ? true : Boolean(payload?.isEnabled)
  const existing = await pool.query(`SELECT id FROM offer_global_discounts ORDER BY created_at DESC LIMIT 1`)
  const warning = existing.rows.length ? "Another global discount configuration already exists. Latest settings were updated." : null
  if (!existing.rows.length) {
    await pool.query(
      `INSERT INTO offer_global_discounts (id, discount_percent, start_at, end_at, is_enabled, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuid(), discountPercent, startAt, endAt, isEnabled, actorUserId]
    )
  } else {
    await pool.query(
      `UPDATE offer_global_discounts SET discount_percent=$2,start_at=$3,end_at=$4,is_enabled=$5,updated_at=NOW(),created_by=$6 WHERE id=$1`,
      [existing.rows[0].id, discountPercent, startAt, endAt, isEnabled, actorUserId]
    )
  }
  return { warning, center: await getOfferCenterData() }
}

export async function createServiceDiscount({ payload, actorUserId }) {
  const serviceId = `${payload?.serviceId ?? ""}`.trim()
  const discountPercent = toPercent(payload?.discountPercent)
  if (!serviceId || discountPercent === null) throw Object.assign(new Error("Service and valid discount are required"), { code: "BAD_REQUEST" })
  const startAt = toDate(payload?.startAt)
  const endAt = toDate(payload?.endAt)
  const isEnabled = payload?.isEnabled !== false
  const { rows: existingRows } = await pool.query(
    `
      SELECT id
      FROM offer_service_discounts
      WHERE service_id = $1
        AND start_at IS NOT DISTINCT FROM $2::timestamptz
        AND end_at IS NOT DISTINCT FROM $3::timestamptz
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [serviceId, startAt, endAt]
  )
  if (existingRows.length) {
    await pool.query(
      `
        UPDATE offer_service_discounts
        SET discount_percent = $2,
            is_enabled = $3,
            created_by = $4,
            updated_at = NOW()
        WHERE id = $1
      `,
      [existingRows[0].id, discountPercent, isEnabled, actorUserId]
    )
  } else {
    await pool.query(
      `INSERT INTO offer_service_discounts (id, service_id, discount_percent, start_at, end_at, is_enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuid(), serviceId, discountPercent, startAt, endAt, isEnabled, actorUserId]
    )
  }
  return getOfferCenterData()
}

export async function createMembershipDiscount({ payload, actorUserId }) {
  const serviceId = `${payload?.serviceId ?? ""}`.trim()
  const segment = normalizeMembershipSegment(payload?.membershipSegment)
  const discountPercent = toPercent(payload?.discountPercent)
  if (!serviceId || !segment || discountPercent === null) throw Object.assign(new Error("Service, membership, and valid discount are required"), { code: "BAD_REQUEST" })
  await pool.query(
    `INSERT INTO offer_membership_service_discounts (id, service_id, membership_segment, discount_percent, start_at, end_at, is_enabled, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuid(), serviceId, segment, discountPercent, toDate(payload?.startAt), toDate(payload?.endAt), payload?.isEnabled !== false, actorUserId]
  )
  return getOfferCenterData()
}

export async function createComboOffer({ payload, actorUserId }) {
  const name = `${payload?.name ?? ""}`.trim()
  const description = `${payload?.description ?? ""}`.trim()
  const category = `${payload?.category ?? ""}`.trim().toUpperCase()
  const offerPrice = Number(payload?.offerPrice ?? 0)
  const serviceIds = Array.isArray(payload?.serviceIds) ? payload.serviceIds.map(id => `${id ?? ""}`.trim()).filter(Boolean) : []
  const visibleSegments = Array.isArray(payload?.visibleSegments)
    ? payload.visibleSegments.map(normalizeMembershipSegment).filter(Boolean)
    : MEMBERSHIP_SEGMENTS
  if (!name || !COMBO_CATEGORIES.includes(category) || !serviceIds.length || !Number.isFinite(offerPrice) || offerPrice <= 0) {
    throw Object.assign(new Error("Invalid combo payload"), { code: "BAD_REQUEST" })
  }
  const comboId = uuid()
  await pool.query(
    `INSERT INTO offer_combos (id, name, description, category, offer_price, visible_segments, start_at, end_at, is_enabled, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10)`,
    [comboId, name, description || null, category, offerPrice, visibleSegments.length ? visibleSegments : MEMBERSHIP_SEGMENTS, toDate(payload?.startAt), toDate(payload?.endAt), payload?.isEnabled !== false, actorUserId]
  )
  for (const serviceId of serviceIds) {
    await pool.query(`INSERT INTO offer_combo_services (id, combo_id, service_id) VALUES ($1,$2,$3) ON CONFLICT (combo_id, service_id) DO NOTHING`, [uuid(), comboId, serviceId])
  }
  return getOfferCenterData()
}

export async function listOfferCalendarEvents() {
  const { rows } = await pool.query(
    `
      SELECT id, 'GLOBAL'::text AS type, discount_percent::text AS title, start_at, end_at FROM offer_global_discounts
      UNION ALL
      SELECT d.id, 'SERVICE'::text AS type, CONCAT(s.name, ' ', d.discount_percent::text, '%') AS title, d.start_at, d.end_at
      FROM offer_service_discounts d
      LEFT JOIN service_catalog s ON s.id = d.service_id
      UNION ALL
      SELECT d.id, 'MEMBERSHIP'::text AS type, CONCAT(d.membership_segment, ' ', s.name, ' ', d.discount_percent::text, '%') AS title, d.start_at, d.end_at
      FROM offer_membership_service_discounts d
      LEFT JOIN service_catalog s ON s.id = d.service_id
      UNION ALL
      SELECT id, 'COMBO'::text AS type, name AS title, start_at, end_at
      FROM offer_combos
      ORDER BY start_at ASC NULLS LAST, end_at ASC NULLS LAST
    `
  )
  return rows.map(row => ({
    id: row.id,
    type: row.type,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
  }))
}

export async function deleteOfferByType({ type, id }) {
  const offerId = `${id ?? ""}`.trim()
  const normalizedType = `${type ?? ""}`.trim().toUpperCase()
  if (!offerId) throw Object.assign(new Error("Offer id is required"), { code: "BAD_REQUEST" })

  let result = null
  if (normalizedType === "GLOBAL") {
    result = await pool.query(`DELETE FROM offer_global_discounts WHERE id = $1`, [offerId])
  } else if (normalizedType === "SERVICE") {
    result = await pool.query(`DELETE FROM offer_service_discounts WHERE id = $1`, [offerId])
  } else if (normalizedType === "MEMBERSHIP") {
    result = await pool.query(`DELETE FROM offer_membership_service_discounts WHERE id = $1`, [offerId])
  } else if (normalizedType === "COMBO") {
    result = await pool.query(`DELETE FROM offer_combos WHERE id = $1`, [offerId])
  } else {
    throw Object.assign(new Error("Unsupported offer type"), { code: "BAD_REQUEST" })
  }

  return { deleted: Number(result?.rowCount ?? 0) > 0 }
}

export async function updateOfferByType({ type, id, payload, actorUserId }) {
  const offerId = `${id ?? ""}`.trim()
  const normalizedType = `${type ?? ""}`.trim().toUpperCase()
  if (!offerId) throw Object.assign(new Error("Offer id is required"), { code: "BAD_REQUEST" })

  if (normalizedType === "GLOBAL") {
    const discountPercent = toPercent(payload?.discountPercent)
    if (discountPercent === null) throw Object.assign(new Error("Discount must be between 0 and 100"), { code: "BAD_REQUEST" })
    await pool.query(
      `
        UPDATE offer_global_discounts
        SET discount_percent = $2,
            start_at = $3,
            end_at = $4,
            is_enabled = $5,
            created_by = $6,
            updated_at = NOW()
        WHERE id = $1
      `,
      [offerId, discountPercent, toDate(payload?.startAt), toDate(payload?.endAt), payload?.isEnabled !== false, actorUserId]
    )
    return { updated: true }
  }

  if (normalizedType === "SERVICE") {
    const serviceId = `${payload?.serviceId ?? ""}`.trim()
    const discountPercent = toPercent(payload?.discountPercent)
    if (!serviceId || discountPercent === null) throw Object.assign(new Error("Service and valid discount are required"), { code: "BAD_REQUEST" })
    await pool.query(
      `
        UPDATE offer_service_discounts
        SET service_id = $2,
            discount_percent = $3,
            start_at = $4,
            end_at = $5,
            is_enabled = $6,
            created_by = $7,
            updated_at = NOW()
        WHERE id = $1
      `,
      [offerId, serviceId, discountPercent, toDate(payload?.startAt), toDate(payload?.endAt), payload?.isEnabled !== false, actorUserId]
    )
    return { updated: true }
  }

  if (normalizedType === "MEMBERSHIP") {
    const serviceId = `${payload?.serviceId ?? ""}`.trim()
    const segment = normalizeMembershipSegment(payload?.membershipSegment)
    const discountPercent = toPercent(payload?.discountPercent)
    if (!serviceId || !segment || discountPercent === null) {
      throw Object.assign(new Error("Service, membership, and valid discount are required"), { code: "BAD_REQUEST" })
    }
    await pool.query(
      `
        UPDATE offer_membership_service_discounts
        SET service_id = $2,
            membership_segment = $3,
            discount_percent = $4,
            start_at = $5,
            end_at = $6,
            is_enabled = $7,
            created_by = $8,
            updated_at = NOW()
        WHERE id = $1
      `,
      [offerId, serviceId, segment, discountPercent, toDate(payload?.startAt), toDate(payload?.endAt), payload?.isEnabled !== false, actorUserId]
    )
    return { updated: true }
  }

  if (normalizedType === "COMBO") {
    const name = `${payload?.name ?? ""}`.trim()
    const description = `${payload?.description ?? ""}`.trim()
    const category = `${payload?.category ?? ""}`.trim().toUpperCase()
    const offerPrice = Number(payload?.offerPrice ?? 0)
    const serviceIds = Array.isArray(payload?.serviceIds) ? payload.serviceIds.map(item => `${item ?? ""}`.trim()).filter(Boolean) : []
    const visibleSegments = Array.isArray(payload?.visibleSegments)
      ? payload.visibleSegments.map(normalizeMembershipSegment).filter(Boolean)
      : MEMBERSHIP_SEGMENTS
    if (!name || !COMBO_CATEGORIES.includes(category) || !Number.isFinite(offerPrice) || offerPrice <= 0) {
      throw Object.assign(new Error("Invalid combo payload"), { code: "BAD_REQUEST" })
    }
    await pool.query(
      `
        UPDATE offer_combos
        SET name = $2,
            description = $3,
            category = $4,
            offer_price = $5,
            visible_segments = $6::text[],
            start_at = $7,
            end_at = $8,
            is_enabled = $9,
            created_by = $10,
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        offerId,
        name,
        description || null,
        category,
        offerPrice,
        visibleSegments.length ? visibleSegments : MEMBERSHIP_SEGMENTS,
        toDate(payload?.startAt),
        toDate(payload?.endAt),
        payload?.isEnabled !== false,
        actorUserId,
      ]
    )
    if (serviceIds.length) {
      await pool.query(`DELETE FROM offer_combo_services WHERE combo_id = $1`, [offerId])
      for (const serviceId of serviceIds) {
        await pool.query(`INSERT INTO offer_combo_services (id, combo_id, service_id) VALUES ($1,$2,$3) ON CONFLICT (combo_id, service_id) DO NOTHING`, [uuid(), offerId, serviceId])
      }
    }
    return { updated: true }
  }

  throw Object.assign(new Error("Unsupported offer type"), { code: "BAD_REQUEST" })
}

export async function getMembershipSegmentForUser(userId) {
  if (!userId) return "FREE"
  await ensureOfferSchema()
  const { rows } = await pool.query(`SELECT membership_segment FROM users WHERE id = $1 LIMIT 1`, [userId])
  return normalizeMembershipSegment(rows[0]?.membership_segment) ?? "FREE"
}

export async function getCustomerOffersForUser({ membershipSegment }) {
  const segment = normalizeMembershipSegment(membershipSegment) ?? "FREE"
  const [preview, center] = await Promise.all([
    previewOffers({ membershipSegment: segment }),
    getOfferCenterData(),
  ])
  const servicesById = new Map(center.services.map(service => [service.id, service]))

  const globalDiscount = center.globalDiscount?.isActiveNow
    ? {
        discountPercent: center.globalDiscount.discountPercent,
        startAt: center.globalDiscount.startAt,
        endAt: center.globalDiscount.endAt,
        label: `${Number(center.globalDiscount.discountPercent).toFixed(0)}% off all services`,
      }
    : null

  const serviceOffers = center.serviceDiscounts
    .filter(row => row.isActiveNow)
    .map(row => {
      const service = servicesById.get(row.serviceId)
      const originalPrice = Number(service?.basePrice ?? 0)
      const discountPercent = Number(row.discountPercent ?? 0)
      return {
        id: row.id,
        serviceId: row.serviceId,
        serviceName: service?.name ?? "Service",
        discountPercent,
        originalPrice,
        finalPrice: Math.max(0, originalPrice - (originalPrice * discountPercent) / 100),
        startAt: row.startAt,
        endAt: row.endAt,
      }
    })

  const membershipOffers = center.membershipDiscounts
    .filter(row => row.isActiveNow && row.membershipSegment === segment)
    .map(row => {
      const service = servicesById.get(row.serviceId)
      const originalPrice = Number(service?.basePrice ?? 0)
      const discountPercent = Number(row.discountPercent ?? 0)
      return {
        id: row.id,
        serviceId: row.serviceId,
        serviceName: service?.name ?? "Service",
        discountPercent,
        originalPrice,
        finalPrice: Math.max(0, originalPrice - (originalPrice * discountPercent) / 100),
        startAt: row.startAt,
        endAt: row.endAt,
      }
    })

  return {
    globalDiscount,
    serviceOffers,
    membershipOffers,
    combos: preview.combos.map(combo => ({
      id: combo.id,
      name: combo.name,
      description: combo.description ?? "",
      category: combo.category,
      serviceIds: combo.serviceIds,
      serviceNames: combo.serviceIds.map(id => servicesById.get(id)?.name).filter(Boolean),
      actualPrice: combo.actualPrice,
      offerPrice: combo.offerPrice,
      savings: combo.savings,
      startAt: combo.startAt,
      endAt: combo.endAt,
    })),
    pricedServices: preview.services.map(item => ({
      serviceId: item.serviceId,
      serviceName: item.serviceName,
      originalPrice: item.originalPrice,
      finalPrice: item.finalPrice,
      appliedPercent: item.appliedPercent,
      source: item.source,
    })),
    generatedAt: preview.generatedAt,
  }
}

export async function computeBookingOfferPricing({ serviceIds, membershipSegment, comboId = null, serviceCatalog }) {
  const segment = normalizeMembershipSegment(membershipSegment) ?? "FREE"
  const preview = await previewOffers({ membershipSegment: segment })
  const selectedServices = serviceCatalog.filter(service => serviceIds.includes(service.id))
  if (selectedServices.length !== serviceIds.length) {
    throw Object.assign(new Error("One or more selected services are invalid"), { code: "BAD_REQUEST" })
  }

  if (comboId) {
    const combo = preview.combos.find(item => item.id === comboId)
    if (!combo) throw Object.assign(new Error("Selected combo offer is not available"), { code: "BAD_REQUEST" })
    const comboKey = [...combo.serviceIds].sort().join(",")
    const selectedKey = [...serviceIds].sort().join(",")
    if (comboKey !== selectedKey) {
      throw Object.assign(new Error("Selected services do not match the combo offer"), { code: "BAD_REQUEST" })
    }
    const totalAmount = Number(combo.actualPrice ?? 0)
    const payableAmount = Number(combo.offerPrice ?? 0)
    return {
      totalAmount,
      discountAmount: Math.max(0, totalAmount - payableAmount),
      payableAmount,
      comboId,
      offerSource: "COMBO_OFFER",
      serviceItems: selectedServices.map(service => ({
        id: service.id,
        name: service.name,
        basePrice: Number(service.basePrice ?? 0),
        discountPercent: 0,
        offerSource: "COMBO_OFFER",
      })),
    }
  }

  let totalAmount = 0
  let payableAmount = 0
  const serviceItems = selectedServices.map(service => {
    const priced = preview.services.find(item => item.serviceId === service.id)
    const originalPrice = Number(service.basePrice ?? 0)
    const finalPrice = Number(priced?.finalPrice ?? originalPrice)
    const appliedPercent = Number(priced?.appliedPercent ?? 0)
    totalAmount += originalPrice
    payableAmount += finalPrice
    return {
      id: service.id,
      name: service.name,
      basePrice: originalPrice,
      discountPercent: appliedPercent,
      offerSource: priced?.source ?? "NONE",
    }
  })

  return {
    totalAmount,
    discountAmount: Math.max(0, totalAmount - payableAmount),
    payableAmount,
    comboId: null,
    offerSource: serviceItems.some(item => item.offerSource !== "NONE") ? "OFFER_APPLIED" : "NONE",
    serviceItems,
  }
}

export async function previewOffers({ membershipSegment }) {
  const segment = normalizeMembershipSegment(membershipSegment) ?? "FREE"
  const now = new Date()
  const center = await getOfferCenterData()
  const servicesById = new Map(center.services.map(service => [service.id, service]))
  const globalDiscount = center.globalDiscount && center.globalDiscount.isActiveNow ? center.globalDiscount.discountPercent : 0
  const serviceDiscountMap = new Map()
  for (const row of center.serviceDiscounts) {
    if (row.isActiveNow) serviceDiscountMap.set(row.serviceId, Math.max(serviceDiscountMap.get(row.serviceId) ?? 0, row.discountPercent))
  }
  const membershipDiscountMap = new Map()
  for (const row of center.membershipDiscounts) {
    if (row.isActiveNow && row.membershipSegment === segment) {
      membershipDiscountMap.set(row.serviceId, Math.max(membershipDiscountMap.get(row.serviceId) ?? 0, row.discountPercent))
    }
  }
  const services = center.services.map(service => {
    const membershipPercent = membershipDiscountMap.get(service.id) ?? 0
    const servicePercent = serviceDiscountMap.get(service.id) ?? 0
    const globalPercent = Number(globalDiscount ?? 0)
    let appliedPercent = 0
    let source = "NONE"
    if (membershipPercent > 0) {
      appliedPercent = membershipPercent
      source = "MEMBERSHIP_OFFER"
    } else if (servicePercent > 0) {
      appliedPercent = servicePercent
      source = "SERVICE_DISCOUNT"
    } else if (globalPercent > 0) {
      appliedPercent = globalPercent
      source = "GLOBAL_DISCOUNT"
    }
    const originalPrice = Number(service.basePrice ?? 0)
    const finalPrice = Math.max(0, originalPrice - (originalPrice * appliedPercent) / 100)
    return {
      serviceId: service.id,
      serviceName: service.name,
      originalPrice,
      finalPrice,
      appliedPercent,
      source,
      priority: source === "MEMBERSHIP_OFFER" ? 1 : source === "COMBO_OFFER" ? 2 : source === "SERVICE_DISCOUNT" ? 3 : source === "GLOBAL_DISCOUNT" ? 4 : 99,
    }
  })
  const visibleCombos = center.combos
    .filter(combo => combo.isActiveNow && (combo.visibleSegments ?? []).includes(segment))
    .map(combo => {
      const actualPrice = combo.serviceIds.reduce((sum, serviceId) => sum + Number(servicesById.get(serviceId)?.basePrice ?? 0), 0)
      const savings = Math.max(0, actualPrice - Number(combo.offerPrice ?? 0))
      return {
        ...combo,
        actualPrice,
        savings,
        source: "COMBO_OFFER",
        priority: 2,
      }
    })
  return { segment, services, combos: visibleCombos, generatedAt: now.toISOString() }
}

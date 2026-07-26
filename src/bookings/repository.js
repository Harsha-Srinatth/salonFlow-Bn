import { v4 as uuid } from "uuid"
import { pool } from "../lib/db-pool.js"
import { decryptPiiText, encryptPiiText } from "../security/crypto-envelope.js"
import { normalizeBookingStatus } from "./validators.js"

const BOOKING_PAYMENT_AGG_COLUMNS = `
  COALESCE((
    SELECT SUM(CASE WHEN pt.source_type IN ('BOOKING', 'WALKIN') THEN pt.amount ELSE 0 END)
    FROM payment_transactions pt
    WHERE pt.booking_id = b.id
  ), 0)::numeric AS collected_amount,
  COALESCE((
    SELECT SUM(CASE WHEN pt.source_type = 'REFUND' THEN pt.amount ELSE 0 END)
    FROM payment_transactions pt
    WHERE pt.booking_id = b.id
  ), 0)::numeric AS refund_amount
`

const PAYMENT_NET_AMOUNT_SQL = `
  CASE WHEN p.source_type = 'REFUND' THEN -p.amount ELSE p.amount END
`

function buildPaymentHistoryMeta(sourceType, amount) {
  const normalized = `${sourceType ?? ""}`.trim().toUpperCase()
  const absAmount = Number(amount ?? 0)
  if (normalized === "REFUND") {
    return {
      transactionLabel: "Refund (Repay to customer)",
      direction: "OUT",
      isRefund: true,
      signedAmount: -absAmount,
    }
  }
  if (normalized === "WALKIN") {
    return {
      transactionLabel: "Walk-in collection",
      direction: "IN",
      isRefund: false,
      signedAmount: absAmount,
    }
  }
  return {
    transactionLabel: "Booking collection",
    direction: "IN",
    isRefund: false,
    signedAmount: absAmount,
  }
}

function toBookingDto(row) {
  const serviceItems = Array.isArray(row.service_items_json) ? row.service_items_json : []
  const status = normalizeBookingStatus(row.status) ?? "PENDING"
  const collectedAmount = Number(row.collected_amount ?? 0)
  const refundAmount = Number(row.refund_amount ?? 0)
  const retainedAmount = Math.round((collectedAmount - refundAmount) * 100) / 100
  const dto = {
    id: row.id,
    customer: decryptPiiText(row.customer_name_enc) ?? row.customer_name,
    customerEmail: decryptPiiText(row.customer_email_enc) ?? row.customer_email ?? "",
    customerPhone: decryptPiiText(row.customer_phone_enc) ?? row.customer_phone ?? "",
    service: row.service_name,
    services: serviceItems,
    stylistId: row.stylist_id ?? null,
    stylistName: row.stylist_name ?? null,
    startsAt: row.starts_at,
    durationMinutes: row.duration_minutes,
    totalAmount: Number(row.total_amount ?? 0),
    discountAmount: Number(row.discount_amount ?? 0),
    payableAmount: Number(row.payable_amount ?? 0),
    penaltyAmount: Number(row.penalty_amount ?? 0),
    overtimeMinutes: Number(row.overtime_minutes ?? 0),
    actualStartAt: row.actual_start_at ?? null,
    completedAt: row.completed_at ?? null,
    invoiceNumber: row.invoice_number ?? null,
    createdBy: row.created_by ?? null,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (status === "CANCELLED") {
    dto.cancellationFinancials = {
      collectedAmount,
      refundAmount,
      retainedAmount,
    }
  }
  return dto
}

export async function listBookings(filters) {
  const where = []
  const values = []
  const sort = filters.sort ?? "starts_asc"
  if (filters.statuses?.length) {
    values.push(filters.statuses)
    where.push(`status = ANY($${values.length}::varchar[])`)
  } else if (filters.status) {
    values.push(filters.status)
    where.push(`status = $${values.length}`)
  }
  if (filters.from) {
    values.push(filters.from)
    where.push(`starts_at >= $${values.length}::timestamptz`)
  }
  if (filters.to) {
    values.push(filters.to)
    where.push(`starts_at <= $${values.length}::timestamptz`)
  }
  if (filters.search) {
    values.push(`%${filters.search}%`)
    where.push(`(customer_name ILIKE $${values.length} OR service_name ILIKE $${values.length})`)
  }
  if (sort === "proximity" && !filters.from && !filters.to) {
    where.push(`starts_at >= date_trunc('day', NOW())`)
    where.push(`starts_at < date_trunc('day', NOW()) + interval '1 day'`)
  }
  let orderBy = "ORDER BY b.starts_at ASC"
  if (sort === "latest") {
    orderBy = "ORDER BY b.created_at DESC NULLS LAST, b.id DESC"
  } else if (sort === "proximity") {
    orderBy =
      "ORDER BY ABS(EXTRACT(EPOCH FROM (b.starts_at - NOW()))) ASC NULLS LAST, b.starts_at ASC"
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const listValues = [...values, filters.limit, filters.offset]
  const { rows } = await pool.query(
    `
      SELECT
        b.id,
        b.customer_name,
        b.customer_name_enc,
        b.customer_email,
        b.customer_email_enc,
        b.customer_phone,
        b.customer_phone_enc,
        b.service_name,
        b.stylist_id,
        u.name AS stylist_name,
        b.starts_at,
        b.duration_minutes,
        b.service_items_json,
        b.total_amount,
        b.discount_amount,
        b.payable_amount,
        b.actual_start_at,
        b.completed_at,
        b.overtime_minutes,
        b.penalty_amount,
        b.invoice_number,
        b.created_by,
        b.status,
        b.created_at,
        b.updated_at,
        ${BOOKING_PAYMENT_AGG_COLUMNS}
      FROM bookings b
      LEFT JOIN users u ON u.id = b.stylist_id
      ${whereSql}
      ${orderBy}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    listValues
  )
  const { rows: countRows } = await pool.query(
    `
      SELECT COUNT(*)::INT AS total
      FROM bookings
      ${whereSql}
    `,
    values
  )
  return {
    bookings: rows.map(toBookingDto),
    pagination: {
      limit: filters.limit,
      offset: filters.offset,
      total: countRows[0]?.total ?? 0,
    },
  }
}

export async function listBookingsForCustomer({ customerEmail, customerPhone, limit = 50, offset = 0 }) {
  const values = [customerEmail, customerPhone, limit, offset]
  const { rows } = await pool.query(
    `
      SELECT
        b.id,
        b.customer_name,
        b.customer_name_enc,
        b.customer_email,
        b.customer_email_enc,
        b.customer_phone,
        b.customer_phone_enc,
        b.service_name,
        b.stylist_id,
        u.name AS stylist_name,
        b.starts_at,
        b.duration_minutes,
        b.service_items_json,
        b.total_amount,
        b.discount_amount,
        b.payable_amount,
        b.actual_start_at,
        b.completed_at,
        b.overtime_minutes,
        b.penalty_amount,
        b.invoice_number,
        b.created_by,
        b.status,
        b.created_at,
        b.updated_at
      FROM bookings b
      LEFT JOIN users u ON u.id = b.stylist_id
      WHERE lower(b.customer_email) = lower($1) OR b.customer_phone = $2
      ORDER BY b.starts_at DESC
      LIMIT $3
      OFFSET $4
    `,
    values
  )
  const { rows: countRows } = await pool.query(
    `
      SELECT COUNT(*)::INT AS total
      FROM bookings
      WHERE lower(customer_email) = lower($1) OR customer_phone = $2
    `,
    [customerEmail, customerPhone]
  )
  return {
    bookings: rows.map(toBookingDto),
    pagination: {
      limit,
      offset,
      total: countRows[0]?.total ?? 0,
    },
  }
}

export async function getBookingForUpdate(client, bookingId) {
  const { rows } = await client.query(
    `
      SELECT id, status, customer_name, customer_name_enc, customer_email, customer_email_enc, customer_phone, customer_phone_enc, service_name, stylist_id, starts_at, duration_minutes, service_items_json, total_amount, discount_amount, payable_amount, actual_start_at, completed_at, overtime_minutes, penalty_amount, invoice_number, created_by, created_at, updated_at
      FROM bookings
      WHERE id = $1
      FOR UPDATE
    `,
    [bookingId]
  )
  return rows[0] ?? null
}

export async function updateBookingStatus(client, { bookingId, status, updatedBy }) {
  const { rows } = await client.query(
    `
      UPDATE bookings
      SET status = $2, updated_by = $3, updated_at = NOW()
      WHERE id = $1
      RETURNING id, customer_name, customer_name_enc, customer_email, customer_email_enc, customer_phone, customer_phone_enc, service_name, stylist_id, starts_at, duration_minutes, service_items_json, total_amount, discount_amount, payable_amount, actual_start_at, completed_at, overtime_minutes, penalty_amount, invoice_number, status, created_by, created_at, updated_at
    `,
    [bookingId, status, updatedBy]
  )
  if (!rows[0]) return null
  const { rows: stylistRows } = await pool.query("SELECT name FROM users WHERE id = $1 LIMIT 1", [rows[0].stylist_id])
  return toBookingDto({ ...rows[0], stylist_name: stylistRows[0]?.name ?? null })
}

export async function insertAuditLog(client, { action, performedBy, resourceId, originalValue, newValue }) {
  await client.query(
    `
      INSERT INTO audit_logs (id, action, performed_by, resource_id, resource_type, original_value, new_value)
      VALUES ($1, $2, $3, $4, 'BOOKING', $5::jsonb, $6::jsonb)
    `,
    [uuid(), action, performedBy, resourceId, JSON.stringify(originalValue), JSON.stringify(newValue)]
  )
}

export async function withTransaction(run) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const value = await run(client)
    await client.query("COMMIT")
    return value
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function createBooking({
  customerName,
  customerEmail,
  customerPhone,
  serviceName,
  serviceItems,
  stylistId,
  startsAt,
  durationMinutes,
  totalAmount,
  discountAmount,
  payableAmount,
  invoiceNumber,
  createdBy,
  status = "CONFIRMED",
}) {
  const encryptedName = encryptPiiText(customerName)
  const encryptedEmail = encryptPiiText(customerEmail)
  const encryptedPhone = encryptPiiText(customerPhone)
  const { rows } = await pool.query(
    `
      INSERT INTO bookings (
        id,
        customer_name,
        customer_name_enc,
        customer_email,
        customer_email_enc,
        customer_phone,
        customer_phone_enc,
        service_name,
        service_items_json,
        stylist_id,
        starts_at,
        duration_minutes,
        total_amount,
        discount_amount,
        payable_amount,
        invoice_number,
        status,
        created_by,
        updated_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING id, customer_name, customer_name_enc, customer_email, customer_email_enc, customer_phone, customer_phone_enc, service_name, stylist_id, starts_at, duration_minutes, service_items_json, total_amount, discount_amount, payable_amount, actual_start_at, completed_at, overtime_minutes, penalty_amount, invoice_number, status, created_by, created_at, updated_at
    `,
    [
      uuid(),
      customerName,
      encryptedName,
      customerEmail,
      encryptedEmail,
      customerPhone,
      encryptedPhone,
      serviceName,
      JSON.stringify(serviceItems ?? []),
      stylistId,
      startsAt,
      durationMinutes,
      Number(totalAmount ?? 0),
      Number(discountAmount ?? 0),
      Number(payableAmount ?? 0),
      invoiceNumber ?? null,
      status,
      createdBy,
      createdBy,
    ]
  )
  if (!rows[0]) return null
  const { rows: stylistRows } = await pool.query("SELECT name FROM users WHERE id = $1 LIMIT 1", [rows[0].stylist_id])
  return toBookingDto({ ...rows[0], stylist_name: stylistRows[0]?.name ?? null })
}

export async function findOrCreateWalkinCustomerAccount({ customerName, customerEmail, customerPhone }) {
  const normalizedEmail = `${customerEmail ?? ""}`.trim().toLowerCase()
  const normalizedPhone = `${customerPhone ?? ""}`.trim()
  const normalizedName = `${customerName ?? ""}`.trim()
  const { rows } = await pool.query(
    `
      SELECT id, name, email, phone, role, account_status
      FROM users
      WHERE lower(btrim(email)) = lower($1) OR phone = $2
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [normalizedEmail, normalizedPhone]
  )
  const existing = rows[0] ?? null
  if (existing) {
    if (existing.role !== "USER") {
      const error = new Error("Provided phone/email belongs to staff/admin account")
      error.code = "BAD_REQUEST"
      throw error
    }
    await pool.query(
      `
        UPDATE users
        SET
          name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
          email = CASE WHEN $3 <> '' THEN $3 ELSE email END,
          phone = CASE WHEN $4 <> '' THEN $4 ELSE phone END,
          updated_at = NOW()
        WHERE id = $1
      `,
      [existing.id, normalizedName, normalizedEmail, normalizedPhone]
    )
    return {
      id: existing.id,
      isNew: false,
      accountStatus: existing.account_status,
    }
  }
  const id = uuid()
  let inserted
  try {
    inserted = await pool.query(
      `
        INSERT INTO users (id, name, email, phone, role, gender, account_status, latitude, longitude)
        VALUES ($1, $2, $3, $4, 'USER', 'OTHER', 'PENDING_VERIFICATION', 0, 0)
        RETURNING id, account_status
      `,
      [id, normalizedName, normalizedEmail, normalizedPhone]
    )
  } catch (error) {
    if (error?.code !== "23505") throw error
    const { rows: retryRows } = await pool.query(
      `
        SELECT id, role, account_status
        FROM users
        WHERE lower(btrim(email)) = lower($1) OR phone = $2
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT 1
      `,
      [normalizedEmail, normalizedPhone]
    )
    const retryUser = retryRows[0] ?? null
    if (!retryUser || retryUser.role !== "USER") {
      const conflictError = new Error("Could not create or resolve customer account")
      conflictError.code = "BAD_REQUEST"
      throw conflictError
    }
    return {
      id: retryUser.id,
      isNew: false,
      accountStatus: retryUser.account_status,
    }
  }
  return {
    id: inserted.rows[0].id,
    isNew: true,
    accountStatus: inserted.rows[0].account_status,
  }
}

export async function lookupWalkinCustomerByPhoneOrEmail({ customerEmail, customerPhone }) {
  const normalizedEmail = `${customerEmail ?? ""}`.trim().toLowerCase()
  const normalizedPhone = `${customerPhone ?? ""}`.trim()
  if (!normalizedEmail && !normalizedPhone) return null
  const { rows } = await pool.query(
    `
      SELECT id, name, email, phone, role, account_status, membership_segment
      FROM users
      WHERE ($1 <> '' AND lower(btrim(email)) = lower($1))
         OR ($2 <> '' AND phone = $2)
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [normalizedEmail, normalizedPhone]
  )
  const row = rows[0] ?? null
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    accountStatus: row.account_status,
    membershipSegment: `${row.membership_segment ?? "FREE"}`.trim().toUpperCase() || "FREE",
    isExistingCustomer: row.role === "USER",
  }
}

export async function listReceptionStylists() {
  const { rows } = await pool.query(
    `
      SELECT u.id, u.name, u.email, u.phone
      FROM users u
      LEFT JOIN stylist_profiles sp ON sp.stylist_id = u.id
      WHERE u.role = 'STAFF' AND u.account_status = 'ACTIVE' AND COALESCE(sp.is_active, TRUE) = TRUE
      ORDER BY name ASC
    `
  )
  return rows
}

function toServiceDto(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    gender: row.target_gender,
    basePrice: Number(row.base_price ?? 0),
    duration: Number(row.duration_minutes ?? 45),
    description: row.description ?? "",
    image: row.image_url ?? "",
    variants: Array.isArray(row.variants_json) ? row.variants_json : [],
    discountPercent: Number(row.discount_percent ?? 0),
    isActive: Boolean(row.is_active),
  }
}

export async function listServiceCatalog({ includeInactive = false } = {}) {
  const { rows } = await pool.query(
    `
      SELECT id, name, category, target_gender, base_price, duration_minutes, description, image_url, variants_json, discount_percent, is_active
      FROM service_catalog
      WHERE ($1::boolean = TRUE OR is_active = TRUE)
      ORDER BY name ASC
    `,
    [Boolean(includeInactive)]
  )
  return rows.map(toServiceDto)
}

export async function createServiceCatalogItem({
  name,
  category,
  targetGender,
  basePrice,
  durationMinutes,
  description,
  imageUrl,
  variants,
  createdBy,
}) {
  const serviceId = uuid()
  const { rows } = await pool.query(
    `
      INSERT INTO service_catalog (
        id, name, category, target_gender, base_price, duration_minutes,
        description, image_url, variants_json, discount_percent, is_active, created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,0,TRUE,$10)
      RETURNING id, name, category, target_gender, base_price, duration_minutes, description, image_url, variants_json, discount_percent, is_active
    `,
    [
      serviceId,
      name,
      category,
      targetGender,
      Number(basePrice),
      Number(durationMinutes),
      description || null,
      imageUrl || null,
      JSON.stringify(variants ?? []),
      createdBy,
    ]
  )
  const service = rows[0]
  if (!service) return null
  return toServiceDto(service)
}

export async function updateServiceCatalogItem({
  id,
  name,
  category,
  targetGender,
  basePrice,
  durationMinutes,
  description,
  imageUrl,
  variants,
  discountPercent,
  isActive,
}) {
  const { rows } = await pool.query(
    `
      UPDATE service_catalog
      SET
        name = $2,
        category = $3,
        target_gender = $4,
        base_price = $5,
        duration_minutes = $6,
        description = $7,
        image_url = $8,
        variants_json = $9::jsonb,
        discount_percent = COALESCE($10::numeric, discount_percent),
        is_active = $11,
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, category, target_gender, base_price, duration_minutes, description, image_url, variants_json, discount_percent, is_active
    `,
    [
      id,
      name,
      category,
      targetGender,
      Number(basePrice),
      Number(durationMinutes),
      description || null,
      imageUrl || null,
      JSON.stringify(variants ?? []),
      discountPercent === undefined ? null : Number(discountPercent),
      Boolean(isActive),
    ]
  )
  return rows[0] ? toServiceDto(rows[0]) : null
}

export async function upsertServiceDiscounts(items) {
  for (const item of items) {
    await pool.query(
      `
        UPDATE service_catalog
        SET discount_percent = $2, updated_at = NOW()
        WHERE id = $1
      `,
      [item.id, Number(item.discountPercent ?? 0)]
    )
  }
}

export async function findAvailableStylistsForServices({ serviceIds, startsAt, durationMinutes, customerGender }) {
  const mins = Number(durationMinutes ?? 45)
  const slotBufferMinutes = Number(process.env.BOOKING_SLOT_BUFFER_MINUTES ?? 0)
  const normalizedGender = `${customerGender ?? "UNSPECIFIED"}`.trim().toUpperCase()
  const allowedSegments = normalizedGender === "FEMALE" ? ["WOMEN_ONLY", "UNISEX"] : normalizedGender === "MALE" ? ["MEN_ONLY", "UNISEX"] : ["UNISEX", "MEN_ONLY", "WOMEN_ONLY"]
  const { rows } = await pool.query(
    `
      WITH requested AS (
        SELECT unnest($1::uuid[]) AS service_id
      ),
      requested_count AS (
        SELECT COUNT(*)::INT AS total FROM requested
      ),
      matched AS (
        SELECT u.id, u.name, COUNT(DISTINCT r.service_id)::INT AS matched_count
        FROM users u
        LEFT JOIN stylist_profiles sp ON sp.stylist_id = u.id
        LEFT JOIN stylist_service_map m ON m.stylist_id = u.id
        LEFT JOIN requested r ON r.service_id = m.service_id
        WHERE u.role = 'STAFF' AND u.account_status = 'ACTIVE'
          AND COALESCE(sp.target_segment, 'UNISEX') = ANY($5::text[])
          AND COALESCE(sp.is_active, TRUE) = TRUE
        GROUP BY u.id, u.name
      ),
      available AS (
        SELECT m.id, m.name, m.matched_count
        FROM matched m
        CROSS JOIN requested_count rc
        WHERE m.matched_count = rc.total
          AND NOT EXISTS (
            SELECT 1
            FROM bookings b
            WHERE b.stylist_id = m.id
              AND tstzrange(
                b.starts_at - make_interval(mins => $4::int),
                b.starts_at + make_interval(mins => b.duration_minutes + $4::int),
                '[)'
              )
              && tstzrange(
                $2::timestamptz - make_interval(mins => $4::int),
                $2::timestamptz + make_interval(mins => $3::int + $4::int),
                '[)'
              )
              AND b.status IN ('PENDING','CONFIRMED','STARTED')
          )
      )
      SELECT id, name, matched_count
      FROM available
      ORDER BY matched_count DESC, name ASC
    `,
    [serviceIds, startsAt, mins, slotBufferMinutes, allowedSegments]
  )
  return rows
}

export async function listEligibleStylistsForServices({ serviceIds, customerGender }) {
  const normalizedGender = `${customerGender ?? "UNSPECIFIED"}`.trim().toUpperCase()
  const allowedSegments = normalizedGender === "FEMALE" ? ["WOMEN_ONLY", "UNISEX"] : normalizedGender === "MALE" ? ["MEN_ONLY", "UNISEX"] : ["UNISEX", "MEN_ONLY", "WOMEN_ONLY"]
  const { rows } = await pool.query(
    `
      WITH requested AS (
        SELECT unnest($1::uuid[]) AS service_id
      ),
      requested_count AS (
        SELECT COUNT(*)::INT AS total FROM requested
      ),
      matched AS (
        SELECT
          u.id,
          u.name,
          u.email,
          u.phone,
          sw.shift_start,
          sw.shift_end,
          COUNT(DISTINCT r.service_id)::INT AS matched_count
        FROM users u
        LEFT JOIN stylist_profiles sp ON sp.stylist_id = u.id
        LEFT JOIN stylist_shift_windows sw ON sw.stylist_id = u.id
        LEFT JOIN stylist_service_map m ON m.stylist_id = u.id
        LEFT JOIN requested r ON r.service_id = m.service_id
        WHERE u.role = 'STAFF'
          AND u.account_status = 'ACTIVE'
          AND COALESCE(sp.is_active, TRUE) = TRUE
          AND COALESCE(sp.target_segment, 'UNISEX') = ANY($2::text[])
        GROUP BY u.id, u.name, u.email, u.phone, sw.shift_start, sw.shift_end
      )
      SELECT id, name, email, phone, COALESCE(shift_start, '08:00') AS shift_start, COALESCE(shift_end, '23:00') AS shift_end
      FROM matched m
      CROSS JOIN requested_count rc
      WHERE m.matched_count = rc.total
      ORDER BY name ASC
    `,
    [serviceIds, allowedSegments]
  )
  return rows
}

export async function listBookingsForStylistsInRange({ stylistIds, rangeStart, rangeEnd }) {
  if (!Array.isArray(stylistIds) || !stylistIds.length) return []
  const { rows } = await pool.query(
    `
      SELECT id, stylist_id, starts_at, duration_minutes, status
      FROM bookings
      WHERE stylist_id = ANY($1::uuid[])
        AND starts_at >= $2::timestamptz
        AND starts_at < $3::timestamptz
        AND status IN ('PENDING', 'CONFIRMED', 'STARTED')
      ORDER BY starts_at ASC
    `,
    [stylistIds, rangeStart, rangeEnd]
  )
  return rows
}

export async function listLeavesForStylistsOnDate({ stylistIds, date }) {
  if (!Array.isArray(stylistIds) || !stylistIds.length) return []
  const { rows } = await pool.query(
    `
      SELECT stylist_id
      FROM stylist_leaves
      WHERE stylist_id = ANY($1::uuid[])
        AND $2::date BETWEEN leave_start AND leave_end
    `,
    [stylistIds, date]
  )
  return rows
}

export async function upsertStylistShift({ stylistId, shiftStart, shiftEnd, isActive = true }) {
  const { rows } = await pool.query(
    `
      INSERT INTO stylist_shift_windows (id, stylist_id, shift_start, shift_end, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (stylist_id) DO UPDATE
      SET shift_start = EXCLUDED.shift_start,
          shift_end = EXCLUDED.shift_end,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
      RETURNING stylist_id, shift_start, shift_end, is_active
    `,
    [uuid(), stylistId, shiftStart, shiftEnd, Boolean(isActive)]
  )
  return rows[0] ?? null
}

export async function createStylistLeave({ stylistId, leaveStart, leaveEnd, note, createdBy }) {
  const { rows } = await pool.query(
    `
      INSERT INTO stylist_leaves (id, stylist_id, leave_start, leave_end, note, created_by)
      VALUES ($1, $2, $3::date, $4::date, $5, $6)
      RETURNING id, stylist_id, leave_start, leave_end, note, created_at
    `,
    [uuid(), stylistId, leaveStart, leaveEnd, note ?? null, createdBy]
  )
  return rows[0] ?? null
}

export async function deleteBookingById(bookingId) {
  const { rowCount } = await pool.query(`DELETE FROM bookings WHERE id = $1`, [bookingId])
  return rowCount > 0
}

export async function getBookingById(bookingId) {
  const { rows } = await pool.query(
    `
      SELECT
        b.id, b.customer_name, b.customer_name_enc, b.customer_email, b.customer_email_enc, b.customer_phone, b.customer_phone_enc,
        b.service_name, b.service_items_json, b.stylist_id, u.name AS stylist_name, b.starts_at, b.duration_minutes,
        b.total_amount, b.discount_amount, b.payable_amount, b.invoice_number, b.status, b.created_by, b.created_at, b.updated_at,
        ${BOOKING_PAYMENT_AGG_COLUMNS}
      FROM bookings b
      LEFT JOIN users u ON u.id = b.stylist_id
      WHERE b.id = $1
      LIMIT 1
    `,
    [bookingId]
  )
  return rows[0] ? toBookingDto(rows[0]) : null
}

export async function updateBookingSchedule({ bookingId, stylistId, startsAt, durationMinutes, updatedBy, status }) {
  const { rows } = await pool.query(
    `
      UPDATE bookings
      SET
        stylist_id = COALESCE($2, stylist_id),
        starts_at = COALESCE($3::timestamptz, starts_at),
        duration_minutes = COALESCE($4, duration_minutes),
        status = COALESCE($5, status),
        updated_by = $6,
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, customer_name, customer_name_enc, customer_email, customer_email_enc, customer_phone, customer_phone_enc, service_name, stylist_id, starts_at, duration_minutes, service_items_json, total_amount, discount_amount, payable_amount, invoice_number, status, created_by, created_at, updated_at
    `,
    [bookingId, stylistId ?? null, startsAt ?? null, durationMinutes ?? null, status ?? null, updatedBy]
  )
  if (!rows[0]) return null
  const { rows: stylistRows } = await pool.query("SELECT name FROM users WHERE id = $1 LIMIT 1", [rows[0].stylist_id])
  return toBookingDto({ ...rows[0], stylist_name: stylistRows[0]?.name ?? null })
}

export async function findOverdueStartedBookingsForAutoComplete() {
  const { rows } = await pool.query(
    `
      SELECT id, stylist_id
      FROM bookings
      WHERE status = 'STARTED'
        AND date_trunc('day', NOW()) > date_trunc('day', COALESCE(actual_start_at, starts_at))
    `
  )
  return rows
}

export async function listQueueBookingsForRole({ role, userId, limit = 100 }) {
  const values = [limit]
  let roleWhere = ""
  if (role === "STAFF") {
    values.push(userId)
    roleWhere = `AND b.stylist_id = $2`
  }
  const { rows } = await pool.query(
    `
      SELECT
        b.id, b.customer_name, b.customer_name_enc, b.customer_email, b.customer_email_enc, b.customer_phone, b.customer_phone_enc,
        b.service_name, b.service_items_json, b.stylist_id, u.name AS stylist_name, b.starts_at, b.duration_minutes,
        b.total_amount, b.discount_amount, b.payable_amount, b.actual_start_at, b.completed_at, b.overtime_minutes, b.penalty_amount, b.invoice_number, b.status, b.created_by, b.created_at, b.updated_at
      FROM bookings b
      LEFT JOIN users u ON u.id = b.stylist_id
      WHERE (
        (
          b.status IN ('PENDING', 'CONFIRMED')
          AND b.starts_at >= date_trunc('day', NOW())
          AND b.starts_at < date_trunc('day', NOW()) + interval '1 day'
        )
        OR b.status = 'STARTED'
      )
      ${roleWhere}
      ORDER BY ABS(EXTRACT(EPOCH FROM (b.starts_at - NOW()))) ASC NULLS LAST, b.starts_at ASC
      LIMIT $1
    `,
    values
  )
  return rows.map(toBookingDto)
}

export async function markBookingStarted({ bookingId, stylistId, startedAt = new Date().toISOString() }) {
  const { rows } = await pool.query(
    `
      UPDATE bookings
      SET
        status = 'STARTED',
        actual_start_at = COALESCE(actual_start_at, $3::timestamptz),
        updated_by = $2,
        updated_at = NOW()
      WHERE id = $1 AND stylist_id = $2
      RETURNING id, customer_name, customer_name_enc, customer_email, customer_email_enc, customer_phone, customer_phone_enc, service_name, stylist_id, starts_at, duration_minutes, service_items_json, total_amount, discount_amount, payable_amount, actual_start_at, completed_at, overtime_minutes, penalty_amount, invoice_number, status, created_by, created_at, updated_at
    `,
    [bookingId, stylistId, startedAt]
  )
  if (!rows[0]) return null
  const { rows: stylistRows } = await pool.query("SELECT name FROM users WHERE id = $1 LIMIT 1", [rows[0].stylist_id])
  return toBookingDto({ ...rows[0], stylist_name: stylistRows[0]?.name ?? null })
}

export async function markBookingCompletedWithPenalty({
  bookingId,
  stylistId,
  completedAt = new Date().toISOString(),
  graceMinutes = 10,
  penaltyPerMinute = 0,
}) {
  const { rows } = await pool.query(
    `
      SELECT id, stylist_id, starts_at, actual_start_at, duration_minutes
      FROM bookings
      WHERE id = $1 AND stylist_id = $2
      LIMIT 1
    `,
    [bookingId, stylistId]
  )
  const current = rows[0]
  if (!current) return null
  const actualStart = new Date(current.actual_start_at ?? current.starts_at)
  const end = new Date(completedAt)
  const elapsed = Math.max(0, Math.ceil((end.getTime() - actualStart.getTime()) / (60 * 1000)))
  const planned = Number(current.duration_minutes ?? 0)
  const overtimeMinutes = Math.max(0, elapsed - planned)
  const chargeableOvertime = Math.max(0, overtimeMinutes - Number(graceMinutes ?? 10))
  const penaltyAmount = chargeableOvertime * Number(penaltyPerMinute ?? 0)

  const { rows: updateRows } = await pool.query(
    `
      UPDATE bookings
      SET
        status = 'COMPLETED',
        completed_at = $3::timestamptz,
        overtime_minutes = $4,
        penalty_amount = $5,
        updated_by = $2,
        updated_at = NOW()
      WHERE id = $1 AND stylist_id = $2
      RETURNING id, customer_name, customer_name_enc, customer_email, customer_email_enc, customer_phone, customer_phone_enc, service_name, stylist_id, starts_at, duration_minutes, service_items_json, total_amount, discount_amount, payable_amount, actual_start_at, completed_at, overtime_minutes, penalty_amount, invoice_number, status, created_by, created_at, updated_at
    `,
    [bookingId, stylistId, completedAt, overtimeMinutes, penaltyAmount]
  )
  if (!updateRows[0]) return null
  const { rows: stylistRows } = await pool.query("SELECT name FROM users WHERE id = $1 LIMIT 1", [updateRows[0].stylist_id])
  return toBookingDto({ ...updateRows[0], stylist_name: stylistRows[0]?.name ?? null })
}

export async function getPayrollPolicy() {
  const { rows } = await pool.query(
    `
      SELECT grace_minutes, penalty_per_minute
      FROM admin_payroll_policy
      ORDER BY updated_at DESC
      LIMIT 1
    `
  )
  return rows[0]
    ? {
        graceMinutes: Number(rows[0].grace_minutes ?? 10),
        penaltyPerMinute: Number(rows[0].penalty_per_minute ?? 0),
      }
    : { graceMinutes: 10, penaltyPerMinute: 0 }
}

export async function upsertPayrollPolicy({ graceMinutes, penaltyPerMinute, updatedBy }) {
  const { rows } = await pool.query("SELECT id FROM admin_payroll_policy ORDER BY updated_at DESC LIMIT 1")
  const id = rows[0]?.id ?? uuid()
  await pool.query(
    `
      INSERT INTO admin_payroll_policy (id, grace_minutes, penalty_per_minute, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (id) DO UPDATE
      SET grace_minutes = EXCLUDED.grace_minutes,
          penalty_per_minute = EXCLUDED.penalty_per_minute,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
    `,
    [id, graceMinutes, penaltyPerMinute, updatedBy]
  )
  return getPayrollPolicy()
}

export async function listMonthlyStylistDeductions({ month }) {
  const start = new Date(`${month}-01T00:00:00.000Z`)
  const end = new Date(start)
  end.setUTCMonth(start.getUTCMonth() + 1)
  const { rows } = await pool.query(
    `
      SELECT
        b.stylist_id,
        u.name AS stylist_name,
        COUNT(*)::int AS bookings_count,
        COALESCE(SUM(b.overtime_minutes), 0)::int AS overtime_minutes,
        COALESCE(SUM(b.penalty_amount), 0)::numeric AS total_penalty
      FROM bookings b
      JOIN users u ON u.id = b.stylist_id
      WHERE b.stylist_id IS NOT NULL
        AND b.status = 'COMPLETED'
        AND b.completed_at >= $1::timestamptz
        AND b.completed_at < $2::timestamptz
      GROUP BY b.stylist_id, u.name
      ORDER BY total_penalty DESC, stylist_name ASC
    `,
    [start.toISOString(), end.toISOString()]
  )
  return rows.map((row) => ({
    stylistId: row.stylist_id,
    stylistName: row.stylist_name,
    bookingsCount: Number(row.bookings_count ?? 0),
    overtimeMinutes: Number(row.overtime_minutes ?? 0),
    totalPenalty: Number(row.total_penalty ?? 0),
  }))
}

export async function createPaymentTransaction({
  bookingId,
  sourceType,
  customerName,
  customerEmail,
  customerPhone,
  amount,
  paymentMode,
  collectedBy,
}) {
  const { rows } = await pool.query(
    `
      INSERT INTO payment_transactions (
        id, booking_id, source_type, customer_name, customer_email, customer_phone, amount, payment_mode, collected_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, booking_id, source_type, customer_name, customer_email, customer_phone, amount, payment_mode, collected_by, collected_at
    `,
    [
      uuid(),
      bookingId ?? null,
      sourceType,
      customerName,
      customerEmail ?? null,
      customerPhone ?? null,
      Number(amount ?? 0),
      paymentMode,
      collectedBy ?? null,
    ]
  )
  return rows[0] ?? null
}

function formatPaymentServicesLabel(row) {
  if (row.booking_service_name) return row.booking_service_name
  const items = Array.isArray(row.service_items_json) ? row.service_items_json : []
  if (items.length) return items.map(item => item?.name).filter(Boolean).join(", ")
  if (row.source_type === "WALKIN") return "Walk-in"
  return "—"
}

function toPaymentHistoryDto(row) {
  const amount = Number(row.amount ?? 0)
  const meta = buildPaymentHistoryMeta(row.source_type, amount)
  return {
    id: row.id,
    bookingId: row.booking_id ?? null,
    sourceType: row.source_type,
    bookingStatus: row.booking_status ?? null,
    customerName: row.customer_name,
    customerEmail: row.customer_email ?? "",
    customerPhone: row.customer_phone ?? "",
    services: formatPaymentServicesLabel(row),
    amount,
    signedAmount: meta.signedAmount,
    transactionLabel: meta.transactionLabel,
    direction: meta.direction,
    isRefund: meta.isRefund,
    paymentMode: row.payment_mode,
    collectedAt: row.collected_at,
    collectedByName: row.collected_by_name ?? "—",
  }
}

export async function listPaymentTransactions({ month, paymentMode, from, to, limit = 100, offset = 0 }) {
  const where = []
  const values = []
  if (month && /^\d{4}-\d{2}$/.test(`${month}`.trim())) {
    const start = new Date(`${month}-01T00:00:00.000Z`)
    const end = new Date(start)
    end.setUTCMonth(end.getUTCMonth() + 1)
    values.push(start.toISOString(), end.toISOString())
    where.push(`p.collected_at >= $${values.length - 1}::timestamptz AND p.collected_at < $${values.length}::timestamptz`)
  }
  if (from) {
    values.push(from)
    where.push(`p.collected_at >= $${values.length}::timestamptz`)
  }
  if (to) {
    values.push(to)
    where.push(`p.collected_at <= $${values.length}::timestamptz`)
  }
  if (paymentMode) {
    values.push(paymentMode)
    where.push(`p.payment_mode = $${values.length}`)
  }
  const safeLimit = Math.min(Math.max(Number(limit ?? 100), 1), 500)
  const safeOffset = Math.max(Number(offset ?? 0), 0)
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const listValues = [...values, safeLimit, safeOffset]
  const { rows } = await pool.query(
    `
      SELECT
        p.id,
        p.booking_id,
        p.source_type,
        p.customer_name,
        p.customer_email,
        p.customer_phone,
        p.amount,
        p.payment_mode,
        p.collected_at,
        u.name AS collected_by_name,
        b.service_name AS booking_service_name,
        b.service_items_json,
        b.status AS booking_status
      FROM payment_transactions p
      LEFT JOIN users u ON u.id = p.collected_by
      LEFT JOIN bookings b ON b.id = p.booking_id
      ${whereSql}
      ORDER BY p.collected_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    listValues
  )
  const { rows: countRows } = await pool.query(
    `
      SELECT COUNT(*)::INT AS total
      FROM payment_transactions p
      ${whereSql}
    `,
    values
  )
  return {
    payments: rows.map(toPaymentHistoryDto),
    pagination: {
      limit: safeLimit,
      offset: safeOffset,
      total: countRows[0]?.total ?? 0,
    },
  }
}

export async function listRecentPaymentTransactions(filters) {
  const result = await listPaymentTransactions(filters)
  return result.payments
}

const SALON_TIMEZONE = process.env.SALON_TIMEZONE ?? "Asia/Kolkata"

export async function getRevenueSummaryForDate({ timezone = SALON_TIMEZONE } = {}) {
  const { rows } = await pool.query(
    `
      WITH local_now AS (
        SELECT timezone($1::text, now()) AS ts
      ),
      bounds AS (
        SELECT
          (date_trunc('day', ts) AT TIME ZONE $1) AS day_start,
          ((date_trunc('day', ts) + interval '1 day') AT TIME ZONE $1) AS day_end,
          (date_trunc('week', ts) AT TIME ZONE $1) AS week_start,
          ((date_trunc('week', ts) + interval '1 week') AT TIME ZONE $1) AS week_end,
          ((date_trunc('week', ts) - interval '1 week') AT TIME ZONE $1) AS prev_week_start,
          (date_trunc('week', ts) AT TIME ZONE $1) AS prev_week_end,
          (date_trunc('month', ts) AT TIME ZONE $1) AS month_start,
          ((date_trunc('month', ts) + interval '1 month') AT TIME ZONE $1) AS month_end,
          (date_trunc('year', ts) AT TIME ZONE $1) AS year_start,
          ((date_trunc('year', ts) + interval '1 year') AT TIME ZONE $1) AS year_end
        FROM local_now
      )
      SELECT
        COALESCE(SUM(CASE WHEN p.collected_at >= b.day_start AND p.collected_at < b.day_end THEN ${PAYMENT_NET_AMOUNT_SQL} ELSE 0 END), 0)::numeric AS day_total,
        COALESCE(SUM(CASE WHEN p.collected_at >= b.week_start AND p.collected_at < b.week_end THEN ${PAYMENT_NET_AMOUNT_SQL} ELSE 0 END), 0)::numeric AS week_total,
        COALESCE(SUM(CASE WHEN p.collected_at >= b.month_start AND p.collected_at < b.month_end THEN ${PAYMENT_NET_AMOUNT_SQL} ELSE 0 END), 0)::numeric AS month_total,
        COALESCE(SUM(CASE WHEN p.collected_at >= b.year_start AND p.collected_at < b.year_end THEN ${PAYMENT_NET_AMOUNT_SQL} ELSE 0 END), 0)::numeric AS year_total,
        COALESCE(SUM(CASE WHEN p.collected_at >= b.prev_week_start AND p.collected_at < b.prev_week_end THEN ${PAYMENT_NET_AMOUNT_SQL} ELSE 0 END), 0)::numeric AS prev_week_total
      FROM payment_transactions p
      CROSS JOIN bounds b
    `,
    [timezone]
  )
  const row = rows[0] ?? {}
  return {
    dayTotal: Number(row.day_total ?? 0),
    weekTotal: Number(row.week_total ?? 0),
    monthTotal: Number(row.month_total ?? 0),
    yearTotal: Number(row.year_total ?? 0),
    prevWeekTotal: Number(row.prev_week_total ?? 0),
    timezone,
  }
}

export async function getPaymentHistoryById(paymentId) {
  const { rows } = await pool.query(
    `
      SELECT
        p.id,
        p.booking_id,
        p.source_type,
        p.customer_name,
        p.customer_email,
        p.customer_phone,
        p.amount,
        p.payment_mode,
        p.collected_at,
        u.name AS collected_by_name,
        b.service_name AS booking_service_name,
        b.service_items_json,
        b.status AS booking_status
      FROM payment_transactions p
      LEFT JOIN users u ON u.id = p.collected_by
      LEFT JOIN bookings b ON b.id = p.booking_id
      WHERE p.id = $1
      LIMIT 1
    `,
    [paymentId]
  )
  return rows[0] ? toPaymentHistoryDto(rows[0]) : null
}

export async function ensureStylistProfilesForActiveStaff() {
  const { rows: stylistRows } = await pool.query(`
    SELECT id
    FROM users
    WHERE role = 'STAFF' AND account_status = 'ACTIVE'
  `)
  for (const stylist of stylistRows) {
    await pool.query(
      `
        INSERT INTO stylist_profiles (stylist_id, target_segment)
        VALUES ($1, 'UNISEX')
        ON CONFLICT (stylist_id) DO NOTHING
      `,
      [stylist.id]
    )
  }
}

/** Removes legacy auto-seeded demo rows (Aarav Kumar / Ishita Reddy) from empty databases. */
export async function removeLegacyDemoSeedBookings() {
  const { rows } = await pool.query(
    `
      SELECT id
      FROM bookings
      WHERE created_by IS NULL
        AND stylist_id IS NULL
        AND COALESCE(total_amount, 0) = 0
        AND COALESCE(payable_amount, 0) = 0
        AND (
          (customer_name = 'Aarav Kumar' AND service_name = 'Haircut')
          OR (customer_name = 'Ishita Reddy' AND service_name = 'Hair Color')
        )
    `
  )
  const ids = rows.map(row => row.id).filter(Boolean)
  if (!ids.length) return 0
  await pool.query(`DELETE FROM payment_transactions WHERE booking_id = ANY($1::uuid[])`, [ids])
  const { rowCount } = await pool.query(`DELETE FROM bookings WHERE id = ANY($1::uuid[])`, [ids])
  return rowCount ?? 0
}

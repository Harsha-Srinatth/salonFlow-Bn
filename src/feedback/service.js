import { v4 as uuid } from "uuid"
import { pool } from "../lib/db-pool.js"
import { createSchemaEnsurer } from "../lib/schema-guard.js"
import { getBookingById } from "../bookings/repository.js"
import { normalizeBookingStatus } from "../bookings/validators.js"
import { notifyRole, notifyUser } from "../notifications/service.js"

export const ensureFeedbackSchema = createSchemaEnsurer({
  name: "feedback",
  async migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id UUID PRIMARY KEY,
        booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        customer_id UUID REFERENCES users(id) ON DELETE SET NULL,
        customer_name VARCHAR(255) NOT NULL,
        service_name VARCHAR(255),
        stylist_id UUID REFERENCES users(id) ON DELETE SET NULL,
        stylist_name VARCHAR(255),
        rating SMALLINT NOT NULL,
        comment TEXT,
        type VARCHAR(16) NOT NULL DEFAULT 'FEEDBACK',
        status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
        admin_response TEXT,
        resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT feedback_booking_uq UNIQUE (booking_id),
        CONSTRAINT feedback_rating_range CHECK (rating BETWEEN 1 AND 5)
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS feedback_status_idx ON feedback(status)`)
    await client.query(`CREATE INDEX IF NOT EXISTS feedback_customer_id_idx ON feedback(customer_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback(created_at)`)
  },
})

function customerOwnsBooking(booking, actorUser) {
  const email = `${actorUser?.email ?? ""}`.trim().toLowerCase()
  const phone = `${actorUser?.phone ?? ""}`.trim()
  const bookingEmail = `${booking?.customerEmail ?? ""}`.trim().toLowerCase()
  const bookingPhone = `${booking?.customerPhone ?? ""}`.trim()
  if (booking?.createdBy && actorUser?.id && booking.createdBy === actorUser.id) return true
  if (email && bookingEmail && email === bookingEmail) return true
  if (phone && bookingPhone && phone === bookingPhone) return true
  return false
}

function toFeedbackDto(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    customerId: row.customer_id ?? null,
    customerName: row.customer_name,
    serviceName: row.service_name ?? "",
    stylistId: row.stylist_id ?? null,
    stylistName: row.stylist_name ?? "",
    rating: Number(row.rating ?? 0),
    comment: row.comment ?? "",
    type: row.type,
    status: row.status,
    adminResponse: row.admin_response ?? "",
    resolvedAt: row.resolved_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createCustomerFeedback({ bookingId, actorUser, rating, comment, type }) {
  await ensureFeedbackSchema()
  const booking = await getBookingById(bookingId)
  if (!booking) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
  if (!customerOwnsBooking(booking, actorUser)) {
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" })
  }
  if (normalizeBookingStatus(booking.status) !== "COMPLETED") {
    throw Object.assign(new Error("You can only review a completed service"), { code: "BAD_REQUEST" })
  }
  const numericRating = Number(rating)
  if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
    throw Object.assign(new Error("Rating must be a whole number between 1 and 5"), { code: "BAD_REQUEST" })
  }
  const normalizedType = `${type ?? ""}`.trim().toUpperCase() === "COMPLAINT" ? "COMPLAINT" : "FEEDBACK"
  const normalizedComment = `${comment ?? ""}`.trim().slice(0, 2000) || null

  try {
    const { rows } = await pool.query(
      `
        INSERT INTO feedback (
          id, booking_id, customer_id, customer_name, service_name, stylist_id, stylist_name,
          rating, comment, type, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'OPEN')
        RETURNING *
      `,
      [
        uuid(),
        booking.id,
        actorUser?.id ?? null,
        booking.customer,
        booking.service,
        booking.stylistId,
        booking.stylistName,
        numericRating,
        normalizedComment,
        normalizedType,
      ]
    )
    const feedback = toFeedbackDto(rows[0])
    notifyRole({
      role: "ADMIN",
      type: normalizedType === "COMPLAINT" ? "FEEDBACK_COMPLAINT" : "FEEDBACK_NEW",
      title: normalizedType === "COMPLAINT" ? "New complaint received" : "New review received",
      body: `${booking.customer} rated ${booking.service} ${numericRating}★${normalizedComment ? `: "${normalizedComment.slice(0, 120)}"` : "."}`,
      data: { feedbackId: feedback.id, bookingId: booking.id },
    }).catch(error => console.error("notify_feedback_new_failed", error))
    return feedback
  } catch (error) {
    if (error?.code === "23505") {
      throw Object.assign(new Error("You have already reviewed this booking"), { code: "BAD_REQUEST" })
    }
    throw error
  }
}

export async function listCustomerFeedback(actorUser) {
  await ensureFeedbackSchema()
  const { rows } = await pool.query(
    `SELECT * FROM feedback WHERE customer_id = $1 ORDER BY created_at DESC`,
    [actorUser?.id ?? null]
  )
  return rows.map(toFeedbackDto)
}

export async function listAdminFeedback({ status, type, limit = 100, offset = 0 } = {}) {
  await ensureFeedbackSchema()
  const where = []
  const values = []
  const normalizedStatus = `${status ?? ""}`.trim().toUpperCase()
  const normalizedType = `${type ?? ""}`.trim().toUpperCase()
  if (["OPEN", "REVIEWED", "RESOLVED"].includes(normalizedStatus)) {
    values.push(normalizedStatus)
    where.push(`status = $${values.length}`)
  }
  if (["FEEDBACK", "COMPLAINT"].includes(normalizedType)) {
    values.push(normalizedType)
    where.push(`type = $${values.length}`)
  }
  values.push(Math.min(Math.max(Number(limit) || 100, 1), 200))
  values.push(Math.max(Number(offset) || 0, 0))
  const { rows } = await pool.query(
    `
      SELECT *
      FROM feedback
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values
  )
  return rows.map(toFeedbackDto)
}

export async function getFeedbackSummary() {
  await ensureFeedbackSchema()
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::INT AS total,
      COALESCE(AVG(rating), 0)::FLOAT AS average_rating,
      COUNT(*) FILTER (WHERE type = 'COMPLAINT')::INT AS total_complaints,
      COUNT(*) FILTER (WHERE status = 'OPEN')::INT AS open_count,
      COUNT(*) FILTER (WHERE status = 'RESOLVED')::INT AS resolved_count
    FROM feedback
  `)
  const row = rows[0] ?? {}
  return {
    total: Number(row.total ?? 0),
    averageRating: Math.round(Number(row.average_rating ?? 0) * 10) / 10,
    totalComplaints: Number(row.total_complaints ?? 0),
    openCount: Number(row.open_count ?? 0),
    resolvedCount: Number(row.resolved_count ?? 0),
  }
}

export async function updateFeedbackStatus({ feedbackId, status, adminResponse, actorUserId }) {
  await ensureFeedbackSchema()
  const normalizedStatus = `${status ?? ""}`.trim().toUpperCase()
  if (!["OPEN", "REVIEWED", "RESOLVED"].includes(normalizedStatus)) {
    throw Object.assign(new Error("Status must be OPEN, REVIEWED, or RESOLVED"), { code: "BAD_REQUEST" })
  }
  const response = `${adminResponse ?? ""}`.trim().slice(0, 2000) || null
  const resolved = normalizedStatus === "RESOLVED"
  const { rows } = await pool.query(
    `
      UPDATE feedback
      SET
        status = $2,
        admin_response = COALESCE($3, admin_response),
        resolved_by = CASE WHEN $4 THEN $5 ELSE resolved_by END,
        resolved_at = CASE WHEN $4 THEN NOW() ELSE resolved_at END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [feedbackId, normalizedStatus, response, resolved, actorUserId ?? null]
  )
  if (!rows[0]) throw Object.assign(new Error("Feedback entry not found"), { code: "NOT_FOUND" })
  const feedback = toFeedbackDto(rows[0])
  if (response && rows[0].customer_id) {
    notifyUser({
      userId: rows[0].customer_id,
      type: "FEEDBACK_RESPONDED",
      title: "The salon replied to your review",
      body: response,
      data: { feedbackId: feedback.id, bookingId: feedback.bookingId },
    }).catch(error => console.error("notify_feedback_responded_failed", error))
  }
  return feedback
}

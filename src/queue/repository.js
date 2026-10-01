import { v4 as uuid } from "uuid"
import { pool } from "../lib/db-pool.js"
import { SALON_TODAY_START_SQL, SALON_TOMORROW_START_SQL } from "../lib/salon-time.js"
import { decryptPiiText } from "../security/crypto-envelope.js"
import { ownerEmailHash, ownerPhoneHash } from "./tickets.js"

/**
 * Upper bound on rows pulled into a single snapshot. A salon day cannot
 * realistically exceed this, and the cap guarantees the projection stays
 * constant-time regardless of how the data grows or how badly a filter breaks.
 */
const MAX_QUEUE_ROWS = Number(process.env.QUEUE_MAX_ROWS ?? 2000)

/**
 * Reduce a booking row to the minimum the queue needs, replacing every piece of
 * customer PII with a one-way hash.
 *
 * This is deliberate: the result is cached in Redis and pushed over websockets,
 * so it must be safe at rest and in transit. Ownership ("is this entry mine?")
 * is still answerable by hashing the caller's own email/phone the same way.
 */
function toQueueRow(row) {
  const email = decryptPiiText(row.customer_email_enc) ?? row.customer_email ?? ""
  const phone = decryptPiiText(row.customer_phone_enc) ?? row.customer_phone ?? ""
  return {
    id: row.id,
    stylistId: row.stylist_id ?? null,
    stylistName: row.stylist_name ?? null,
    serviceName: row.service_name,
    startsAt: new Date(row.starts_at).toISOString(),
    durationMinutes: Number(row.duration_minutes ?? 0),
    status: row.status,
    actualStartAt: row.actual_start_at ? new Date(row.actual_start_at).toISOString() : null,
    createdBy: row.created_by ?? null,
    ownerEmailHash: ownerEmailHash(email),
    ownerPhoneHash: ownerPhoneHash(phone),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
}

/**
 * Every booking that can affect today's waiting time: today's not-yet-started
 * appointments plus anything currently in service (a service started yesterday
 * and never closed still occupies its stylist, which is why STARTED is not
 * date-bounded — the same rule the existing role queue uses).
 *
 * @returns {Promise<Array<ReturnType<typeof toQueueRow>>>}
 */
export async function loadActiveQueueRows() {
  const { rows } = await pool.query(
    `
      SELECT
        b.id,
        b.stylist_id,
        u.name AS stylist_name,
        b.service_name,
        b.starts_at,
        b.duration_minutes,
        b.status,
        b.actual_start_at,
        b.created_by,
        b.customer_email,
        b.customer_email_enc,
        b.customer_phone,
        b.customer_phone_enc,
        b.updated_at
      FROM bookings b
      LEFT JOIN users u ON u.id = b.stylist_id
      WHERE (
        (
          b.status IN ('PENDING', 'CONFIRMED')
          AND b.starts_at >= ${SALON_TODAY_START_SQL}
          AND b.starts_at < ${SALON_TOMORROW_START_SQL}
        )
        OR b.status = 'STARTED'
      )
      ORDER BY b.starts_at ASC
      LIMIT $1
    `,
    [MAX_QUEUE_ROWS]
  )
  return rows.map(toQueueRow)
}

/**
 * Active stylist roster, so the snapshot can report who is idle right now and
 * how soon a walk-in could actually be seated.
 *
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function loadActiveStylistRoster() {
  const { rows } = await pool.query(
    `
      SELECT u.id, u.name
      FROM users u
      LEFT JOIN stylist_profiles sp ON sp.stylist_id = u.id
      WHERE u.role = 'STAFF'
        AND u.account_status = 'ACTIVE'
        AND COALESCE(sp.is_active, TRUE) = TRUE
      ORDER BY u.name ASC
    `
  )
  return rows.map(row => ({ id: row.id, name: row.name }))
}

/**
 * How long each service *actually* takes, learned from completed bookings.
 *
 * SRS 4.7 asks for an estimate "where sufficient scheduling data is available";
 * this is that data. Rows where the recorded span is implausible (negative, or
 * longer than a full working block because the booking was auto-completed the
 * next day) are excluded so one bad record cannot skew a service's average.
 *
 * @param {{ windowDays: number }} params
 * @returns {Promise<Array<{ serviceName: string, samples: number, averageMinutes: number }>>}
 */
export async function loadServiceDurationStats({ windowDays }) {
  const days = Math.max(1, Math.trunc(Number(windowDays) || 30))
  const { rows } = await pool.query(
    `
      SELECT
        service_name,
        COUNT(*)::INT AS samples,
        AVG(EXTRACT(EPOCH FROM (completed_at - COALESCE(actual_start_at, starts_at))) / 60.0) AS average_minutes
      FROM bookings
      WHERE status = 'COMPLETED'
        AND completed_at IS NOT NULL
        AND completed_at >= NOW() - ($1::int * interval '1 day')
        AND completed_at > COALESCE(actual_start_at, starts_at)
        AND completed_at <= COALESCE(actual_start_at, starts_at) + interval '480 minutes'
      GROUP BY service_name
    `,
    [days]
  )
  return rows.map(row => ({
    serviceName: row.service_name,
    samples: Number(row.samples ?? 0),
    averageMinutes: Number(row.average_minutes ?? 0),
  }))
}

/**
 * Claim the right to send one reminder for a booking.
 *
 * The unique constraint is the coordination primitive: run this from ten API
 * instances at the same moment and exactly one gets `true`. No lock, no leader
 * election, and it stays correct if an instance dies mid-sweep.
 *
 * @param {{ bookingId: string, kind: string, userId?: string | null }} params
 * @returns {Promise<boolean>} true when this caller should send the notification
 */
export async function claimQueueReminder({ bookingId, kind, userId }) {
  const { rowCount } = await pool.query(
    `
      INSERT INTO queue_reminders (id, booking_id, kind, user_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (booking_id, kind) DO NOTHING
    `,
    [uuid(), bookingId, kind, userId ?? null]
  )
  return rowCount > 0
}

/**
 * @param {{ retentionDays: number }} params
 * @returns {Promise<number>} rows removed
 */
export async function pruneQueueReminders({ retentionDays }) {
  const days = Math.max(1, Math.trunc(Number(retentionDays) || 7))
  const { rowCount } = await pool.query(
    `DELETE FROM queue_reminders WHERE sent_at < NOW() - ($1::int * interval '1 day')`,
    [days]
  )
  return rowCount
}

import { v4 as uuid } from "uuid"
import { pool } from "../lib/db-pool.js"
import { createSchemaEnsurer } from "../lib/schema-guard.js"
import { publishNotificationEvent } from "../realtime/socket-gateway.js"

export const ensureNotificationsSchema = createSchemaEnsurer({
  name: "notifications",
  async migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(48) NOT NULL,
        title VARCHAR(255) NOT NULL,
        body TEXT,
        data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        channel VARCHAR(16) NOT NULL DEFAULT 'IN_APP',
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id, created_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id) WHERE read_at IS NULL`)
  },
})

function toNotificationDto(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body ?? "",
    data: row.data_json ?? {},
    channel: row.channel,
    read: Boolean(row.read_at),
    readAt: row.read_at ?? null,
    createdAt: row.created_at,
  }
}

async function insertNotification({ userId, type, title, body, data }) {
  const { rows } = await pool.query(
    `
      INSERT INTO notifications (id, user_id, type, title, body, data_json)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING *
    `,
    [uuid(), userId, type, title, body ?? null, JSON.stringify(data ?? {})]
  )
  return toNotificationDto(rows[0])
}

/** Notify a single user (customer, a specific stylist, etc). Delivers in-app in realtime. */
export async function notifyUser({ userId, type, title, body, data }) {
  if (!userId || !type || !title) return null
  await ensureNotificationsSchema()
  const notification = await insertNotification({ userId, type, title, body, data })
  publishNotificationEvent(notification)
  return notification
}

/**
 * Notify every active user of a role (e.g. every ADMIN when a complaint comes in).
 * Each recipient gets their own persisted row so read/unread state never bleeds
 * across users sharing the role inbox.
 */
export async function notifyRole({ role, type, title, body, data, excludeUserId }) {
  if (!role || !type || !title) return []
  await ensureNotificationsSchema()
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role = $1 AND account_status = 'ACTIVE' AND id <> COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [role, excludeUserId ?? null]
  )
  const notifications = []
  for (const row of rows) {
    const notification = await insertNotification({ userId: row.id, type, title, body, data })
    publishNotificationEvent(notification)
    notifications.push(notification)
  }
  return notifications
}

export async function listNotifications({ userId, limit = 30, offset = 0, unreadOnly = false }) {
  await ensureNotificationsSchema()
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100)
  const safeOffset = Math.max(Number(offset) || 0, 0)
  const { rows } = await pool.query(
    `
      SELECT *
      FROM notifications
      WHERE user_id = $1 ${unreadOnly ? "AND read_at IS NULL" : ""}
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `,
    [userId, safeLimit, safeOffset]
  )
  return rows.map(toNotificationDto)
}

export async function getUnreadCount(userId) {
  await ensureNotificationsSchema()
  const { rows } = await pool.query(
    `SELECT COUNT(*)::INT AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  )
  return Number(rows[0]?.count ?? 0)
}

export async function markNotificationRead({ notificationId, userId }) {
  await ensureNotificationsSchema()
  const { rows } = await pool.query(
    `
      UPDATE notifications
      SET read_at = COALESCE(read_at, NOW())
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `,
    [notificationId, userId]
  )
  if (!rows[0]) throw Object.assign(new Error("Notification not found"), { code: "NOT_FOUND" })
  return toNotificationDto(rows[0])
}

export async function markAllNotificationsRead(userId) {
  await ensureNotificationsSchema()
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  )
  return { updated: rowCount }
}

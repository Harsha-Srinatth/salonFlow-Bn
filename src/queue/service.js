import crypto from "node:crypto"

import { cachedRead, onCacheInvalidated } from "../lib/cache.js"
import { tryAcquireSlot } from "../lib/redis.js"
import { notifyUser, pruneOldNotifications } from "../notifications/service.js"
import { buildQueueProjection } from "./estimator.js"
import {
  QUEUE_BROADCAST_SLOT_KEY,
  QUEUE_REMINDER_KIND,
  QUEUE_REMINDER_SLOT_KEY,
  QUEUE_ROWS_CACHE_KEY,
  QUEUE_SERVICE_STATS_CACHE_KEY,
  queueConfig,
} from "./constants.js"
import {
  claimQueueReminder,
  loadActiveQueueRows,
  loadActiveStylistRoster,
  loadServiceDurationStats,
  pruneQueueReminders,
} from "./repository.js"
import { ownerEmailHash, ownerPhoneHash } from "./tickets.js"

const WAITING_STATUSES = new Set(["PENDING", "CONFIRMED"])

const QUEUE_REMINDER_PRUNE_SLOT_KEY = "sahasra:queue:reminder-prune-slot"

const NOTIFY_TIMEZONE = process.env.SALON_TIMEZONE ?? "Asia/Kolkata"

/**
 * Last computed projection, reused by every request that lands in the same
 * resolution window. Wait times are reported in whole minutes, so recomputing
 * per request would burn CPU to produce an identical answer — at high read
 * volume this memo is the difference between a projection per request and a
 * projection per second.
 *
 * @type {{ key: string | null, value: object | null }}
 */
let projectionMemo = { key: null, value: null }

/** Digest of the last pushed snapshot, so an unchanged queue is not re-broadcast. */
let lastBroadcastDigest = null

// A booking write invalidates the row cache fleet-wide; the derived projection
// must go with it or a customer could act on a snapshot that no longer exists.
onCacheInvalidated(QUEUE_ROWS_CACHE_KEY, () => {
  projectionMemo = { key: null, value: null }
  lastBroadcastDigest = null
})

function formatNotifyTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-IN", {
      timeZone: NOTIFY_TIMEZONE,
      hour: "numeric",
      minute: "2-digit",
    })
  } catch {
    return new Date(iso).toISOString()
  }
}

/**
 * Raw inputs for the projection, cached as one entry because they are always
 * read together and must describe the same instant.
 */
async function getQueueInputs() {
  const config = queueConfig()
  return cachedRead(QUEUE_ROWS_CACHE_KEY, {
    l1TtlMs: config.rowsL1TtlMs,
    l2TtlMs: config.rowsL2TtlMs,
    async load() {
      const [rows, roster] = await Promise.all([loadActiveQueueRows(), loadActiveStylistRoster()])
      const latestUpdatedAt = rows.reduce((max, row) => (row.updatedAt > max ? row.updatedAt : max), "")
      return {
        rows,
        roster,
        // Cheap change detector: any insert, status change or reschedule moves
        // either the row count or the newest `updated_at`.
        fingerprint: `${rows.length}:${roster.length}:${latestUpdatedAt}:${rows.at(-1)?.id ?? ""}`,
      }
    },
  })
}

/**
 * Observed service durations. Changes on the order of hours, so it gets its own
 * long-lived cache entry rather than riding along with the volatile row set.
 *
 * @returns {Promise<Map<string, { samples: number, averageMinutes: number }>>}
 */
async function getServiceDurationStats() {
  const config = queueConfig()
  const stats = await cachedRead(QUEUE_SERVICE_STATS_CACHE_KEY, {
    l1TtlMs: config.serviceStatsTtlMs,
    l2TtlMs: config.serviceStatsTtlMs,
    load: () => loadServiceDurationStats({ windowDays: config.serviceStatsWindowDays }),
  })
  // Rebuilt per read because a Map cannot survive JSON serialization into Redis.
  return new Map((stats ?? []).map(stat => [stat.serviceName, stat]))
}

/**
 * The full, server-side-only projection. Contains ownership hashes and booking
 * ids — never return it to a client directly; use one of the projections below.
 *
 * @param {{ now?: number }} [options]
 */
export async function getQueueProjection({ now = Date.now() } = {}) {
  const config = queueConfig()
  const [inputs, serviceStats] = await Promise.all([getQueueInputs(), getServiceDurationStats()])
  const bucket = Math.floor(now / Math.max(1, config.projectionResolutionMs))
  const memoKey = `${inputs.fingerprint}|${bucket}`
  if (projectionMemo.key === memoKey && projectionMemo.value) return projectionMemo.value

  const projection = buildQueueProjection({
    rows: inputs.rows,
    roster: inputs.roster,
    serviceStats,
    now,
    config,
  })
  projectionMemo = { key: memoKey, value: projection }
  return projection
}

function toPublicEntry(entry) {
  return {
    ticket: entry.ticket,
    serviceName: entry.serviceName,
    stylistName: entry.stylistName,
    status: entry.status,
    expectedStartAt: entry.expectedStartAt,
    expectedEndAt: entry.expectedEndAt,
    waitMinutes: entry.waitMinutes,
    remainingMinutes: entry.remainingMinutes,
    salonPosition: entry.salonPosition,
    positionInLane: entry.positionInLane,
    confidence: entry.confidence,
  }
}

/**
 * The anonymised salon-wide board: what every signed-in customer may see and
 * what gets pushed over websockets.
 *
 * No booking ids, no names, no contact details — a customer recognises their own
 * row by the ticket code their personal endpoint hands them. The entry list is
 * capped so the payload stays small enough to fan out to a very large number of
 * connected clients.
 */
export async function getPublicQueueBoard({ now = Date.now() } = {}) {
  const config = queueConfig()
  const projection = await getQueueProjection({ now })
  const visible = projection.entries.slice(0, config.publicMaxEntries)
  return {
    generatedAt: projection.generatedAt,
    summary: projection.summary,
    entries: visible.map(toPublicEntry),
    truncated: projection.entries.length > visible.length,
    totalEntries: projection.entries.length,
  }
}

function toOwnEntry(entry) {
  return {
    bookingId: entry.id,
    ticket: entry.ticket,
    serviceName: entry.serviceName,
    stylistName: entry.stylistName,
    status: entry.status,
    scheduledStartAt: entry.scheduledStartAt,
    expectedStartAt: entry.expectedStartAt,
    expectedEndAt: entry.expectedEndAt,
    waitMinutes: entry.waitMinutes,
    remainingMinutes: entry.remainingMinutes,
    delayMinutes: entry.delayMinutes,
    salonPosition: entry.salonPosition,
    positionInLane: entry.positionInLane,
    peopleAhead: Math.max(0, entry.positionInLane - 1),
    needsAssignment: entry.needsAssignment,
    confidence: entry.confidence,
  }
}

function isOwnedBy(entry, { userId, emailHash, phoneHash }) {
  if (userId && entry.createdBy === userId) return true
  if (emailHash && entry.ownerEmailHash === emailHash) return true
  if (phoneHash && entry.ownerPhoneHash === phoneHash) return true
  return false
}

/**
 * A customer's own place in the queue.
 *
 * Matching falls back from account id to hashed email/phone because a walk-in
 * booked at reception can predate the customer's account link, and the same
 * person should still see their own ticket.
 *
 * @param {{ appUser: object, now?: number }} params
 */
export async function getMyQueueStatus({ appUser, now = Date.now() }) {
  const projection = await getQueueProjection({ now })
  const identity = {
    userId: appUser?.id ?? null,
    emailHash: ownerEmailHash(appUser?.email),
    phoneHash: ownerPhoneHash(appUser?.phone),
  }
  const mine = projection.entries.filter(entry => isOwnedBy(entry, identity)).map(toOwnEntry)
  const inService = mine.find(entry => entry.status === "STARTED") ?? null
  const nextUp = mine.find(entry => WAITING_STATUSES.has(entry.status)) ?? null
  return {
    generatedAt: projection.generatedAt,
    summary: projection.summary,
    current: inService ?? nextUp,
    entries: mine,
  }
}

function toStaffEntry(entry) {
  return {
    bookingId: entry.id,
    ticket: entry.ticket,
    stylistId: entry.stylistId,
    stylistName: entry.stylistName,
    serviceName: entry.serviceName,
    status: entry.status,
    scheduledStartAt: entry.scheduledStartAt,
    expectedStartAt: entry.expectedStartAt,
    expectedEndAt: entry.expectedEndAt,
    waitMinutes: entry.waitMinutes,
    remainingMinutes: entry.remainingMinutes,
    delayMinutes: entry.delayMinutes,
    positionInLane: entry.positionInLane,
    salonPosition: entry.salonPosition,
    needsAssignment: entry.needsAssignment,
    confidence: entry.confidence,
  }
}

/**
 * Operational view for reception, admin and stylists.
 *
 * Entries carry `bookingId` so the caller can join this timing overlay onto the
 * booking records it already holds — customer details stay on those existing,
 * separately authorised endpoints and never enter the shared cache.
 *
 * @param {{ role: string, userId?: string, now?: number }} params
 */
export async function getOperationalQueueBoard({ role, userId, now = Date.now() }) {
  const projection = await getQueueProjection({ now })
  const scopedToOwnLane = role === "STAFF"
  const entries = projection.entries
    .filter(entry => (scopedToOwnLane ? entry.stylistId === userId : true))
    .map(toStaffEntry)
  const lanes = projection.lanes.filter(lane => (scopedToOwnLane ? lane.stylistId === userId : true))
  return {
    generatedAt: projection.generatedAt,
    summary: projection.summary,
    lanes,
    entries,
  }
}

function digestOf(board) {
  // `generatedAt` moves every tick by definition; excluding it means an idle
  // salon produces a stable digest and no broadcast at all.
  const { generatedAt: _ignored, ...rest } = board
  return crypto.createHash("sha1").update(JSON.stringify(rest)).digest("hex")
}

/**
 * Push the public board to every subscribed client, at most once per tick for
 * the whole fleet and only when something actually changed.
 *
 * Two guards matter at scale: the Redis slot stops N instances emitting N copies
 * of the same snapshot into a shared room, and the digest stops a quiet salon
 * from waking up every connected device on a timer.
 *
 * @param {{ publish: (board: object) => void }} params
 * @returns {Promise<object | null>} the broadcast payload, or null when skipped
 */
export async function broadcastQueueSnapshot({ publish }) {
  if (typeof publish !== "function") return null
  const config = queueConfig()
  const slotTtlMs = Math.max(1000, Math.round(config.broadcastIntervalMs * 0.9))
  if (!(await tryAcquireSlot(QUEUE_BROADCAST_SLOT_KEY, slotTtlMs))) return null

  const board = await getPublicQueueBoard()
  const digest = digestOf(board)
  if (digest === lastBroadcastDigest) return null
  lastBroadcastDigest = digest
  publish(board)
  return board
}

/**
 * Notify customers whose turn is approaching (SRS 4.7).
 *
 * Safe to run from every instance: `claimQueueReminder` is an insert against a
 * unique key, so exactly one caller in the fleet ever sends a given reminder.
 * The Redis slot is only an optimisation on top of that guarantee.
 *
 * @param {{ now?: number }} [options]
 * @returns {Promise<{ sent: number, skipped: boolean }>}
 */
export async function runQueueReminderSweep({ now = Date.now() } = {}) {
  const config = queueConfig()
  const slotTtlMs = Math.max(1000, Math.round(config.reminderSweepIntervalMs * 0.9))
  if (!(await tryAcquireSlot(QUEUE_REMINDER_SLOT_KEY, slotTtlMs))) return { sent: 0, skipped: true }

  const projection = await getQueueProjection({ now })
  const due = projection.entries.filter(
    entry =>
      WAITING_STATUSES.has(entry.status) &&
      entry.createdBy &&
      entry.waitMinutes <= config.reminderLeadMinutes
  )

  let sent = 0
  for (const entry of due) {
    try {
      const claimed = await claimQueueReminder({
        bookingId: entry.id,
        kind: QUEUE_REMINDER_KIND,
        userId: entry.createdBy,
      })
      if (!claimed) continue
      await notifyUser({
        userId: entry.createdBy,
        type: "QUEUE_APPROACHING",
        title: "You're up soon",
        body:
          entry.waitMinutes <= 1
            ? `${entry.serviceName} with ${entry.stylistName ?? "your stylist"} is starting now.`
            : `${entry.serviceName} with ${entry.stylistName ?? "your stylist"} starts in about ${entry.waitMinutes} min (around ${formatNotifyTime(entry.expectedStartAt)}).`,
        data: { bookingId: entry.id, ticket: entry.ticket, waitMinutes: entry.waitMinutes },
      })
      sent += 1
    } catch (error) {
      // One customer's reminder failing must not stop the rest of the sweep.
      console.error("queue_reminder_failed", {
        bookingId: entry.id,
        message: error instanceof Error ? error.message : error,
      })
    }
  }

  if (await tryAcquireSlot(QUEUE_REMINDER_PRUNE_SLOT_KEY, 24 * 60 * 60 * 1000)) {
    await pruneQueueReminders({ retentionDays: config.reminderRetentionDays }).catch(error =>
      console.error("queue_reminder_prune_failed", {
        message: error instanceof Error ? error.message : error,
      })
    )
    await pruneOldNotifications().catch(error =>
      console.error("notification_prune_failed", {
        message: error instanceof Error ? error.message : error,
      })
    )
  }

  return { sent, skipped: false }
}

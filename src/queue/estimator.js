import { bookingTicketCode } from "./tickets.js"

/**
 * Wait-time estimation (SRS 4.7).
 *
 * Everything in this file is pure: given rows, a roster, duration statistics and
 * a clock reading it returns a projection. No I/O, no cache, no globals — which
 * is what makes it cheap enough to run on the hot read path and simple enough to
 * reason about when a customer asks why their estimate moved.
 */

const WAITING_STATUSES = new Set(["PENDING", "CONFIRMED"])

const UNASSIGNED_LANE = "__unassigned__"

const MAX_SERVICE_MINUTES = 480

export const QUEUE_CONFIDENCE = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
}

function toMillis(value) {
  const millis = new Date(value ?? "").getTime()
  return Number.isFinite(millis) ? millis : null
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function diffMinutes(later, earlier) {
  return Math.max(0, Math.round((later - earlier) / 60000))
}

/**
 * How long this service is expected to take, blending the scheduled duration
 * with what the salon actually observes.
 *
 * With no history the scheduled duration is used unchanged. As completed
 * bookings accumulate the observed average takes over gradually, so an estimate
 * never lurches the first time a service is completed. The result is clamped
 * around the scheduled duration so a single mis-recorded booking cannot produce
 * an absurd projection for everyone behind it.
 *
 * @param {{ serviceName: string, durationMinutes: number, serviceStats: Map<string, { samples: number, averageMinutes: number }>, config: object }} params
 * @returns {{ minutes: number, samples: number, confidence: string }}
 */
export function estimateServiceMinutes({ serviceName, durationMinutes, serviceStats, config }) {
  const scheduled = clamp(Math.round(Number(durationMinutes) || 0) || 30, 1, MAX_SERVICE_MINUTES)
  const stat = serviceStats?.get?.(serviceName) ?? null
  const samples = Number(stat?.samples ?? 0)

  if (!stat || samples < config.minimumSampleSize) {
    return { minutes: scheduled, samples, confidence: QUEUE_CONFIDENCE.LOW }
  }

  const observed = clamp(Math.round(Number(stat.averageMinutes) || scheduled), 1, MAX_SERVICE_MINUTES)
  const weight = Math.min(1, samples / Math.max(1, config.confidentSampleSize))
  const blended = Math.round(scheduled * (1 - weight) + observed * weight)
  const minutes = clamp(blended, Math.max(1, Math.round(scheduled * 0.5)), Math.round(scheduled * 2.5))

  return {
    minutes,
    samples,
    confidence: samples >= config.confidentSampleSize ? QUEUE_CONFIDENCE.HIGH : QUEUE_CONFIDENCE.MEDIUM,
  }
}

function laneKeyFor(row) {
  return row.stylistId ?? UNASSIGNED_LANE
}

function byScheduledStart(a, b) {
  const left = toMillis(a.startsAt) ?? 0
  const right = toMillis(b.startsAt) ?? 0
  if (left !== right) return left - right
  // Stable tiebreak so two bookings on the same minute always project in the
  // same order — otherwise a customer's position could flip between polls.
  return `${a.id}`.localeCompare(`${b.id}`)
}

function summarizeConfidence(entries) {
  if (!entries.length) return QUEUE_CONFIDENCE.HIGH
  const high = entries.filter(entry => entry.confidence === QUEUE_CONFIDENCE.HIGH).length
  const ratio = high / entries.length
  if (ratio >= 0.7) return QUEUE_CONFIDENCE.HIGH
  if (ratio >= 0.3) return QUEUE_CONFIDENCE.MEDIUM
  return QUEUE_CONFIDENCE.LOW
}

/**
 * Project the whole salon forward from `now`.
 *
 * Per stylist the timeline is walked in order: whatever is in service finishes
 * first, then each waiting booking starts at the later of its scheduled time and
 * the moment the stylist is actually free. That single rule is what turns a
 * running-late stylist into a realistic wait for everyone behind them instead of
 * a schedule that quietly lies.
 *
 * @param {{
 *   rows: Array<object>,
 *   roster?: Array<{ id: string, name: string }>,
 *   serviceStats?: Map<string, { samples: number, averageMinutes: number }>,
 *   now?: number,
 *   config: object,
 * }} params
 */
export function buildQueueProjection({ rows, roster = [], serviceStats = new Map(), now = Date.now(), config }) {
  const lanesByKey = new Map()
  for (const stylist of roster) {
    lanesByKey.set(stylist.id, { stylistId: stylist.id, stylistName: stylist.name, rows: [] })
  }
  const unassignedRows = []

  for (const row of rows ?? []) {
    const key = laneKeyFor(row)
    if (key === UNASSIGNED_LANE) {
      unassignedRows.push(row)
      continue
    }
    if (!lanesByKey.has(key)) {
      // A stylist who was deactivated mid-day still owns the bookings already
      // assigned to them, so their lane has to exist for the projection to add up.
      lanesByKey.set(key, { stylistId: key, stylistName: row.stylistName ?? null, rows: [] })
    }
    lanesByKey.get(key).rows.push(row)
  }

  const entries = []
  const lanes = []

  for (const lane of lanesByKey.values()) {
    const active = lane.rows.filter(row => row.status === "STARTED").sort(byScheduledStart)
    const waiting = lane.rows.filter(row => WAITING_STATUSES.has(row.status)).sort(byScheduledStart)
    let cursor = now

    for (const row of active) {
      const estimate = estimateServiceMinutes({
        serviceName: row.serviceName,
        durationMinutes: row.durationMinutes,
        serviceStats,
        config,
      })
      const startedAt = toMillis(row.actualStartAt) ?? toMillis(row.startsAt) ?? now
      const plannedEnd = startedAt + estimate.minutes * 60000
      // Already over its estimate: it will still take *some* time to finish, and
      // pretending it ends "now" would hand everyone behind it a wait of zero.
      const expectedEnd = plannedEnd > now ? plannedEnd : now + config.overrunTailMinutes * 60000
      cursor = Math.max(cursor, expectedEnd)

      entries.push({
        id: row.id,
        ticket: bookingTicketCode(row.id),
        stylistId: lane.stylistId,
        stylistName: lane.stylistName,
        serviceName: row.serviceName,
        status: row.status,
        scheduledStartAt: new Date(toMillis(row.startsAt) ?? now).toISOString(),
        expectedStartAt: new Date(startedAt).toISOString(),
        expectedEndAt: new Date(expectedEnd).toISOString(),
        waitMinutes: 0,
        remainingMinutes: diffMinutes(expectedEnd, now),
        delayMinutes: 0,
        estimatedMinutes: estimate.minutes,
        positionInLane: 0,
        salonPosition: null,
        confidence: estimate.confidence,
        needsAssignment: false,
        createdBy: row.createdBy ?? null,
        ownerEmailHash: row.ownerEmailHash ?? null,
        ownerPhoneHash: row.ownerPhoneHash ?? null,
      })
    }

    // The chair is free the moment the current service ends — a booking later
    // today does not make a stylist "busy now", which is exactly the question a
    // walk-in is asking.
    const freeAt = cursor

    waiting.forEach((row, index) => {
      const estimate = estimateServiceMinutes({
        serviceName: row.serviceName,
        durationMinutes: row.durationMinutes,
        serviceStats,
        config,
      })
      const scheduledStart = toMillis(row.startsAt) ?? now
      const expectedStart = Math.max(scheduledStart, cursor)
      const expectedEnd = expectedStart + estimate.minutes * 60000
      cursor = expectedEnd

      entries.push({
        id: row.id,
        ticket: bookingTicketCode(row.id),
        stylistId: lane.stylistId,
        stylistName: lane.stylistName,
        serviceName: row.serviceName,
        status: row.status,
        scheduledStartAt: new Date(scheduledStart).toISOString(),
        expectedStartAt: new Date(expectedStart).toISOString(),
        expectedEndAt: new Date(expectedEnd).toISOString(),
        waitMinutes: diffMinutes(expectedStart, now),
        remainingMinutes: estimate.minutes,
        delayMinutes: diffMinutes(expectedStart, scheduledStart),
        estimatedMinutes: estimate.minutes,
        positionInLane: index + 1,
        salonPosition: null,
        confidence: estimate.confidence,
        needsAssignment: false,
        createdBy: row.createdBy ?? null,
        ownerEmailHash: row.ownerEmailHash ?? null,
        ownerPhoneHash: row.ownerPhoneHash ?? null,
      })
    })

    lanes.push({
      stylistId: lane.stylistId,
      stylistName: lane.stylistName,
      inServiceCount: active.length,
      waitingCount: waiting.length,
      isBusy: active.length > 0,
      freeAt: new Date(freeAt).toISOString(),
      freeInMinutes: diffMinutes(freeAt, now),
      queueEndsAt: new Date(cursor).toISOString(),
      queueEndsInMinutes: diffMinutes(cursor, now),
    })
  }

  // Bookings whose stylist was removed are not sequenced against anything: they
  // are shown as needing reassignment rather than silently inheriting someone
  // else's timeline.
  for (const row of unassignedRows.sort(byScheduledStart)) {
    const estimate = estimateServiceMinutes({
      serviceName: row.serviceName,
      durationMinutes: row.durationMinutes,
      serviceStats,
      config,
    })
    const scheduledStart = toMillis(row.startsAt) ?? now
    const expectedStart = Math.max(scheduledStart, now)
    entries.push({
      id: row.id,
      ticket: bookingTicketCode(row.id),
      stylistId: null,
      stylistName: null,
      serviceName: row.serviceName,
      status: row.status,
      scheduledStartAt: new Date(scheduledStart).toISOString(),
      expectedStartAt: new Date(expectedStart).toISOString(),
      expectedEndAt: new Date(expectedStart + estimate.minutes * 60000).toISOString(),
      waitMinutes: diffMinutes(expectedStart, now),
      remainingMinutes: estimate.minutes,
      delayMinutes: diffMinutes(expectedStart, scheduledStart),
      estimatedMinutes: estimate.minutes,
      positionInLane: 0,
      salonPosition: null,
      confidence: QUEUE_CONFIDENCE.LOW,
      needsAssignment: true,
      createdBy: row.createdBy ?? null,
      ownerEmailHash: row.ownerEmailHash ?? null,
      ownerPhoneHash: row.ownerPhoneHash ?? null,
    })
  }

  const waitingEntries = entries
    .filter(entry => WAITING_STATUSES.has(entry.status))
    .sort((a, b) => new Date(a.expectedStartAt) - new Date(b.expectedStartAt))
  waitingEntries.forEach((entry, index) => {
    entry.salonPosition = index + 1
  })

  const inServiceCount = entries.filter(entry => entry.status === "STARTED").length
  const rosterIds = new Set(roster.map(stylist => stylist.id))
  const rosterLanes = lanes.filter(lane => rosterIds.has(lane.stylistId))
  const busyLanes = rosterLanes.filter(lane => lane.isBusy)
  const waitMinutesList = waitingEntries.map(entry => entry.waitMinutes)
  const nextWalkInWaitMinutes = rosterLanes.length
    ? Math.min(...rosterLanes.map(lane => lane.freeInMinutes))
    : null

  return {
    generatedAt: new Date(now).toISOString(),
    entries: entries.sort((a, b) => new Date(a.expectedStartAt) - new Date(b.expectedStartAt)),
    lanes: lanes.sort((a, b) => `${a.stylistName ?? ""}`.localeCompare(`${b.stylistName ?? ""}`)),
    summary: {
      waitingCount: waitingEntries.length,
      inServiceCount,
      activeStylists: rosterLanes.length,
      busyStylists: busyLanes.length,
      freeStylists: Math.max(0, rosterLanes.length - busyLanes.length),
      averageWaitMinutes: waitMinutesList.length
        ? Math.round(waitMinutesList.reduce((sum, value) => sum + value, 0) / waitMinutesList.length)
        : 0,
      longestWaitMinutes: waitMinutesList.length ? Math.max(...waitMinutesList) : 0,
      nextWalkInWaitMinutes,
      confidence: summarizeConfidence(entries),
    },
  }
}

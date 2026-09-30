/**
 * Tunables for the live queue / wait-time module (SRS 4.7).
 *
 * Every value is read through a function rather than captured at import time so
 * a deployment can change behaviour with an environment variable without a code
 * change, and so tests can override without module reloading.
 */

function num(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

/** Cache key for the raw active-queue row set. Versioned: bump on shape changes. */
export const QUEUE_ROWS_CACHE_KEY = "sahasra:queue:rows:v1"

/** Cache key for observed per-service duration statistics. */
export const QUEUE_SERVICE_STATS_CACHE_KEY = "sahasra:queue:service-stats:v1"

/** Redis slot keys so only one instance broadcasts / sweeps per tick. */
export const QUEUE_BROADCAST_SLOT_KEY = "sahasra:queue:broadcast-slot"
export const QUEUE_REMINDER_SLOT_KEY = "sahasra:queue:reminder-slot"

/** Socket.IO room every authenticated socket joins to receive queue snapshots. */
export const QUEUE_LIVE_ROOM = "queue:live"

/** Realtime event name for the anonymised salon-wide queue snapshot. */
export const QUEUE_SNAPSHOT_EVENT = "queue.snapshot.v1"

/** Notification kind stored in `queue_reminders` for the "you're next" nudge. */
export const QUEUE_REMINDER_KIND = "APPROACHING"

export function queueConfig() {
  return {
    /** Per-process cache lifetime for the raw row set. */
    rowsL1TtlMs: num("QUEUE_ROWS_L1_TTL_MS", 1000),
    /** Shared (Redis) cache lifetime for the raw row set. */
    rowsL2TtlMs: num("QUEUE_ROWS_L2_TTL_MS", 5000),
    /** Cache lifetime for observed service durations — changes slowly. */
    serviceStatsTtlMs: num("QUEUE_SERVICE_STATS_TTL_MS", 5 * 60 * 1000),
    /**
     * Wait times only need to be accurate to the minute, so the projection is
     * recomputed at most once per this many milliseconds per instance and reused
     * by every request in between.
     */
    projectionResolutionMs: num("QUEUE_PROJECTION_RESOLUTION_MS", 1000),
    /** How often the salon-wide snapshot is pushed to subscribed clients. */
    broadcastIntervalMs: num("QUEUE_BROADCAST_INTERVAL_MS", 5000),
    /** Hard cap on entries in the pushed/public payload so it stays small. */
    publicMaxEntries: num("QUEUE_PUBLIC_MAX_ENTRIES", 40),
    /** Minutes of remaining time assumed for a service that has already overrun. */
    overrunTailMinutes: num("QUEUE_OVERRUN_TAIL_MINUTES", 5),
    /** Completed bookings needed before observed durations fully replace scheduled ones. */
    confidentSampleSize: num("QUEUE_CONFIDENT_SAMPLE_SIZE", 8),
    /** Minimum completed bookings before observed durations are used at all. */
    minimumSampleSize: num("QUEUE_MINIMUM_SAMPLE_SIZE", 3),
    /** Days of completed history used to learn real service durations. */
    serviceStatsWindowDays: num("QUEUE_SERVICE_STATS_WINDOW_DAYS", 30),
    /** Lead time for the "your service is approaching" notification. */
    reminderLeadMinutes: num("QUEUE_REMINDER_LEAD_MINUTES", 15),
    /** How often the reminder sweep runs. */
    reminderSweepIntervalMs: num("QUEUE_REMINDER_SWEEP_INTERVAL_MS", 60 * 1000),
    /** Days of reminder ledger rows kept before pruning. */
    reminderRetentionDays: num("QUEUE_REMINDER_RETENTION_DAYS", 7),
  }
}

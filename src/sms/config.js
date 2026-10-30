/**
 * SMS reminder configuration, read from the environment in one place.
 * `describeSmsConfig` reports which values are present, never what they are.
 */

function text(value) {
  return `${value ?? ""}`.trim()
}

function int(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = text(value)
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : Number.NaN
}

/** Reminder offsets in minutes before the appointment, e.g. "1440,120" -> [1440, 120]. */
function parseOffsets(value) {
  const offsets = (text(value) || "1440,120").split(",").map(part => Number(part.trim()))
  if (offsets.some(n => !Number.isInteger(n) || n < 5 || n > 7 * 24 * 60)) return null
  return [...new Set(offsets)].sort((a, b) => b - a)
}

export function smsConfig(env = process.env) {
  return {
    enabled: ["1", "true", "yes", "on"].includes(text(env.SMS_ENABLED).toLowerCase()),
    production: env.NODE_ENV === "production",
    authKey: text(env.MSG91_AUTH_KEY),
    reminderTemplateId: text(env.MSG91_REMINDER_TEMPLATE_ID),
    apiUrl: "https://control.msg91.com/api/v5/flow/",
    requestTimeoutMs: int(env.SMS_REQUEST_TIMEOUT_MS, 10_000, { min: 1000, max: 60_000 }),
    // 0 stops all reminders for the month without touching anything else.
    monthlyLimit: int(env.SMS_MONTHLY_LIMIT_REMINDER, 2000, { min: 0, max: 1_000_000 }),
    reminders: {
      offsetsMinutes: parseOffsets(env.SMS_REMINDER_OFFSETS_MINUTES),
      // A reminder that would fire sooner than this after the booking is made is not scheduled.
      minLeadMinutes: int(env.SMS_REMINDER_MIN_LEAD_MINUTES, 30, { min: 0, max: 24 * 60 }),
    },
    worker: {
      intervalMs: int(env.SMS_WORKER_INTERVAL_MS, 30_000, { min: 1000, max: 600_000 }),
      batchSize: int(env.SMS_WORKER_BATCH_SIZE, 20, { min: 1, max: 200 }),
      maxAttempts: int(env.SMS_SEND_MAX_ATTEMPTS, 5, { min: 1, max: 20 }),
      leaseSeconds: int(env.SMS_WORKER_LEASE_SECONDS, 120, { min: 30, max: 3600 }),
    },
  }
}

/** Every problem with the configuration. Empty when SMS is off (nothing else is needed then). */
export function validateSmsConfig(config = smsConfig()) {
  if (!config.enabled) return []
  const problems = []
  if (!config.authKey) problems.push("MSG91_AUTH_KEY is not set (MSG91 dashboard > Authkey)")
  if (!config.reminderTemplateId) problems.push("MSG91_REMINDER_TEMPLATE_ID is not set (MSG91 dashboard > SMS > Templates)")
  for (const [name, value] of Object.entries({
    SMS_REQUEST_TIMEOUT_MS: config.requestTimeoutMs,
    SMS_MONTHLY_LIMIT_REMINDER: config.monthlyLimit,
    SMS_REMINDER_MIN_LEAD_MINUTES: config.reminders.minLeadMinutes,
    SMS_WORKER_INTERVAL_MS: config.worker.intervalMs,
    SMS_WORKER_BATCH_SIZE: config.worker.batchSize,
    SMS_SEND_MAX_ATTEMPTS: config.worker.maxAttempts,
    SMS_WORKER_LEASE_SECONDS: config.worker.leaseSeconds,
  })) {
    if (Number.isNaN(value)) problems.push(`${name} is not a valid whole number in its allowed range`)
  }
  if (!config.reminders.offsetsMinutes) problems.push("SMS_REMINDER_OFFSETS_MINUTES must be comma-separated minutes, e.g. 1440,120")
  return problems
}

/** True when messages can actually be sent: enabled and every required value valid. */
export function isSmsAvailable(config = smsConfig()) {
  return config.enabled && validateSmsConfig(config).length === 0
}

/** Safe-to-log summary. */
export function describeSmsConfig(config = smsConfig()) {
  return {
    enabled: config.enabled,
    authKey: Boolean(config.authKey),
    reminderTemplateId: Boolean(config.reminderTemplateId),
    reminderOffsetsMinutes: config.reminders.offsetsMinutes,
    monthlyLimit: config.monthlyLimit,
  }
}

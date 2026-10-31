/**
 * Email configuration, read from the environment in one place.
 * `describeEmailConfig` reports which values are present, never what the secret ones are.
 *
 * Two independent switches decide how customers register:
 *  - EMAIL_VERIFICATION_ENABLED turns on `/register` and password reset through SES.
 *  - PHONE_VERIFICATION_ENABLED (default on) keeps the Firebase SMS step in registration.
 * Turning phone verification off needs email verification on, so a registration always proves
 * something. Both are read by the frontend from GET /api/auth/config, so flipping them back
 * needs a redeploy of the backend only.
 */

function text(value) {
  return `${value ?? ""}`.trim()
}

function flag(value, fallback = false) {
  const raw = text(value).toLowerCase()
  if (!raw) return fallback
  return ["1", "true", "yes", "on"].includes(raw)
}

function int(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = text(value)
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : Number.NaN
}

function parseOffsets(value) {
  const offsets = (text(value) || "1440,120").split(",").map(part => Number(part.trim()))
  if (offsets.some(n => !Number.isInteger(n) || n < 5 || n > 7 * 24 * 60)) return null
  return [...new Set(offsets)].sort((a, b) => b - a)
}

function list(value) {
  return text(value)
    .split(",")
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
}

export function emailConfig(env = process.env) {
  return {
    enabled: flag(env.EMAIL_ENABLED),
    production: env.NODE_ENV === "production",
    verificationEnabled: flag(env.EMAIL_VERIFICATION_ENABLED),
    phoneVerificationEnabled: flag(env.PHONE_VERIFICATION_ENABLED, true),
    remindersEnabled: flag(env.EMAIL_REMINDERS_ENABLED),
    marketingEnabled: flag(env.EMAIL_MARKETING_ENABLED),
    region: text(env.AWS_REGION) || "ap-southeast-2",
    fromEmail: text(env.AWS_SES_FROM_EMAIL),
    fromName: text(env.AWS_SES_FROM_NAME) || "Sahasra Family Salon",
    replyTo: text(env.AWS_SES_REPLY_TO),
    configurationSet: text(env.AWS_SES_CONFIGURATION_SET),
    // Open and click tracking rewrites links, so it stays on the marketing set only. A password
    // reset token must never pass through a tracking redirect.
    marketingConfigurationSet: text(env.AWS_SES_MARKETING_CONFIGURATION_SET) || text(env.AWS_SES_CONFIGURATION_SET),
    eventsTopicArn: text(env.AWS_SES_EVENTS_TOPIC_ARN),
    publicUrl: text(env.APP_PUBLIC_URL).replace(/\/+$/, ""),
    // Mail providers POST one-click unsubscribes straight to the API; the static site cannot.
    apiPublicUrl: text(env.API_PUBLIC_URL).replace(/\/+$/, ""),
    linkSecret: text(env.EMAIL_LINK_SECRET),
    // Empty means no restriction. Set it while SES is in its sandbox: real customers' mail is
    // then skipped instead of being rejected by SES.
    recipientAllowlist: list(env.EMAIL_RECIPIENT_ALLOWLIST),
    verificationTokenMinutes: int(env.EMAIL_VERIFICATION_TOKEN_EXPIRY, 24 * 60, { min: 10, max: 7 * 24 * 60 }),
    passwordResetTokenMinutes: int(env.PASSWORD_RESET_TOKEN_EXPIRY, 30, { min: 5, max: 24 * 60 }),
    // An unverified signup older than this is removed, freeing its email and phone again.
    pendingSignupRetentionHours: int(env.EMAIL_PENDING_SIGNUP_RETENTION_HOURS, 7 * 24, { min: 24, max: 90 * 24 }),
    requestCooldownSeconds: int(env.EMAIL_REQUEST_COOLDOWN_SECONDS, 60, { min: 0, max: 3600 }),
    requestHourlyLimit: int(env.EMAIL_REQUEST_HOURLY_LIMIT, 5, { min: 1, max: 100 }),
    reminders: {
      offsetsMinutes: parseOffsets(env.EMAIL_REMINDER_OFFSETS_MINUTES),
      minLeadMinutes: int(env.EMAIL_REMINDER_MIN_LEAD_MINUTES, 30, { min: 0, max: 24 * 60 }),
    },
    marketingDailyLimit: int(env.EMAIL_MARKETING_DAILY_LIMIT, 150, { min: 0, max: 1_000_000 }),
    requestTimeoutMs: int(env.EMAIL_REQUEST_TIMEOUT_MS, 10_000, { min: 1000, max: 60_000 }),
    worker: {
      intervalMs: int(env.EMAIL_WORKER_INTERVAL_MS, 15_000, { min: 1000, max: 600_000 }),
      batchSize: int(env.EMAIL_WORKER_BATCH_SIZE, 20, { min: 1, max: 200 }),
      maxAttempts: int(env.EMAIL_SEND_MAX_ATTEMPTS, 6, { min: 1, max: 20 }),
      leaseSeconds: int(env.EMAIL_WORKER_LEASE_SECONDS, 180, { min: 30, max: 3600 }),
      // SES starts at one message a second; raise this when AWS raises the sending rate.
      sendIntervalMs: int(env.EMAIL_WORKER_SEND_INTERVAL_MS, 1100, { min: 0, max: 60_000 }),
    },
  }
}

/** Every problem with the configuration. Sending off needs nothing else. */
export function validateEmailConfig(config = emailConfig()) {
  const problems = []
  if (config.verificationEnabled && !config.enabled) problems.push("EMAIL_VERIFICATION_ENABLED needs EMAIL_ENABLED=true")
  if (!config.phoneVerificationEnabled && !config.verificationEnabled) {
    problems.push("PHONE_VERIFICATION_ENABLED=false needs EMAIL_VERIFICATION_ENABLED=true")
  }
  if (!config.enabled) return problems
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.fromEmail)) problems.push("AWS_SES_FROM_EMAIL is not a valid address")
  if (!config.configurationSet) problems.push("AWS_SES_CONFIGURATION_SET is not set")
  if (!config.publicUrl) problems.push("APP_PUBLIC_URL is not set")
  else if (config.production && !config.publicUrl.startsWith("https://")) problems.push("APP_PUBLIC_URL must be https in production")
  if (config.production && !config.apiPublicUrl.startsWith("https://")) problems.push("API_PUBLIC_URL must be https in production")
  if (config.linkSecret.length < 32) problems.push("EMAIL_LINK_SECRET must be a random value of at least 32 characters")
  if (config.production && !config.eventsTopicArn) problems.push("AWS_SES_EVENTS_TOPIC_ARN is not set (bounces would go unhandled)")
  for (const [name, value] of Object.entries({
    EMAIL_VERIFICATION_TOKEN_EXPIRY: config.verificationTokenMinutes,
    PASSWORD_RESET_TOKEN_EXPIRY: config.passwordResetTokenMinutes,
    EMAIL_PENDING_SIGNUP_RETENTION_HOURS: config.pendingSignupRetentionHours,
    EMAIL_REQUEST_COOLDOWN_SECONDS: config.requestCooldownSeconds,
    EMAIL_REQUEST_HOURLY_LIMIT: config.requestHourlyLimit,
    EMAIL_REMINDER_MIN_LEAD_MINUTES: config.reminders.minLeadMinutes,
    EMAIL_MARKETING_DAILY_LIMIT: config.marketingDailyLimit,
    EMAIL_REQUEST_TIMEOUT_MS: config.requestTimeoutMs,
    EMAIL_WORKER_INTERVAL_MS: config.worker.intervalMs,
    EMAIL_WORKER_BATCH_SIZE: config.worker.batchSize,
    EMAIL_SEND_MAX_ATTEMPTS: config.worker.maxAttempts,
    EMAIL_WORKER_LEASE_SECONDS: config.worker.leaseSeconds,
    EMAIL_WORKER_SEND_INTERVAL_MS: config.worker.sendIntervalMs,
  })) {
    if (Number.isNaN(value)) problems.push(`${name} is not a valid whole number in its allowed range`)
  }
  if (!config.reminders.offsetsMinutes) problems.push("EMAIL_REMINDER_OFFSETS_MINUTES must be comma-separated minutes, e.g. 1440,120")
  return problems
}

/** True when mail can actually be sent: enabled and every required value valid. */
export function isEmailAvailable(config = emailConfig()) {
  return config.enabled && validateEmailConfig(config).length === 0
}

/** Safe-to-log summary. */
export function describeEmailConfig(config = emailConfig()) {
  return {
    enabled: config.enabled,
    verificationEnabled: config.verificationEnabled,
    phoneVerificationEnabled: config.phoneVerificationEnabled,
    remindersEnabled: config.remindersEnabled,
    marketingEnabled: config.marketingEnabled,
    region: config.region,
    fromEmail: config.fromEmail,
    configurationSet: config.configurationSet,
    marketingConfigurationSet: config.marketingConfigurationSet,
    publicUrl: config.publicUrl,
    linkSecret: Boolean(config.linkSecret),
    eventsTopicArn: Boolean(config.eventsTopicArn),
    recipientAllowlistSize: config.recipientAllowlist.length,
  }
}

/** What the signup screens need to know; contains nothing sensitive. */
export function publicAuthConfig(config = emailConfig()) {
  return {
    emailVerificationEnabled: config.verificationEnabled,
    phoneVerificationEnabled: config.phoneVerificationEnabled,
  }
}

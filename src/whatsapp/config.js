/**
 * WhatsApp Cloud API configuration, read from the environment in one place.
 *
 * Nothing here is sent anywhere or logged: `describeWhatsAppConfig` reports which
 * values are *present*, never what they are.
 *
 * Feature switches follow one rule: a message type is only produced when its approved
 * template name is configured. Template names are not invented here, because a name that
 * does not exist in the salon's WhatsApp Business Account fails every send (error 132001).
 * Leaving `WHATSAPP_TEMPLATE_WELCOME` empty therefore simply means "no welcome messages",
 * which lets each feature go live as soon as Meta approves its template.
 */

const TRUE_VALUES = new Set(["1", "true", "yes", "on"])

function flag(value, fallback = false) {
  const raw = `${value ?? ""}`.trim().toLowerCase()
  if (!raw) return fallback
  return TRUE_VALUES.has(raw)
}

function text(value) {
  return `${value ?? ""}`.trim()
}

function int(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = `${value ?? ""}`.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return Number.NaN
  return parsed
}

/** Reminder offsets in minutes before the appointment, e.g. "1440,120" -> [1440, 120]. */
function parseOffsets(value) {
  const raw = text(value) || "1440,120"
  const offsets = raw.split(",").map(part => Number(part.trim()))
  if (!offsets.length || offsets.some(n => !Number.isInteger(n) || n < 5 || n > 7 * 24 * 60)) return null
  // Largest first, duplicates removed: reminder #1 is always the earliest one.
  return [...new Set(offsets)].sort((a, b) => b - a)
}

function parseCountryCodes(value) {
  const raw = text(value) || "91"
  const codes = raw.split(",").map(part => part.trim().replace(/^\+/, "")).filter(Boolean)
  if (codes.some(code => !/^[1-9]\d{0,3}$/.test(code))) return null
  return codes
}

export const TEMPLATE_KEYS = {
  OTP: "OTP",
  WELCOME: "WELCOME",
  BOOKING_CONFIRMED: "BOOKING_CONFIRMED",
  BOOKING_CANCELLED: "BOOKING_CANCELLED",
  BOOKING_RESCHEDULED: "BOOKING_RESCHEDULED",
  APPOINTMENT_REMINDER: "APPOINTMENT_REMINDER",
  OFFER: "OFFER",
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function whatsappConfig(env = process.env) {
  const language = text(env.WHATSAPP_TEMPLATE_LANGUAGE) || "en"
  const templates = {}
  for (const key of Object.values(TEMPLATE_KEYS)) {
    const name = text(env[`WHATSAPP_TEMPLATE_${key}`])
    templates[key] = name ? { name, language: text(env[`WHATSAPP_TEMPLATE_${key}_LANGUAGE`]) || language } : null
  }
  return {
    enabled: flag(env.WHATSAPP_ENABLED),
    production: env.NODE_ENV === "production",
    accessToken: text(env.WHATSAPP_ACCESS_TOKEN),
    phoneNumberId: text(env.WHATSAPP_PHONE_NUMBER_ID),
    businessAccountId: text(env.WHATSAPP_BUSINESS_ACCOUNT_ID),
    appSecret: text(env.WHATSAPP_APP_SECRET),
    webhookVerifyToken: text(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN),
    apiVersion: text(env.WHATSAPP_GRAPH_API_VERSION) || "v26.0",
    graphBaseUrl: "https://graph.facebook.com",
    requestTimeoutMs: int(env.WHATSAPP_REQUEST_TIMEOUT_MS, 10_000, { min: 1000, max: 60_000 }),
    defaultCountryCode: text(env.WHATSAPP_DEFAULT_COUNTRY_CODE).replace(/^\+/, "") || "91",
    templates,
    otp: {
      length: int(env.WHATSAPP_OTP_LENGTH, 6, { min: 4, max: 8 }),
      ttlSeconds: int(env.WHATSAPP_OTP_TTL_SECONDS, 300, { min: 60, max: 90 * 60 }),
      maxAttempts: int(env.WHATSAPP_OTP_MAX_ATTEMPTS, 5, { min: 1, max: 10 }),
      resendCooldownSeconds: int(env.WHATSAPP_OTP_RESEND_COOLDOWN_SECONDS, 45, { min: 15, max: 3600 }),
      maxPerPhonePerHour: int(env.WHATSAPP_OTP_MAX_PER_PHONE_PER_HOUR, 5, { min: 1, max: 50 }),
      maxPerIpPerHour: int(env.WHATSAPP_OTP_MAX_PER_IP_PER_HOUR, 20, { min: 1, max: 1000 }),
      allowedCountryCodes: parseCountryCodes(env.WHATSAPP_OTP_ALLOWED_COUNTRY_CODES),
      proofTtlSeconds: int(env.WHATSAPP_PHONE_PROOF_TTL_SECONDS, 30 * 60, { min: 300, max: 24 * 3600 }),
      // Local development only (refused in production): a fixed code is accepted and no
      // message is sent, like Firebase's fictional test numbers.
      devFixedCode: text(env.WHATSAPP_DEV_FIXED_OTP),
    },
    reminders: {
      offsetsMinutes: parseOffsets(env.WHATSAPP_REMINDER_OFFSETS_MINUTES),
      // A reminder that would fire sooner than this after the booking is made is not scheduled.
      minLeadMinutes: int(env.WHATSAPP_REMINDER_MIN_LEAD_MINUTES, 30, { min: 0, max: 24 * 60 }),
    },
    worker: {
      intervalMs: int(env.WHATSAPP_WORKER_INTERVAL_MS, 15_000, { min: 1000, max: 600_000 }),
      batchSize: int(env.WHATSAPP_WORKER_BATCH_SIZE, 20, { min: 1, max: 200 }),
      maxAttempts: int(env.WHATSAPP_SEND_MAX_ATTEMPTS, 5, { min: 1, max: 20 }),
      leaseSeconds: int(env.WHATSAPP_WORKER_LEASE_SECONDS, 120, { min: 30, max: 3600 }),
    },
    marketing: {
      maxRecipients: int(env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS, 1000, { min: 1, max: 100_000 }),
    },
    // Monthly caps per message type (see budget.js). 0 switches a type off.
    budget: {
      OTP: int(env.WHATSAPP_MONTHLY_LIMIT_OTP, 1000, { min: 0, max: 1_000_000 }),
      WELCOME: int(env.WHATSAPP_MONTHLY_LIMIT_WELCOME, 1000, { min: 0, max: 1_000_000 }),
      REMINDER: int(env.WHATSAPP_MONTHLY_LIMIT_REMINDER, 2000, { min: 0, max: 1_000_000 }),
      OFFER: int(env.WHATSAPP_MONTHLY_LIMIT_OFFER, 1000, { min: 0, max: 1_000_000 }),
      // Confirmation / cancellation / reschedule messages: not in the budget, off by default.
      BOOKING_UPDATES: int(env.WHATSAPP_MONTHLY_LIMIT_BOOKING_UPDATES, 0, { min: 0, max: 1_000_000 }),
    },
    // Phone-OTP sign-in for existing customers (email/Google sign-in stay free). Each use
    // costs one authentication message from the OTP budget.
    otpLoginEnabled: flag(env.WHATSAPP_OTP_LOGIN_ENABLED, true),
  }
}

/**
 * Every problem with the current configuration, as human-readable sentences.
 * Empty when WhatsApp is disabled (then nothing else is required) or fully configured.
 *
 * @param {ReturnType<typeof whatsappConfig>} config
 * @returns {string[]}
 */
export function validateWhatsAppConfig(config = whatsappConfig()) {
  const problems = []
  if (config.otp.devFixedCode) {
    if (config.production) problems.push("WHATSAPP_DEV_FIXED_OTP must not be set in production")
    else if (!/^\d{4,8}$/.test(config.otp.devFixedCode)) problems.push("WHATSAPP_DEV_FIXED_OTP must be 4-8 digits")
  }
  if (!config.enabled) return problems
  if (!config.accessToken) problems.push("WHATSAPP_ACCESS_TOKEN is not set (System User access token from Meta Business Settings)")
  if (!config.phoneNumberId) problems.push("WHATSAPP_PHONE_NUMBER_ID is not set (WhatsApp Manager > Phone numbers > Phone number ID)")
  else if (!/^\d{5,20}$/.test(config.phoneNumberId)) problems.push("WHATSAPP_PHONE_NUMBER_ID must be the numeric phone number ID, not the phone number itself")
  if (config.phoneNumberId && config.accessToken && config.phoneNumberId === config.accessToken) {
    problems.push("WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are the same value")
  }
  if (!/^v\d{2,3}\.\d$/.test(config.apiVersion)) problems.push("WHATSAPP_GRAPH_API_VERSION must look like v26.0")
  if (config.production) {
    if (!config.appSecret) problems.push("WHATSAPP_APP_SECRET is not set (webhook signatures cannot be verified)")
    if (!config.webhookVerifyToken) problems.push("WHATSAPP_WEBHOOK_VERIFY_TOKEN is not set (Meta cannot verify the webhook URL)")
  }
  if (config.webhookVerifyToken && config.webhookVerifyToken.length < 16) {
    problems.push("WHATSAPP_WEBHOOK_VERIFY_TOKEN must be a random string of at least 16 characters")
  }
  for (const [name, value] of Object.entries({
    WHATSAPP_REQUEST_TIMEOUT_MS: config.requestTimeoutMs,
    WHATSAPP_OTP_LENGTH: config.otp.length,
    WHATSAPP_OTP_TTL_SECONDS: config.otp.ttlSeconds,
    WHATSAPP_OTP_MAX_ATTEMPTS: config.otp.maxAttempts,
    WHATSAPP_OTP_RESEND_COOLDOWN_SECONDS: config.otp.resendCooldownSeconds,
    WHATSAPP_OTP_MAX_PER_PHONE_PER_HOUR: config.otp.maxPerPhonePerHour,
    WHATSAPP_OTP_MAX_PER_IP_PER_HOUR: config.otp.maxPerIpPerHour,
    WHATSAPP_PHONE_PROOF_TTL_SECONDS: config.otp.proofTtlSeconds,
    WHATSAPP_WORKER_INTERVAL_MS: config.worker.intervalMs,
    WHATSAPP_WORKER_BATCH_SIZE: config.worker.batchSize,
    WHATSAPP_SEND_MAX_ATTEMPTS: config.worker.maxAttempts,
    WHATSAPP_WORKER_LEASE_SECONDS: config.worker.leaseSeconds,
    WHATSAPP_CAMPAIGN_MAX_RECIPIENTS: config.marketing.maxRecipients,
    WHATSAPP_REMINDER_MIN_LEAD_MINUTES: config.reminders.minLeadMinutes,
    WHATSAPP_MONTHLY_LIMIT_OTP: config.budget.OTP,
    WHATSAPP_MONTHLY_LIMIT_WELCOME: config.budget.WELCOME,
    WHATSAPP_MONTHLY_LIMIT_REMINDER: config.budget.REMINDER,
    WHATSAPP_MONTHLY_LIMIT_OFFER: config.budget.OFFER,
    WHATSAPP_MONTHLY_LIMIT_BOOKING_UPDATES: config.budget.BOOKING_UPDATES,
  })) {
    if (Number.isNaN(value)) problems.push(`${name} is not a valid whole number in its allowed range`)
  }
  if (!config.reminders.offsetsMinutes) problems.push("WHATSAPP_REMINDER_OFFSETS_MINUTES must be comma-separated minutes, e.g. 1440,120")
  if (!config.otp.allowedCountryCodes) problems.push("WHATSAPP_OTP_ALLOWED_COUNTRY_CODES must be comma-separated country codes, e.g. 91")
  if (!/^[1-9]\d{0,3}$/.test(config.defaultCountryCode)) problems.push("WHATSAPP_DEFAULT_COUNTRY_CODE must be a country calling code, e.g. 91")
  return problems
}

/** True when messages can actually be sent: enabled and every required value valid. */
export function isWhatsAppSendingAvailable(config = whatsappConfig()) {
  return config.enabled && validateWhatsAppConfig(config).length === 0
}

/** Template for a message type, or null when that feature is switched off. */
export function templateFor(key, config = whatsappConfig()) {
  return config.templates[key] ?? null
}

/** Safe-to-log summary: which values are present, never their contents. */
export function describeWhatsAppConfig(config = whatsappConfig()) {
  return {
    enabled: config.enabled,
    apiVersion: config.apiVersion,
    accessToken: Boolean(config.accessToken),
    phoneNumberId: Boolean(config.phoneNumberId),
    businessAccountId: Boolean(config.businessAccountId),
    appSecret: Boolean(config.appSecret),
    webhookVerifyToken: Boolean(config.webhookVerifyToken),
    templates: Object.fromEntries(Object.entries(config.templates).map(([key, value]) => [key, Boolean(value)])),
    reminderOffsetsMinutes: config.reminders.offsetsMinutes,
    monthlyLimits: config.budget,
    otpLoginEnabled: config.otpLoginEnabled,
    devFixedOtp: Boolean(config.otp.devFixedCode),
  }
}

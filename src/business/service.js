import { auditAuthAsync } from "../lib/audit-log.js"
import { cachedRead, invalidateCacheKey } from "../lib/cache.js"
import { pool } from "../lib/db-pool.js"
import { createSchemaEnsurer } from "../lib/schema-guard.js"
import { SALON_TIMEZONE } from "../lib/salon-time.js"
import { CUSTOMER_CANCELLATION_POLICY_RULES } from "../bookings/cancellation-policy.js"
import {
  BOOKING_WINDOW_DAYS,
  LUNCH_END_MINUTES,
  LUNCH_START_MINUTES,
  SALON_CLOSE_MINUTES,
  SALON_OPEN_MINUTES,
} from "../bookings/constants.js"

/**
 * The business profile: the one place the salon's public contact details, address, social
 * links, written policies and FAQ live. The landing-page footer and the support assistant both
 * read it, so neither ever shows invented contact information — a field nobody has filled in is
 * simply absent (and reported as missing to the admin).
 *
 * Everything here is public by design (it is shown on the landing page). Nothing about
 * customers, staff or money is stored in it.
 */

const PROFILE_CACHE_KEY = "sahasra:business:profile:v1"

export const ensureBusinessSchema = createSchemaEnsurer({
  name: "business",
  async migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_profile (
        id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`INSERT INTO business_profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING`)
  },
})

const TEXT_FIELDS = {
  businessName: 120,
  tagline: 200,
  about: 1500,
  phone: 24,
  whatsapp: 24,
  supportEmail: 254,
  addressLine1: 200,
  addressLine2: 200,
  city: 80,
  state: 80,
  postalCode: 16,
  country: 80,
  paymentPolicy: 1500,
  lateArrivalPolicy: 1500,
  generalPolicy: 3000,
}
const URL_FIELDS = ["mapsUrl", "website", "instagram", "facebook", "youtube", "x", "privacyUrl", "termsUrl"]
const MAX_FAQ = 25

/** Fields the footer/assistant consider essential; reported to the admin when empty. */
const ESSENTIAL_FIELDS = ["businessName", "supportEmail", "phone", "addressLine1", "city"]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/

function fail(message) {
  return Object.assign(new Error(message), { code: "BAD_REQUEST", status: 400, expose: true })
}

function cleanText(value, max) {
  const text = `${value ?? ""}`.replace(/\s+\n/g, "\n").trim()
  return text.length > max ? text.slice(0, max) : text
}

function cleanUrl(value, field) {
  const text = `${value ?? ""}`.trim()
  if (!text) return ""
  let url
  try {
    url = new URL(text)
  } catch {
    throw fail(`${field} must be a full https:// link`)
  }
  if (url.protocol !== "https:") throw fail(`${field} must start with https://`)
  return url.toString()
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function hhmmToMinutes(value) {
  const match = HHMM_RE.exec(`${value ?? ""}`.trim())
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

function minutesToHhmm(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

const DEFAULT_HOURS = {
  opensAt: minutesToHhmm(SALON_OPEN_MINUTES),
  closesAt: minutesToHhmm(SALON_CLOSE_MINUTES),
  lunchFrom: minutesToHhmm(LUNCH_START_MINUTES),
  lunchTo: minutesToHhmm(LUNCH_END_MINUTES),
}

/**
 * Opening hours the admin sets in Settings; the slot generator and the booking checks read them
 * through getSalonHours(). Both lunch fields empty means no lunch break. `strict` throws on bad
 * input (admin save); otherwise an unusable stored value quietly falls back to the defaults.
 */
export function normalizeSalonHours(input, { strict = true } = {}) {
  const source = input && typeof input === "object" ? input : {}
  const pick = field => (field in source ? `${source[field] ?? ""}`.trim() : DEFAULT_HOURS[field])
  const hours = { opensAt: pick("opensAt"), closesAt: pick("closesAt"), lunchFrom: pick("lunchFrom"), lunchTo: pick("lunchTo") }
  const open = hhmmToMinutes(hours.opensAt)
  const close = hhmmToMinutes(hours.closesAt)
  const lunchFrom = hhmmToMinutes(hours.lunchFrom)
  const lunchTo = hhmmToMinutes(hours.lunchTo)
  const noLunch = hours.lunchFrom === "" && hours.lunchTo === ""
  let problem = null
  if (open === null || close === null) problem = "Opening and closing times must be HH:MM"
  else if (close - open < 60) problem = "The salon must be open for at least an hour"
  else if (!noLunch && (lunchFrom === null || lunchTo === null)) problem = "Set both lunch times, or clear both for no lunch break"
  else if (!noLunch && (lunchTo <= lunchFrom || lunchFrom < open || lunchTo > close)) problem = "Lunch break must fall inside opening hours"
  if (problem) {
    if (strict) throw fail(problem)
    return { ...DEFAULT_HOURS }
  }
  return noLunch ? { ...hours, lunchFrom: "", lunchTo: "" } : hours
}

/**
 * Validate and normalise an admin-submitted profile. Unknown keys are dropped, so the stored
 * JSON can only ever contain the fields above.
 */
export function normalizeBusinessProfile(input, { strict = true } = {}) {
  const source = input && typeof input === "object" ? input : {}
  const profile = {}
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    profile[field] = cleanText(source[field], max)
  }
  for (const field of URL_FIELDS) profile[field] = cleanUrl(source[field], field)

  if (profile.supportEmail && !EMAIL_RE.test(profile.supportEmail)) throw fail("Support email is not a valid address")
  for (const field of ["phone", "whatsapp"]) {
    if (profile[field] && !PHONE_RE.test(profile[field])) throw fail(`${field === "phone" ? "Phone" : "WhatsApp"} number is not valid`)
  }

  const faqRaw = Array.isArray(source.faq) ? source.faq : []
  if (faqRaw.length > MAX_FAQ) throw fail(`At most ${MAX_FAQ} FAQ entries`)
  profile.faq = faqRaw
    .map(item => ({ question: cleanText(item?.question, 300), answer: cleanText(item?.answer, 1500) }))
    .filter(item => item.question || item.answer)
  for (const item of profile.faq) {
    if (!item.question || !item.answer) throw fail("Each FAQ entry needs both a question and an answer")
  }
  profile.hours = normalizeSalonHours(source.hours, { strict })
  return profile
}

async function loadProfileRow() {
  await ensureBusinessSchema()
  const { rows } = await pool.query(`SELECT profile_json, updated_at FROM business_profile WHERE id = 1`)
  const stored = rows[0]?.profile_json ?? {}
  // Re-normalise on read: tolerates older/partial rows and guarantees every key exists.
  let profile
  try {
    profile = normalizeBusinessProfile(stored, { strict: false })
  } catch {
    profile = normalizeBusinessProfile({})
  }
  return { profile, updatedAt: rows[0]?.updated_at ?? null }
}

export async function getBusinessProfile() {
  return cachedRead(PROFILE_CACHE_KEY, { l1TtlMs: 30_000, l2TtlMs: 120_000, load: loadProfileRow })
}

export async function updateBusinessProfile({ payload, actorUserId }) {
  const profile = normalizeBusinessProfile(payload)
  await ensureBusinessSchema()
  await pool.query(
    `
      INSERT INTO business_profile (id, profile_json, updated_by, updated_at)
      VALUES (1, $1::jsonb, $2, NOW())
      ON CONFLICT (id) DO UPDATE SET profile_json = EXCLUDED.profile_json, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `,
    [JSON.stringify(profile), actorUserId ?? null]
  )
  await invalidateCacheKey(PROFILE_CACHE_KEY)
  auditAuthAsync("auth", "admin_business_profile_updated", { adminUserId: actorUserId })
  return getAdminBusinessProfile()
}

export function minutesToLabel(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const suffix = h >= 12 ? "PM" : "AM"
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`
}

/**
 * The salon's working day in minutes after midnight, as the booking engine enforces it.
 * `lunchStart`/`lunchEnd` are null when there is no lunch break.
 */
export async function getSalonHours() {
  const { profile } = await getBusinessProfile()
  const hours = normalizeSalonHours(profile.hours, { strict: false })
  const noLunch = hours.lunchFrom === ""
  return {
    open: hhmmToMinutes(hours.opensAt),
    close: hhmmToMinutes(hours.closesAt),
    lunchStart: noLunch ? null : hhmmToMinutes(hours.lunchFrom),
    lunchEnd: noLunch ? null : hhmmToMinutes(hours.lunchTo),
  }
}

/** Opening hours as enforced by the booking engine (not free text, so it cannot drift). */
export function getOperatingHours(salonHours) {
  const { open, close, lunchStart, lunchEnd } = salonHours
  return {
    timezone: SALON_TIMEZONE,
    opens: minutesToLabel(open),
    closes: minutesToLabel(close),
    lunchBreak: lunchStart === null ? null : { from: minutesToLabel(lunchStart), to: minutesToLabel(lunchEnd) },
    days: "Every day",
    bookingWindow: `Online bookings can be made for today or tomorrow (${BOOKING_WINDOW_DAYS} days).`,
  }
}

export function getCancellationPolicy() {
  return CUSTOMER_CANCELLATION_POLICY_RULES.map(rule => ({
    when: rule.condition,
    refund: rule.refund,
    detail: rule.detail,
  }))
}

function missingEssentials(profile) {
  return ESSENTIAL_FIELDS.filter(field => !profile[field])
}

/** Safe for anyone: shown on the public landing page. */
export async function getPublicBusinessInfo() {
  const { profile } = await getBusinessProfile()
  return {
    profile,
    hours: getOperatingHours(await getSalonHours()),
    cancellationPolicy: getCancellationPolicy(),
    missingFields: missingEssentials(profile),
  }
}

export async function getAdminBusinessProfile() {
  const { profile, updatedAt } = await getBusinessProfile()
  return { profile, updatedAt, missingFields: missingEssentials(profile), hours: getOperatingHours(await getSalonHours()) }
}

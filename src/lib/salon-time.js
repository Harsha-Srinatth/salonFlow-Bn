/**
 * Everything about "what day is it" and "what time is it" for the salon goes through here.
 *
 * The salon works in one zone (default Asia/Kolkata). The server and the database do
 * not: a container's clock and a managed Postgres session are usually UTC, and code that
 * used `new Date().getHours()` or `date_trunc('day', NOW())` silently meant "UTC" there —
 * which shifted bookable hours by 5.5 h and cut the "today" queue at 05:30 local time.
 */

const RAW_ZONE = `${process.env.SALON_TIMEZONE ?? "Asia/Kolkata"}`.trim()

function validZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return /^[A-Za-z0-9_+\-/]+$/.test(zone)
  } catch {
    return false
  }
}

export const SALON_TIMEZONE = validZone(RAW_ZONE) ? RAW_ZONE : "Asia/Kolkata"

/** SQL: start of the salon-local day containing `expr` (a timestamptz expression). Zone is a validated constant. */
export function salonDayStartSql(expr) {
  return `(date_trunc('day', ${expr} AT TIME ZONE '${SALON_TIMEZONE}') AT TIME ZONE '${SALON_TIMEZONE}')`
}
export const SALON_TODAY_START_SQL = salonDayStartSql("NOW()")
/** SQL: start of the salon-local day after today (handles DST days correctly, unlike `+ interval '1 day'` on a UTC timestamp). */
export const SALON_TOMORROW_START_SQL = `((date_trunc('day', NOW() AT TIME ZONE '${SALON_TIMEZONE}') + interval '1 day') AT TIME ZONE '${SALON_TIMEZONE}')`

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SALON_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})
const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SALON_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

/** `YYYY-MM-DD` of an instant as seen on the salon's wall clock. */
export function salonDateString(instant = new Date()) {
  return dateFormatter.format(instant)
}

/** Minutes since local midnight (0-1439) of an instant on the salon's wall clock. */
export function salonMinutesOfDay(instant = new Date()) {
  const parts = Object.fromEntries(partsFormatter.formatToParts(instant).map(p => [p.type, p.value]))
  return Number(parts.hour) * 60 + Number(parts.minute)
}

function offsetMinutesAt(instant) {
  const parts = Object.fromEntries(partsFormatter.formatToParts(instant).map(p => [p.type, p.value]))
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000)
}

/**
 * The real instant at which the salon's wall clock reads `dateStr` + `minutesOfDay`.
 * Two passes converge across a DST change; Asia/Kolkata has none, so it is exact there.
 *
 * @param {string} dateStr `YYYY-MM-DD`
 * @param {number} minutesOfDay 0-1439 (may exceed 1439 to mean "into the next day")
 * @returns {Date}
 */
export function salonWallClockToDate(dateStr, minutesOfDay = 0) {
  const [y, m, d] = `${dateStr}`.split("-").map(Number)
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0) + minutesOfDay * 60_000
  let guess = naive - offsetMinutesAt(new Date(naive)) * 60_000
  guess = naive - offsetMinutesAt(new Date(guess)) * 60_000
  return new Date(guess)
}

/** `YYYY-MM-DD` of the day after `dateStr`. */
export function addDaysToDateString(dateStr, days) {
  const [y, m, d] = `${dateStr}`.split("-").map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + days))
  return next.toISOString().slice(0, 10)
}

export function isValidDateString(dateStr) {
  const value = `${dateStr ?? ""}`.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split("-").map(Number)
  const parsed = new Date(Date.UTC(y, m - 1, d))
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
}

/** True when `dateStr` is today or tomorrow on the salon's calendar. */
export function isTodayOrTomorrowInSalon(dateStr, now = new Date()) {
  if (!isValidDateString(dateStr)) return false
  const today = salonDateString(now)
  return dateStr === today || dateStr === addDaysToDateString(today, 1)
}

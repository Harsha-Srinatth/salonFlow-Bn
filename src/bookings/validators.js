import { BOOKING_STATUS_ORDER } from "./constants.js"

export function normalizeBookingStatus(status) {
  const normalized = `${status ?? ""}`.trim().toUpperCase()
  if (BOOKING_STATUS_ORDER.includes(normalized)) return normalized
  return null
}

/** Admin "PENDING" tab = paid/confirmed but service not yet started. */
export const BOOKING_UPCOMING_STATUSES = ["PENDING", "CONFIRMED"]

export function resolveBookingListStatuses(status) {
  const normalized = normalizeBookingStatus(status)
  if (!normalized) return null
  if (normalized === "PENDING") return BOOKING_UPCOMING_STATUSES
  return [normalized]
}

export function canTransitionBookingStatus(currentStatus, nextStatus) {
  return (
    (currentStatus === "PENDING" && nextStatus === "CONFIRMED") ||
    (currentStatus === "PENDING" && nextStatus === "CANCELLED") ||
    (currentStatus === "CONFIRMED" && nextStatus === "STARTED") ||
    (currentStatus === "CONFIRMED" && nextStatus === "CANCELLED") ||
    (currentStatus === "STARTED" && nextStatus === "COMPLETED")
  )
}

const BOOKING_LIST_SORTS = new Set(["starts_asc", "latest", "proximity"])

export function sanitizeBookingFilters(query) {
  const limitRaw = Number(query.limit ?? 25)
  const offsetRaw = Number(query.offset ?? 0)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0
  const status = normalizeBookingStatus(query.status)
  const statuses = resolveBookingListStatuses(status)
  const search = `${query.search ?? ""}`.trim()
  const from = `${query.from ?? ""}`.trim()
  const to = `${query.to ?? ""}`.trim()
  const sortRaw = `${query.sort ?? ""}`.trim().toLowerCase()
  const sort = BOOKING_LIST_SORTS.has(sortRaw) ? sortRaw : "starts_asc"
  return {
    limit,
    offset,
    status,
    statuses,
    search,
    from,
    to,
    sort,
  }
}

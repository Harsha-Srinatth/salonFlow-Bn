export const BOOKING_STATUSES = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  STARTED: "STARTED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  NO_SHOW: "NO-SHOW",
}

export const BOOKING_STATUS_ORDER = [
  BOOKING_STATUSES.PENDING,
  BOOKING_STATUSES.CONFIRMED,
  BOOKING_STATUSES.STARTED,
  BOOKING_STATUSES.COMPLETED,
  BOOKING_STATUSES.CANCELLED,
  BOOKING_STATUSES.NO_SHOW,
]

// Salon-local opening hours and lunch break, in minutes after midnight. The slot generator and
// the server-side booking checks enforce these; the public business profile and the support
// assistant read them from here so what customers are told always matches what can be booked.
export const SALON_OPEN_MINUTES = 8 * 60
export const SALON_CLOSE_MINUTES = 23 * 60
export const LUNCH_START_MINUTES = 13 * 60
export const LUNCH_END_MINUTES = 13 * 60 + 30
export const SLOT_STEP_MINUTES = 15
/** Customers can book for the salon's today and tomorrow only (see isTodayOrTomorrowInSalon). */
export const BOOKING_WINDOW_DAYS = 2

import { auditAuthAsync } from "../lib/audit-log.js"
import { normalizeCustomerGender, parseSelectableGender } from "../lib/gender.js"
import { notifyRole, notifyUser } from "../notifications/service.js"
import {
  attachRewardVoucherToBooking,
  claimRewardVoucher,
  computeFirstBookingDiscount,
  redeemWalletCredit,
  rewardReferralIfEligible,
} from "../loyalty/service.js"
import { computeBookingOfferPricing, getMembershipSegmentForUser } from "../offers/service.js"
import {
  computeCancellationRefund,
  CUSTOMER_CANCELLATION_POLICY_RULES,
} from "./cancellation-policy.js"
import { canTransitionBookingStatus, normalizeBookingStatus, sanitizeBookingFilters } from "./validators.js"
import {
  createServiceCatalogItem,
  createBooking,
  findAvailableStylistsForServices,
  getBookingForUpdate,
  insertAuditLog,
  listBookings,
  listBookingsForCustomer,
  listReceptionStylists,
  listServiceCatalog,
  updateServiceCatalogItem,
  upsertServiceDiscounts,
  updateBookingStatus,
  listEligibleStylistsForServices,
  listBookingsForStylistsInRange,
  listLeavesForStylistsOnDate,
  upsertStylistShift,
  createStylistLeave,
  updateBookingSchedule,
  listQueueBookingsForRole,
  getBookingById,
  deleteBookingById,
  getPayrollPolicy,
  upsertPayrollPolicy,
  listMonthlyStylistDeductions,
  findOrCreateWalkinCustomerAccount,
  lookupWalkinCustomerByPhoneOrEmail,
  markBookingStarted,
  markBookingCompletedWithPenalty,
  findOverdueStartedBookingsForAutoComplete,
  findOverdueUpcomingBookingsForNoShow,
  markBookingNoShow,
  createPaymentTransaction,
  getRevenueSummaryForDate,
  listPaymentTransactions,
  getPaymentHistoryById,
  withTransaction,
} from "./repository.js"

const SALON_OPEN_MINUTES = 8 * 60
const SALON_CLOSE_MINUTES = 23 * 60
const LUNCH_START_MINUTES = 13 * 60
const LUNCH_END_MINUTES = 13 * 60 + 30
const SLOT_STEP_MINUTES = 15
const NOTIFY_TIMEZONE = process.env.SALON_TIMEZONE ?? "Asia/Kolkata"

function formatNotifyDateTime(iso) {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      timeZone: NOTIFY_TIMEZONE,
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    })
  } catch {
    return new Date(iso).toISOString()
  }
}

function hhmmToMinutes(value, fallback) {
  const raw = `${value ?? ""}`.trim()
  const [h, m] = raw.split(":").map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return fallback
  return h * 60 + m
}

function buildDateAtMinutes(dateIso, minutes) {
  const date = new Date(`${dateIso}T00:00:00`)
  date.setMinutes(minutes, 0, 0)
  return date
}

function isTodayOrTomorrow(dateIso) {
  const target = new Date(`${dateIso}T00:00:00`)
  if (Number.isNaN(target.getTime())) return false
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  return target.getTime() === today.getTime() || target.getTime() === tomorrow.getTime()
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart
}

function roundUpToSlotMinute(totalMinutes, stepMinutes) {
  return Math.ceil(totalMinutes / stepMinutes) * stepMinutes
}

export async function listAdminBookings(query) {
  await autoCompleteOverdueStartedBookings({})
  await autoMarkNoShowBookings({})
  const filters = sanitizeBookingFilters(query)
  return listBookings(filters)
}

export async function transitionAdminBookingStatus({ bookingId, requestedStatus, actorUserId, publishEvent }) {
  const nextStatus = normalizeBookingStatus(requestedStatus)
  if (!nextStatus) {
    const error = new Error("Invalid status")
    error.code = "INVALID_STATUS"
    throw error
  }
  if (nextStatus === "STARTED" || nextStatus === "COMPLETED") {
    throw Object.assign(
      new Error("Admins cannot change booking status to STARTED or COMPLETED. Only the assigned stylist can update service status."),
      { code: "FORBIDDEN" }
    )
  }
  const booking = await withTransaction(async client => {
    const current = await getBookingForUpdate(client, bookingId)
    if (!current) {
      const error = new Error("Booking not found")
      error.code = "NOT_FOUND"
      throw error
    }
    const currentStatus = normalizeBookingStatus(current.status)
    if (!currentStatus) {
      const error = new Error("Booking has unsupported status")
      error.code = "INVALID_CURRENT_STATUS"
      throw error
    }
    if (currentStatus === nextStatus) {
      return await updateBookingStatus(client, { bookingId, status: nextStatus, updatedBy: actorUserId })
    }
    if (!canTransitionBookingStatus(currentStatus, nextStatus)) {
      const error = new Error(`Invalid transition ${currentStatus} -> ${nextStatus}`)
      error.code = "INVALID_TRANSITION"
      throw error
    }
    const updated = await updateBookingStatus(client, { bookingId, status: nextStatus, updatedBy: actorUserId })
    await insertAuditLog(client, {
      action: "booking_status_updated",
      performedBy: actorUserId,
      resourceId: bookingId,
      originalValue: { status: currentStatus },
      newValue: { status: nextStatus },
    })
    return updated
  })
  auditAuthAsync("auth", "admin_booking_status_updated", {
    adminUserId: actorUserId,
    bookingId,
    toStatus: booking?.status,
  })
  if (booking && publishEvent) publishEvent("booking.updated.v1", booking)
  return booking
}

function isValidEmail(email) {
  const value = `${email ?? ""}`.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function isValidPhone(phone) {
  return /^\+?[1-9]\d{7,14}$/.test(`${phone ?? ""}`.trim())
}

export async function createReceptionBooking({ payload, actorUserId, publishEvent, publishPaymentEvent }) {
  const customerName = `${payload.customerName ?? ""}`.trim()
  const customerEmail = `${payload.customerEmail ?? ""}`.trim().toLowerCase()
  const customerPhone = `${payload.customerPhone ?? ""}`.trim()
  const customerGender = parseSelectableGender(payload.customerGender)
  const stylistId = `${payload.stylistId ?? ""}`.trim()
  const startsAt = `${payload.startsAt ?? ""}`.trim()
  const serviceIds = Array.isArray(payload.serviceIds)
    ? payload.serviceIds.map(item => `${item ?? ""}`.trim()).filter(Boolean)
    : []
  const legacyServiceId = `${payload.serviceId ?? ""}`.trim()
  const resolvedServiceIds = serviceIds.length ? serviceIds : legacyServiceId ? [legacyServiceId] : []
  if (customerName.length < 2) throw Object.assign(new Error("Customer name is required"), { code: "BAD_REQUEST" })
  if (!isValidEmail(customerEmail)) throw Object.assign(new Error("Valid email is required"), { code: "BAD_REQUEST" })
  if (!isValidPhone(customerPhone)) throw Object.assign(new Error("Valid phone is required"), { code: "BAD_REQUEST" })
  // A walk-in booking registers a customer account, so it has to ask the same
  // question signup does — otherwise reception keeps minting genderless accounts.
  if (!customerGender) throw Object.assign(new Error("Customer gender is required"), { code: "BAD_REQUEST" })
  if (!resolvedServiceIds.length) throw Object.assign(new Error("At least one service is required"), { code: "BAD_REQUEST" })
  if (!stylistId) throw Object.assign(new Error("Stylist is required"), { code: "BAD_REQUEST" })
  if (!startsAt || Number.isNaN(new Date(startsAt).getTime())) throw Object.assign(new Error("Valid slot time is required"), { code: "BAD_REQUEST" })
  const serviceCatalog = await listServiceCatalog()
  const selectedServices = serviceCatalog.filter(item => resolvedServiceIds.includes(item.id))
  if (selectedServices.length !== resolvedServiceIds.length) {
    throw Object.assign(new Error("One or more selected services are not available"), { code: "BAD_REQUEST" })
  }
  const customerAccount = await findOrCreateWalkinCustomerAccount({
    customerName,
    customerEmail,
    customerPhone,
    customerGender,
  })
  const comboId = `${payload.comboId ?? ""}`.trim() || null
  const membershipSegment =
    `${payload.membershipSegment ?? ""}`.trim().toUpperCase() ||
    (await getMembershipSegmentForUser(customerAccount.id))
  const pricing = await computeBookingOfferPricing({
    serviceIds: resolvedServiceIds,
    membershipSegment,
    comboId,
    serviceCatalog,
  })
  const durationMinutes = selectedServices.reduce(
    (sum, service) => sum + Number(service.duration ?? service.durationMinutes ?? 0),
    0
  )
  const serviceName = selectedServices.map(service => service.name).join(", ")
  const availableStylists = await listRecommendedStylists({
    serviceIds: resolvedServiceIds,
    startsAt: new Date(startsAt).toISOString(),
    durationMinutes,
    customerGender,
  })
  const stylistAllowed = availableStylists.some(stylist => stylist.id === stylistId)
  if (!stylistAllowed) {
    throw Object.assign(new Error("Selected stylist cannot perform this service at selected slot"), { code: "BAD_REQUEST" })
  }
  const paymentMode = `${payload.paymentMode ?? ""}`.trim().toUpperCase()
  const walkInPaymentModes = ["OFFLINE_CASH", "OFFLINE_UPI"]
  if (!walkInPaymentModes.includes(paymentMode)) {
    throw Object.assign(new Error("paymentMode must be OFFLINE_CASH or OFFLINE_UPI"), { code: "BAD_REQUEST" })
  }
  const booking = await createBooking({
    customerName,
    customerEmail,
    customerPhone,
    serviceName,
    serviceItems: pricing.serviceItems,
    stylistId,
    startsAt,
    durationMinutes,
    totalAmount: pricing.totalAmount,
    discountAmount: pricing.discountAmount,
    payableAmount: pricing.payableAmount,
    invoiceNumber: `INV-${Date.now()}`,
    status: "CONFIRMED",
    createdBy: customerAccount.id,
  })
  if (booking?.id && pricing.payableAmount > 0) {
    await recordReceptionPayment({
      payload: {
        sourceType: "BOOKING",
        bookingId: booking.id,
        paymentMode,
        amount: pricing.payableAmount,
      },
      actorUserId,
      publishPaymentEvent,
    })
  }
  auditAuthAsync("auth", "reception_booking_created", {
    receptionistUserId: actorUserId,
    bookingId: booking?.id,
    stylistId,
    customerUserId: customerAccount.id,
    customerAccountStatus: customerAccount.accountStatus,
    customerAccountCreated: customerAccount.isNew,
  })
  if (booking && publishEvent) publishEvent("booking.updated.v1", booking)
  return booking
}

export async function listReceptionBookingStylists() {
  return listReceptionStylists()
}

export async function lookupReceptionCustomer({ customerEmail, customerPhone }) {
  const customer = await lookupWalkinCustomerByPhoneOrEmail({ customerEmail, customerPhone })
  if (!customer) {
    return {
      status: "NEW_CUSTOMER",
      customer: null,
    }
  }
  if (!customer.isExistingCustomer) {
    return {
      status: "CONFLICT_NON_CUSTOMER_ACCOUNT",
      customer,
    }
  }
  return {
    status: "EXISTING_CUSTOMER",
    customer,
  }
}

export async function autoCompleteOverdueStartedBookings({ publishEvent } = {}) {
  const policy = await getPayrollPolicy()
  const overdue = await findOverdueStartedBookingsForAutoComplete()
  const completed = []
  for (const row of overdue) {
    const booking = await markBookingCompletedWithPenalty({
      bookingId: row.id,
      stylistId: row.stylist_id,
      graceMinutes: policy.graceMinutes,
      penaltyPerMinute: policy.penaltyPerMinute,
    })
    if (!booking) continue
    completed.push(booking)
    auditAuthAsync("auth", "booking_auto_completed", {
      bookingId: row.id,
      stylistId: row.stylist_id,
    })
    if (booking.createdBy) {
      rewardReferralIfEligible({ userId: booking.createdBy }).catch(error =>
        console.error("reward_referral_auto_complete_failed", error)
      )
    }
    if (publishEvent) publishEvent("booking.updated.v1", booking)
  }
  return completed
}

/**
 * A booking left in PENDING/CONFIRMED past its scheduled end time means the
 * customer never showed up and no stylist ever started the service. It is
 * auto-resolved as NO-SHOW: no refund is computed (unlike cancellation —
 * the slot was held and never used), and the stylist is simply freed since
 * nothing was ever assigned to "release".
 */
export async function autoMarkNoShowBookings({ publishEvent } = {}) {
  const overdue = await findOverdueUpcomingBookingsForNoShow()
  const updated = []
  for (const row of overdue) {
    const booking = await markBookingNoShow({ bookingId: row.id })
    if (!booking) continue
    updated.push(booking)
    auditAuthAsync("auth", "booking_marked_no_show", { bookingId: row.id })
    if (booking.createdBy) {
      notifyUser({
        userId: booking.createdBy,
        type: "BOOKING_NO_SHOW",
        title: "Missed appointment",
        body: `Your ${formatNotifyDateTime(booking.startsAt)} ${booking.service} slot passed without a visit. The amount paid is non-refundable.`,
        data: { bookingId: booking.id },
      }).catch(error => console.error("notify_booking_no_show_failed", error))
    }
    if (publishEvent) publishEvent("booking.updated.v1", booking)
  }
  return updated
}

export async function listCustomerBookings({ customerEmail, customerPhone, limit, offset, publishEvent } = {}) {
  await autoCompleteOverdueStartedBookings({ publishEvent })
  await autoMarkNoShowBookings({ publishEvent })
  return listBookingsForCustomer({ customerEmail, customerPhone, limit, offset })
}

export async function listBookableServices() {
  return listServiceCatalog()
}

export async function listAdminServices() {
  return listServiceCatalog({ includeInactive: true })
}

export async function listRecommendedStylists({ serviceIds, startsAt, durationMinutes, customerGender }) {
  const safeServiceIds = Array.isArray(serviceIds) ? serviceIds.filter(Boolean) : []
  if (!safeServiceIds.length) return []
  return findAvailableStylistsForServices({
    serviceIds: safeServiceIds,
    startsAt,
    durationMinutes,
    customerGender,
  })
}

export async function listAvailableSlots({ serviceIds, date, customerGender }) {
  const safeServiceIds = Array.isArray(serviceIds) ? serviceIds.filter(Boolean) : []
  if (!safeServiceIds.length) throw Object.assign(new Error("serviceIds are required"), { code: "BAD_REQUEST" })
  if (!isTodayOrTomorrow(date)) throw Object.assign(new Error("Bookings are allowed only for today or tomorrow"), { code: "BAD_REQUEST" })
  const services = await listServiceCatalog()
  const selectedServices = services.filter(item => safeServiceIds.includes(item.id))
  if (selectedServices.length !== safeServiceIds.length) {
    throw Object.assign(new Error("One or more services are invalid"), { code: "BAD_REQUEST" })
  }
  const totalDuration = selectedServices.reduce((sum, item) => sum + Number(item.duration ?? item.durationMinutes ?? 0), 0)
  const eligibleStylists = await listEligibleStylistsForServices({ serviceIds: safeServiceIds, customerGender })
  const stylistIds = eligibleStylists.map(item => item.id)
  const dayStart = `${date}T00:00:00.000Z`
  const nextDay = new Date(`${date}T00:00:00.000Z`)
  nextDay.setUTCDate(nextDay.getUTCDate() + 1)
  const dayEnd = nextDay.toISOString()
  const booked = await listBookingsForStylistsInRange({ stylistIds, rangeStart: dayStart, rangeEnd: dayEnd })
  const leaves = await listLeavesForStylistsOnDate({ stylistIds, date })
  const onLeaveSet = new Set(leaves.map(item => item.stylist_id))
  const byStylist = new Map()
  for (const booking of booked) {
    const list = byStylist.get(booking.stylist_id) ?? []
    const start = new Date(booking.starts_at).getTime()
    const end = start + Number(booking.duration_minutes ?? 0) * 60 * 1000
    list.push({ start, end })
    byStylist.set(booking.stylist_id, list)
  }
  const slots = []
  const now = new Date()
  const requestedDate = new Date(`${date}T00:00:00`)
  const isToday =
    requestedDate.getFullYear() === now.getFullYear() &&
    requestedDate.getMonth() === now.getMonth() &&
    requestedDate.getDate() === now.getDate()
  const nowMinutesRaw =
    now.getHours() * 60 +
    now.getMinutes() +
    (now.getSeconds() > 0 || now.getMilliseconds() > 0 ? 1 : 0)
  const earliestMinute = isToday
    ? Math.max(SALON_OPEN_MINUTES, roundUpToSlotMinute(nowMinutesRaw, SLOT_STEP_MINUTES))
    : SALON_OPEN_MINUTES

  for (let minute = earliestMinute; minute + totalDuration <= SALON_CLOSE_MINUTES; minute += SLOT_STEP_MINUTES) {
    const slotStart = buildDateAtMinutes(date, minute)
    const slotEnd = new Date(slotStart.getTime() + totalDuration * 60 * 1000)
    if (overlaps(minute, minute + totalDuration, LUNCH_START_MINUTES, LUNCH_END_MINUTES)) continue
    const availableStylists = eligibleStylists.filter(stylist => {
      if (onLeaveSet.has(stylist.id)) return false
      const shiftStart = hhmmToMinutes(stylist.shift_start, SALON_OPEN_MINUTES)
      const shiftEnd = hhmmToMinutes(stylist.shift_end, SALON_CLOSE_MINUTES)
      if (minute < shiftStart || minute + totalDuration > shiftEnd) return false
      const windows = byStylist.get(stylist.id) ?? []
      return !windows.some(window => overlaps(slotStart.getTime(), slotEnd.getTime(), window.start, window.end))
    })
    if (availableStylists.length) {
      slots.push({
        startsAt: slotStart.toISOString(),
        endsAt: slotEnd.toISOString(),
        stylists: availableStylists.map(item => ({ id: item.id, name: item.name })),
      })
    }
  }
  return { totalDuration, slots }
}

export async function updateAdminServiceDiscounts({ items, actorUserId }) {
  const normalized = (Array.isArray(items) ? items : []).map(item => ({
    id: `${item?.id ?? ""}`.trim(),
    discountPercent: Number(item?.discountPercent ?? 0),
  }))
  for (const item of normalized) {
    if (!item.id) throw Object.assign(new Error("Service id is required"), { code: "BAD_REQUEST" })
    if (!Number.isFinite(item.discountPercent) || item.discountPercent < 0 || item.discountPercent > 100) {
      throw Object.assign(new Error("Discount percent must be between 0 and 100"), { code: "BAD_REQUEST" })
    }
  }
  await upsertServiceDiscounts(normalized)
  auditAuthAsync("auth", "admin_service_discounts_updated", {
    adminUserId: actorUserId,
    count: normalized.length,
  })
  return listAdminServices()
}

function normalizeServiceGender(value) {
  const normalized = `${value ?? ""}`.trim().toUpperCase()
  if (["MEN", "WOMEN", "UNISEX"].includes(normalized)) return normalized
  return null
}

export async function createAdminService({ payload, actorUserId }) {
  const name = `${payload?.name ?? ""}`.trim()
  const category = `${payload?.category ?? ""}`.trim().toUpperCase()
  const targetGender = normalizeServiceGender(payload?.gender)
  const basePrice = Number(payload?.basePrice ?? 0)
  const duration = Number(payload?.duration ?? 0)
  const description = `${payload?.description ?? ""}`.trim()
  const image = `${payload?.image ?? ""}`.trim()
  const variantsRaw = Array.isArray(payload?.variants) ? payload.variants : []
  const variants = variantsRaw.map(item => ({
    name: `${item?.name ?? ""}`.trim(),
    price: Number(item?.price ?? 0),
    duration: Number(item?.duration ?? 0),
  }))
  if (!name) throw Object.assign(new Error("Service name is required"), { code: "BAD_REQUEST" })
  if (!category) throw Object.assign(new Error("Service category is required"), { code: "BAD_REQUEST" })
  if (!targetGender) throw Object.assign(new Error("Service gender must be men, women, or unisex"), { code: "BAD_REQUEST" })
  if (!Number.isFinite(basePrice) || basePrice <= 0) throw Object.assign(new Error("Base price must be greater than 0"), { code: "BAD_REQUEST" })
  if (!Number.isFinite(duration) || duration < 10 || duration > 480) {
    throw Object.assign(new Error("Duration must be between 10 and 480 minutes"), { code: "BAD_REQUEST" })
  }
  for (const variant of variants) {
    if (!variant.name) throw Object.assign(new Error("Variant name is required"), { code: "BAD_REQUEST" })
    if (!Number.isFinite(variant.price) || variant.price <= 0) {
      throw Object.assign(new Error("Variant price must be greater than 0"), { code: "BAD_REQUEST" })
    }
    if (!Number.isFinite(variant.duration) || variant.duration < 10 || variant.duration > 480) {
      throw Object.assign(new Error("Variant duration must be between 10 and 480 minutes"), { code: "BAD_REQUEST" })
    }
  }
  const created = await createServiceCatalogItem({
    name,
    category,
    targetGender,
    basePrice,
    durationMinutes: duration,
    description,
    imageUrl: image,
    variants,
    createdBy: actorUserId,
  })
  auditAuthAsync("auth", "admin_service_created", {
    adminUserId: actorUserId,
    serviceId: created?.id,
    serviceName: created?.name,
  })
  return created
}

export async function updateAdminService({ serviceId, payload, actorUserId }) {
  const name = `${payload?.name ?? ""}`.trim()
  const category = `${payload?.category ?? ""}`.trim().toUpperCase()
  const targetGender = normalizeServiceGender(payload?.gender)
  const basePrice = Number(payload?.basePrice ?? 0)
  const duration = Number(payload?.duration ?? 0)
  const description = `${payload?.description ?? ""}`.trim()
  const image = `${payload?.image ?? ""}`.trim()
  const discountPercentRaw = payload?.discountPercent
  const discountPercent = discountPercentRaw === undefined ? undefined : Number(discountPercentRaw)
  const isActive = Boolean(payload?.isActive)
  const variantsRaw = Array.isArray(payload?.variants) ? payload.variants : []
  const variants = variantsRaw.map(item => ({
    name: `${item?.name ?? ""}`.trim(),
    price: Number(item?.price ?? 0),
    duration: Number(item?.duration ?? 0),
  }))
  if (!serviceId) throw Object.assign(new Error("Service id is required"), { code: "BAD_REQUEST" })
  if (!name || !category || !targetGender) throw Object.assign(new Error("Name, category and gender are required"), { code: "BAD_REQUEST" })
  if (!Number.isFinite(basePrice) || basePrice <= 0) throw Object.assign(new Error("Base price must be greater than 0"), { code: "BAD_REQUEST" })
  if (!Number.isFinite(duration) || duration < 10 || duration > 480) throw Object.assign(new Error("Duration must be between 10 and 480 minutes"), { code: "BAD_REQUEST" })
  if (discountPercent !== undefined) {
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      throw Object.assign(new Error("Discount percent must be between 0 and 100"), { code: "BAD_REQUEST" })
    }
  }
  for (const variant of variants) {
    if (!variant.name) throw Object.assign(new Error("Variant name is required"), { code: "BAD_REQUEST" })
    if (!Number.isFinite(variant.price) || variant.price <= 0) throw Object.assign(new Error("Variant price must be greater than 0"), { code: "BAD_REQUEST" })
    if (!Number.isFinite(variant.duration) || variant.duration < 10 || variant.duration > 480) throw Object.assign(new Error("Variant duration must be between 10 and 480 minutes"), { code: "BAD_REQUEST" })
  }
  const updated = await updateServiceCatalogItem({
    id: serviceId,
    name,
    category,
    targetGender,
    basePrice,
    durationMinutes: duration,
    description,
    imageUrl: image,
    variants,
    discountPercent,
    isActive,
  })
  if (!updated) throw Object.assign(new Error("Service not found"), { code: "NOT_FOUND" })
  auditAuthAsync("auth", "admin_service_updated", {
    adminUserId: actorUserId,
    serviceId,
    isActive,
  })
  return updated
}

export async function createCustomerBooking({ payload, actorUser, publishEvent, publishPaymentEvent }) {
  const serviceIds = Array.isArray(payload.serviceIds) ? payload.serviceIds.map(item => `${item ?? ""}`.trim()).filter(Boolean) : []
  const stylistId = `${payload.stylistId ?? ""}`.trim()
  const comboId = `${payload.comboId ?? ""}`.trim() || null
  const bookingDate = `${payload.bookingDate ?? ""}`.trim()
  const bookingTime = `${payload.bookingTime ?? ""}`.trim()
  const startsAtRaw = `${payload.startsAt ?? ""}`.trim()
  if (!serviceIds.length) throw Object.assign(new Error("At least one service is required"), { code: "BAD_REQUEST" })
  if (!stylistId) throw Object.assign(new Error("Stylist is required"), { code: "BAD_REQUEST" })
  const customerGender = normalizeCustomerGender(actorUser?.gender)
  const membershipSegment = `${actorUser?.membershipSegment ?? "FREE"}`.trim().toUpperCase() || "FREE"
  const startsAt = startsAtRaw ? new Date(startsAtRaw) : new Date(`${bookingDate}T${bookingTime}:00`)
  if (Number.isNaN(startsAt.getTime())) throw Object.assign(new Error("Valid slot time is required"), { code: "BAD_REQUEST" })
  const bookingDateIso = startsAt.toISOString().slice(0, 10)
  if (!isTodayOrTomorrow(bookingDateIso)) throw Object.assign(new Error("Bookings are allowed only for today or tomorrow"), { code: "BAD_REQUEST" })

  const serviceCatalog = await listServiceCatalog()
  const pricing = await computeBookingOfferPricing({
    serviceIds,
    membershipSegment,
    comboId,
    serviceCatalog,
  })
  const selectedServices = serviceCatalog.filter(service => serviceIds.includes(service.id))
  const durationMinutes = selectedServices.reduce((sum, service) => sum + Number(service.duration ?? service.durationMinutes ?? 0), 0)
  const availableStylists = await listRecommendedStylists({
    serviceIds,
    startsAt: startsAt.toISOString(),
    durationMinutes,
    customerGender,
  })
  const isChosenStylistAvailable = availableStylists.some(stylist => stylist.id === stylistId)
  if (!isChosenStylistAvailable) {
    const alternatives = availableStylists.slice(0, 3).map(item => ({ id: item.id, name: item.name }))
    throw Object.assign(new Error("Selected stylist is not available for this slot"), {
      code: "STYLIST_UNAVAILABLE",
      alternatives,
    })
  }

  // First-time-customer discount and wallet credit are both applied on top of
  // offer/membership pricing, then folded into discountAmount so
  // payableAmount = totalAmount - discountAmount stays true for invoices and
  // revenue reports. Both are always recomputed by the server from the
  // customer's actual booking history / wallet balance — never trusted from
  // the client. Order: offers -> first-booking discount -> wallet credit.
  let payableAmount = pricing.payableAmount
  let discountAmount = pricing.discountAmount
  let firstBookingDiscountAmount = 0
  const firstBookingDiscount = await computeFirstBookingDiscount({ userId: actorUser.id, payableAmount })
  if (firstBookingDiscount.discountAmount > 0) {
    firstBookingDiscountAmount = firstBookingDiscount.discountAmount
    payableAmount = Math.max(0, payableAmount - firstBookingDiscountAmount)
    discountAmount += firstBookingDiscountAmount
  }
  // A won reward-card voucher makes one specific selected service free.
  // Claimed atomically UP FRONT (before any discount is applied) so a lost
  // race against a concurrent claim falls back to "no voucher" instead of
  // granting the discount without ever actually consuming a voucher.
  // Not available alongside a combo: combo pricing only returns each item's
  // standalone price (not its share of the bundle), so "free" would be
  // computed against the wrong base and over-discount the bundle total.
  let voucherWinId = null
  let voucherDiscountAmount = 0
  const requestedVoucherServiceId = `${payload?.redeemRewardServiceId ?? ""}`.trim()
  if (!comboId && requestedVoucherServiceId && serviceIds.includes(requestedVoucherServiceId)) {
    const voucherItem = pricing.serviceItems.find(item => item.id === requestedVoucherServiceId)
    if (voucherItem) {
      const claim = await claimRewardVoucher({ userId: actorUser.id, serviceId: requestedVoucherServiceId })
      if (claim) {
        const itemFinalPrice = Number(voucherItem.basePrice ?? 0) * (1 - Number(voucherItem.discountPercent ?? 0) / 100)
        voucherDiscountAmount = Math.max(0, Math.min(payableAmount, Math.round(itemFinalPrice * 100) / 100))
        voucherWinId = claim.winId
        payableAmount = Math.max(0, payableAmount - voucherDiscountAmount)
        discountAmount += voucherDiscountAmount
      }
    }
  }
  let walletRedeemAmount = 0
  if (payload?.useWalletCredit && payableAmount > 0) {
    walletRedeemAmount = await redeemWalletCredit({ userId: actorUser.id, maxAmount: payableAmount })
    if (walletRedeemAmount > 0) {
      payableAmount = Math.max(0, payableAmount - walletRedeemAmount)
      discountAmount += walletRedeemAmount
    }
  }

  const booking = await createBooking({
    customerName: actorUser.name,
    customerEmail: actorUser.email,
    customerPhone: actorUser.phone,
    serviceName: selectedServices.map(service => service.name).join(", "),
    serviceItems: pricing.serviceItems,
    stylistId,
    startsAt: startsAt.toISOString(),
    durationMinutes,
    totalAmount: pricing.totalAmount,
    discountAmount,
    payableAmount,
    invoiceNumber: `INV-${Date.now()}`,
    status: "CONFIRMED",
    createdBy: actorUser.id,
  })
  auditAuthAsync("auth", "customer_booking_created", {
    customerUserId: actorUser.id,
    bookingId: booking?.id,
    stylistId,
    walletRedeemAmount,
    firstBookingDiscountAmount,
    voucherDiscountAmount,
  })
  if (booking?.id && voucherWinId) {
    attachRewardVoucherToBooking({ winId: voucherWinId, bookingId: booking.id }).catch(error =>
      console.error("attach_reward_voucher_to_booking_failed", error)
    )
  }
  if (booking?.id && payableAmount > 0) {
    await recordReceptionPayment({
      payload: {
        sourceType: "BOOKING",
        bookingId: booking.id,
        paymentMode: "ONLINE",
        amount: payableAmount,
      },
      actorUserId: actorUser.id,
      publishPaymentEvent,
    })
  }
  if (booking?.id) {
    booking.walletRedeemAmount = walletRedeemAmount
    booking.firstBookingDiscountAmount = firstBookingDiscountAmount
    booking.voucherDiscountAmount = voucherDiscountAmount
    notifyUser({
      userId: actorUser.id,
      type: "BOOKING_CONFIRMED",
      title: "Booking confirmed",
      body: `${booking.service} on ${formatNotifyDateTime(booking.startsAt)} with ${booking.stylistName ?? "your stylist"} is confirmed.`,
      data: { bookingId: booking.id },
    }).catch(error => console.error("notify_booking_confirmed_failed", error))
    if (stylistId) {
      notifyUser({
        userId: stylistId,
        type: "BOOKING_ASSIGNED",
        title: "New appointment assigned",
        body: `${booking.service} for ${booking.customer} at ${formatNotifyDateTime(booking.startsAt)}.`,
        data: { bookingId: booking.id },
      }).catch(error => console.error("notify_booking_assigned_failed", error))
    }
  }
  if (booking && publishEvent) publishEvent("booking.updated.v1", booking)
  return booking
}

export async function upsertAdminStylistShift({ stylistId, shiftStart, shiftEnd, isActive, actorUserId }) {
  if (!stylistId) throw Object.assign(new Error("Stylist id is required"), { code: "BAD_REQUEST" })
  const shift = await upsertStylistShift({ stylistId, shiftStart, shiftEnd, isActive })
  auditAuthAsync("auth", "admin_shift_upserted", { adminUserId: actorUserId, stylistId })
  return shift
}

export async function addAdminStylistLeave({ stylistId, leaveStart, leaveEnd, note, actorUserId }) {
  if (!stylistId || !leaveStart || !leaveEnd) throw Object.assign(new Error("stylistId, leaveStart and leaveEnd are required"), { code: "BAD_REQUEST" })
  const leave = await createStylistLeave({ stylistId, leaveStart, leaveEnd, note, createdBy: actorUserId })
  auditAuthAsync("auth", "admin_leave_created", { adminUserId: actorUserId, stylistId })
  return leave
}

export async function listRoleQueue({ role, userId, limit, publishEvent } = {}) {
  await autoCompleteOverdueStartedBookings({ publishEvent })
  await autoMarkNoShowBookings({ publishEvent })
  return listQueueBookingsForRole({ role, userId, limit })
}

export async function startStylistBooking({ bookingId, actorUserId, publishEvent }) {
  const booking = await markBookingStarted({ bookingId, stylistId: actorUserId })
  if (!booking) throw Object.assign(new Error("Booking not found for stylist"), { code: "NOT_FOUND" })
  if (publishEvent) publishEvent("booking.updated.v1", booking)
  return booking
}

export async function completeStylistBooking({ bookingId, actorUserId, publishEvent }) {
  const policy = await getPayrollPolicy()
  const booking = await markBookingCompletedWithPenalty({
    bookingId,
    stylistId: actorUserId,
    graceMinutes: policy.graceMinutes,
    penaltyPerMinute: policy.penaltyPerMinute,
  })
  if (!booking) throw Object.assign(new Error("Booking not found for stylist"), { code: "NOT_FOUND" })
  if (booking.createdBy) {
    rewardReferralIfEligible({ userId: booking.createdBy }).catch(error =>
      console.error("reward_referral_stylist_complete_failed", error)
    )
  }
  if (publishEvent) publishEvent("booking.updated.v1", booking)
  return booking
}

export async function getAdminPayrollPolicy() {
  return getPayrollPolicy()
}

export async function saveAdminPayrollPolicy({ payload, actorUserId }) {
  const graceMinutes = Number(payload?.graceMinutes ?? 10)
  const penaltyPerMinute = Number(payload?.penaltyPerMinute ?? 0)
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0 || graceMinutes > 180) {
    throw Object.assign(new Error("graceMinutes must be between 0 and 180"), { code: "BAD_REQUEST" })
  }
  if (!Number.isFinite(penaltyPerMinute) || penaltyPerMinute < 0 || penaltyPerMinute > 10000) {
    throw Object.assign(new Error("penaltyPerMinute must be between 0 and 10000"), { code: "BAD_REQUEST" })
  }
  return upsertPayrollPolicy({ graceMinutes, penaltyPerMinute, updatedBy: actorUserId })
}

export async function getMonthlyDeductionsReport({ month }) {
  const normalized = `${month ?? ""}`.trim()
  if (!/^\d{4}-\d{2}$/.test(normalized)) {
    throw Object.assign(new Error("month must be YYYY-MM"), { code: "BAD_REQUEST" })
  }
  return listMonthlyStylistDeductions({ month: normalized })
}

const PAYMENT_MODES = ["ONLINE", "OFFLINE_CASH", "OFFLINE_UPI"]
const PAYMENT_SOURCES = ["BOOKING", "WALKIN"]

export async function recordReceptionPayment({ payload, actorUserId, publishPaymentEvent }) {
  const sourceType = `${payload?.sourceType ?? "BOOKING"}`.trim().toUpperCase()
  const paymentMode = `${payload?.paymentMode ?? ""}`.trim().toUpperCase()
  const amount = Number(payload?.amount ?? 0)
  const bookingId = `${payload?.bookingId ?? ""}`.trim() || null
  const customerName = `${payload?.customerName ?? ""}`.trim()
  const customerEmail = `${payload?.customerEmail ?? ""}`.trim().toLowerCase()
  const customerPhone = `${payload?.customerPhone ?? ""}`.trim()

  if (!PAYMENT_SOURCES.includes(sourceType)) throw Object.assign(new Error("Invalid sourceType"), { code: "BAD_REQUEST" })
  if (!PAYMENT_MODES.includes(paymentMode)) throw Object.assign(new Error("Invalid paymentMode"), { code: "BAD_REQUEST" })
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error("amount must be greater than 0"), { code: "BAD_REQUEST" })

  let resolvedBookingId = bookingId
  let resolvedCustomerName = customerName
  let resolvedCustomerEmail = customerEmail
  let resolvedCustomerPhone = customerPhone
  if (sourceType === "BOOKING") {
    if (!bookingId) throw Object.assign(new Error("bookingId is required for booking payment"), { code: "BAD_REQUEST" })
    const booking = await getBookingById(bookingId)
    if (!booking) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
    // Guards against double-collecting: bookings are already paid in full at creation time
    // (both online self-service and reception walk-in), so without this check the reception
    // "Collect payment" panel could record a second payment against an already-settled booking.
    const alreadyPaid = Number(booking.paidAmount ?? 0)
    const remainingDue = Math.round((Number(booking.payableAmount ?? 0) - alreadyPaid) * 100) / 100
    if (amount > remainingDue + 0.01) {
      throw Object.assign(
        new Error(`Amount exceeds the remaining balance due (Rs ${Math.max(0, remainingDue).toFixed(2)})`),
        { code: "BAD_REQUEST" }
      )
    }
    resolvedBookingId = booking.id
    resolvedCustomerName = booking.customer
    resolvedCustomerEmail = booking.customerEmail
    resolvedCustomerPhone = booking.customerPhone
  } else if (!resolvedCustomerName) {
    throw Object.assign(new Error("customerName is required for walk-in payment"), { code: "BAD_REQUEST" })
  }

  const inserted = await createPaymentTransaction({
    bookingId: resolvedBookingId,
    sourceType,
    customerName: resolvedCustomerName,
    customerEmail: resolvedCustomerEmail,
    customerPhone: resolvedCustomerPhone,
    amount,
    paymentMode,
    collectedBy: actorUserId,
  })
  const payment = inserted?.id ? await getPaymentHistoryById(inserted.id) : null
  auditAuthAsync("auth", "reception_payment_recorded", {
    receptionistUserId: actorUserId,
    paymentId: payment?.id,
    sourceType,
    paymentMode,
    amount,
  })
  if (payment && publishPaymentEvent) publishPaymentEvent("payment.updated.v1", payment)
  return payment
}

const ADMIN_PAYMENT_MODE_FILTERS = new Set(["ONLINE", "OFFLINE_CASH", "OFFLINE_UPI"])

export async function getAdminRevenueReport({ month, paymentMode, from, to, limit, offset }) {
  const normalizedMonth = /^\d{4}-\d{2}$/.test(`${month ?? ""}`.trim())
    ? `${month}`.trim()
    : new Date().toISOString().slice(0, 7)
  const modeRaw = `${paymentMode ?? ""}`.trim().toUpperCase()
  const modeFilter = ADMIN_PAYMENT_MODE_FILTERS.has(modeRaw) ? modeRaw : null
  const summary = await getRevenueSummaryForDate()
  const { payments, pagination } = await listPaymentTransactions({
    month: normalizedMonth,
    paymentMode: modeFilter,
    from: `${from ?? ""}`.trim() || null,
    to: `${to ?? ""}`.trim() || null,
    limit: limit ?? 100,
    offset: offset ?? 0,
  })
  return {
    month: normalizedMonth,
    summary,
    latestPayments: payments,
    pagination,
  }
}

export async function updateReceptionBookingLifecycle({ bookingId, payload, actorUserId, publishEvent, publishPaymentEvent }) {
  const action = `${payload?.action ?? ""}`.trim().toLowerCase()
  if (!bookingId || !action) throw Object.assign(new Error("bookingId and action are required"), { code: "BAD_REQUEST" })
  let updated = null
  if (action === "cancel") {
    // Reuses the same tiered refund policy as a customer's own cancellation
    // (100%/50%/0% by time-to-appointment) — every booking here was already
    // paid in full at creation, so cancelling without this would leave the
    // collected payment unaccounted for with no refund ever recorded.
    const current = await getBookingById(bookingId)
    if (!current) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
    const currentStatus = normalizeBookingStatus(current.status)
    if (!canTransitionBookingStatus(currentStatus, "CANCELLED")) {
      throw Object.assign(new Error("This booking cannot be cancelled"), { code: "INVALID_TRANSITION" })
    }
    const refundPreview = computeCancellationRefund({
      payableAmount: current.payableAmount,
      startsAt: current.startsAt,
    })
    if (!refundPreview.canCancel) {
      throw Object.assign(new Error(refundPreview.reason ?? "Cannot cancel this booking"), { code: "BAD_REQUEST" })
    }
    updated = await updateBookingSchedule({ bookingId, status: "CANCELLED", updatedBy: actorUserId })
    if (refundPreview.refundAmount > 0) {
      await recordBookingRefund({
        booking: current,
        amount: refundPreview.refundAmount,
        actorUserId,
        publishPaymentEvent,
      })
    }
  } else if (action === "complete") {
    // Only the assigned stylist can complete service (see completeStylistBooking) —
    // that path also computes overtime/penalty from the real start time and triggers
    // referral rewards, none of which a bare status flip here could do correctly.
    throw Object.assign(
      new Error("Only the assigned stylist can mark a booking as completed, from their own portal."),
      { code: "FORBIDDEN" }
    )
  } else if (action === "assign" || action === "reschedule") {
    const startsAt = payload?.startsAt ? new Date(payload.startsAt).toISOString() : null
    const stylistId = `${payload?.stylistId ?? ""}`.trim() || null
    const current = await getBookingById(bookingId)
    if (!current) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
    updated = await updateBookingSchedule({
      bookingId,
      stylistId,
      startsAt,
      durationMinutes: current.durationMinutes,
      updatedBy: actorUserId,
      status: "CONFIRMED",
    })
  } else {
    throw Object.assign(new Error("Unsupported action"), { code: "BAD_REQUEST" })
  }
  if (!updated) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
  if (publishEvent) publishEvent("booking.updated.v1", updated)
  return updated
}

function customerOwnsBooking(booking, actorUser) {
  const email = `${actorUser?.email ?? ""}`.trim().toLowerCase()
  const phone = `${actorUser?.phone ?? ""}`.trim()
  const bookingEmail = `${booking?.customerEmail ?? ""}`.trim().toLowerCase()
  const bookingPhone = `${booking?.customerPhone ?? ""}`.trim()
  if (booking?.createdBy && actorUser?.id && booking.createdBy === actorUser.id) return true
  if (email && bookingEmail && email === bookingEmail) return true
  if (phone && bookingPhone && phone === bookingPhone) return true
  return false
}

export async function getCustomerCancellationPreview({ bookingId, actorUser }) {
  const booking = await getBookingById(bookingId)
  if (!booking) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
  if (!customerOwnsBooking(booking, actorUser)) {
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" })
  }
  const status = normalizeBookingStatus(booking.status)
  const cancellableStatuses = new Set(["PENDING", "CONFIRMED"])
  if (!cancellableStatuses.has(status)) {
    return {
      policyRules: CUSTOMER_CANCELLATION_POLICY_RULES,
      booking: { id: booking.id, status, startsAt: booking.startsAt, payableAmount: booking.payableAmount },
      preview: {
        canCancel: false,
        reason:
          status === "STARTED"
            ? "This appointment is in progress and cannot be cancelled online."
            : "Only upcoming bookings can be cancelled. Remove completed records from history instead.",
      },
    }
  }
  const refundPreview = computeCancellationRefund({
    payableAmount: booking.payableAmount,
    startsAt: booking.startsAt,
  })
  return {
    policyRules: CUSTOMER_CANCELLATION_POLICY_RULES,
    booking: {
      id: booking.id,
      status,
      service: booking.service,
      stylistName: booking.stylistName,
      startsAt: booking.startsAt,
      payableAmount: booking.payableAmount,
    },
    preview: refundPreview,
  }
}

async function recordBookingRefund({ booking, amount, actorUserId, publishPaymentEvent }) {
  const refundAmount = Number(amount ?? 0)
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) return null
  const inserted = await createPaymentTransaction({
    bookingId: booking.id,
    sourceType: "REFUND",
    customerName: booking.customer,
    customerEmail: booking.customerEmail,
    customerPhone: booking.customerPhone,
    amount: refundAmount,
    paymentMode: "ONLINE",
    collectedBy: actorUserId,
  })
  const payment = inserted?.id ? await getPaymentHistoryById(inserted.id) : null
  if (payment && publishPaymentEvent) publishPaymentEvent("payment.updated.v1", payment)
  return payment
}

export async function cancelCustomerBooking({ bookingId, actorUser, publishEvent, publishPaymentEvent }) {
  const booking = await getBookingById(bookingId)
  if (!booking) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
  if (!customerOwnsBooking(booking, actorUser)) {
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" })
  }
  const status = normalizeBookingStatus(booking.status)
  if (!canTransitionBookingStatus(status, "CANCELLED")) {
    throw Object.assign(new Error("This booking cannot be cancelled"), { code: "INVALID_TRANSITION" })
  }
  const refundPreview = computeCancellationRefund({
    payableAmount: booking.payableAmount,
    startsAt: booking.startsAt,
  })
  if (!refundPreview.canCancel) {
    throw Object.assign(new Error(refundPreview.reason ?? "Cannot cancel this booking"), { code: "BAD_REQUEST" })
  }
  await updateBookingSchedule({ bookingId, status: "CANCELLED", updatedBy: actorUser.id })
  let refundPayment = null
  if (refundPreview.refundAmount > 0) {
    refundPayment = await recordBookingRefund({
      booking,
      amount: refundPreview.refundAmount,
      actorUserId: actorUser.id,
      publishPaymentEvent,
    })
  }
  const updated = await getBookingById(bookingId)
  auditAuthAsync("auth", "customer_booking_cancelled", {
    customerUserId: actorUser.id,
    bookingId,
    refundAmount: refundPreview.refundAmount,
    refundPercent: refundPreview.refundPercent,
  })
  notifyUser({
    userId: actorUser.id,
    type: "BOOKING_CANCELLED",
    title: "Booking cancelled",
    body:
      refundPreview.refundAmount > 0
        ? `Your ${booking.service} booking was cancelled. Rs ${refundPreview.refundAmount.toFixed(2)} (${refundPreview.refundPercent}%) will be refunded.`
        : `Your ${booking.service} booking was cancelled. No refund applies at this stage.`,
    data: { bookingId },
  }).catch(error => console.error("notify_booking_cancelled_failed", error))
  notifyRole({
    role: "ADMIN",
    type: "BOOKING_CANCELLED_ADMIN",
    title: "Customer cancelled a booking",
    body: `${booking.customer} cancelled ${booking.service} (${formatNotifyDateTime(booking.startsAt)}).`,
    data: { bookingId },
  }).catch(error => console.error("notify_booking_cancelled_admin_failed", error))
  if (publishEvent && updated) publishEvent("booking.updated.v1", updated)
  return {
    id: bookingId,
    booking: updated,
    refund: {
      percent: refundPreview.refundPercent,
      amount: refundPreview.refundAmount,
      retainedAmount: refundPreview.retainedAmount,
      credited: Boolean(refundPayment),
      message:
        refundPreview.refundAmount > 0
          ? `Rs ${refundPreview.refundAmount.toFixed(2)} (${refundPreview.refundPercent}% refund) will be credited to your original payment method.`
          : "No refund applies for this cancellation. Your stylist slot has been freed.",
    },
    stylistFreedImmediately: true,
  }
}

/** Remove a booking from the customer's history (hard delete). Does not apply to in-progress appointments. */
export async function removeCustomerBookingFromHistory({ bookingId, actorUser, publishEvent }) {
  const booking = await getBookingById(bookingId)
  if (!booking) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
  if (!customerOwnsBooking(booking, actorUser)) {
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" })
  }
  const status = normalizeBookingStatus(booking.status)
  if (status === "STARTED") {
    throw Object.assign(new Error("In-progress appointments cannot be removed"), { code: "INVALID_TRANSITION" })
  }
  if (status === "PENDING" || status === "CONFIRMED") {
    throw Object.assign(
      new Error("Upcoming bookings must be cancelled first (use Cancel booking to apply the refund policy)"),
      { code: "BAD_REQUEST" }
    )
  }
  const deleted = await deleteBookingById(bookingId)
  if (!deleted) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
  auditAuthAsync("auth", "customer_booking_deleted", {
    customerUserId: actorUser.id,
    bookingId,
  })
  if (publishEvent) publishEvent("booking.deleted.v1", { id: bookingId })
  return { id: bookingId, deleted: true }
}

export async function getBookingInvoice({ bookingId, actorUser }) {
  const booking = await getBookingById(bookingId)
  if (!booking) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
  if (actorUser.role === "USER" && booking.createdBy !== actorUser.id) {
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" })
  }
  if (actorUser.role === "STAFF" && booking.stylistId !== actorUser.id) {
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" })
  }
  return booking
}

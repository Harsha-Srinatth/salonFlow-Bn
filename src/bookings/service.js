import { auditAuthAsync } from "../lib/audit-log.js"
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
    customerGender: "OTHER",
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
    if (publishEvent) publishEvent("booking.updated.v1", booking)
  }
  return completed
}

export async function listCustomerBookings({ customerEmail, customerPhone, limit, offset, publishEvent } = {}) {
  await autoCompleteOverdueStartedBookings({ publishEvent })
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
  const customerGender = `${actorUser?.gender ?? "OTHER"}`.trim().toUpperCase()
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
    discountAmount: pricing.discountAmount,
    payableAmount: pricing.payableAmount,
    invoiceNumber: `INV-${Date.now()}`,
    status: "CONFIRMED",
    createdBy: actorUser.id,
  })
  auditAuthAsync("auth", "customer_booking_created", {
    customerUserId: actorUser.id,
    bookingId: booking?.id,
    stylistId,
  })
  if (booking?.id && pricing.payableAmount > 0) {
    await recordReceptionPayment({
      payload: {
        sourceType: "BOOKING",
        bookingId: booking.id,
        paymentMode: "ONLINE",
        amount: pricing.payableAmount,
      },
      actorUserId: actorUser.id,
      publishPaymentEvent,
    })
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

export async function updateReceptionBookingLifecycle({ bookingId, payload, actorUserId, publishEvent }) {
  const action = `${payload?.action ?? ""}`.trim().toLowerCase()
  if (!bookingId || !action) throw Object.assign(new Error("bookingId and action are required"), { code: "BAD_REQUEST" })
  let updated = null
  if (action === "cancel") {
    updated = await updateBookingSchedule({ bookingId, status: "CANCELLED", updatedBy: actorUserId })
  } else if (action === "complete") {
    updated = await updateBookingSchedule({ bookingId, status: "COMPLETED", updatedBy: actorUserId })
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

import { v4 as uuid } from "uuid"
import {
  addDaysToDateString,
  isTodayOrTomorrowInSalon,
  salonDateString,
  salonMinutesOfDay,
  salonWallClockToDate,
} from "../lib/salon-time.js"
import { auditAuthAsync } from "../lib/audit-log.js"
import { pool } from "../lib/db-pool.js"
import { generateInvoiceNumber } from "../lib/invoice-number.js"
import { roundMoney } from "../lib/money.js"
import { isOnlinePaymentRequired, isRazorpayConfigured } from "../payments/config.js"
import { initiateCancellationRefund } from "../payments/cancel-refund.js"
import { ensurePaymentsSchema } from "../payments/schema-init.js"
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
  hideBookingFromCustomer,
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
  lockStylistSchedule,
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
  return salonWallClockToDate(dateIso, minutes)
}

function isTodayOrTomorrow(dateIso) {
  return isTodayOrTomorrowInSalon(dateIso)
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

/**
 * Admin "Cancelled" used to flip the status and nothing else: no refund row, no message to
 * the customer, so a paid booking could disappear with the money unaccounted for. It now
 * takes the same atomic refund-policy path as every other cancellation and tells the customer.
 */
async function cancelBookingAsStaff({ bookingId, actorUserId, publishEvent, publishPaymentEvent, refundPercent = null }) {
  const existing = await getBookingById(bookingId)
  if (!existing) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
  if (normalizeBookingStatus(existing.status) === "CANCELLED") return existing
  const { booking, refundPreview, refundPaymentId, gatewayRefund, gatewayRefundQueued } = await cancelBookingWithRefund({
    bookingId,
    actorUserId,
    auditAction: "booking_status_updated",
    refundPercentOverride: refundPercent,
  })
  await publishRefundPayment(refundPaymentId, publishPaymentEvent)
  const updated = await getBookingById(bookingId)
  auditAuthAsync("auth", "admin_booking_status_updated", { adminUserId: actorUserId, bookingId, toStatus: "CANCELLED" })
  if (booking.createdBy) {
    notifyUser({
      userId: booking.createdBy,
      type: "BOOKING_CANCELLED",
      title: "Booking cancelled by the salon",
      body:
        refundPreview.refundAmount > 0
          ? `Your ${booking.service} booking on ${formatNotifyDateTime(booking.startsAt)} was cancelled. Rs ${refundPreview.refundAmount.toFixed(2)} (${refundPreview.refundPercent}%) will be refunded.`
          : `Your ${booking.service} booking on ${formatNotifyDateTime(booking.startsAt)} was cancelled.`,
      data: { bookingId },
    }).catch(error => console.error("notify_staff_cancel_failed", error))
  }
  if (updated) {
    updated.refund = {
      percent: refundPreview.refundPercent,
      amount: refundPreview.refundAmount,
      retainedAmount: refundPreview.retainedAmount,
      basis: refundPreview.policyKey,
      gatewayRefund: gatewayRefundQueued ? (gatewayRefund ? "INITIATED" : "PENDING") : null,
    }
  }
  if (updated && publishEvent) publishEvent("booking.updated.v1", updated)
  return updated
}

export async function transitionAdminBookingStatus({ bookingId, requestedStatus, actorUserId, publishEvent, publishPaymentEvent, refundPercent = null }) {
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
  if (nextStatus === "CANCELLED") {
    return cancelBookingAsStaff({ bookingId, actorUserId, publishEvent, publishPaymentEvent, refundPercent })
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

/**
 * Server-side enforcement of the rules the slot picker already shows. The picker hides
 * past times, closed hours, lunch, stylist shifts and leave, but the create endpoints
 * used to accept any time the client sent, so a direct API call could book 3 a.m. or an
 * hour ago. Runs inside the booking transaction (after the stylist lock) so it sees the
 * same data the insert will.
 */
async function assertBookableWindow({ client, stylistId, startsAt, durationMinutes, graceMinutes }) {
  const fail = message => Object.assign(new Error(message), { code: "BAD_REQUEST" })
  if (startsAt.getTime() < Date.now() - graceMinutes * 60_000) throw fail("That time has already passed")
  const startMinute = salonMinutesOfDay(startsAt)
  const endMinute = startMinute + durationMinutes
  if (startMinute < SALON_OPEN_MINUTES || endMinute > SALON_CLOSE_MINUTES) {
    throw fail("The salon is closed at that time (open 08:00 to 23:00)")
  }
  if (overlaps(startMinute, endMinute, LUNCH_START_MINUTES, LUNCH_END_MINUTES)) throw fail("That time falls in the lunch break")
  const { rows: shiftRows } = await client.query(
    "SELECT shift_start, shift_end FROM stylist_shift_windows WHERE stylist_id = $1 LIMIT 1",
    [stylistId]
  )
  const shiftStart = hhmmToMinutes(shiftRows[0]?.shift_start, SALON_OPEN_MINUTES)
  const shiftEnd = hhmmToMinutes(shiftRows[0]?.shift_end, SALON_CLOSE_MINUTES)
  if (startMinute < shiftStart || endMinute > shiftEnd) throw fail("That stylist is not working at that time")
  const { rows: leaveRows } = await client.query(
    "SELECT 1 FROM stylist_leaves WHERE stylist_id = $1 AND $2::date BETWEEN leave_start AND leave_end LIMIT 1",
    [stylistId, salonDateString(startsAt)]
  )
  if (leaveRows.length) throw fail("That stylist is on leave that day")
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
  // The tier decides the discount, so it is read from the customer's record. Taking it from
  // the request body let any receptionist pick PREMIUM pricing for any customer.
  const membershipSegment = await getMembershipSegmentForUser(customerAccount.id)
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
  const paymentMode = `${payload.paymentMode ?? ""}`.trim().toUpperCase()
  const walkInPaymentModes = ["OFFLINE_CASH", "OFFLINE_UPI"]
  if (!walkInPaymentModes.includes(paymentMode)) {
    throw Object.assign(new Error("paymentMode must be OFFLINE_CASH or OFFLINE_UPI"), { code: "BAD_REQUEST" })
  }
  const bookingId = uuid()
  // Availability re-check, booking and payment in one transaction, serialised per
  // stylist (see createCustomerBooking for why).
  const { booking, paymentId } = await withTransaction(async client => {
    await lockStylistSchedule(client, stylistId)
    await assertBookableWindow({ client, stylistId, startsAt: new Date(startsAt), durationMinutes, graceMinutes: 15 })
    const availableStylists = await listRecommendedStylists({
      serviceIds: resolvedServiceIds,
      startsAt: new Date(startsAt).toISOString(),
      durationMinutes,
      customerGender,
      db: client,
    })
    if (!availableStylists.some(stylist => stylist.id === stylistId)) {
      throw Object.assign(new Error("Selected stylist cannot perform this service at selected slot"), { code: "BAD_REQUEST" })
    }
    const created = await createBooking({
      id: bookingId,
      db: client,
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
      invoiceNumber: generateInvoiceNumber(),
      status: "CONFIRMED",
      createdBy: customerAccount.id,
    })
    let insertedPaymentId = null
    if (created?.id && pricing.payableAmount > 0) {
      const inserted = await createPaymentTransaction({
        db: client,
        bookingId: created.id,
        sourceType: "BOOKING",
        customerName: created.customer,
        customerEmail: created.customerEmail,
        customerPhone: created.customerPhone,
        amount: pricing.payableAmount,
        paymentMode,
        collectedBy: actorUserId,
      })
      insertedPaymentId = inserted?.id ?? null
    }
    return { booking: created, paymentId: insertedPaymentId }
  })
  if (paymentId) {
    const payment = await getPaymentHistoryById(paymentId)
    auditAuthAsync("auth", "reception_payment_recorded", {
      receptionistUserId: actorUserId,
      paymentId,
      sourceType: "BOOKING",
      paymentMode,
      amount: pricing.payableAmount,
    })
    if (payment && publishPaymentEvent) publishPaymentEvent("payment.updated.v1", payment)
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
  return listBookingsForCustomer({ customerEmail, customerPhone, limit, offset })
}

export async function listBookableServices() {
  return listServiceCatalog()
}

export async function listAdminServices() {
  return listServiceCatalog({ includeInactive: true })
}

export async function listRecommendedStylists({ serviceIds, startsAt, durationMinutes, customerGender, db }) {
  const safeServiceIds = Array.isArray(serviceIds) ? serviceIds.filter(Boolean) : []
  if (!safeServiceIds.length) return []
  return findAvailableStylistsForServices({
    serviceIds: safeServiceIds,
    startsAt,
    durationMinutes,
    customerGender,
    db,
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
  // The salon's calendar day, expressed as real instants (not "00:00 UTC").
  const dayStart = salonWallClockToDate(date, 0).toISOString()
  const dayEnd = salonWallClockToDate(addDaysToDateString(date, 1), 0).toISOString()
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
  const isToday = date === salonDateString(now)
  const nowMinutesRaw = salonMinutesOfDay(now) + (now.getSeconds() > 0 || now.getMilliseconds() > 0 ? 1 : 0)
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

/**
 * Resolves and validates everything a customer booking needs *before* the transaction:
 * request fields, slot time, server-side catalogue pricing and the first-booking discount.
 * Shared by the legacy booking route, the payment quote and the post-payment confirmation, so
 * all three always agree on the price.
 */
async function buildCustomerBookingContext({ payload, actorUser }) {
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
  const startsAt = startsAtRaw
    ? new Date(startsAtRaw)
    : salonWallClockToDate(bookingDate, hhmmToMinutes(bookingTime, Number.NaN))
  if (Number.isNaN(startsAt.getTime())) throw Object.assign(new Error("Valid slot time is required"), { code: "BAD_REQUEST" })
  const bookingDateIso = salonDateString(startsAt)
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

  // First-time-customer discount and wallet credit are both applied on top of
  // offer/membership pricing, then folded into discountAmount so
  // payableAmount = totalAmount - discountAmount stays true for invoices and
  // revenue reports. Both are always recomputed by the server from the
  // customer's actual booking history / wallet balance — never trusted from
  // the client. Order: offers -> first-booking discount -> wallet credit.
  const firstBookingDiscount = await computeFirstBookingDiscount({ userId: actorUser.id, payableAmount: pricing.payableAmount })
  const requestedVoucherServiceId = `${payload?.redeemRewardServiceId ?? ""}`.trim()
  return {
    serviceIds,
    stylistId,
    comboId,
    startsAt,
    customerGender,
    pricing,
    selectedServices,
    durationMinutes,
    firstBookingDiscount,
    requestedVoucherServiceId,
    bookingId: uuid(),
  }
}

/**
 * The booking transaction body. Runs on the caller's client so it can be composed with other
 * writes (the payment settlement does exactly that).
 *
 * `mode`:
 *  - "legacy": the original behaviour. Refused (PAYMENT_REQUIRED) when money is owed and online
 *    payment is enforced, otherwise the customer would get an unpaid CONFIRMED booking.
 *  - "quote":  does all the pricing, voucher and wallet work and then throws `{code:"QUOTE"}` so the
 *    caller's transaction rolls back and nothing is consumed. Gives the exact payable amount.
 *  - "paid":   used after a verified payment. Refuses (PRICE_CHANGED) if the recomputed payable
 *    amount differs from what the customer actually paid.
 */
async function runCustomerBookingTransaction(client, ctx, { payload, actorUser, mode = "legacy", expectedPayableAmount = null }) {
  const { serviceIds, stylistId, comboId, startsAt, customerGender, pricing, selectedServices, durationMinutes, firstBookingDiscount, requestedVoucherServiceId, bookingId } = ctx
  await lockStylistSchedule(client, stylistId)
  await assertBookableWindow({ client, stylistId, startsAt, durationMinutes, graceMinutes: 2 })
  const availableStylists = await listRecommendedStylists({
    serviceIds,
    startsAt: startsAt.toISOString(),
    durationMinutes,
    customerGender,
    db: client,
  })
  if (!availableStylists.some(stylist => stylist.id === stylistId)) {
    const alternatives = availableStylists.slice(0, 3).map(item => ({ id: item.id, name: item.name }))
    throw Object.assign(new Error("Selected stylist is not available for this slot"), {
      code: "STYLIST_UNAVAILABLE",
      alternatives,
    })
  }

  let payableAmount = pricing.payableAmount
  let discountAmount = pricing.discountAmount
  let firstBookingDiscountAmount = 0
  if (firstBookingDiscount.discountAmount > 0) {
    firstBookingDiscountAmount = firstBookingDiscount.discountAmount
    payableAmount = roundMoney(Math.max(0, payableAmount - firstBookingDiscountAmount))
    discountAmount += firstBookingDiscountAmount
  }
  // A won reward-card voucher makes one specific selected service free. Claimed
  // atomically before any discount is applied so a lost race falls back to "no
  // voucher". Not available alongside a combo: combo pricing only returns each
  // item's standalone price, so "free" would be computed against the wrong base.
  let voucherWinId = null
  let voucherDiscountAmount = 0
  if (!comboId && requestedVoucherServiceId && serviceIds.includes(requestedVoucherServiceId)) {
    const voucherItem = pricing.serviceItems.find(item => item.id === requestedVoucherServiceId)
    if (voucherItem) {
      const claim = await claimRewardVoucher({ userId: actorUser.id, serviceId: requestedVoucherServiceId, db: client })
      if (claim) {
        const itemFinalPrice = Number(voucherItem.basePrice ?? 0) * (1 - Number(voucherItem.discountPercent ?? 0) / 100)
        voucherDiscountAmount = Math.max(0, Math.min(payableAmount, Math.round(itemFinalPrice * 100) / 100))
        voucherWinId = claim.winId
        payableAmount = roundMoney(Math.max(0, payableAmount - voucherDiscountAmount))
        discountAmount += voucherDiscountAmount
      }
    }
  }
  let walletRedeemAmount = 0
  if (payload?.useWalletCredit && payableAmount > 0) {
    walletRedeemAmount = await redeemWalletCredit({ userId: actorUser.id, maxAmount: payableAmount, bookingId, db: client })
    if (walletRedeemAmount > 0) {
      payableAmount = Math.max(0, payableAmount - walletRedeemAmount)
      discountAmount += walletRedeemAmount
    }
  }
  payableAmount = roundMoney(payableAmount)

  if (mode === "quote") {
    throw Object.assign(new Error("quote"), {
      code: "QUOTE",
      quote: {
        totalAmount: roundMoney(pricing.totalAmount),
        discountAmount: roundMoney(discountAmount),
        payableAmount,
        serviceName: selectedServices.map(service => service.name).join(", "),
        startsAt: startsAt.toISOString(),
        durationMinutes,
      },
    })
  }
  if (mode === "legacy" && payableAmount > 0 && isOnlinePaymentRequired()) {
    throw Object.assign(new Error("Payment is required to confirm this booking"), { code: "PAYMENT_REQUIRED" })
  }
  if (mode === "paid" && payableAmount !== roundMoney(expectedPayableAmount)) {
    throw Object.assign(new Error("The price changed after payment"), {
      code: "PRICE_CHANGED",
      expected: roundMoney(expectedPayableAmount),
      actual: payableAmount,
    })
  }

  const booking = await createBooking({
    id: bookingId,
    db: client,
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
    invoiceNumber: generateInvoiceNumber(),
    status: "CONFIRMED",
    createdBy: actorUser.id,
  })
  if (voucherWinId) await attachRewardVoucherToBooking({ winId: voucherWinId, bookingId: booking.id, db: client })
  let paymentId = null
  if (payableAmount > 0) {
    const inserted = await createPaymentTransaction({
      db: client,
      bookingId: booking.id,
      sourceType: "BOOKING",
      customerName: booking.customer,
      customerEmail: booking.customerEmail,
      customerPhone: booking.customerPhone,
      amount: payableAmount,
      paymentMode: "ONLINE",
      collectedBy: actorUser.id,
    })
    paymentId = inserted?.id ?? null
  }
  return { booking, paymentId, payableAmount, walletRedeemAmount, firstBookingDiscountAmount, voucherDiscountAmount }
}

/** Notifications, audit and realtime events that follow a committed booking. */
export async function runPostBookingEffects({ created, actorUser, stylistId, publishEvent, publishPaymentEvent }) {
  const { booking, paymentId, payableAmount, walletRedeemAmount, firstBookingDiscountAmount, voucherDiscountAmount } = created
  auditAuthAsync("auth", "customer_booking_created", {
    customerUserId: actorUser.id,
    bookingId: booking?.id,
    stylistId,
    walletRedeemAmount,
    firstBookingDiscountAmount,
    voucherDiscountAmount,
  })
  if (paymentId) {
    const payment = await getPaymentHistoryById(paymentId).catch(() => null)
    auditAuthAsync("auth", "reception_payment_recorded", {
      receptionistUserId: actorUser.id,
      paymentId,
      sourceType: "BOOKING",
      paymentMode: "ONLINE",
      amount: payableAmount,
    })
    if (payment && publishPaymentEvent) publishPaymentEvent("payment.updated.v1", payment)
  }
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
  notifyUser({
    userId: stylistId,
    type: "BOOKING_ASSIGNED",
    title: "New appointment assigned",
    body: `${booking.service} for ${booking.customer} at ${formatNotifyDateTime(booking.startsAt)}.`,
    data: { bookingId: booking.id },
  }).catch(error => console.error("notify_booking_assigned_failed", error))
  if (publishEvent) publishEvent("booking.updated.v1", booking)
}

export async function createCustomerBooking({ payload, actorUser, publishEvent, publishPaymentEvent }) {
  const ctx = await buildCustomerBookingContext({ payload, actorUser })
  // Everything that must be true together happens in ONE transaction, serialised per
  // stylist: re-checking availability, consuming the voucher and wallet credit, writing
  // the booking and its payment. Checking availability outside and inserting afterwards
  // let two concurrent customers both pass the check and double-book the stylist; and
  // consuming credit before a failed insert burned it with no booking to show for it.
  const created = await withTransaction(client => runCustomerBookingTransaction(client, ctx, { payload, actorUser }))
  await runPostBookingEffects({ created, actorUser, stylistId: ctx.stylistId, publishEvent, publishPaymentEvent })
  return created.booking
}

/**
 * What would this customer have to pay right now for this booking request? Computed by the
 * very same code path as the booking itself, in a transaction that is always rolled back, so
 * the quote can never drift from what the booking would really charge.
 */
export async function quoteCustomerBooking({ payload, actorUser }) {
  const ctx = await buildCustomerBookingContext({ payload, actorUser })
  try {
    await withTransaction(client => runCustomerBookingTransaction(client, ctx, { payload, actorUser, mode: "quote" }))
  } catch (error) {
    if (error?.code === "QUOTE") return error.quote
    throw error
  }
  throw new Error("quote did not complete")
}

/**
 * Creates the booking for a payment that has already been verified. Runs on the settlement
 * transaction's client; the caller owns commit/rollback and calls `runPostBookingEffects`
 * after it commits.
 */
export async function createPaidCustomerBookingInTransaction(client, { payload, actorUser, expectedPayableAmount }) {
  const ctx = await buildCustomerBookingContext({ payload, actorUser })
  const created = await runCustomerBookingTransaction(client, ctx, { payload, actorUser, mode: "paid", expectedPayableAmount })
  return { created, stylistId: ctx.stylistId }
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
  return listQueueBookingsForRole({ role, userId, limit })
}

/**
 * A stylist start/complete matched no row. Three different situations look identical to
 * the UPDATE, and each deserves its own answer:
 *  - the booking is already in the requested state (double tap, retry) -> succeed, unchanged;
 *  - the booking exists for this stylist but is in the wrong state (cancelled, not started)
 *    -> 409, never silently flipped;
 *  - it is not theirs / does not exist -> 404.
 */
async function resolveStylistTransitionMiss({ bookingId, actorUserId, expected }) {
  const existing = await getBookingById(bookingId)
  if (!existing || existing.stylistId !== actorUserId) {
    throw Object.assign(new Error("Booking not found for stylist"), { code: "NOT_FOUND" })
  }
  if (normalizeBookingStatus(existing.status) === expected) return existing
  throw Object.assign(new Error(`Booking is ${existing.status}; it cannot move to ${expected}`), { code: "INVALID_TRANSITION" })
}

export async function startStylistBooking({ bookingId, actorUserId, publishEvent }) {
  const booking = await markBookingStarted({ bookingId, stylistId: actorUserId })
  if (!booking) return resolveStylistTransitionMiss({ bookingId, actorUserId, expected: "STARTED" })
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
  if (!booking) return resolveStylistTransitionMiss({ bookingId, actorUserId, expected: "COMPLETED" })
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
  const amount = roundMoney(payload?.amount)
  const bookingId = `${payload?.bookingId ?? ""}`.trim() || null
  const customerName = `${payload?.customerName ?? ""}`.trim()
  const customerEmail = `${payload?.customerEmail ?? ""}`.trim().toLowerCase()
  const customerPhone = `${payload?.customerPhone ?? ""}`.trim()

  if (!PAYMENT_SOURCES.includes(sourceType)) throw Object.assign(new Error("Invalid sourceType"), { code: "BAD_REQUEST" })
  if (!PAYMENT_MODES.includes(paymentMode)) throw Object.assign(new Error("Invalid paymentMode"), { code: "BAD_REQUEST" })
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error("amount must be greater than 0"), { code: "BAD_REQUEST" })
  if (sourceType === "BOOKING" && !bookingId) throw Object.assign(new Error("bookingId is required for booking payment"), { code: "BAD_REQUEST" })
  if (sourceType !== "BOOKING" && !customerName) {
    throw Object.assign(new Error("customerName is required for walk-in payment"), { code: "BAD_REQUEST" })
  }

  // The balance check and the insert happen under a lock on the booking row. As two separate
  // steps, two concurrent "collect payment" clicks both saw the full balance due and both
  // recorded it, collecting twice for one booking.
  const insertedId = await withTransaction(async client => {
    let target = { bookingId: null, name: customerName, email: customerEmail, phone: customerPhone }
    if (sourceType === "BOOKING") {
      const locked = await getBookingForUpdate(client, bookingId)
      if (!locked) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
      const booking = await getBookingById(bookingId, client)
      const status = normalizeBookingStatus(booking.status)
      // Money is not collected against a booking that was cancelled or never attended.
      if (status === "CANCELLED" || status === "NO-SHOW") {
        throw Object.assign(new Error(`Cannot collect payment for a ${status.toLowerCase()} booking`), { code: "BAD_REQUEST" })
      }
      // Bookings are normally paid in full when created, so without this the "Collect payment"
      // panel could record a second payment against an already-settled booking.
      const remainingDue = roundMoney(Number(booking.payableAmount ?? 0) - Number(booking.paidAmount ?? 0))
      if (amount > remainingDue + 0.01) {
        throw Object.assign(
          new Error(`Amount exceeds the remaining balance due (Rs ${Math.max(0, remainingDue).toFixed(2)})`),
          { code: "BAD_REQUEST" }
        )
      }
      target = { bookingId: booking.id, name: booking.customer, email: booking.customerEmail, phone: booking.customerPhone }
    }
    const inserted = await createPaymentTransaction({
      db: client,
      bookingId: target.bookingId,
      sourceType,
      customerName: target.name,
      customerEmail: target.email,
      customerPhone: target.phone,
      amount,
      paymentMode,
      collectedBy: actorUserId,
    })
    return inserted?.id ?? null
  })
  const payment = insertedId ? await getPaymentHistoryById(insertedId) : null
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

/**
 * Moves a booking to another stylist and/or time. Done under the same per-stylist lock and
 * with the same rules as a new booking: the target stylist must be free (ignoring this very
 * booking), inside opening hours/shift and not on leave, and only an upcoming booking can be
 * moved — it used to overwrite anything, even resurrecting a CANCELLED or COMPLETED booking
 * as CONFIRMED, and could stack two customers on one stylist.
 */
async function rescheduleBooking({ bookingId, payload, actorUserId }) {
  const fail = (message, code = "BAD_REQUEST") => Object.assign(new Error(message), { code })
  const requestedStart = payload?.startsAt ? new Date(payload.startsAt) : null
  if (requestedStart && Number.isNaN(requestedStart.getTime())) throw fail("Valid slot time is required")
  const requestedStylistId = `${payload?.stylistId ?? ""}`.trim() || null
  if (!requestedStart && !requestedStylistId) throw fail("Provide a new time and/or a stylist")

  const result = await withTransaction(async client => {
    const locked = await getBookingForUpdate(client, bookingId)
    if (!locked) throw fail("Booking not found", "NOT_FOUND")
    const current = await getBookingById(bookingId, client)
    if (!["PENDING", "CONFIRMED"].includes(normalizeBookingStatus(current.status))) {
      throw fail("Only an upcoming booking can be moved", "INVALID_TRANSITION")
    }
    const stylistId = requestedStylistId ?? current.stylistId
    if (!stylistId) throw fail("A stylist is required")
    const startsAt = requestedStart ?? new Date(current.startsAt)
    await lockStylistSchedule(client, stylistId)
    const { rows: stylistRows } = await client.query(
      "SELECT 1 FROM users WHERE id = $1 AND role = 'STAFF' AND account_status = 'ACTIVE'",
      [stylistId]
    )
    if (!stylistRows.length) throw fail("Selected stylist is not an active stylist")
    await assertBookableWindow({ client, stylistId, startsAt, durationMinutes: current.durationMinutes, graceMinutes: 15 })
    const serviceIds = (current.services ?? []).map(item => item?.id).filter(Boolean)
    const free = serviceIds.length
      ? (
          await findAvailableStylistsForServices({
            serviceIds,
            startsAt: startsAt.toISOString(),
            durationMinutes: current.durationMinutes,
            customerGender: "UNSPECIFIED",
            db: client,
            excludeBookingId: bookingId,
          })
        ).some(stylist => stylist.id === stylistId)
      : !(
          await client.query(
            `SELECT 1 FROM bookings b
             WHERE b.stylist_id = $1 AND b.id <> $2 AND b.status IN ('PENDING','CONFIRMED','STARTED')
               AND tstzrange(b.starts_at, b.starts_at + make_interval(mins => b.duration_minutes), '[)')
                   && tstzrange($3::timestamptz, $3::timestamptz + make_interval(mins => $4::int), '[)')
             LIMIT 1`,
            [stylistId, bookingId, startsAt.toISOString(), current.durationMinutes]
          )
        ).rows.length
    if (!free) throw fail("Selected stylist cannot perform this service at selected slot")
    const updated = await updateBookingSchedule({
      bookingId,
      stylistId,
      startsAt: startsAt.toISOString(),
      durationMinutes: current.durationMinutes,
      updatedBy: actorUserId,
      status: "CONFIRMED",
      db: client,
      onlyIfStatusIn: ["PENDING", "CONFIRMED"],
    })
    if (!updated) throw fail("Only an upcoming booking can be moved", "INVALID_TRANSITION")
    return { updated, previousStylistId: current.stylistId, previousStart: current.startsAt }
  })

  const { updated, previousStylistId, previousStart } = result
  const changedTime = new Date(previousStart).getTime() !== new Date(updated.startsAt).getTime()
  const changedStylist = previousStylistId !== updated.stylistId
  if (updated.createdBy && (changedTime || changedStylist)) {
    notifyUser({
      userId: updated.createdBy,
      type: "BOOKING_RESCHEDULED",
      title: "Your appointment was updated",
      body: `${updated.service} is now ${formatNotifyDateTime(updated.startsAt)} with ${updated.stylistName ?? "your stylist"}.`,
      data: { bookingId },
    }).catch(error => console.error("notify_booking_rescheduled_failed", error))
  }
  if (changedStylist && updated.stylistId) {
    notifyUser({
      userId: updated.stylistId,
      type: "BOOKING_ASSIGNED",
      title: "New appointment assigned",
      body: `${updated.service} for ${updated.customer} at ${formatNotifyDateTime(updated.startsAt)}.`,
      data: { bookingId },
    }).catch(error => console.error("notify_booking_assigned_failed", error))
  }
  return updated
}

/**
 * What the receptionist's cancel dialog needs: how much the salon holds for this booking, what the
 * standard policy would refund (shown as the suggested option), and whether the money went through
 * Razorpay (then the refund goes back to the customer's UPI/card, otherwise it is cash at the desk).
 */
export async function getReceptionCancellationPreview({ bookingId }) {
  const booking = await getBookingById(bookingId)
  if (!booking) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
  const status = normalizeBookingStatus(booking.status)
  if (!["PENDING", "CONFIRMED"].includes(status)) {
    return { canCancel: false, reason: "Only upcoming bookings can be cancelled.", booking: { id: booking.id, status } }
  }
  const held = roundMoney(booking.paidAmount ?? booking.payableAmount)
  const policy = computeCancellationRefund({ payableAmount: held, startsAt: booking.startsAt })
  let paidOnline = false
  let onlineMethod = null
  if (isRazorpayConfigured()) {
    await ensurePaymentsSchema()
    const { rows } = await pool.query(`SELECT payment_method FROM razorpay_payments WHERE booking_id = $1 AND fulfillment = 'BOOKED'`, [booking.id])
    paidOnline = Boolean(rows[0])
    onlineMethod = rows[0]?.payment_method ?? null
  }
  return {
    canCancel: true,
    booking: {
      id: booking.id,
      status,
      customer: booking.customer,
      service: booking.service,
      startsAt: booking.startsAt,
      payableAmount: booking.payableAmount,
      heldAmount: held,
    },
    paidOnline,
    onlineMethod,
    policy: policy.canCancel
      ? { percent: policy.refundPercent, tierLabel: policy.tierLabel, key: policy.policyKey }
      : { percent: 0, tierLabel: policy.reason ?? "Appointment time has passed", key: "NONE" },
    options: [0, 25, 50, 75, 100],
  }
}

export async function updateReceptionBookingLifecycle({ bookingId, payload, actorUserId, publishEvent, publishPaymentEvent }) {
  const action = `${payload?.action ?? ""}`.trim().toLowerCase()
  if (!bookingId || !action) throw Object.assign(new Error("bookingId and action are required"), { code: "BAD_REQUEST" })
  let updated = null
  if (action === "cancel") {
    // Same tiered refund policy as a customer's own cancellation (100%/50%/0% by
    // time-to-appointment), applied atomically, and the customer is told.
    updated = await cancelBookingAsStaff({ bookingId, actorUserId, publishEvent: null, publishPaymentEvent, refundPercent: payload?.refundPercent ?? null })
  } else if (action === "complete") {
    // Only the assigned stylist can complete service (see completeStylistBooking) —
    // that path also computes overtime/penalty from the real start time and triggers
    // referral rewards, none of which a bare status flip here could do correctly.
    throw Object.assign(
      new Error("Only the assigned stylist can mark a booking as completed, from their own portal."),
      { code: "FORBIDDEN" }
    )
  } else if (action === "assign" || action === "reschedule") {
    updated = await rescheduleBooking({ bookingId, payload, actorUserId })
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

/**
 * Cancels a booking and records its refund as ONE atomic unit.
 *
 * The row is locked for the duration, the status change is conditional on the booking
 * still being cancellable, and the refund is written in the same transaction. Two
 * concurrent cancels (double-click, retry, two tabs) therefore serialise: the second
 * finds the booking already cancelled and gets INVALID_TRANSITION instead of paying a
 * second refund.
 *
 * @param {{ bookingId: string, actorUserId: string, authorize?: (booking: object) => void }} params
 */
async function cancelBookingWithRefund({ bookingId, actorUserId, authorize, auditAction = null, refundPercentOverride = null }) {
  if (isRazorpayConfigured()) await ensurePaymentsSchema()
  const result = await withTransaction(async client => {
    const locked = await getBookingForUpdate(client, bookingId)
    if (!locked) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
    const booking = await getBookingById(bookingId, client)
    authorize?.(booking)
    const status = normalizeBookingStatus(booking.status)
    if (!canTransitionBookingStatus(status, "CANCELLED")) {
      throw Object.assign(new Error("This booking cannot be cancelled"), { code: "INVALID_TRANSITION" })
    }
    let refundPreview
    if (refundPercentOverride !== null && refundPercentOverride !== undefined && `${refundPercentOverride}` !== "") {
      // Reception decides how much goes back. It is a percentage of what the salon actually holds for this
      // booking (collected minus already refunded), so it can never refund more than was paid.
      const percent = Number(refundPercentOverride)
      if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
        throw Object.assign(new Error("Refund percentage must be a whole number from 0 to 100"), { code: "BAD_REQUEST" })
      }
      const held = roundMoney(booking.paidAmount ?? booking.payableAmount)
      const refundAmount = roundMoney((held * percent) / 100)
      refundPreview = {
        canCancel: true,
        refundPercent: percent,
        refundAmount,
        retainedAmount: roundMoney(held - refundAmount),
        payableAmount: held,
        policyKey: "RECEPTION_CHOICE",
        tierLabel: "Chosen by reception",
        stylistFreedImmediately: true,
      }
    } else {
      refundPreview = computeCancellationRefund({
        payableAmount: booking.payableAmount,
        startsAt: booking.startsAt,
      })
    }
    if (!refundPreview.canCancel) {
      throw Object.assign(new Error(refundPreview.reason ?? "Cannot cancel this booking"), { code: "BAD_REQUEST" })
    }
    const updated = await updateBookingSchedule({
      bookingId,
      status: "CANCELLED",
      updatedBy: actorUserId,
      db: client,
      onlyIfStatusIn: ["PENDING", "CONFIRMED"],
    })
    if (!updated) throw Object.assign(new Error("This booking cannot be cancelled"), { code: "INVALID_TRANSITION" })
    if (auditAction) {
      await insertAuditLog(client, {
        action: auditAction,
        performedBy: actorUserId,
        resourceId: bookingId,
        originalValue: { status },
        newValue: { status: "CANCELLED", refundAmount: refundPreview.refundAmount, refundPercent: refundPreview.refundPercent, refundBasis: refundPreview.policyKey },
      })
    }
    let refundPaymentId = null
    if (refundPreview.refundAmount > 0) {
      const inserted = await createPaymentTransaction({
        db: client,
        bookingId: booking.id,
        sourceType: "REFUND",
        customerName: booking.customer,
        customerEmail: booking.customerEmail,
        customerPhone: booking.customerPhone,
        amount: refundPreview.refundAmount,
        paymentMode: "ONLINE",
        collectedBy: actorUserId,
      })
      refundPaymentId = inserted?.id ?? null
    }
    // Paid through Razorpay: owe the customer the policy amount at the gateway. Recorded in this
    // transaction so a cancelled booking can never exist without its refund being queued.
    let gatewayRefundRowId = null
    if (refundPreview.refundAmount > 0 && isRazorpayConfigured()) {
      const { rows } = await client.query(
        `UPDATE razorpay_payments SET cancel_refund_paise = LEAST($2::bigint, amount_paise), cancel_refund_status = 'PENDING', updated_at = NOW()
         WHERE booking_id = $1 AND fulfillment = 'BOOKED' AND cancel_refund_status IS NULL RETURNING id`,
        [booking.id, Math.round(refundPreview.refundAmount * 100)]
      )
      gatewayRefundRowId = rows[0]?.id ?? null
    }
    return { booking, refundPreview, refundPaymentId, gatewayRefundRowId }
  })
  // After commit: send the refund to Razorpay. If this fails the row stays PENDING and the sweep retries.
  let gatewayRefund = null
  if (result.gatewayRefundRowId) {
    gatewayRefund = await initiateCancellationRefund(result.gatewayRefundRowId).catch(error => {
      console.error("cancel_refund_initiation_failed", { bookingId, error: error?.code ?? error?.message ?? "error" })
      return null
    })
  }
  return { ...result, gatewayRefund, gatewayRefundQueued: Boolean(result.gatewayRefundRowId) }
}

async function publishRefundPayment(refundPaymentId, publishPaymentEvent) {
  if (!refundPaymentId) return null
  const payment = await getPaymentHistoryById(refundPaymentId)
  if (payment && publishPaymentEvent) publishPaymentEvent("payment.updated.v1", payment)
  return payment
}

export async function cancelCustomerBooking({ bookingId, actorUser, publishEvent, publishPaymentEvent }) {
  const { booking, refundPreview, refundPaymentId, gatewayRefund, gatewayRefundQueued } = await cancelBookingWithRefund({
    bookingId,
    actorUserId: actorUser.id,
    authorize: current => {
      if (!customerOwnsBooking(current, actorUser)) {
        throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" })
      }
    },
  })
  const refundPayment = await publishRefundPayment(refundPaymentId, publishPaymentEvent)
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
      gatewayRefund: gatewayRefundQueued ? (gatewayRefund ? "INITIATED" : "PENDING") : null,
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
  // Hide, never delete: the booking's payments, invoice and any complaint must survive, and
  // the first-booking discount counts every booking a customer has ever made.
  const deleted = await hideBookingFromCustomer(bookingId)
  if (!deleted) throw Object.assign(new Error("Booking not found"), { code: "NOT_FOUND" })
  auditAuthAsync("auth", "customer_booking_deleted", {
    customerUserId: actorUser.id,
    bookingId,
  })
  if (publishEvent) publishEvent("booking.deleted.v1", { id: bookingId, createdBy: actorUser.id })
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

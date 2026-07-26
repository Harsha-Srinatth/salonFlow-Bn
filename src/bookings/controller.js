import { decryptEnvelope, encryptEnvelope, hasEnvelopeCryptoEnabled } from "../security/crypto-envelope.js"
import { uploadServiceImageDataUri } from "../lib/cloudinary.js"
import { buildBookingInvoicePdf } from "../billing/invoice.js"
import { getCustomerMembershipView } from "../membership/service.js"
import { getCustomerOffersForUser } from "../offers/service.js"
import {
  getBookingInvoice,
  getAdminPayrollPolicy,
  saveAdminPayrollPolicy,
  getMonthlyDeductionsReport,
  getAdminRevenueReport,
  addAdminStylistLeave,
  createCustomerBooking,
  cancelCustomerBooking,
  getCustomerCancellationPreview,
  removeCustomerBookingFromHistory,
  createAdminService,
  createReceptionBooking,
  listAvailableSlots,
  listAdminBookings,
  listAdminServices,
  listBookableServices,
  listCustomerBookings,
  listRoleQueue,
  listRecommendedStylists,
  listReceptionBookingStylists,
  lookupReceptionCustomer,
  transitionAdminBookingStatus,
  updateReceptionBookingLifecycle,
  recordReceptionPayment,
  startStylistBooking,
  completeStylistBooking,
  upsertAdminStylistShift,
  updateAdminService,
  updateAdminServiceDiscounts,
} from "./service.js"

function isEncryptedRequest(req) {
  return `${req.headers["x-payload-encrypted"] ?? ""}`.toLowerCase() === "1"
}

function readBody(req) {
  if (!isEncryptedRequest(req)) return req.body ?? {}
  if (!hasEnvelopeCryptoEnabled()) throw new Error("Encrypted payload requested but crypto is not configured")
  return decryptEnvelope(req.body?.encrypted)
}

function sendPayload(req, res, statusCode, value) {
  if (!isEncryptedRequest(req) || !hasEnvelopeCryptoEnabled()) return res.status(statusCode).json(value)
  const encrypted = encryptEnvelope(value)
  return res.status(statusCode).json({ encrypted })
}

export async function listBookingsController(req, res) {
  const result = await listAdminBookings(req.query)
  return sendPayload(req, res, 200, result)
}

export async function updateBookingStatusController(req, res, { publishEvent }) {
  try {
    const body = readBody(req)
    const booking = await transitionAdminBookingStatus({
      bookingId: req.params.id,
      requestedStatus: body?.status,
      actorUserId: req.appUser.id,
      publishEvent,
    })
    return sendPayload(req, res, 200, { booking })
  } catch (error) {
    if (error?.code === "FORBIDDEN") return sendPayload(req, res, 403, { error: error.message })
    if (error?.code === "INVALID_STATUS") return sendPayload(req, res, 400, { error: error.message })
    if (error?.code === "NOT_FOUND") return sendPayload(req, res, 404, { error: error.message })
    if (error?.code === "INVALID_CURRENT_STATUS" || error?.code === "INVALID_TRANSITION") {
      return sendPayload(req, res, 409, { error: error.message })
    }
    console.error("Failed to update booking status", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function createReceptionBookingController(req, res, { publishEvent, publishPaymentEvent } = {}) {
  try {
    const body = readBody(req)
    const booking = await createReceptionBooking({
      payload: body,
      actorUserId: req.appUser.id,
      publishEvent,
      publishPaymentEvent,
    })
    return sendPayload(req, res, 201, { booking })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    console.error("Failed to create reception booking", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function listReceptionStylistsController(req, res) {
  const stylists = await listReceptionBookingStylists()
  return sendPayload(req, res, 200, { stylists })
}

export async function lookupReceptionCustomerController(req, res) {
  const customerEmail = `${req.query.email ?? ""}`.trim()
  const customerPhone = `${req.query.phone ?? ""}`.trim()
  const result = await lookupReceptionCustomer({ customerEmail, customerPhone })
  return sendPayload(req, res, 200, result)
}

export async function listReceptionOffersController(req, res) {
  try {
    const segment = `${req.query.membershipSegment ?? "FREE"}`.trim().toUpperCase() || "FREE"
    const [offers, membership] = await Promise.all([
      getCustomerOffersForUser({ membershipSegment: segment }),
      getCustomerMembershipView({ membershipSegment: segment }),
    ])
    return sendPayload(req, res, 200, {
      membershipSegment: segment,
      membershipPlanName: membership.currentPlan?.name ?? "Free",
      ...offers,
    })
  } catch (error) {
    console.error("Failed to load reception offers", error)
    return sendPayload(req, res, 500, { error: "Could not load offers" })
  }
}

export async function listCustomerBookingsController(req, res, { publishEvent } = {}) {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100)
  const offset = Math.max(Number(req.query.offset ?? 0), 0)
  const result = await listCustomerBookings({
    customerEmail: req.appUser.email,
    customerPhone: req.appUser.phone,
    limit,
    offset,
    publishEvent,
  })
  return sendPayload(req, res, 200, result)
}

export async function createCustomerBookingController(req, res, { publishEvent, publishPaymentEvent } = {}) {
  try {
    const body = readBody(req)
    const booking = await createCustomerBooking({
      payload: body,
      actorUser: req.appUser,
      publishEvent,
      publishPaymentEvent,
    })
    return sendPayload(req, res, 201, { booking })
  } catch (error) {
    if (error?.code === "STYLIST_UNAVAILABLE") {
      return sendPayload(req, res, 409, { error: error.message, alternatives: error.alternatives ?? [] })
    }
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    console.error("Failed to create customer booking", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function getCustomerCancellationPreviewController(req, res) {
  try {
    const result = await getCustomerCancellationPreview({
      bookingId: `${req.params.id ?? ""}`.trim(),
      actorUser: req.appUser,
    })
    return sendPayload(req, res, 200, result)
  } catch (error) {
    if (error?.code === "FORBIDDEN") return sendPayload(req, res, 403, { error: error.message })
    if (error?.code === "NOT_FOUND") return sendPayload(req, res, 404, { error: error.message })
    console.error("Failed to load cancellation preview", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function cancelCustomerBookingController(req, res, { publishEvent, publishPaymentEvent } = {}) {
  try {
    const result = await cancelCustomerBooking({
      bookingId: `${req.params.id ?? ""}`.trim(),
      actorUser: req.appUser,
      publishEvent,
      publishPaymentEvent,
    })
    return sendPayload(req, res, 200, result)
  } catch (error) {
    if (error?.code === "FORBIDDEN") return sendPayload(req, res, 403, { error: error.message })
    if (error?.code === "NOT_FOUND") return sendPayload(req, res, 404, { error: error.message })
    if (error?.code === "INVALID_TRANSITION") return sendPayload(req, res, 409, { error: error.message })
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    console.error("Failed to cancel customer booking", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function removeCustomerBookingFromHistoryController(req, res, { publishEvent } = {}) {
  try {
    const result = await removeCustomerBookingFromHistory({
      bookingId: `${req.params.id ?? ""}`.trim(),
      actorUser: req.appUser,
      publishEvent,
    })
    return sendPayload(req, res, 200, result)
  } catch (error) {
    if (error?.code === "FORBIDDEN") return sendPayload(req, res, 403, { error: error.message })
    if (error?.code === "NOT_FOUND") return sendPayload(req, res, 404, { error: error.message })
    if (error?.code === "INVALID_TRANSITION") return sendPayload(req, res, 409, { error: error.message })
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    console.error("Failed to remove customer booking from history", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function listBookableServicesController(req, res) {
  const services = await listBookableServices()
  return sendPayload(req, res, 200, { services })
}

export async function listAdminServicesController(req, res) {
  const services = await listAdminServices()
  return sendPayload(req, res, 200, { services })
}

export async function listRecommendedStylistsController(req, res) {
  const serviceIds = `${req.query.serviceIds ?? ""}`
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
  const startsAt = `${req.query.startsAt ?? ""}`.trim()
  const durationMinutes = Number(req.query.durationMinutes ?? 45)
  if (!serviceIds.length || !startsAt) {
    return sendPayload(req, res, 400, { error: "serviceIds and startsAt are required" })
  }
  const stylists = await listRecommendedStylists({
    serviceIds,
    startsAt,
    durationMinutes,
    customerGender: req.appUser?.gender ?? "OTHER",
  })
  return sendPayload(req, res, 200, { stylists: stylists.map(item => ({ id: item.id, name: item.name })) })
}

export async function listAvailableSlotsController(req, res) {
  try {
    const serviceIds = `${req.query.serviceIds ?? ""}`.split(",").map(item => item.trim()).filter(Boolean)
    const date = `${req.query.date ?? ""}`.trim()
    const result = await listAvailableSlots({
      serviceIds,
      date,
      customerGender: req.appUser?.gender ?? "OTHER",
    })
    return sendPayload(req, res, 200, result)
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    console.error("Failed to list slots", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function upsertStaffShiftController(req, res) {
  try {
    const body = readBody(req)
    const shift = await upsertAdminStylistShift({
      stylistId: `${req.params.id ?? ""}`.trim(),
      shiftStart: `${body?.shiftStart ?? "08:00"}`.trim(),
      shiftEnd: `${body?.shiftEnd ?? "23:00"}`.trim(),
      isActive: body?.isActive ?? true,
      actorUserId: req.appUser.id,
    })
    return sendPayload(req, res, 200, { shift })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    console.error("Failed to upsert shift", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function createStaffLeaveController(req, res) {
  try {
    const body = readBody(req)
    const leave = await addAdminStylistLeave({
      stylistId: `${req.params.id ?? ""}`.trim(),
      leaveStart: `${body?.leaveStart ?? ""}`.trim(),
      leaveEnd: `${body?.leaveEnd ?? ""}`.trim(),
      note: `${body?.note ?? ""}`.trim(),
      actorUserId: req.appUser.id,
    })
    return sendPayload(req, res, 201, { leave })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    console.error("Failed to create leave", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function listQueueController(req, res, { publishEvent } = {}) {
  const queue = await listRoleQueue({
    role: req.appUser.role,
    userId: req.appUser.id,
    limit: Math.min(Math.max(Number(req.query.limit ?? 100), 1), 200),
    publishEvent,
  })
  return sendPayload(req, res, 200, { queue })
}

export async function updateReceptionBookingController(req, res, { publishEvent }) {
  try {
    const body = readBody(req)
    const booking = await updateReceptionBookingLifecycle({
      bookingId: `${req.params.id ?? ""}`.trim(),
      payload: body,
      actorUserId: req.appUser.id,
      publishEvent,
    })
    return sendPayload(req, res, 200, { booking })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    if (error?.code === "NOT_FOUND") return sendPayload(req, res, 404, { error: error.message })
    console.error("Failed to update reception booking", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function downloadBookingInvoiceController(req, res) {
  try {
    const booking = await getBookingInvoice({
      bookingId: `${req.params.id ?? ""}`.trim(),
      actorUser: req.appUser,
    })
    const pdf = await buildBookingInvoicePdf({ booking })
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader("Content-Disposition", `attachment; filename="invoice-${booking.id}.pdf"`)
    return res.status(200).send(pdf)
  } catch (error) {
    if (error?.code === "NOT_FOUND") return res.status(404).json({ error: error.message })
    if (error?.code === "FORBIDDEN") return res.status(403).json({ error: error.message })
    console.error("Failed to download invoice", error)
    return res.status(500).json({ error: "Internal server error" })
  }
}

export async function startStylistBookingController(req, res, { publishEvent }) {
  try {
    const booking = await startStylistBooking({
      bookingId: `${req.params.id ?? ""}`.trim(),
      actorUserId: req.appUser.id,
      publishEvent,
    })
    return sendPayload(req, res, 200, { booking })
  } catch (error) {
    if (error?.code === "NOT_FOUND") return sendPayload(req, res, 404, { error: error.message })
    console.error("Failed to start stylist booking", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function completeStylistBookingController(req, res, { publishEvent }) {
  try {
    const booking = await completeStylistBooking({
      bookingId: `${req.params.id ?? ""}`.trim(),
      actorUserId: req.appUser.id,
      publishEvent,
    })
    return sendPayload(req, res, 200, { booking })
  } catch (error) {
    if (error?.code === "NOT_FOUND") return sendPayload(req, res, 404, { error: error.message })
    console.error("Failed to complete stylist booking", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function getPayrollPolicyController(req, res) {
  const policy = await getAdminPayrollPolicy()
  return sendPayload(req, res, 200, { policy })
}

export async function updatePayrollPolicyController(req, res) {
  try {
    const body = readBody(req)
    const policy = await saveAdminPayrollPolicy({
      payload: body,
      actorUserId: req.appUser.id,
    })
    return sendPayload(req, res, 200, { policy })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    console.error("Failed to update payroll policy", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function listMonthlyDeductionsController(req, res) {
  try {
    const month = `${req.query.month ?? ""}`.trim()
    const items = await getMonthlyDeductionsReport({ month })
    return sendPayload(req, res, 200, { items })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    console.error("Failed to list deductions report", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function createReceptionPaymentController(req, res, { publishPaymentEvent } = {}) {
  try {
    const body = readBody(req)
    const payment = await recordReceptionPayment({
      payload: body,
      actorUserId: req.appUser.id,
      publishPaymentEvent,
    })
    return sendPayload(req, res, 201, { payment })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    if (error?.code === "NOT_FOUND") return sendPayload(req, res, 404, { error: error.message })
    console.error("Failed to create reception payment", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function getAdminRevenueReportController(req, res) {
  const month = `${req.query.month ?? ""}`.trim()
  const paymentMode = `${req.query.paymentMode ?? ""}`.trim()
  const from = `${req.query.from ?? ""}`.trim()
  const to = `${req.query.to ?? ""}`.trim()
  const limit = Number(req.query.limit ?? 100)
  const offset = Number(req.query.offset ?? 0)
  const report = await getAdminRevenueReport({ month, paymentMode, from, to, limit, offset })
  return sendPayload(req, res, 200, report)
}

export async function updateAdminServiceDiscountsController(req, res, { publishServiceEvent } = {}) {
  try {
    const body = readBody(req)
    const services = await updateAdminServiceDiscounts({
      items: body?.services ?? [],
      actorUserId: req.appUser.id,
    })
    if (publishServiceEvent) publishServiceEvent("service.catalog.updated.v1", { action: "DISCOUNTS_UPDATED" })
    return sendPayload(req, res, 200, { services })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    console.error("Failed to update service discounts", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function createAdminServiceController(req, res, { publishServiceEvent } = {}) {
  try {
    const body = readBody(req)
    const service = await createAdminService({
      payload: body,
      actorUserId: req.appUser.id,
    })
    if (publishServiceEvent) publishServiceEvent("service.catalog.updated.v1", { action: "CREATED", serviceId: service?.id ?? null })
    return sendPayload(req, res, 201, { service })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    if (error?.code === "23505") return sendPayload(req, res, 409, { error: "Service name already exists" })
    console.error("Failed to create admin service", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function updateAdminServiceController(req, res, { publishServiceEvent } = {}) {
  try {
    const body = readBody(req)
    const service = await updateAdminService({
      serviceId: `${req.params.id ?? ""}`.trim(),
      payload: body,
      actorUserId: req.appUser.id,
    })
    if (publishServiceEvent) publishServiceEvent("service.catalog.updated.v1", { action: "UPDATED", serviceId: service?.id ?? null })
    return sendPayload(req, res, 200, { service })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    if (error?.code === "NOT_FOUND") return sendPayload(req, res, 404, { error: error.message })
    if (error?.code === "23505") return sendPayload(req, res, 409, { error: "Service name already exists" })
    console.error("Failed to update admin service", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

export async function uploadAdminServiceImageController(req, res) {
  try {
    const body = readBody(req)
    const uploaded = await uploadServiceImageDataUri(body?.imageDataUri)
    return sendPayload(req, res, 201, { imageUrl: uploaded.url, publicId: uploaded.publicId })
  } catch (error) {
    if (error?.code === "BAD_REQUEST") return sendPayload(req, res, 400, { error: error.message })
    if (error?.code === "CLOUDINARY_NOT_CONFIGURED") return sendPayload(req, res, 503, { error: error.message })
    console.error("Failed to upload service image", error)
    return sendPayload(req, res, 500, { error: "Internal server error" })
  }
}

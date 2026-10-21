import { randomUUID } from "node:crypto"
import { pool } from "../../src/lib/db-pool.js"
import { ensureUserProfileSchema } from "../../src/auth/schema-init.js"
import { ensureBookingsSchema } from "../../src/bookings/schema-init.js"
import { createBooking } from "../../src/bookings/repository.js"
import { ensureOfferSchema } from "../../src/offers/service.js"
import { ensureWhatsAppSchema } from "../../src/whatsapp/schema-init.js"
import { prepareWhatsAppNotifications } from "../../src/whatsapp/notifications.js"
import "../../src/whatsapp/runtime.js"

export { pool }

export async function prepareDatabase() {
  await ensureUserProfileSchema()
  await ensureBookingsSchema()
  await ensureOfferSchema()
  await ensureWhatsAppSchema()
  await prepareWhatsAppNotifications()
}

export async function resetData() {
  await pool.query(`
    TRUNCATE whatsapp_messages, whatsapp_otp_challenges, whatsapp_contacts, whatsapp_webhook_events, whatsapp_campaigns,
             offer_global_discounts, offer_service_discounts, offer_membership_service_discounts, offer_combos
    CASCADE
  `)
  await pool.query(`DELETE FROM bookings`)
  await pool.query(`DELETE FROM users`)
}

let phoneSeq = 0
export function uniquePhone() {
  phoneSeq += 1
  return `+9198${`${Date.now() % 100000}`.padStart(5, "0")}${`${phoneSeq}`.padStart(3, "0")}`
}

export async function createUser({ role = "USER", phone = uniquePhone(), name = "Asha Rao", segment = "FREE", status = "ACTIVE" } = {}) {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO users (id, name, email, phone, role, latitude, longitude, account_status, membership_segment)
     VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7)`,
    [id, name, `${id}@example.test`, phone, role, status, segment]
  )
  return { id, name, phone, role }
}

/** Inserts a CONFIRMED booking `hoursAhead` from now, inside `client` when given. */
export async function insertBooking({ customer, hoursAhead = 30, stylistId = null, db = pool, status = "CONFIRMED" }) {
  return createBooking({
    id: randomUUID(),
    db,
    customerName: customer.name,
    customerEmail: `${customer.id}@example.test`,
    customerPhone: customer.phone,
    serviceName: "Haircut",
    serviceItems: [],
    stylistId,
    startsAt: new Date(Date.now() + hoursAhead * 3600_000).toISOString(),
    durationMinutes: 45,
    totalAmount: 500,
    discountAmount: 0,
    payableAmount: 500,
    invoiceNumber: `INV-${Math.floor(Math.random() * 1e6)}`,
    status,
    createdBy: customer.id,
  })
}

export async function messages(where = "TRUE", values = []) {
  const { rows } = await pool.query(`SELECT * FROM whatsapp_messages WHERE ${where} ORDER BY scheduled_for`, values)
  return rows
}

/** Makes every pending message due now (simulates time passing). */
export async function makeAllDue() {
  await pool.query(`UPDATE whatsapp_messages SET next_attempt_at = NOW() - interval '1 second' WHERE status = 'PENDING'`)
}

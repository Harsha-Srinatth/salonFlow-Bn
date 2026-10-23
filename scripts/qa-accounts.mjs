/**
 * Disposable QA accounts for browser testing on a LOCAL database only.
 *
 *   node scripts/qa-accounts.mjs create   -> one ACTIVE account per role (USER, ADMIN, RECEPTIONIST,
 *                                            STAFF) plus a second customer, each with a random password; credentials are written
 *                                            to bn/.qa-accounts.local.json (never printed)
 *   node scripts/qa-accounts.mjs remove   -> deletes those accounts and every booking, payment,
 *                                            notification and feedback row that references them
 *
 * All QA e-mails end in @sahasra.test, so they can never collide with a real customer.
 * Refuses to run when DATABASE_URL does not point at localhost.
 */
import { randomBytes, randomUUID } from "node:crypto"
import { readFileSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import bcrypt from "bcryptjs"
import dotenv from "dotenv"
import pg from "pg"

const here = path.dirname(fileURLToPath(import.meta.url))
// bn/.env wherever the script is run from.
dotenv.config({ path: path.join(here, "..", ".env") })
const credentialsFile = path.join(here, "..", ".qa-accounts.local.json")
const ACCOUNTS = [
  { role: "USER", name: "Qa Customer", email: "qa-customer@sahasra.test", phone: "+919990000101", gender: "FEMALE" },
  { key: "USER2", role: "USER", name: "Qa Othercustomer", email: "qa-customer2@sahasra.test", phone: "+919990000105", gender: "MALE" },
  { role: "ADMIN", name: "Qa Admin", email: "qa-admin@sahasra.test", phone: "+919990000102", gender: "UNSPECIFIED" },
  { role: "RECEPTIONIST", name: "Qa Reception", email: "qa-reception@sahasra.test", phone: "+919990000103", gender: "UNSPECIFIED" },
  { role: "STAFF", name: "Qa Stylist", email: "qa-stylist@sahasra.test", phone: "+919990000104", gender: "UNSPECIFIED" },
]

const url = new URL(process.env.DATABASE_URL ?? "")
if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
  console.error("Refusing to run: DATABASE_URL is not a local database")
  process.exit(1)
}

const command = process.argv[2]
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

async function qaUserIds() {
  const { rows } = await client.query("SELECT id FROM users WHERE email LIKE '%@sahasra.test'")
  return rows.map((row) => row.id)
}

async function removeAll() {
  const ids = await qaUserIds()
  if (!ids.length) return 0
  await client.query("BEGIN")
  // Bookings reference users with ON DELETE SET NULL, so delete the QA bookings explicitly
  // (with everything hanging off them) instead of leaving orphans behind.
  const { rows: bookings } = await client.query(
    "SELECT id FROM bookings WHERE created_by = ANY($1) OR stylist_id = ANY($1)",
    [ids]
  )
  const bookingIds = bookings.map((row) => row.id)
  for (const table of ["payment_transactions", "razorpay_payments", "feedback", "queue_reminders"]) {
    const { rows } = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'booking_id'",
      [table]
    )
    if (rows.length && bookingIds.length) await client.query(`DELETE FROM ${table} WHERE booking_id = ANY($1)`, [bookingIds])
  }
  if (bookingIds.length) await client.query("DELETE FROM bookings WHERE id = ANY($1)", [bookingIds])
  await client.query("DELETE FROM users WHERE id = ANY($1)", [ids])
  await client.query("COMMIT")
  return ids.length
}

if (command === "create") {
  await removeAll()
  const credentials = {}
  const { rows: services } = await client.query("SELECT id FROM service_catalog WHERE is_active")
  for (const account of ACCOUNTS) {
    const password = randomBytes(12).toString("base64url")
    const id = randomUUID()
    await client.query(
      `INSERT INTO users (id, name, email, phone, role, latitude, longitude, account_status, password_hash,
                          email_verified, phone_verified, gender, auth_provider)
       VALUES ($1, $2, $3, $4, $5, 0, 0, 'ACTIVE', $6, TRUE, TRUE, $7, 'PASSWORD')`,
      [id, account.name, account.email, account.phone, account.role, await bcrypt.hash(password, 10), account.gender]
    )
    if (account.role === "STAFF") {
      await client.query(
        "INSERT INTO stylist_profiles (stylist_id, target_segment, working_hours_json, is_active) VALUES ($1, 'UNISEX', '{}'::jsonb, TRUE)",
        [id]
      )
      for (const service of services) {
        await client.query("INSERT INTO stylist_service_map (id, stylist_id, service_id) VALUES ($1, $2, $3)", [randomUUID(), id, service.id])
      }
    }
    credentials[account.key ?? account.role] = { email: account.email, password }
  }
  writeFileSync(credentialsFile, JSON.stringify(credentials, null, 2))
  console.log(`Created ${ACCOUNTS.length} QA accounts; credentials in ${path.basename(credentialsFile)}`)
} else if (command === "remove") {
  const removed = await removeAll()
  rmSync(credentialsFile, { force: true })
  console.log(`Removed ${removed} QA accounts and their bookings`)
} else {
  console.log("Usage: node scripts/qa-accounts.mjs create|remove")
  try {
    readFileSync(credentialsFile)
    console.log("QA accounts currently exist")
  } catch {}
}

await client.end()

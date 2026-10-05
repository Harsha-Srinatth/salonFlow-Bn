// Replaces the salon service catalog with the real Sahasra menu.
//
//   node scripts/seed-real-menu.mjs local            # dry run (no writes)
//   node scripts/seed-real-menu.mjs local --apply
//   node scripts/seed-real-menu.mjs neon --apply
//
// Only the database named by this repo's .env is touched. Before anything is deleted, every table
// that references service_catalog (and would be cascaded) is dumped to bn/backups/*.json.
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import pg from "pg"
import { MENU, validateMenu } from "./menu/index.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, "..", ".env") })

const target = process.argv[2]
const apply = process.argv.includes("--apply")
const urls = { local: process.env.DATABASE_URL, neon: process.env.DATABASE_URL_FOR_NEON }
if (!urls[target]) {
  console.error("usage: node scripts/seed-real-menu.mjs <local|neon> [--apply]")
  process.exit(1)
}

const DEFAULT_DURATION = 30
const BACKED_UP_TABLES = [
  "service_catalog",
  "stylist_service_map",
  "offer_service_discounts",
  "offer_membership_service_discounts",
  "offer_combos",
  "offer_combo_services",
  "referral_reward_cards",
  "referral_reward_wins",
]

const problems = validateMenu()
if (problems.length) {
  console.error("Menu data is invalid:\n" + problems.join("\n"))
  process.exit(1)
}

const client = new pg.Client({ connectionString: urls[target] })
await client.connect()
const dbName = (await client.query("select current_database() as d")).rows[0].d
console.log(`target=${target} database=${dbName} apply=${apply}`)

try {
  // Same idempotent DDL as ensureBookingsSchema, so the script also works on a database the app has not booted against yet.
  await client.query("ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS member_price NUMERIC(12,2)")
  await client.query("ALTER TABLE service_catalog ALTER COLUMN duration_minutes SET DEFAULT 30")

  const counts = {}
  const backup = {}
  for (const table of BACKED_UP_TABLES) {
    const exists = (await client.query("select to_regclass($1) as r", [`public.${table}`])).rows[0].r
    if (!exists) continue
    backup[table] = (await client.query(`select * from ${table}`)).rows
    counts[table] = backup[table].length
  }
  console.log("rows that the replacement touches:", counts)
  const bookings = (await client.query("select count(*)::int as n from bookings")).rows[0].n
  const users = (await client.query("select count(*)::int as n from users")).rows[0].n

  if (!apply) {
    console.log(`dry run: would insert ${MENU.length} services. bookings=${bookings} users=${users} left untouched.`)
    process.exit(0)
  }

  mkdirSync(path.join(here, "..", "backups"), { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const file = path.join(here, "..", "backups", `menu-replace-${target}-${stamp}.json`)
  writeFileSync(file, JSON.stringify(backup, null, 2))
  console.log("backup written:", file)

  await client.query("BEGIN")
  await client.query("DELETE FROM service_catalog")
  // Combos whose every service was just removed would be empty shells; they are backed up above.
  const orphanCombos = await client.query(
    "DELETE FROM offer_combos WHERE id NOT IN (SELECT combo_id FROM offer_combo_services)"
  )
  console.log(`removed ${orphanCombos.rowCount} now-empty combo offers`)
  const inserted = []
  for (const s of MENU) {
    const variants = (s.variants ?? []).map(([name, price, memberPrice]) => ({ name, price, memberPrice, duration: DEFAULT_DURATION }))
    const basePrice = variants.length ? Math.min(...variants.map(v => v.price)) : s.price[0]
    const memberPrice = variants.length ? null : s.price[1]
    const id = randomUUID()
    await client.query(
      `INSERT INTO service_catalog
         (id, name, category, target_gender, base_price, member_price, duration_minutes, description, image_url,
          variants_json, discount_percent, is_active, details_json, gallery_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9::jsonb,0,$10,'{}'::jsonb,'[]'::jsonb)`,
      [id, s.name, s.category, s.audience, basePrice, memberPrice, DEFAULT_DURATION, s.description, JSON.stringify(variants), s.active !== false]
    )
    inserted.push({ id, audience: s.audience })
  }

  // Deleting the old services cascaded away the stylist<->service assignments; without them nobody
  // is bookable. Re-assign every active stylist to every service they can serve by audience segment.
  const stylists = (
    await client.query(
      `SELECT u.id, COALESCE(sp.target_segment, 'UNISEX') AS segment
         FROM users u LEFT JOIN stylist_profiles sp ON sp.stylist_id = u.id
        WHERE u.role = 'STAFF' AND u.account_status = 'ACTIVE' AND COALESCE(sp.is_active, TRUE) = TRUE`
    )
  ).rows
  const canServe = (segment, audience) =>
    segment === "MEN_ONLY" ? !["WOMEN", "GIRL"].includes(audience) : segment === "WOMEN_ONLY" ? audience !== "MEN" : true
  let mapped = 0
  for (const st of stylists) {
    for (const svc of inserted) {
      if (!canServe(st.segment, svc.audience)) continue
      await client.query("INSERT INTO stylist_service_map (id, stylist_id, service_id) VALUES ($1,$2,$3)", [randomUUID(), st.id, svc.id])
      mapped++
    }
  }
  await client.query("COMMIT")
  console.log(`inserted ${inserted.length} services, ${mapped} stylist assignments for ${stylists.length} stylists`)

  const after = (
    await client.query(
      `SELECT (SELECT count(*) FROM bookings)::int AS bookings, (SELECT count(*) FROM users)::int AS users,
              (SELECT count(*) FROM service_catalog)::int AS services`
    )
  ).rows[0]
  console.log("after:", after, "before bookings/users:", bookings, users)
  if (after.bookings !== bookings || after.users !== users) throw new Error("bookings/users count changed!")
} catch (error) {
  await client.query("ROLLBACK").catch(() => {})
  console.error("FAILED, rolled back:", error.message)
  process.exitCode = 1
} finally {
  await client.end()
}

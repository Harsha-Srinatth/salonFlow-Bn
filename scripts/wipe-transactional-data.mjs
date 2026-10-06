// Clears operational/history data (bookings, payments, notifications, logs, offers...) and keeps
// users and configuration. Everything deleted is first written to bn/backups/*.json.
//
//   node scripts/wipe-transactional-data.mjs local            # dry run
//   node scripts/wipe-transactional-data.mjs neon --apply
//
// KEPT: users, devices, salons, salon_members, business_profile, loyalty_settings, membership_plans,
//       admin_payroll_policy, stylist_profiles/shift_windows/leaves, referrals, accounts,
//       service_catalog + stylist_service_map (the new menu), applied_migrations.
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import pg from "pg"

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, "..", ".env") })

const target = process.argv[2]
const apply = process.argv.includes("--apply")
const urls = { local: process.env.DATABASE_URL, neon: process.env.DATABASE_URL_FOR_NEON }
if (!urls[target]) {
  console.error("usage: node scripts/wipe-transactional-data.mjs <local|neon> [--apply]")
  process.exit(1)
}

// Child tables first, so no delete ever hits a foreign key.
const WIPE_ORDER = [
  "razorpay_payment_events",
  "razorpay_payments",
  "razorpay_webhook_events",
  "payment_transactions",
  "queue_reminders",
  "feedback",
  "bookings",
  "referral_reward_wins",
  "referral_reward_cards",
  "wallet_transactions",
  "offer_combo_services",
  "offer_combos",
  "offer_membership_service_discounts",
  "offer_service_discounts",
  "offer_global_discounts",
  "notifications",
  "agent_runs",
  "audit_logs",
  "sessions",
  "verifications",
]

const client = new pg.Client({ connectionString: urls[target] })
await client.connect()
console.log(`target=${target} database=${(await client.query("select current_database() d")).rows[0].d} apply=${apply}`)

try {
  const present = []
  const backup = {}
  for (const table of WIPE_ORDER) {
    if (!(await client.query("select to_regclass($1) r", [`public.${table}`])).rows[0].r) continue
    backup[table] = (await client.query(`select * from ${table}`)).rows
    present.push(table)
  }
  const users = (await client.query("select id, wallet_balance, is_first_booking_done from users")).rows
  backup.__users_state = users
  console.log(Object.fromEntries(present.map(t => [t, backup[t].length])))
  const usersBefore = users.length

  if (!apply) {
    console.log("dry run: nothing deleted")
    process.exit(0)
  }

  mkdirSync(path.join(here, "..", "backups"), { recursive: true })
  const file = path.join(here, "..", "backups", `wipe-${target}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  writeFileSync(file, JSON.stringify(backup, null, 2))
  console.log("backup written:", file)

  await client.query("BEGIN")
  for (const table of present) await client.query(`DELETE FROM ${table}`)
  // Users keep their accounts, but their "first booking done" flag and wallet derive from the deleted history.
  const reset = await client.query("UPDATE users SET is_first_booking_done = FALSE, wallet_balance = 0 WHERE is_first_booking_done OR wallet_balance <> 0")
  console.log(`reset first-booking flag / wallet on ${reset.rowCount} users`)
  const usersAfter = (await client.query("select count(*)::int n from users")).rows[0].n
  if (usersAfter !== usersBefore) throw new Error("users count changed")
  await client.query("COMMIT")
  console.log("wiped:", present.join(", "))
} catch (error) {
  await client.query("ROLLBACK").catch(() => {})
  console.error("FAILED, rolled back:", error.message)
  process.exitCode = 1
} finally {
  await client.end()
}

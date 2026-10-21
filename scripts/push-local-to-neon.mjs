// Overwrites the Neon database with the local one (schema + data).
//   node scripts/push-local-to-neon.mjs            # backs up Neon, dumps local, no changes
//   node scripts/push-local-to-neon.mjs --apply    # also restores over Neon
// Only DATABASE_URL and DATABASE_URL_FOR_NEON from bn/.env are used.
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, "..", ".env") })
const apply = process.argv.includes("--apply")
const BIN = "C:/Program Files/PostgreSQL/18/bin"

function pgEnv(urlText) {
  const u = new URL(urlText)
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.slice(1),
    PGSSLMODE: u.searchParams.get("sslmode") ?? "prefer",
  }
}
function run(cmd, args, env) {
  const r = spawnSync(path.join(BIN, cmd), args, { env, encoding: "utf8", maxBuffer: 1 << 28 })
  if (r.status !== 0) {
    console.error(`${cmd} failed (${r.status}):\n${(r.stderr || "").split("\n").slice(-15).join("\n")}`)
    process.exit(1)
  }
  return r.stderr
}

const local = pgEnv(process.env.DATABASE_URL)
const neon = pgEnv(process.env.DATABASE_URL_FOR_NEON)
if (neon.PGHOST === local.PGHOST || /^(localhost|127\.)/.test(neon.PGHOST)) throw new Error("Neon URL looks local; aborting")

const dir = path.join(here, "..", "backups")
mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const neonBackup = path.join(dir, `neon-before-push-${stamp}.dump`)
const localDump = path.join(dir, `local-for-push-${stamp}.dump`)

run("pg_dump", ["-Fc", "--no-owner", "--no-acl", "-f", neonBackup], neon)
console.log("Neon backed up:", neonBackup)
run("pg_dump", ["-Fc", "--no-owner", "--no-acl", "-f", localDump], local)
console.log("Local dumped:", localDump)

if (!apply) {
  console.log("dry run: Neon untouched")
  process.exit(0)
}
const err = run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-acl", "--single-transaction", "-d", neon.PGDATABASE, localDump], neon)
console.log("restored over Neon", err ? `(notes: ${err.slice(0, 300)})` : "")

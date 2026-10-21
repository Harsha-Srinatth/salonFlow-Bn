/**
 * One-off: copy local rows that Neon does not have into Neon, keeping every Neon row unchanged.
 *
 *   node scripts/merge-local-into-neon.mjs           dry run: reports what would happen, writes nothing
 *   node scripts/merge-local-into-neon.mjs --apply   does it, in ONE transaction (all or nothing)
 *
 * Source = DATABASE_URL (local), target = DATABASE_URL_FOR_NEON, both from .env.
 *
 * A local row counts as "already in Neon" when Neon has a row with the same primary key or the same
 * value in any unique column/column-set (e.g. users.email, users.phone, service_catalog.name). Then
 * Neon's row wins and every local row that references the local one is pointed at Neon's id instead,
 * so local bookings, payments etc. still attach to the right user/service.
 * Only columns that exist on both sides are copied. applied_migrations is never copied.
 */
import { createRequire } from "node:module"
import path from "node:path"
import fs from "node:fs"

const require = createRequire(path.join(process.cwd(), "package.json"))
const dotenv = require("dotenv")
const { Client } = require("pg")

const APPLY = process.argv.includes("--apply")
const SKIP_TABLES = new Set(["applied_migrations"])

const env = dotenv.parse(fs.readFileSync(".env"))
const localUrl = env.DATABASE_URL
const neonUrl = env.DATABASE_URL_FOR_NEON
if (!localUrl) throw new Error("DATABASE_URL missing in .env")
if (!neonUrl) throw new Error("DATABASE_URL_FOR_NEON missing in .env")
if (localUrl === neonUrl) throw new Error("Local and Neon URLs are the same")

// --to-local: same merge the other way (Neon rows added to local, local rows kept).
// Below, `local` is always the source and `neon` the target.
const TO_LOCAL = process.argv.includes("--to-local")
const local = new Client(TO_LOCAL ? { connectionString: neonUrl, ssl: { rejectUnauthorized: true } } : { connectionString: localUrl })
const neon = new Client(TO_LOCAL ? { connectionString: localUrl } : { connectionString: neonUrl, ssl: { rejectUnauthorized: true } })
await local.connect()
await neon.connect()

const q = (s) => `"${s.replaceAll('"', '""')}"`

async function describe(db) {
  const { rows: cols } = await db.query(`
    SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`)
  const { rows: cons } = await db.query(`
    SELECT k.contype, c.relname AS tbl, f.relname AS ref_tbl,
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.o) AS cols,
      ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.o) AS ref_cols
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
    LEFT JOIN pg_class f ON f.oid = k.confrelid
    WHERE ns.nspname = 'public' AND k.contype IN ('p', 'u', 'f')`)
  const tables = new Map()
  for (const { table_name, column_name, data_type } of cols) {
    if (!tables.has(table_name)) tables.set(table_name, { columns: [], json: new Set(), pk: null, uniques: [], fks: [] })
    tables.get(table_name).columns.push(column_name)
    if (data_type === "json" || data_type === "jsonb") tables.get(table_name).json.add(column_name)
  }
  for (const k of cons) {
    const t = tables.get(k.tbl)
    if (!t) continue
    if (k.contype === "p") t.pk = k.cols
    if (k.contype === "u") t.uniques.push(k.cols)
    if (k.contype === "f") t.fks.push({ cols: k.cols, refTable: k.ref_tbl, refCols: k.ref_cols })
  }
  return tables
}

const L = await describe(local)
const N = await describe(neon)

// Parents before children (self-references ignored here; handled per row below).
const order = []
const seen = new Set()
function visit(name, stack = new Set()) {
  if (seen.has(name) || stack.has(name)) return
  stack.add(name)
  for (const fk of L.get(name).fks) if (fk.refTable !== name && L.has(fk.refTable)) visit(fk.refTable, stack)
  seen.add(name)
  order.push(name)
}
for (const name of [...L.keys()].sort()) visit(name)

// idMap["table.col"] : Map(localValue -> neonValue) for single-column keys.
const idMap = new Map()
const mapFor = (table, col) => {
  const key = `${table}.${col}`
  if (!idMap.has(key)) idMap.set(key, new Map())
  return idMap.get(key)
}
const keyOf = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : `${v}`)

const report = []
if (APPLY) await neon.query("BEGIN")
try {
  for (const name of order) {
    if (SKIP_TABLES.has(name)) {
      report.push({ table: name, note: "skipped (migration bookkeeping)" })
      continue
    }
    const lt = L.get(name)
    const nt = N.get(name)
    if (!nt) {
      const { rows } = await local.query(`SELECT count(*)::int AS n FROM ${q(name)}`)
      report.push({ table: name, note: `NOT IN NEON - ${rows[0].n} local rows not copied` })
      continue
    }
    const common = lt.columns.filter((c) => nt.columns.includes(c))
    const missingInNeon = lt.columns.filter((c) => !nt.columns.includes(c))
    const keys = [lt.pk, ...lt.uniques].filter((k) => k?.length && k.every((c) => common.includes(c)))
    const { rows } = await local.query(`SELECT ${common.map(q).join(", ")} FROM ${q(name)}`)
    let inserted = 0
    let matched = 0
    const failed = []
    const deferredSelf = []

    for (const row of rows) {
      // Point foreign keys at Neon's ids where the parent row was matched to an existing Neon row.
      const out = { ...row }
      for (const fk of lt.fks) {
        if (fk.cols.length !== 1) continue
        const [c] = fk.cols
        if (!(c in out) || out[c] === null) continue
        const mapped = idMap.get(`${fk.refTable}.${fk.refCols[0]}`)?.get(keyOf(out[c]))
        if (mapped !== undefined) out[c] = mapped
        else if (fk.refTable === name) {
          deferredSelf.push({ col: c, refCol: fk.refCols[0], value: out[c], row: out })
          out[c] = null // set after all rows of this table exist
        }
      }

      // Already in Neon (same PK or same unique value)? Then Neon's row wins.
      let existing = null
      for (const key of keys) {
        if (key.some((c) => out[c] === null || out[c] === undefined)) continue
        const where = key.map((c, i) => `${q(c)} = $${i + 1}`).join(" AND ")
        const { rows: hit } = await neon.query(`SELECT * FROM ${q(name)} WHERE ${where} LIMIT 1`, key.map((c) => out[c]))
        if (hit[0]) {
          existing = hit[0]
          break
        }
      }
      if (existing) {
        matched += 1
        for (const key of keys) if (key.length === 1) mapFor(name, key[0]).set(keyOf(row[key[0]]), existing[key[0]])
        continue
      }

      if (APPLY) {
        await neon.query("SAVEPOINT r")
        try {
          const cols = Object.keys(out)
          // json/jsonb need JSON text; Postgres array columns (text[] etc.) take JS arrays as-is.
          const vals = cols.map((c) => (nt.json.has(c) && out[c] !== null ? JSON.stringify(out[c]) : out[c]))
          await neon.query(`INSERT INTO ${q(name)} (${cols.map(q).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals)
          await neon.query("RELEASE SAVEPOINT r")
        } catch (error) {
          await neon.query("ROLLBACK TO SAVEPOINT r")
          failed.push(error.message)
          continue
        }
      }
      inserted += 1
      for (const key of keys) if (key.length === 1) mapFor(name, key[0]).set(keyOf(row[key[0]]), out[key[0]])
    }

    if (APPLY && lt.pk?.length === 1) {
      for (const d of deferredSelf) {
        const target = idMap.get(`${name}.${d.refCol}`)?.get(keyOf(d.value)) ?? d.value
        await neon.query(`UPDATE ${q(name)} SET ${q(d.col)} = $1 WHERE ${q(lt.pk[0])} = $2 AND ${q(d.col)} IS NULL`, [target, d.row[lt.pk[0]]])
      }
    }

    report.push({
      table: name,
      local: rows.length,
      [APPLY ? "inserted" : "would_insert"]: inserted,
      already_in_neon: matched,
      failed: failed.length,
      note: [missingInNeon.length ? `local-only columns dropped: ${missingInNeon.join(",")}` : "", ...new Set(failed)].filter(Boolean).join(" ; ") || undefined,
    })
  }

  if (APPLY) {
    // Serial/identity columns: move sequences past the highest id now in each table.
    const { rows: seqs } = await neon.query(`
      SELECT c.table_name, c.column_name, pg_get_serial_sequence(format('%I', c.table_name), c.column_name) AS seq
      FROM information_schema.columns c WHERE c.table_schema = 'public'
        AND pg_get_serial_sequence(format('%I', c.table_name), c.column_name) IS NOT NULL`)
    for (const s of seqs) {
      await neon.query(`SELECT setval($1, GREATEST((SELECT COALESCE(MAX(${q(s.column_name)}), 0) FROM ${q(s.table_name)}), 1))`, [s.seq])
    }
    await neon.query("COMMIT")
  }
} catch (error) {
  if (APPLY) await neon.query("ROLLBACK")
  throw error
} finally {
  await local.end()
  await neon.end()
}

console.log(APPLY ? "APPLIED (committed)" : "DRY RUN - nothing written")
console.table(report)

import { auditAuthAsync } from "../lib/audit-log.js"
import { cachedRead, invalidateCacheKey } from "../lib/cache.js"
import { pool } from "../lib/db-pool.js"
import { createSchemaEnsurer } from "../lib/schema-guard.js"
import { getBusinessProfile } from "../business/service.js"
import { DEFAULT_EFFECTIVE_DATE, LEGAL_DOCUMENTS, defaultLegalBody } from "./defaults.js"

/**
 * The salon's own Privacy Policy and Terms & Conditions, served by the API and shown at /privacy
 * and /terms. Until the admin saves an edited version, the built-in text (./defaults.js) is used;
 * deleting the saved row restores it.
 */

export const LEGAL_SLUGS = Object.keys(LEGAL_DOCUMENTS)
const MAX_BODY = 40_000
const MIN_BODY = 200
const cacheKey = slug => `sahasra:legal:${slug}:v1`

export const ensureLegalSchema = createSchemaEnsurer({
  name: "legal",
  async migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS legal_documents (
        slug VARCHAR(32) PRIMARY KEY CHECK (slug IN ('privacy', 'terms')),
        body TEXT NOT NULL,
        effective_date DATE NOT NULL,
        updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  },
})

function fail(message, code = "BAD_REQUEST") {
  return Object.assign(new Error(message), { code })
}

export function assertLegalSlug(slug) {
  if (!LEGAL_SLUGS.includes(slug)) throw fail("Unknown document", "NOT_FOUND")
}

async function loadDocument(slug) {
  await ensureLegalSchema()
  const { rows } = await pool.query(
    `SELECT body, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, updated_at FROM legal_documents WHERE slug = $1`,
    [slug]
  )
  const stored = rows[0]
  if (stored) return { body: stored.body, effectiveDate: stored.effective_date, updatedAt: stored.updated_at, isDefault: false }
  const { profile } = await getBusinessProfile()
  return { body: defaultLegalBody(slug, profile), effectiveDate: DEFAULT_EFFECTIVE_DATE, updatedAt: null, isDefault: true }
}

/** @returns {Promise<{ slug, title, summary, body, effectiveDate, updatedAt, isDefault }>} */
export async function getLegalDocument(slug) {
  assertLegalSlug(slug)
  // The built-in text embeds business-profile contact details, so it follows profile edits within
  // the cache window rather than needing its own invalidation.
  const document = await cachedRead(cacheKey(slug), { l1TtlMs: 60_000, l2TtlMs: 300_000, load: () => loadDocument(slug) })
  return { slug, ...LEGAL_DOCUMENTS[slug], ...document }
}

export async function listLegalDocuments() {
  return Promise.all(LEGAL_SLUGS.map(getLegalDocument))
}

function normalizeBody(value) {
  const body = `${value ?? ""}`.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim()
  if (body.length < MIN_BODY) throw fail(`The document must be at least ${MIN_BODY} characters`)
  if (body.length > MAX_BODY) throw fail(`The document must be at most ${MAX_BODY.toLocaleString("en-IN")} characters`)
  if (!/^## \S/m.test(body)) throw fail('Start each section with a heading line beginning "## "')
  return body
}

function normalizeEffectiveDate(value) {
  const text = `${value ?? ""}`.trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null
  if (!date || date.toISOString().slice(0, 10) !== text) throw fail("Effective date must be a real date (YYYY-MM-DD)")
  return text
}

export async function saveLegalDocument({ slug, payload, actorUserId }) {
  assertLegalSlug(slug)
  const body = normalizeBody(payload?.body)
  const effectiveDate = normalizeEffectiveDate(payload?.effectiveDate)
  await ensureLegalSchema()
  await pool.query(
    `
      INSERT INTO legal_documents (slug, body, effective_date, updated_by, updated_at)
      VALUES ($1, $2, $3::date, $4, NOW())
      ON CONFLICT (slug) DO UPDATE
        SET body = EXCLUDED.body, effective_date = EXCLUDED.effective_date, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `,
    [slug, body, effectiveDate, actorUserId ?? null]
  )
  await invalidateCacheKey(cacheKey(slug))
  auditAuthAsync("auth", "admin_legal_document_updated", { adminUserId: actorUserId, slug })
  return getLegalDocument(slug)
}

/** Drops the edited version so the built-in text applies again. */
export async function resetLegalDocument({ slug, actorUserId }) {
  assertLegalSlug(slug)
  await ensureLegalSchema()
  await pool.query(`DELETE FROM legal_documents WHERE slug = $1`, [slug])
  await invalidateCacheKey(cacheKey(slug))
  auditAuthAsync("auth", "admin_legal_document_reset", { adminUserId: actorUserId, slug })
  return getLegalDocument(slug)
}

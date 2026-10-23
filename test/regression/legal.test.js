// The salon's own Privacy Policy / Terms & Conditions (GET /api/public/legal/:slug, admin edit).
import "../whatsapp/setup.js"
import test from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { createUser, pool, prepareDatabase, resetData } from "../whatsapp/fixtures.js"
import publicRoutes from "../../src/routes/public.js"
import { ensureLegalSchema, getLegalDocument, resetLegalDocument, saveLegalDocument } from "../../src/legal/service.js"
import { DEFAULT_EFFECTIVE_DATE } from "../../src/legal/defaults.js"
import { CUSTOMER_CANCELLATION_POLICY_RULES } from "../../src/bookings/cancellation-policy.js"
import { invalidateCacheKey } from "../../src/lib/cache.js"

let server
let base
test.before(async () => {
  await prepareDatabase()
  await ensureLegalSchema()
  const app = express()
  app.use("/api/public", publicRoutes)
  await new Promise(resolve => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => {
  await new Promise(resolve => server.close(resolve))
  await pool.end()
})
test.beforeEach(async () => {
  await resetData()
  await pool.query("DELETE FROM legal_documents")
  for (const slug of ["privacy", "terms"]) await invalidateCacheKey(`sahasra:legal:${slug}:v1`)
})

const validBody = `## Introduction\n${"We look after your information carefully. ".repeat(8).trim()}\n\n## Contact\n- Email: help@example.test`

test("public: both documents are served with the built-in text until edited", async () => {
  for (const slug of ["privacy", "terms"]) {
    const response = await fetch(`${base}/api/public/legal/${slug}`)
    assert.equal(response.status, 200)
    const { document } = await response.json()
    assert.equal(document.slug, slug)
    assert.equal(document.isDefault, true)
    assert.equal(document.effectiveDate, DEFAULT_EFFECTIVE_DATE)
    assert.match(document.body, /^## /)
    assert.ok(!/lovable|privacypolicies\.com/i.test(document.body), "no third-party policy links")
  }
  assert.equal((await fetch(`${base}/api/public/legal/cookies`)).status, 404)
})

test("terms: the refund tiers are the ones the booking engine applies", async () => {
  const { body } = await getLegalDocument("terms")
  for (const rule of CUSTOMER_CANCELLATION_POLICY_RULES) assert.ok(body.includes(`${rule.condition}: ${rule.refund}.`), rule.id)
})

test("admin: an edited version is served, and restoring brings the built-in text back", async () => {
  const admin = await createUser({ role: "ADMIN" })
  const saved = await saveLegalDocument({ slug: "privacy", payload: { body: validBody, effectiveDate: "2026-11-01" }, actorUserId: admin.id })
  assert.equal(saved.isDefault, false)
  assert.equal(saved.effectiveDate, "2026-11-01")
  const served = await (await fetch(`${base}/api/public/legal/privacy`)).json()
  assert.equal(served.document.body, validBody)
  const restored = await resetLegalDocument({ slug: "privacy", actorUserId: admin.id })
  assert.equal(restored.isDefault, true)
  assert.notEqual(restored.body, validBody)
})

test("admin: invalid edits are rejected and nothing is stored", async () => {
  const admin = await createUser({ role: "ADMIN" })
  const cases = [
    { body: "too short", effectiveDate: "2026-11-01" },
    { body: validBody.replace(/## /g, ""), effectiveDate: "2026-11-01" },
    { body: `## A\n${"x".repeat(40_001)}`, effectiveDate: "2026-11-01" },
    { body: validBody, effectiveDate: "2026-02-30" },
    { body: validBody, effectiveDate: "" },
  ]
  for (const payload of cases) {
    await assert.rejects(saveLegalDocument({ slug: "terms", payload, actorUserId: admin.id }), err => err.code === "BAD_REQUEST")
  }
  await assert.rejects(saveLegalDocument({ slug: "cookies", payload: { body: validBody, effectiveDate: "2026-11-01" }, actorUserId: admin.id }), err => err.code === "NOT_FOUND")
  const { rows } = await pool.query("SELECT 1 FROM legal_documents")
  assert.equal(rows.length, 0)
})

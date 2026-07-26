import { v4 as uuid } from "uuid"
import { pool } from "../lib/db-pool.js"

/**
 * Note: `stripe_webhook_events` (Drizzle schema) stores processed Stripe event IDs
 * so webhooks are not handled twice. It is NOT the membership plans table.
 * When Stripe checkout/subscriptions are wired, webhook handlers will update
 * `users.membership_segment` and log each event id in `stripe_webhook_events`.
 */

const PAID_SEGMENTS = ["BASIC", "PREMIUM"]

const DEFAULT_FREE_PLAN = {
  segment: "FREE",
  name: "Free",
  tagline: "Book services and enjoy salon-wide offers.",
  priceAmount: 0,
  currency: "INR",
  billingInterval: "month",
  benefits: [
    "Book appointments online",
    "Access global and service offers",
    "Combo deals when enabled for free customers",
  ],
  isActive: true,
  sortOrder: 0,
}

const DEFAULT_PAID_PLANS = [
  {
    segment: "BASIC",
    name: "Basic Membership",
    tagline: "Save more on every visit with member-only offers.",
    priceAmount: 499,
    benefits: [
      "All free plan benefits",
      "Member-only service discounts",
      "Exclusive combo packages",
      "Priority booking support",
    ],
    sortOrder: 1,
  },
  {
    segment: "PREMIUM",
    name: "Premium Membership",
    tagline: "Best value for regular salon guests.",
    priceAmount: 999,
    benefits: [
      "All Basic plan benefits",
      "Highest member discount rates",
      "Premium-only combo deals",
      "Early access to seasonal offers",
    ],
    sortOrder: 2,
  },
]

function normalizePaidSegment(value) {
  const normalized = `${value ?? ""}`.trim().toUpperCase()
  return PAID_SEGMENTS.includes(normalized) ? normalized : null
}

function parseBenefits(value) {
  if (Array.isArray(value)) {
    return value.map(item => `${item ?? ""}`.trim()).filter(Boolean)
  }
  if (typeof value === "string") {
    return value
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
  }
  return []
}

function toPlanDto(row) {
  const benefits = Array.isArray(row.benefits_json) ? row.benefits_json : []
  return {
    id: row.id,
    segment: row.segment,
    name: row.name,
    tagline: row.tagline ?? "",
    priceAmount: Number(row.price_amount ?? 0),
    currency: row.currency ?? "INR",
    billingInterval: row.billing_interval ?? "month",
    stripePriceId: row.stripe_price_id ?? "",
    benefits,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order ?? 0),
    updatedAt: row.updated_at,
  }
}

export async function ensureMembershipSchema() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_segment VARCHAR(16) NOT NULL DEFAULT 'FREE'`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS membership_plans (
      id UUID PRIMARY KEY,
      segment VARCHAR(16) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      tagline TEXT,
      price_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency VARCHAR(8) NOT NULL DEFAULT 'INR',
      billing_interval VARCHAR(16) NOT NULL DEFAULT 'month',
      stripe_price_id VARCHAR(255),
      benefits_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  for (const plan of DEFAULT_PAID_PLANS) {
    await pool.query(
      `
        INSERT INTO membership_plans (id, segment, name, tagline, price_amount, benefits_json, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT (segment) DO NOTHING
      `,
      [uuid(), plan.segment, plan.name, plan.tagline, plan.priceAmount, JSON.stringify(plan.benefits), plan.sortOrder]
    )
  }
}

export async function listMembershipPlans({ includeInactive = false } = {}) {
  await ensureMembershipSchema()
  const where = includeInactive ? "" : "WHERE is_active = TRUE"
  const { rows } = await pool.query(
    `
      SELECT *
      FROM membership_plans
      ${where}
      ORDER BY sort_order ASC, segment ASC
    `
  )
  return rows.map(toPlanDto)
}

export async function upsertMembershipPlan({ segment, payload }) {
  const normalizedSegment = normalizePaidSegment(segment)
  if (!normalizedSegment) {
    throw Object.assign(new Error("Plan segment must be BASIC or PREMIUM"), { code: "BAD_REQUEST" })
  }
  const name = `${payload?.name ?? ""}`.trim()
  const tagline = `${payload?.tagline ?? ""}`.trim()
  const priceAmount = Number(payload?.priceAmount ?? 0)
  const currency = `${payload?.currency ?? "INR"}`.trim().toUpperCase() || "INR"
  const billingInterval = `${payload?.billingInterval ?? "month"}`.trim().toLowerCase() || "month"
  const stripePriceId = `${payload?.stripePriceId ?? ""}`.trim() || null
  const benefits = parseBenefits(payload?.benefits)
  const isActive = payload?.isActive !== false
  const sortOrder = Number(payload?.sortOrder ?? (normalizedSegment === "BASIC" ? 1 : 2))

  if (!name) throw Object.assign(new Error("Plan name is required"), { code: "BAD_REQUEST" })
  if (!Number.isFinite(priceAmount) || priceAmount < 0) {
    throw Object.assign(new Error("Price must be zero or greater"), { code: "BAD_REQUEST" })
  }

  await ensureMembershipSchema()
  const { rows } = await pool.query(
    `
      INSERT INTO membership_plans (
        id, segment, name, tagline, price_amount, currency, billing_interval,
        stripe_price_id, benefits_json, is_active, sort_order
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
      ON CONFLICT (segment) DO UPDATE SET
        name = EXCLUDED.name,
        tagline = EXCLUDED.tagline,
        price_amount = EXCLUDED.price_amount,
        currency = EXCLUDED.currency,
        billing_interval = EXCLUDED.billing_interval,
        stripe_price_id = EXCLUDED.stripe_price_id,
        benefits_json = EXCLUDED.benefits_json,
        is_active = EXCLUDED.is_active,
        sort_order = EXCLUDED.sort_order,
        updated_at = NOW()
      RETURNING *
    `,
    [
      uuid(),
      normalizedSegment,
      name,
      tagline || null,
      priceAmount,
      currency,
      billingInterval,
      stripePriceId,
      JSON.stringify(benefits.length ? benefits : DEFAULT_PAID_PLANS.find(p => p.segment === normalizedSegment)?.benefits ?? []),
      isActive,
      sortOrder,
    ]
  )
  return toPlanDto(rows[0])
}

export async function getAdminMembershipCenter() {
  const plans = await listMembershipPlans({ includeInactive: true })
  const { rows } = await pool.query(
    `
      SELECT membership_segment, COUNT(*)::INT AS total
      FROM users
      WHERE role = 'USER'
      GROUP BY membership_segment
    `
  )
  const counts = { FREE: 0, BASIC: 0, PREMIUM: 0 }
  for (const row of rows) {
    const key = `${row.membership_segment ?? "FREE"}`.trim().toUpperCase()
    if (counts[key] !== undefined) counts[key] = row.total
  }
  return {
    freePlan: DEFAULT_FREE_PLAN,
    paidPlans: plans,
    customerCounts: counts,
  }
}

export async function getCustomerMembershipView({ membershipSegment }) {
  const segment = `${membershipSegment ?? "FREE"}`.trim().toUpperCase() || "FREE"
  const paidPlans = await listMembershipPlans({ includeInactive: false })
  const currentPlan =
    segment === "FREE"
      ? DEFAULT_FREE_PLAN
      : paidPlans.find(plan => plan.segment === segment) ?? {
          segment,
          name: segment === "BASIC" ? "Basic Membership" : "Premium Membership",
          tagline: "Your active membership plan",
          priceAmount: 0,
          currency: "INR",
          billingInterval: "month",
          benefits: [],
          isActive: true,
        }

  return {
    currentPlan: {
      segment: currentPlan.segment ?? segment,
      name: currentPlan.name,
      tagline: currentPlan.tagline ?? "",
      isPaid: segment !== "FREE",
    },
    freePlan: DEFAULT_FREE_PLAN,
    upgradePlans: paidPlans.filter(plan => {
      if (segment === "FREE") return true
      if (segment === "BASIC") return plan.segment === "PREMIUM"
      return false
    }),
    allPlans: [DEFAULT_FREE_PLAN, ...paidPlans],
    showUpgradeBanner: segment === "FREE",
  }
}

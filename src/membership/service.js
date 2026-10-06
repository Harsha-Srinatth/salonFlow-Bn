import { v4 as uuid } from "uuid"
import { pool } from "../lib/db-pool.js"
import { createSchemaEnsurer } from "../lib/schema-guard.js"
import { isRazorpayConfigured, razorpayConfig } from "../payments/config.js"

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

export const DURATION_OPTIONS = [1, 3, 6, 12]

function intervalLabel(months) {
  if (months === 1) return "month"
  if (months === 12) return "year"
  return `${months} months`
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
    billingInterval: intervalLabel(Number(row.duration_months ?? 1)),
    durationMonths: Number(row.duration_months ?? 1),
    benefits,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order ?? 0),
    updatedAt: row.updated_at,
  }
}

export const ensureMembershipSchema = createSchemaEnsurer({
  name: "membership",
  async migrate(client) {
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_segment VARCHAR(16) NOT NULL DEFAULT 'FREE'`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS membership_plans (
        id UUID PRIMARY KEY,
        segment VARCHAR(16) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        tagline TEXT,
        price_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency VARCHAR(8) NOT NULL DEFAULT 'INR',
        billing_interval VARCHAR(16) NOT NULL DEFAULT 'month',
        benefits_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS duration_months INT NOT NULL DEFAULT 1`)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_expires_at TIMESTAMPTZ`)
    // One row per Razorpay checkout for a plan: the membership payment lifecycle, kept apart from
    // booking payments. Price and plan name are snapshotted so later plan edits never rewrite history.
    await client.query(`
      CREATE TABLE IF NOT EXISTS membership_purchases (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        segment VARCHAR(16) NOT NULL,
        plan_name VARCHAR(255) NOT NULL,
        duration_months INT NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        amount_paise BIGINT NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'INR',
        status VARCHAR(16) NOT NULL DEFAULT 'CREATED',
        razorpay_order_id VARCHAR(64),
        razorpay_payment_id VARCHAR(64),
        payment_method VARCHAR(32),
        failure_reason TEXT,
        payment_transaction_id UUID,
        starts_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        paid_at TIMESTAMPTZ,
        checkout_expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS membership_purchases_order_uidx ON membership_purchases (razorpay_order_id) WHERE razorpay_order_id IS NOT NULL`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS membership_purchases_payment_uidx ON membership_purchases (razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS membership_purchases_user_idx ON membership_purchases (user_id, created_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS membership_purchases_status_idx ON membership_purchases (status, created_at DESC)`)
    // Seeded on the same locked connection as the DDL that created the table:
    // the rows are not visible to other connections until this commits anyway,
    // and holding the lock means two instances cannot race the seed either.
    for (const plan of DEFAULT_PAID_PLANS) {
      await client.query(
        `
          INSERT INTO membership_plans (id, segment, name, tagline, price_amount, benefits_json, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
          ON CONFLICT (segment) DO NOTHING
        `,
        [uuid(), plan.segment, plan.name, plan.tagline, plan.priceAmount, JSON.stringify(plan.benefits), plan.sortOrder]
      )
    }
  },
})

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
  const durationMonths = Number(payload?.durationMonths ?? 1)
  const benefits = parseBenefits(payload?.benefits)
  const isActive = payload?.isActive !== false
  const sortOrder = Number(payload?.sortOrder ?? (normalizedSegment === "BASIC" ? 1 : 2))

  if (!name) throw Object.assign(new Error("Plan name is required"), { code: "BAD_REQUEST" })
  if (!DURATION_OPTIONS.includes(durationMonths)) {
    throw Object.assign(new Error("Duration must be 1, 3, 6 or 12 months"), { code: "BAD_REQUEST" })
  }
  if (isActive && priceAmount > 0 && priceAmount < 1) {
    throw Object.assign(new Error("Online payments need a price of at least Rs 1"), { code: "BAD_REQUEST" })
  }
  if (!Number.isFinite(priceAmount) || priceAmount < 0) {
    throw Object.assign(new Error("Price must be zero or greater"), { code: "BAD_REQUEST" })
  }

  await ensureMembershipSchema()
  const { rows } = await pool.query(
    `
      INSERT INTO membership_plans (
        id, segment, name, tagline, price_amount, currency, billing_interval,
        duration_months, benefits_json, is_active, sort_order
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
      ON CONFLICT (segment) DO UPDATE SET
        name = EXCLUDED.name,
        tagline = EXCLUDED.tagline,
        price_amount = EXCLUDED.price_amount,
        currency = EXCLUDED.currency,
        billing_interval = EXCLUDED.billing_interval,
        duration_months = EXCLUDED.duration_months,
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
      intervalLabel(durationMonths),
      durationMonths,
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
        AND (membership_segment = 'FREE' OR membership_expires_at IS NULL OR membership_expires_at > NOW())
      GROUP BY membership_segment
    `
  )
  const counts = { FREE: 0, BASIC: 0, PREMIUM: 0 }
  for (const row of rows) {
    const key = `${row.membership_segment ?? "FREE"}`.trim().toUpperCase()
    if (counts[key] !== undefined) counts[key] = row.total
  }
  const { rows: statRows } = await pool.query(
    `
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0)::float8 AS revenue_total,
        COALESCE(SUM(amount) FILTER (WHERE status = 'PAID' AND paid_at >= NOW() - interval '30 days'), 0)::float8 AS revenue_30d,
        COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
        COUNT(*) FILTER (WHERE status IN ('CREATED', 'FAILED', 'EXPIRED') AND created_at >= NOW() - interval '30 days')::int AS unfinished_30d,
        COUNT(*) FILTER (WHERE status = 'MISMATCH')::int AS needs_review
      FROM membership_purchases
    `
  )
  const { rows: expiring } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE membership_segment <> 'FREE' AND membership_expires_at BETWEEN NOW() AND NOW() + interval '7 days'`
  )
  const stat = statRows[0] ?? {}
  const config = razorpayConfig()
  return {
    freePlan: DEFAULT_FREE_PLAN,
    paidPlans: plans,
    customerCounts: counts,
    razorpay: { configured: isRazorpayConfigured(), mode: config.mode, webhookConfigured: Boolean(config.webhookSecret) },
    stats: {
      revenueTotal: Number(stat.revenue_total ?? 0),
      revenue30d: Number(stat.revenue_30d ?? 0),
      paidCount: Number(stat.paid_count ?? 0),
      unfinished30d: Number(stat.unfinished_30d ?? 0),
      needsReview: Number(stat.needs_review ?? 0),
      expiringSoon: Number(expiring[0]?.n ?? 0),
    },
    durationOptions: DURATION_OPTIONS,
  }
}

const SEGMENT_RANK = { FREE: 0, BASIC: 1, PREMIUM: 2 }

/** What the customer can do with a plan: buy it, renew it, upgrade to it, or nothing (a lower tier). */
function purchaseActionFor(plan, segment, active) {
  const have = active ? SEGMENT_RANK[segment] ?? 0 : 0
  const want = SEGMENT_RANK[plan.segment] ?? 0
  if (want === 0) return null
  if (have === want) return "RENEW"
  if (have > want) return null
  return have === 0 ? "BUY" : "UPGRADE"
}

export async function getCustomerMembershipView({ membershipSegment, userId } = {}) {
  let segment = `${membershipSegment ?? "FREE"}`.trim().toUpperCase() || "FREE"
  let expiresAt = null
  if (userId) {
    const { rows } = await pool.query(`SELECT membership_segment, membership_expires_at FROM users WHERE id = $1`, [userId])
    if (rows[0]) {
      segment = `${rows[0].membership_segment ?? "FREE"}`.trim().toUpperCase() || "FREE"
      expiresAt = rows[0].membership_expires_at ?? null
    }
  }
  // A lapsed paid plan counts as Free right away; the sweep tidies the row shortly after.
  const lapsed = segment !== "FREE" && expiresAt && new Date(expiresAt).getTime() <= Date.now()
  if (lapsed) segment = "FREE"
  const active = segment !== "FREE"

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

  const withActions = paidPlans.map(plan => ({ ...plan, purchaseAction: purchaseActionFor(plan, segment, active) }))
  return {
    currentPlan: {
      segment: currentPlan.segment ?? segment,
      name: currentPlan.name,
      tagline: currentPlan.tagline ?? "",
      isPaid: active,
      expiresAt: active ? expiresAt : null,
      lapsed: Boolean(lapsed),
    },
    freePlan: DEFAULT_FREE_PLAN,
    upgradePlans: withActions.filter(plan => plan.purchaseAction === "BUY" || plan.purchaseAction === "UPGRADE"),
    allPlans: [DEFAULT_FREE_PLAN, ...withActions],
    showUpgradeBanner: segment === "FREE",
    onlinePaymentsEnabled: isRazorpayConfigured(),
  }
}

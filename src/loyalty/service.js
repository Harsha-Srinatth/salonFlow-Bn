import { randomBytes } from "node:crypto"
import { v4 as uuid } from "uuid"
import { pool } from "../lib/db-pool.js"
import { GENDER_FEMALE, GENDER_MALE, hasStatedGender, normalizeCustomerGender } from "../lib/gender.js"
import { createSchemaEnsurer } from "../lib/schema-guard.js"
import { withTransaction } from "../bookings/repository.js"
import { notifyUser } from "../notifications/service.js"
import {
  REFERRAL_RISK_DEFAULTS,
  REFERRAL_VERDICTS,
  explainRiskSignals,
  scoreReferralRisk,
} from "./referral-risk.js"

const DEFAULT_REFERRER_REWARD_POINTS = 150
const DEFAULT_REFERRED_WELCOME_POINTS = 75
const DEFAULT_FIRST_BOOKING_DISCOUNT_PERCENT = 10

export const ensureLoyaltySchema = createSchemaEnsurer({
  name: "loyalty",
  async migrate(client) {
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(32) UNIQUE`)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id) ON DELETE SET NULL`)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance INTEGER NOT NULL DEFAULT 0`)
    // `referrals` and `wallet_transactions` are declared in src/drizzle/schema.js,
    // and that declaration is canonical — it is what the deployed database
    // actually contains. The definitions below must match it, because
    // `CREATE TABLE IF NOT EXISTS` is a silent no-op against a table that already
    // exists: a column named differently here is simply never created, and every
    // query in this file that reads it fails at runtime rather than at boot.
    // The `ALTER ... ADD COLUMN IF NOT EXISTS` statements are what converge a
    // database created by either definition onto the same final shape.
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE referral_status AS ENUM ('PENDING', 'FIRST_ACTION_DONE', 'COOLING', 'APPROVED', 'REWARDED', 'REJECTED');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referred_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status referral_status NOT NULL DEFAULT 'PENDING',
        first_action_at TIMESTAMPTZ,
        cooling_until TIMESTAMPTZ,
        approved_at TIMESTAMPTZ,
        rewarded_at TIMESTAMPTZ,
        rejected_reason TEXT,
        reward_amount INTEGER NOT NULL DEFAULT 100,
        reward_given BOOLEAN NOT NULL DEFAULT FALSE,
        ip_address VARCHAR(64),
        device_id VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS reward_amount INTEGER NOT NULL DEFAULT 100`)
    await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS reward_given BOOLEAN NOT NULL DEFAULT FALSE`)
    await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS rewarded_at TIMESTAMPTZ`)
    await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
    // Not in the Drizzle declaration, so they are added here and mirrored there:
    // the welcome credit paid to the referred user, and the reward-vault draw flag.
    await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS welcome_points INTEGER NOT NULL DEFAULT 0`)
    await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS card_drawn BOOLEAN NOT NULL DEFAULT FALSE`)
    // Why a referral was auto-approved, held, or rejected. Stored as signal keys
    // rather than prose so the wording can change without a migration.
    await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0`)
    await client.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS risk_signals JSONB NOT NULL DEFAULT '[]'::jsonb`)
    await client.query(`CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS referrals_status_idx ON referrals(status)`)
    // The settlement sweep scans for work by status + due time on every tick.
    await client.query(
      `CREATE INDEX IF NOT EXISTS referrals_settlement_idx ON referrals(status, cooling_until) WHERE status IN ('COOLING', 'APPROVED')`
    )
    // Device identity is the backbone of the abuse checks: it survives the
    // network change that an IP-only rule would miss.
    await client.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id VARCHAR(255) NOT NULL UNIQUE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        first_seen_ip VARCHAR(64),
        last_seen_ip VARCHAR(64),
        is_suspicious BOOLEAN NOT NULL DEFAULT FALSE,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS devices_user_id_idx ON devices(user_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS devices_is_suspicious_idx ON devices(is_suspicious)`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS referral_reward_cards (
        id UUID PRIMARY KEY,
        service_id UUID NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,
        rank INTEGER NOT NULL DEFAULT 1,
        probability_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS referral_reward_cards_rank_idx ON referral_reward_cards(rank)`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS referral_reward_wins (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referral_id UUID REFERENCES referrals(id) ON DELETE SET NULL,
        service_id UUID NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,
        status VARCHAR(16) NOT NULL DEFAULT 'UNCLAIMED',
        won_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at TIMESTAMPTZ,
        used_booking_id UUID
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS referral_reward_wins_user_idx ON referral_reward_wins(user_id, status)`)
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE wallet_transaction_type AS ENUM ('CREDIT', 'DEBIT');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `)
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE wallet_transaction_source AS ENUM ('REFERRAL', 'BOOKING', 'ADMIN', 'ADJUSTMENT');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `)
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE wallet_transaction_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type wallet_transaction_type NOT NULL,
        source wallet_transaction_source NOT NULL,
        status wallet_transaction_status NOT NULL DEFAULT 'COMPLETED',
        amount BIGINT NOT NULL,
        referral_id UUID REFERENCES referrals(id) ON DELETE SET NULL,
        description TEXT,
        metadata TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // `bookings` lives outside the Drizzle schema, so this column carries no FK.
    await client.query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS booking_id UUID`)
    await client.query(`CREATE INDEX IF NOT EXISTS wallet_tx_user_idx ON wallet_transactions(user_id, created_at DESC)`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_settings (
        id UUID PRIMARY KEY,
        referrer_reward_points INTEGER NOT NULL DEFAULT ${DEFAULT_REFERRER_REWARD_POINTS},
        referred_welcome_points INTEGER NOT NULL DEFAULT ${DEFAULT_REFERRED_WELCOME_POINTS},
        first_booking_discount_percent NUMERIC(5,2) NOT NULL DEFAULT ${DEFAULT_FIRST_BOOKING_DISCOUNT_PERCENT},
        updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS first_booking_discount_percent NUMERIC(5,2) NOT NULL DEFAULT ${DEFAULT_FIRST_BOOKING_DISCOUNT_PERCENT}`)
    // Anti-abuse tuning, admin-editable so a salon can loosen or tighten it
    // without a deploy.
    await client.query(`ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS cooling_hours INTEGER NOT NULL DEFAULT ${REFERRAL_RISK_DEFAULTS.coolingHours}`)
    await client.query(`ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS auto_approve_max_risk INTEGER NOT NULL DEFAULT ${REFERRAL_RISK_DEFAULTS.autoApproveMaxRisk}`)
    await client.query(`ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS auto_reject_min_risk INTEGER NOT NULL DEFAULT ${REFERRAL_RISK_DEFAULTS.autoRejectMinRisk}`)
    await client.query(`ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS velocity_max_referrals INTEGER NOT NULL DEFAULT ${REFERRAL_RISK_DEFAULTS.velocityMaxReferrals}`)
    await client.query(`ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS velocity_window_hours INTEGER NOT NULL DEFAULT ${REFERRAL_RISK_DEFAULTS.velocityWindowHours}`)
  },
})

function generateReferralCode() {
  return `SAHA-${randomBytes(4).toString("hex").toUpperCase()}`
}

export async function getLoyaltySettings() {
  await ensureLoyaltySchema()
  const { rows } = await pool.query(
    `
      SELECT referrer_reward_points, referred_welcome_points, first_booking_discount_percent,
             cooling_hours, auto_approve_max_risk, auto_reject_min_risk,
             velocity_max_referrals, velocity_window_hours
      FROM loyalty_settings
      ORDER BY updated_at DESC
      LIMIT 1
    `
  )
  const row = rows[0] ?? {}
  return {
    referrerRewardPoints: Number(row.referrer_reward_points ?? DEFAULT_REFERRER_REWARD_POINTS),
    referredWelcomePoints: Number(row.referred_welcome_points ?? DEFAULT_REFERRED_WELCOME_POINTS),
    firstBookingDiscountPercent: Number(row.first_booking_discount_percent ?? DEFAULT_FIRST_BOOKING_DISCOUNT_PERCENT),
    coolingHours: Number(row.cooling_hours ?? REFERRAL_RISK_DEFAULTS.coolingHours),
    autoApproveMaxRisk: Number(row.auto_approve_max_risk ?? REFERRAL_RISK_DEFAULTS.autoApproveMaxRisk),
    autoRejectMinRisk: Number(row.auto_reject_min_risk ?? REFERRAL_RISK_DEFAULTS.autoRejectMinRisk),
    velocityMaxReferrals: Number(row.velocity_max_referrals ?? REFERRAL_RISK_DEFAULTS.velocityMaxReferrals),
    velocityWindowHours: Number(row.velocity_window_hours ?? REFERRAL_RISK_DEFAULTS.velocityWindowHours),
  }
}

/**
 * Records the device an account is being used from.
 *
 * `devices` is keyed by the client-generated identifier, so the same phone keeps
 * one row across signups and `user_id` points at whichever account claimed it
 * first. That "first claimer" behaviour is deliberate: it is what makes a second
 * account created on the same handset detectable as reuse rather than looking
 * like a brand-new device.
 *
 * @param {{ deviceId?: string | null, userId: string, ip?: string | null }} params
 * @returns {Promise<{ deviceId: string, ownerUserId: string | null, isSuspicious: boolean, otherAccountUserIds: string[] } | null>}
 */
export async function registerDeviceForUser({ deviceId, userId, ip }) {
  const normalizedDevice = `${deviceId ?? ""}`.trim()
  if (!normalizedDevice || normalizedDevice.length < 8 || !userId) return null
  await ensureLoyaltySchema()
  const { rows } = await pool.query(
    `
      INSERT INTO devices (id, device_id, user_id, first_seen_ip, last_seen_ip)
      VALUES (gen_random_uuid(), $1, $2, $3, $3)
      ON CONFLICT (device_id) DO UPDATE
      SET last_seen_ip = COALESCE(EXCLUDED.last_seen_ip, devices.last_seen_ip),
          user_id = COALESCE(devices.user_id, EXCLUDED.user_id),
          updated_at = NOW()
      RETURNING device_id, user_id, is_suspicious
    `,
    [normalizedDevice, userId, `${ip ?? ""}`.trim() || null]
  )
  // `users.device_id` is unique, so a handset that already belongs to another
  // account cannot silently re-point at this one — the second account simply
  // keeps a null device and the reuse still shows up through `devices`.
  await pool
    .query(`UPDATE users SET device_id = $2, updated_at = NOW() WHERE id = $1 AND device_id IS NULL`, [
      userId,
      normalizedDevice,
    ])
    .catch(() => undefined)
  const { rows: accountRows } = await pool.query(
    `SELECT id FROM users WHERE device_id = $1 AND id <> $2`,
    [normalizedDevice, userId]
  )
  const owner = rows[0]
  return {
    deviceId: normalizedDevice,
    ownerUserId: owner?.user_id ?? null,
    isSuspicious: Boolean(owner?.is_suspicious),
    otherAccountUserIds: accountRows.map(row => row.id),
  }
}

/**
 * Collects everything `scoreReferralRisk` needs. Kept separate from the scoring
 * itself so the rules stay pure and the queries stay in one readable place.
 *
 * @param {{ referrerId: string, referredUserId: string, referredIp?: string | null, referredDeviceId?: string | null, settings: object }} params
 */
async function gatherReferralRiskFacts({ referrerId, referredUserId, referredIp, referredDeviceId, settings }) {
  const windowHours = Math.max(1, Number(settings.velocityWindowHours) || REFERRAL_RISK_DEFAULTS.velocityWindowHours)
  const [referrerRow, deviceRow, deviceAccounts, velocityRow, priorIpRows] = await Promise.all([
    pool.query(`SELECT device_id, is_under_review FROM users WHERE id = $1 LIMIT 1`, [referrerId]),
    referredDeviceId
      ? pool.query(`SELECT user_id, is_suspicious, first_seen_ip FROM devices WHERE device_id = $1 LIMIT 1`, [
          referredDeviceId,
        ])
      : Promise.resolve({ rows: [] }),
    referredDeviceId
      ? pool.query(`SELECT id FROM users WHERE device_id = $1`, [referredDeviceId])
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT COUNT(*)::INT AS count FROM referrals WHERE referrer_id = $1 AND created_at >= NOW() - ($2::int * interval '1 hour')`,
      [referrerId, windowHours]
    ),
    pool.query(
      `SELECT ip_address FROM referrals WHERE referrer_id = $1 AND referred_user_id <> $2 AND ip_address IS NOT NULL LIMIT 100`,
      [referrerId, referredUserId]
    ),
  ])
  // The referrer's own signup IP is the closest thing to "where they are",
  // recorded on the device row they first claimed.
  const referrerDeviceId = referrerRow.rows[0]?.device_id ?? null
  const { rows: referrerDeviceRows } = referrerDeviceId
    ? await pool.query(`SELECT last_seen_ip FROM devices WHERE device_id = $1 LIMIT 1`, [referrerDeviceId])
    : { rows: [] }

  return {
    referrerId,
    referredUserId,
    referrerDeviceId,
    referredDeviceId: referredDeviceId ?? null,
    referrerIp: referrerDeviceRows[0]?.last_seen_ip ?? null,
    referredIp: referredIp ?? null,
    deviceAccountUserIds: deviceAccounts.rows.map(row => row.id).concat(
      deviceRow.rows[0]?.user_id ? [deviceRow.rows[0].user_id] : []
    ),
    deviceFlagged: Boolean(deviceRow.rows[0]?.is_suspicious),
    referrerUnderReview: Boolean(referrerRow.rows[0]?.is_under_review),
    recentReferralCount: Number(velocityRow.rows[0]?.count ?? 0),
    priorReferralIps: priorIpRows.rows.map(row => row.ip_address),
  }
}

/**
 * Re-scores a referral from its stored identity fields. Used at payout and at
 * admin-review time, where the signals may have changed since signup — a device
 * that looked clean can pick up more accounts in the meantime.
 *
 * @param {object} referral Row from `referrals`
 * @param {object} settings
 */
async function rescoreReferral(referral, settings) {
  const facts = await gatherReferralRiskFacts({
    referrerId: referral.referrer_id,
    referredUserId: referral.referred_user_id,
    referredIp: referral.ip_address,
    referredDeviceId: referral.device_id,
    settings,
  })
  return scoreReferralRisk(facts, settings)
}

export async function saveLoyaltySettings({
  referrerRewardPoints,
  referredWelcomePoints,
  firstBookingDiscountPercent,
  coolingHours,
  autoApproveMaxRisk,
  autoRejectMinRisk,
  velocityMaxReferrals,
  velocityWindowHours,
  updatedBy,
}) {
  await ensureLoyaltySchema()
  const referrer = Number(referrerRewardPoints)
  const referred = Number(referredWelcomePoints)
  const firstBookingPercent = Number(firstBookingDiscountPercent)
  if (!Number.isFinite(referrer) || referrer < 0 || !Number.isFinite(referred) || referred < 0) {
    throw Object.assign(new Error("Reward points must be zero or greater"), { code: "BAD_REQUEST" })
  }
  if (!Number.isFinite(firstBookingPercent) || firstBookingPercent < 0 || firstBookingPercent > 100) {
    throw Object.assign(new Error("First booking discount must be between 0 and 100 percent"), { code: "BAD_REQUEST" })
  }
  const current = await getLoyaltySettings()
  // Anti-abuse knobs are optional on the request: an admin saving only the reward
  // amounts must not silently reset the verification policy to defaults.
  const cooling = clampSetting(coolingHours, current.coolingHours, 0, 720)
  const autoApprove = clampSetting(autoApproveMaxRisk, current.autoApproveMaxRisk, 0, 1000)
  const autoReject = clampSetting(autoRejectMinRisk, current.autoRejectMinRisk, 1, 1000)
  if (autoReject <= autoApprove) {
    throw Object.assign(
      new Error("Auto-reject score must be higher than the auto-approve score, otherwise nothing is ever reviewed"),
      { code: "BAD_REQUEST" }
    )
  }
  const velocityMax = clampSetting(velocityMaxReferrals, current.velocityMaxReferrals, 1, 1000)
  const velocityWindow = clampSetting(velocityWindowHours, current.velocityWindowHours, 1, 720)

  const { rows } = await pool.query("SELECT id FROM loyalty_settings ORDER BY updated_at DESC LIMIT 1")
  const id = rows[0]?.id ?? uuid()
  await pool.query(
    `
      INSERT INTO loyalty_settings (
        id, referrer_reward_points, referred_welcome_points, first_booking_discount_percent,
        cooling_hours, auto_approve_max_risk, auto_reject_min_risk,
        velocity_max_referrals, velocity_window_hours, updated_by, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (id) DO UPDATE
      SET referrer_reward_points = EXCLUDED.referrer_reward_points,
          referred_welcome_points = EXCLUDED.referred_welcome_points,
          first_booking_discount_percent = EXCLUDED.first_booking_discount_percent,
          cooling_hours = EXCLUDED.cooling_hours,
          auto_approve_max_risk = EXCLUDED.auto_approve_max_risk,
          auto_reject_min_risk = EXCLUDED.auto_reject_min_risk,
          velocity_max_referrals = EXCLUDED.velocity_max_referrals,
          velocity_window_hours = EXCLUDED.velocity_window_hours,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
    `,
    [
      id,
      Math.round(referrer),
      Math.round(referred),
      Math.round(firstBookingPercent * 100) / 100,
      cooling,
      autoApprove,
      autoReject,
      velocityMax,
      velocityWindow,
      updatedBy ?? null,
    ]
  )
  return getLoyaltySettings()
}

/** Keeps an optional numeric setting inside range, falling back to its current value. */
function clampSetting(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.round(parsed), min), max)
}

export async function getOrCreateReferralCode(userId) {
  await ensureLoyaltySchema()
  const { rows } = await pool.query(`SELECT referral_code FROM users WHERE id = $1`, [userId])
  if (rows[0]?.referral_code) return rows[0].referral_code
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateReferralCode()
    try {
      await pool.query(`UPDATE users SET referral_code = $2 WHERE id = $1`, [userId, code])
      return code
    } catch (error) {
      if (error?.code !== "23505") throw error
    }
  }
  throw Object.assign(new Error("Could not generate a referral code, please try again"), { code: "INTERNAL" })
}

/**
 * Links a brand-new signup to their referrer's code and scores it for abuse.
 *
 * Silent no-op on any invalid/self/duplicate code — signup must never fail
 * because of a bad referral code. A referral that trips the reject threshold is
 * still recorded, as REJECTED with its reason, rather than dropped: the record
 * is what makes repeat attempts from the same device visible next time.
 *
 * @param {{ newUserId: string, referralCodeInput: string, ip?: string | null, deviceId?: string | null }} params
 */
export async function applyReferralOnSignup({ newUserId, referralCodeInput, ip, deviceId }) {
  if (!newUserId) return null
  await ensureLoyaltySchema()
  try {
    // Register the device even when there is no referral code: the history is
    // what later signups get scored against.
    await registerDeviceForUser({ deviceId, userId: newUserId, ip })

    const code = `${referralCodeInput ?? ""}`.trim().toUpperCase()
    if (!code) return null
    const { rows: referrerRows } = await pool.query(
      `SELECT id FROM users WHERE referral_code = $1 AND id <> $2 LIMIT 1`,
      [code, newUserId]
    )
    const referrer = referrerRows[0]
    if (!referrer) return null

    const settings = await getLoyaltySettings()
    const facts = await gatherReferralRiskFacts({
      referrerId: referrer.id,
      referredUserId: newUserId,
      referredIp: ip,
      referredDeviceId: `${deviceId ?? ""}`.trim() || null,
      settings,
    })
    const risk = scoreReferralRisk(facts, settings)
    const rejected = risk.verdict === REFERRAL_VERDICTS.REJECT

    const { rows } = await pool.query(
      `
        INSERT INTO referrals (
          id, referrer_id, referred_user_id, status,
          ip_address, device_id, risk_score, risk_signals, rejected_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        ON CONFLICT DO NOTHING
        RETURNING *
      `,
      [
        uuid(),
        referrer.id,
        newUserId,
        rejected ? "REJECTED" : "PENDING",
        `${ip ?? ""}`.trim() || null,
        `${deviceId ?? ""}`.trim() || null,
        risk.score,
        JSON.stringify(risk.signals),
        rejected ? risk.reason : null,
      ]
    )
    if (!rows[0]) return null

    if (rejected) {
      // Do not attach `referred_by`: an unearned link would still show the
      // referrer a "referral" they can never be paid for.
      auditReferralDecision("referral_auto_rejected", { referralId: rows[0].id, risk })
      return rows[0]
    }
    await pool.query(`UPDATE users SET referred_by = $2 WHERE id = $1 AND referred_by IS NULL`, [newUserId, referrer.id])
    return rows[0]
  } catch (error) {
    console.error("apply_referral_on_signup_failed", error)
    return null
  }
}

function auditReferralDecision(action, { referralId, risk, actorUserId }) {
  console.log(action, {
    referralId,
    riskScore: risk?.score,
    signals: risk?.signals,
    actorUserId,
  })
}

/** Marks every still-pending wallet entry for a referral as reversed. */
async function reverseReferralWalletEntries(client, referralId) {
  await client.query(
    `UPDATE wallet_transactions SET status = 'REVERSED' WHERE referral_id = $1 AND status = 'PENDING'`,
    [referralId]
  )
}

/**
 * Fires after any booking completes. Accrues the reward exactly once per
 * referral, the moment the referred customer's FIRST booking is completed —
 * a no-op for everyone else (no pending referral, or not their first visit).
 *
 * Accrual is not payment. The wallet entries are written as PENDING and
 * `users.wallet_balance` is untouched, so the money is visible to both sides but
 * not spendable until the cooling period ends and the risk re-check passes.
 * Paying immediately is what makes referral farming worth attempting: the payout
 * lands before anyone can notice the pattern.
 */
export async function rewardReferralIfEligible({ userId }) {
  if (!userId) return null
  await ensureLoyaltySchema()
  const { rows: referralRows } = await pool.query(
    `SELECT * FROM referrals WHERE referred_user_id = $1 AND status = 'PENDING' LIMIT 1`,
    [userId]
  )
  const referral = referralRows[0]
  if (!referral) return null
  const { rows: completedRows } = await pool.query(
    `SELECT COUNT(*)::INT AS count FROM bookings WHERE created_by = $1 AND status = 'COMPLETED'`,
    [userId]
  )
  if (Number(completedRows[0]?.count ?? 0) !== 1) return null

  const settings = await getLoyaltySettings()
  // Re-scored rather than trusting the signup verdict: the device may have
  // picked up more accounts between signup and the first visit.
  const risk = await rescoreReferral(referral, settings)

  if (risk.verdict === REFERRAL_VERDICTS.REJECT) {
    await withTransaction(async client => {
      await client.query(
        `
          UPDATE referrals
          SET status = 'REJECTED', first_action_at = NOW(), rejected_reason = $2,
              risk_score = $3, risk_signals = $4::jsonb, updated_at = NOW()
          WHERE id = $1
        `,
        [referral.id, risk.reason, risk.score, JSON.stringify(risk.signals)]
      )
      await reverseReferralWalletEntries(client, referral.id)
    })
    auditReferralDecision("referral_rejected_on_first_action", { referralId: referral.id, risk })
    notifyUser({
      userId: referral.referrer_id,
      type: "REFERRAL_REJECTED",
      title: "Referral could not be verified",
      body: "One of your referrals did not pass our verification checks, so no credit was added.",
      data: { referralId: referral.id },
    }).catch(error => console.error("notify_referral_rejected_failed", error))
    return null
  }

  const coolingHours = Math.max(0, Number(settings.coolingHours) || 0)
  await withTransaction(async client => {
    await client.query(
      `
        UPDATE referrals
        SET status = 'COOLING',
            first_action_at = NOW(),
            cooling_until = NOW() + ($4::int * interval '1 hour'),
            reward_amount = $2,
            welcome_points = $3,
            risk_score = $5,
            risk_signals = $6::jsonb,
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        referral.id,
        settings.referrerRewardPoints,
        settings.referredWelcomePoints,
        coolingHours,
        risk.score,
        JSON.stringify(risk.signals),
      ]
    )
    await client.query(
      `INSERT INTO wallet_transactions (id, user_id, type, source, status, amount, referral_id, description) VALUES ($1,$2,'CREDIT','REFERRAL','PENDING',$3,$4,$5)`,
      [uuid(), referral.referrer_id, settings.referrerRewardPoints, referral.id, "Referral reward — your friend completed their first visit"]
    )
    await client.query(
      `INSERT INTO wallet_transactions (id, user_id, type, source, status, amount, referral_id, description) VALUES ($1,$2,'CREDIT','REFERRAL','PENDING',$3,$4,$5)`,
      [uuid(), referral.referred_user_id, settings.referredWelcomePoints, referral.id, "Welcome bonus for joining via referral"]
    )
  })

  const readyPhrase = coolingHours > 0 ? `in about ${coolingHours} hour${coolingHours === 1 ? "" : "s"}` : "shortly"
  notifyUser({
    userId: referral.referrer_id,
    type: "REFERRAL_PENDING",
    title: "Referral reward on the way",
    body: `Rs ${settings.referrerRewardPoints} is being verified and will land in your wallet ${readyPhrase}.`,
    data: { referralId: referral.id },
  }).catch(error => console.error("notify_referral_pending_referrer_failed", error))
  notifyUser({
    userId: referral.referred_user_id,
    type: "REFERRAL_PENDING",
    title: "Welcome bonus on the way",
    body: `Rs ${settings.referredWelcomePoints} is being verified and will land in your wallet ${readyPhrase}.`,
    data: { referralId: referral.id },
  }).catch(error => console.error("notify_referral_pending_referred_failed", error))

  return referral
}

/**
 * Pays out one approved referral: moves the pending wallet entries to COMPLETED
 * and only then adds to the spendable balance, so the ledger and the balance can
 * never disagree.
 */
async function settleApprovedReferral(referral) {
  const rewardAmount = Number(referral.reward_amount ?? 0)
  const welcomeAmount = Number(referral.welcome_points ?? 0)
  await withTransaction(async client => {
    const { rowCount } = await client.query(
      `UPDATE referrals SET status = 'REWARDED', reward_given = TRUE, rewarded_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'APPROVED'`,
      [referral.id]
    )
    // Lost the race to another instance's sweep — it is paying this one out.
    if (!rowCount) return
    await client.query(
      `UPDATE wallet_transactions SET status = 'COMPLETED' WHERE referral_id = $1 AND status = 'PENDING'`,
      [referral.id]
    )
    if (rewardAmount > 0) {
      await client.query(`UPDATE users SET wallet_balance = wallet_balance + $2 WHERE id = $1`, [
        referral.referrer_id,
        rewardAmount,
      ])
    }
    if (welcomeAmount > 0) {
      await client.query(`UPDATE users SET wallet_balance = wallet_balance + $2 WHERE id = $1`, [
        referral.referred_user_id,
        welcomeAmount,
      ])
    }
  })

  notifyUser({
    userId: referral.referrer_id,
    type: "REFERRAL_REWARDED",
    title: "Referral reward credited!",
    body: `Rs ${rewardAmount} is now available in your wallet — thanks for the referral.`,
    data: { referralId: referral.id },
  }).catch(error => console.error("notify_referral_reward_referrer_failed", error))
  notifyUser({
    userId: referral.referred_user_id,
    type: "REFERRAL_REWARDED",
    title: "Welcome bonus credited!",
    body: `Rs ${welcomeAmount} welcome bonus is now available in your wallet.`,
    data: { referralId: referral.id },
  }).catch(error => console.error("notify_referral_reward_referred_failed", error))
}

/**
 * Moves referrals through the back half of the workflow.
 *
 * Phase 1 — every COOLING referral whose window has elapsed is re-scored:
 *   clean ones become APPROVED, risky ones are rejected, and borderline ones are
 *   simply left in COOLING, which is what puts them in the admin review queue.
 * Phase 2 — everything APPROVED (whether by phase 1 or by an admin) is paid.
 *
 * Splitting it this way means an admin approval and an automatic approval take
 * exactly the same payout path.
 *
 * @returns {Promise<{ approved: number, rejected: number, held: number, paid: number }>}
 */
export async function runReferralSettlementSweep() {
  await ensureLoyaltySchema()
  const settings = await getLoyaltySettings()
  const result = { approved: 0, rejected: 0, held: 0, paid: 0 }

  const { rows: cooling } = await pool.query(
    `SELECT * FROM referrals WHERE status = 'COOLING' AND cooling_until IS NOT NULL AND cooling_until <= NOW() LIMIT 200`
  )
  for (const referral of cooling) {
    try {
      const risk = await rescoreReferral(referral, settings)
      if (risk.verdict === REFERRAL_VERDICTS.REJECT) {
        await withTransaction(async client => {
          await client.query(
            `UPDATE referrals SET status = 'REJECTED', rejected_reason = $2, risk_score = $3, risk_signals = $4::jsonb, updated_at = NOW() WHERE id = $1 AND status = 'COOLING'`,
            [referral.id, risk.reason, risk.score, JSON.stringify(risk.signals)]
          )
          await reverseReferralWalletEntries(client, referral.id)
        })
        result.rejected += 1
        auditReferralDecision("referral_rejected_on_settlement", { referralId: referral.id, risk })
        continue
      }
      if (risk.verdict === REFERRAL_VERDICTS.REVIEW) {
        // Left in COOLING past its due time — that is exactly what the admin
        // queue selects on, so no extra state is needed to represent "waiting
        // for a human".
        await pool.query(
          `UPDATE referrals SET risk_score = $2, risk_signals = $3::jsonb, updated_at = NOW() WHERE id = $1`,
          [referral.id, risk.score, JSON.stringify(risk.signals)]
        )
        result.held += 1
        continue
      }
      await pool.query(
        `UPDATE referrals SET status = 'APPROVED', approved_at = NOW(), risk_score = $2, risk_signals = $3::jsonb, updated_at = NOW() WHERE id = $1 AND status = 'COOLING'`,
        [referral.id, risk.score, JSON.stringify(risk.signals)]
      )
      result.approved += 1
    } catch (error) {
      console.error("referral_settlement_failed", { referralId: referral.id, error })
    }
  }

  const { rows: approved } = await pool.query(`SELECT * FROM referrals WHERE status = 'APPROVED' LIMIT 200`)
  for (const referral of approved) {
    try {
      await settleApprovedReferral(referral)
      result.paid += 1
    } catch (error) {
      console.error("referral_payout_failed", { referralId: referral.id, error })
    }
  }

  return result
}

/** Admin override: clear a held referral for payout on the next sweep phase. */
export async function approveReferral({ referralId, actorUserId }) {
  await ensureLoyaltySchema()
  const { rows } = await pool.query(
    `
      UPDATE referrals
      SET status = 'APPROVED', approved_at = NOW(), rejected_reason = NULL, updated_at = NOW()
      WHERE id = $1 AND status IN ('COOLING', 'FIRST_ACTION_DONE', 'REJECTED')
      RETURNING *
    `,
    [referralId]
  )
  const referral = rows[0]
  if (!referral) throw Object.assign(new Error("Referral is not awaiting a decision"), { code: "BAD_REQUEST" })
  // An admin re-approving a rejected referral needs its reversed entries back in
  // play, otherwise the payout would credit a balance with no matching ledger row.
  await pool.query(
    `UPDATE wallet_transactions SET status = 'PENDING' WHERE referral_id = $1 AND status = 'REVERSED'`,
    [referral.id]
  )
  auditReferralDecision("referral_approved_by_admin", { referralId: referral.id, actorUserId })
  await settleApprovedReferral(referral)
  const { rows: fresh } = await pool.query(`SELECT * FROM referrals WHERE id = $1`, [referral.id])
  return fresh[0] ?? referral
}

/** Admin override: reject a referral and reverse anything it accrued. */
export async function rejectReferral({ referralId, reason, actorUserId }) {
  await ensureLoyaltySchema()
  const normalizedReason = `${reason ?? ""}`.trim().slice(0, 500) || "Rejected by admin after review"
  const referral = await withTransaction(async client => {
    const { rows } = await client.query(
      `
        UPDATE referrals
        SET status = 'REJECTED', rejected_reason = $2, reward_given = FALSE, updated_at = NOW()
        WHERE id = $1 AND status <> 'REWARDED'
        RETURNING *
      `,
      [referralId, normalizedReason]
    )
    if (!rows[0]) return null
    await reverseReferralWalletEntries(client, referralId)
    return rows[0]
  })
  if (!referral) {
    throw Object.assign(new Error("Referral cannot be rejected once it has been paid out"), { code: "BAD_REQUEST" })
  }
  auditReferralDecision("referral_rejected_by_admin", { referralId, actorUserId })
  notifyUser({
    userId: referral.referrer_id,
    type: "REFERRAL_REJECTED",
    title: "Referral could not be verified",
    body: "One of your referrals did not pass our verification checks, so no credit was added.",
    data: { referralId },
  }).catch(error => console.error("notify_referral_rejected_failed", error))
  return referral
}

export async function isFirstTimeCustomer(userId) {
  if (!userId) return false
  const { rows } = await pool.query(`SELECT COUNT(*)::INT AS count FROM bookings WHERE created_by = $1`, [userId])
  return Number(rows[0]?.count ?? 0) === 0
}

/**
 * Admin-configured discount applied automatically on a customer's very first
 * booking (checked against ALL prior bookings, any status — cancelling and
 * rebooking does not re-qualify). Stacks on top of any existing offer/combo
 * pricing, same as wallet credit, and is applied by the caller by folding
 * the returned amount into discountAmount/payableAmount.
 */
export async function computeFirstBookingDiscount({ userId, payableAmount }) {
  const amount = Number(payableAmount) || 0
  if (!userId || amount <= 0) return { isFirstTime: false, discountPercent: 0, discountAmount: 0 }
  await ensureLoyaltySchema()
  const firstTime = await isFirstTimeCustomer(userId)
  if (!firstTime) return { isFirstTime: false, discountPercent: 0, discountAmount: 0 }
  const settings = await getLoyaltySettings()
  const discountAmount = Math.round(amount * (settings.firstBookingDiscountPercent / 100) * 100) / 100
  return { isFirstTime: true, discountPercent: settings.firstBookingDiscountPercent, discountAmount }
}

/** Atomically debits up to `maxAmount` (capped at the user's balance) and records the ledger entry. Returns the amount actually redeemed. */
export async function redeemWalletCredit({ userId, maxAmount, bookingId }) {
  const cap = Math.floor(Number(maxAmount) || 0)
  if (!userId || cap <= 0) return 0
  await ensureLoyaltySchema()
  return withTransaction(async client => {
    const { rows } = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [userId])
    const balance = Number(rows[0]?.wallet_balance ?? 0)
    const redeemAmount = Math.min(balance, cap)
    if (redeemAmount <= 0) return 0
    await client.query(`UPDATE users SET wallet_balance = wallet_balance - $2 WHERE id = $1`, [userId, redeemAmount])
    await client.query(
      `INSERT INTO wallet_transactions (id, user_id, type, source, amount, booking_id, description) VALUES ($1,$2,'DEBIT','BOOKING',$3,$4,$5)`,
      [uuid(), userId, redeemAmount, bookingId ?? null, "Wallet credit applied to booking"]
    )
    return redeemAmount
  })
}

/**
 * A referral sitting in COOLING past its due time has already been re-scored and
 * found borderline by the sweep — it is waiting on a person, not on the clock.
 */
function referralNeedsReview(row) {
  if (row.status !== "COOLING") return false
  if (!row.cooling_until) return false
  return new Date(row.cooling_until).getTime() <= Date.now()
}

/**
 * Customer-facing wording for each state. The internal names are precise but
 * mean nothing to someone waiting on Rs 150.
 */
const REFERRAL_STATUS_COPY = {
  PENDING: "Waiting for their first visit",
  FIRST_ACTION_DONE: "First visit complete — preparing your reward",
  COOLING: "Verifying your reward",
  APPROVED: "Approved — crediting your wallet",
  REWARDED: "Credited to your wallet",
  REJECTED: "Could not be verified",
}

function toReferralDto(row, { includeRisk = false } = {}) {
  const signals = Array.isArray(row.risk_signals) ? row.risk_signals : []
  const dto = {
    id: row.id,
    referrerId: row.referrer_id,
    referrerName: row.referrer_name ?? "",
    referredUserId: row.referred_user_id,
    referredName: row.referred_name ?? "",
    status: row.status,
    statusLabel: REFERRAL_STATUS_COPY[row.status] ?? row.status,
    // API field name predates the column rename; `reward_amount` is the
    // referrer's side of the payout, `welcome_points` the referred user's.
    rewardPoints: Number(row.reward_amount ?? 0),
    welcomePoints: Number(row.welcome_points ?? 0),
    firstActionAt: row.first_action_at ?? null,
    coolingUntil: row.cooling_until ?? null,
    approvedAt: row.approved_at ?? null,
    rewardedAt: row.rewarded_at ?? null,
    rejectedReason: row.rejected_reason ?? null,
    needsReview: referralNeedsReview(row),
    createdAt: row.created_at,
  }
  if (includeRisk) {
    // Admin-only: the signal detail is an abuse-detection map, so it is never
    // returned on the customer endpoint.
    dto.riskScore = Number(row.risk_score ?? 0)
    dto.riskSignals = explainRiskSignals(signals)
    dto.ipAddress = row.ip_address ?? null
    dto.deviceId = row.device_id ?? null
  }
  return dto
}

function toWalletTxDto(row) {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    status: row.status ?? "COMPLETED",
    amount: Number(row.amount ?? 0),
    description: row.description ?? "",
    createdAt: row.created_at,
  }
}

export async function getCustomerLoyaltyOverview(userId) {
  await ensureLoyaltySchema()
  const code = await getOrCreateReferralCode(userId)
  const { rows: userRows } = await pool.query(`SELECT wallet_balance FROM users WHERE id = $1`, [userId])
  const { rows: referralRows } = await pool.query(
    `
      SELECT r.*, u.name AS referred_name
      FROM referrals r
      JOIN users u ON u.id = r.referred_user_id
      WHERE r.referrer_id = $1
      ORDER BY r.created_at DESC
    `,
    [userId]
  )
  const { rows: txRows } = await pool.query(
    `SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
    [userId]
  )
  const { rows: pendingRows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::INT AS pending FROM wallet_transactions WHERE user_id = $1 AND type = 'CREDIT' AND status = 'PENDING'`,
    [userId]
  )
  const referrals = referralRows.map(row => toReferralDto(row))
  const firstTime = await isFirstTimeCustomer(userId)
  const settings = await getLoyaltySettings()
  return {
    referralCode: code,
    // Spendable now. Anything still being verified is reported separately so the
    // customer is never shown a balance they cannot actually use at checkout.
    walletBalance: Number(userRows[0]?.wallet_balance ?? 0),
    pendingCredit: Number(pendingRows[0]?.pending ?? 0),
    coolingHours: settings.coolingHours,
    referrals,
    totalReferred: referrals.length,
    totalRewarded: referrals.filter(item => item.status === "REWARDED").length,
    totalPending: referrals.filter(item => ["PENDING", "FIRST_ACTION_DONE", "COOLING", "APPROVED"].includes(item.status))
      .length,
    transactions: txRows.map(toWalletTxDto),
    isFirstTimeCustomer: firstTime,
    firstBookingDiscountPercent: settings.firstBookingDiscountPercent,
  }
}

export async function getAdminLoyaltyOverview() {
  await ensureLoyaltySchema()
  const { rows: referralRows } = await pool.query(
    `
      SELECT r.*, ru.name AS referrer_name, du.name AS referred_name
      FROM referrals r
      JOIN users ru ON ru.id = r.referrer_id
      JOIN users du ON du.id = r.referred_user_id
      ORDER BY r.created_at DESC
      LIMIT 200
    `
  )
  const { rows: summaryRows } = await pool.query(`
    SELECT
      COUNT(*)::INT AS total_referrals,
      COUNT(*) FILTER (WHERE status = 'REWARDED')::INT AS rewarded_referrals,
      COUNT(*) FILTER (WHERE status IN ('PENDING', 'FIRST_ACTION_DONE'))::INT AS pending_referrals,
      COUNT(*) FILTER (WHERE status = 'COOLING')::INT AS cooling_referrals,
      COUNT(*) FILTER (WHERE status = 'REJECTED')::INT AS rejected_referrals,
      COUNT(*) FILTER (WHERE status = 'COOLING' AND cooling_until IS NOT NULL AND cooling_until <= NOW())::INT AS review_referrals,
      COALESCE(SUM(reward_amount + welcome_points) FILTER (WHERE status = 'REWARDED'), 0)::INT AS total_points_issued
    FROM referrals
  `)
  const { rows: walletRows } = await pool.query(
    `SELECT COALESCE(SUM(wallet_balance), 0)::INT AS total_liability FROM users WHERE wallet_balance > 0`
  )
  const { rows: pendingRows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::INT AS pending_liability FROM wallet_transactions WHERE type = 'CREDIT' AND status = 'PENDING'`
  )
  const settings = await getLoyaltySettings()
  const referrals = referralRows.map(row => toReferralDto(row, { includeRisk: true }))
  return {
    referrals,
    // Pre-filtered so the admin page does not have to re-derive "waiting on me"
    // from timestamps and risk scores.
    reviewQueue: referrals.filter(item => item.needsReview),
    summary: {
      totalReferrals: Number(summaryRows[0]?.total_referrals ?? 0),
      rewardedReferrals: Number(summaryRows[0]?.rewarded_referrals ?? 0),
      pendingReferrals: Number(summaryRows[0]?.pending_referrals ?? 0),
      coolingReferrals: Number(summaryRows[0]?.cooling_referrals ?? 0),
      rejectedReferrals: Number(summaryRows[0]?.rejected_referrals ?? 0),
      needsReviewCount: Number(summaryRows[0]?.review_referrals ?? 0),
      totalPointsIssued: Number(summaryRows[0]?.total_points_issued ?? 0),
      walletLiability: Number(walletRows[0]?.total_liability ?? 0),
      pendingLiability: Number(pendingRows[0]?.pending_liability ?? 0),
    },
    settings,
  }
}

/**
 * Reward vault — a gamified layer on top of the plain wallet reward: each time
 * a referral converts, the referrer earns one weighted "card draw" that wins
 * them a free service (picked by admin, weighted by admin). Which cards are
 * even eligible to appear is driven entirely by each service's own
 * `target_gender` (MEN/WOMEN/UNISEX) — the same field admins already set on
 * every service in the catalog — so admin curates the pool per gender simply
 * by choosing which services to add as cards. No separate gender logic here.
 */
function eligibleServiceGendersFor(customerGender) {
  const normalized = normalizeCustomerGender(customerGender)
  if (normalized === GENDER_FEMALE) return ["WOMEN", "UNISEX"]
  if (normalized === GENDER_MALE) return ["MEN", "UNISEX"]
  // OTHER and UNSPECIFIED both land here. This used to return every gender,
  // which is why men — stored as OTHER because signup never really asked — were
  // shown women's cards. Unisex-only is the honest answer when we can't say a
  // gendered card applies; `getCustomerRewardVault` reports `needsGender` so the
  // customer can state it and unlock the full pool.
  return ["UNISEX"]
}

function toRewardCardDto(row) {
  return {
    id: row.id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    serviceBasePrice: Number(row.base_price ?? 0),
    serviceTargetGender: row.target_gender,
    serviceImageUrl: row.image_url ?? null,
    rank: Number(row.rank ?? 1),
    probabilityPercent: Number(row.probability_percent ?? 0),
    isActive: Boolean(row.is_active),
  }
}

export async function listAdminRewardCards() {
  await ensureLoyaltySchema()
  const { rows } = await pool.query(`
    SELECT c.*, s.name AS service_name, s.base_price, s.target_gender, s.image_url
    FROM referral_reward_cards c
    JOIN service_catalog s ON s.id = c.service_id
    ORDER BY c.rank ASC, c.created_at ASC
  `)
  return rows.map(toRewardCardDto)
}

export async function saveAdminRewardCard({ id, serviceId, rank, probabilityPercent, isActive, actorUserId }) {
  await ensureLoyaltySchema()
  if (!serviceId) throw Object.assign(new Error("A service is required"), { code: "BAD_REQUEST" })
  const rankValue = Math.max(1, Math.round(Number(rank) || 1))
  const probability = Number(probabilityPercent)
  if (!Number.isFinite(probability) || probability < 0 || probability > 100) {
    throw Object.assign(new Error("Probability must be between 0 and 100 percent"), { code: "BAD_REQUEST" })
  }
  const active = isActive !== false
  const cardId = id || uuid()
  await pool.query(
    `
      INSERT INTO referral_reward_cards (id, service_id, rank, probability_percent, is_active, created_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (id) DO UPDATE
      SET service_id = EXCLUDED.service_id,
          rank = EXCLUDED.rank,
          probability_percent = EXCLUDED.probability_percent,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
    `,
    [cardId, serviceId, rankValue, probability, active, actorUserId ?? null]
  )
  const cards = await listAdminRewardCards()
  return cards.find(card => card.id === cardId) ?? null
}

export async function deleteAdminRewardCard(id) {
  await ensureLoyaltySchema()
  const { rowCount } = await pool.query(`DELETE FROM referral_reward_cards WHERE id = $1`, [id])
  return rowCount > 0
}

function toRewardWinDto(row) {
  return {
    id: row.id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    status: row.status,
    wonAt: row.won_at,
    usedAt: row.used_at ?? null,
  }
}

export async function getCustomerRewardVault({ userId, gender }) {
  await ensureLoyaltySchema()
  const genders = eligibleServiceGendersFor(gender)
  const { rows: cardRows } = await pool.query(
    `
      SELECT c.*, s.name AS service_name, s.base_price, s.target_gender, s.image_url
      FROM referral_reward_cards c
      JOIN service_catalog s ON s.id = c.service_id
      WHERE c.is_active = TRUE AND s.is_active = TRUE AND s.target_gender = ANY($1::text[])
      ORDER BY c.rank ASC
      LIMIT 5
    `,
    [genders]
  )
  const { rows: pendingRows } = await pool.query(
    `
      SELECT r.id, u.name AS referred_name
      FROM referrals r
      JOIN users u ON u.id = r.referred_user_id
      WHERE r.referrer_id = $1 AND r.status = 'REWARDED' AND r.card_drawn = FALSE
      ORDER BY r.rewarded_at ASC
    `,
    [userId]
  )
  const { rows: winRows } = await pool.query(
    `
      SELECT w.*, s.name AS service_name
      FROM referral_reward_wins w
      JOIN service_catalog s ON s.id = w.service_id
      WHERE w.user_id = $1
      ORDER BY w.won_at DESC
      LIMIT 25
    `,
    [userId]
  )
  return {
    cards: cardRows.map(toRewardCardDto),
    pendingDraws: pendingRows.map(row => ({ referralId: row.id, referredName: row.referred_name })),
    wins: winRows.map(toRewardWinDto),
    // Accounts registered before gender was asked see a unisex-only pool. The
    // flag lets the UI offer to fix that instead of silently showing less.
    needsGender: !hasStatedGender(gender),
  }
}

/** Weighted-random pick among currently gender-eligible active cards. Renormalizes so the draw is always fair even if admin's raw weights don't sum to 100 for this gender's subset. */
export async function drawRewardCard({ userId, referralId, gender }) {
  if (!userId || !referralId) throw Object.assign(new Error("A referral is required"), { code: "BAD_REQUEST" })
  await ensureLoyaltySchema()
  const { rows: referralRows } = await pool.query(
    `SELECT * FROM referrals WHERE id = $1 AND referrer_id = $2 LIMIT 1`,
    [referralId, userId]
  )
  const referral = referralRows[0]
  if (!referral) throw Object.assign(new Error("Referral not found"), { code: "NOT_FOUND" })
  if (referral.status !== "REWARDED") {
    throw Object.assign(new Error("This referral hasn't earned a reward yet"), { code: "BAD_REQUEST" })
  }
  if (referral.card_drawn) {
    throw Object.assign(new Error("You've already claimed this referral's reward"), { code: "BAD_REQUEST" })
  }
  if (!hasStatedGender(gender)) {
    // A draw is one-shot — it burns the referral. Refuse rather than spend it on
    // a pool narrowed down to unisex because the account never recorded a gender.
    throw Object.assign(new Error("GENDER_REQUIRED"), { code: "BAD_REQUEST" })
  }

  const genders = eligibleServiceGendersFor(gender)
  const { rows: cardRows } = await pool.query(
    `
      SELECT c.*, s.name AS service_name, s.base_price, s.target_gender, s.image_url
      FROM referral_reward_cards c
      JOIN service_catalog s ON s.id = c.service_id
      WHERE c.is_active = TRUE AND s.is_active = TRUE AND s.target_gender = ANY($1::text[])
    `,
    [genders]
  )
  if (!cardRows.length) {
    throw Object.assign(new Error("No reward cards are configured yet — check back soon"), { code: "NOT_FOUND" })
  }
  const totalWeight = cardRows.reduce((sum, row) => sum + Math.max(0, Number(row.probability_percent ?? 0)), 0)
  let roll = Math.random() * (totalWeight > 0 ? totalWeight : cardRows.length)
  let picked = cardRows[cardRows.length - 1]
  for (const row of cardRows) {
    const weight = totalWeight > 0 ? Math.max(0, Number(row.probability_percent ?? 0)) : 1
    if (roll < weight) {
      picked = row
      break
    }
    roll -= weight
  }

  const winId = uuid()
  await withTransaction(async client => {
    await client.query(`UPDATE referrals SET card_drawn = TRUE WHERE id = $1`, [referral.id])
    await client.query(
      `INSERT INTO referral_reward_wins (id, user_id, referral_id, service_id, status) VALUES ($1,$2,$3,$4,'UNCLAIMED')`,
      [winId, userId, referral.id, picked.service_id]
    )
  })

  notifyUser({
    userId,
    type: "REFERRAL_REWARDED",
    title: "You won a free service!",
    body: `${picked.service_name} is now free on your next booking — check Refer & Earn to redeem it.`,
    data: { winId },
  }).catch(error => console.error("notify_reward_card_win_failed", error))

  return {
    winId,
    card: toRewardCardDto(picked),
  }
}

/**
 * Atomically claims one UNCLAIMED win for (userId, serviceId) — `FOR UPDATE
 * SKIP LOCKED` means two concurrent claims for the same voucher can never
 * both succeed. Must be called BEFORE a discount is applied to a booking:
 * the caller only applies the free-service price reduction if this returns
 * a row, so a lost race correctly falls back to "no voucher applied"
 * instead of granting the discount without actually consuming anything.
 */
export async function claimRewardVoucher({ userId, serviceId }) {
  if (!userId || !serviceId) return null
  await ensureLoyaltySchema()
  const { rows } = await pool.query(
    `
      UPDATE referral_reward_wins
      SET status = 'USED', used_at = NOW()
      WHERE id = (
        SELECT id FROM referral_reward_wins
        WHERE user_id = $1 AND service_id = $2 AND status = 'UNCLAIMED'
        ORDER BY won_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, service_id
    `,
    [userId, serviceId]
  )
  return rows[0] ? { winId: rows[0].id, serviceId: rows[0].service_id } : null
}

/** Best-effort traceability link — the win is already durably marked USED by `claimRewardVoucher`; this just records which booking it paid for. */
export async function attachRewardVoucherToBooking({ winId, bookingId }) {
  if (!winId || !bookingId) return
  await ensureLoyaltySchema()
  await pool.query(`UPDATE referral_reward_wins SET used_booking_id = $2 WHERE id = $1`, [winId, bookingId])
}

/**
 * Referral abuse scoring.
 *
 * Pure: given a set of facts about a referral, it returns the signals that
 * fired, a score, and a verdict. No I/O, so the rules can be reasoned about and
 * tested on their own, and the same function can score a referral at signup, at
 * payout time, and again during admin review without duplicating logic.
 *
 * The threat this is built around is one person farming their own referral code:
 * make a second account, refer yourself, collect. The cheap defences people try
 * first are changing network (airplane mode on/off gives a fresh IP) and signing
 * up again from the same phone. IP-based rules alone do not survive that, which
 * is why the highest weights are on device identity and on device reuse across
 * accounts — those persist across a network change.
 *
 * Nothing here is individually conclusive, which is why the output is a score
 * feeding three outcomes (auto-approve / hold for review / auto-reject) rather
 * than a boolean.
 */

/**
 * A weight of 100 is on its own enough to trip the default auto-reject
 * threshold; everything below that has to combine with something else.
 */
export const REFERRAL_RISK_SIGNALS = {
  SELF_REFERRAL: {
    weight: 100,
    label: "Referrer and referred user are the same account",
  },
  SHARED_DEVICE: {
    weight: 100,
    label: "Both accounts signed up from the same device",
  },
  DEVICE_REUSED: {
    weight: 100,
    label: "This device has already been used to create another referred account",
  },
  DEVICE_FLAGGED: {
    weight: 60,
    label: "Device was previously flagged as suspicious",
  },
  IP_REUSED_ACROSS_REFERRALS: {
    weight: 45,
    label: "Another account referred by this referrer used the same IP address",
  },
  BURST_VELOCITY: {
    weight: 45,
    label: "Referrer added several accounts in a short window",
  },
  REFERRER_UNDER_REVIEW: {
    weight: 40,
    label: "Referrer's own account is under review",
  },
  SHARED_IP: {
    weight: 30,
    label: "Both accounts signed up from the same IP address",
  },
  NO_DEVICE_ID: {
    weight: 15,
    label: "Device could not be identified",
  },
}

export const REFERRAL_VERDICTS = {
  /** Clean enough to pay out automatically once the cooling period ends. */
  AUTO: "AUTO",
  /** Held for a human decision instead of paying or rejecting on its own. */
  REVIEW: "REVIEW",
  /** Rejected without payout. */
  REJECT: "REJECT",
}

export const REFERRAL_RISK_DEFAULTS = {
  /** Score at or below which a referral pays out with no human involvement. */
  autoApproveMaxRisk: 29,
  /** Score at or above which a referral is rejected outright. */
  autoRejectMinRisk: 70,
  /** Hours a reward is held before payout, so abuse has time to surface. */
  coolingHours: 24,
  /** Referrals by one referrer within `velocityWindowHours` before it looks like farming. */
  velocityMaxReferrals: 4,
  velocityWindowHours: 24,
}

function normalizeIp(value) {
  const raw = `${value ?? ""}`.trim().toLowerCase()
  if (!raw || raw === "unknown") return null
  // ::ffff:203.0.113.9 and 203.0.113.9 are the same client seen over IPv4-mapped IPv6.
  return raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw
}

function normalizeDeviceId(value) {
  const raw = `${value ?? ""}`.trim()
  return raw.length >= 8 ? raw : null
}

/**
 * @typedef {object} ReferralRiskFacts
 * @property {string} referrerId
 * @property {string} referredUserId
 * @property {string | null} [referrerDeviceId]
 * @property {string | null} [referredDeviceId]
 * @property {string | null} [referrerIp]      Referrer's last known signup/login IP
 * @property {string | null} [referredIp]      IP the referred account signed up from
 * @property {string[]} [deviceAccountUserIds] Other accounts that have used the referred device
 * @property {boolean} [deviceFlagged]
 * @property {boolean} [referrerUnderReview]
 * @property {number} [recentReferralCount]    Referrals this referrer made inside the velocity window
 * @property {string[]} [priorReferralIps]     IPs of accounts this referrer already referred
 */

/**
 * @param {ReferralRiskFacts} facts
 * @param {object} [settings] Overrides for `REFERRAL_RISK_DEFAULTS`
 * @returns {{ signals: string[], score: number, verdict: string, reason: string }}
 */
export function scoreReferralRisk(facts, settings = {}) {
  const config = { ...REFERRAL_RISK_DEFAULTS, ...settings }
  const signals = []

  const referrerDevice = normalizeDeviceId(facts.referrerDeviceId)
  const referredDevice = normalizeDeviceId(facts.referredDeviceId)
  const referrerIp = normalizeIp(facts.referrerIp)
  const referredIp = normalizeIp(facts.referredIp)

  if (facts.referrerId && facts.referrerId === facts.referredUserId) {
    signals.push("SELF_REFERRAL")
  }

  if (referrerDevice && referredDevice && referrerDevice === referredDevice) {
    signals.push("SHARED_DEVICE")
  } else if (!referredDevice) {
    // Either an old client or someone who stripped the identifier. Not damning on
    // its own, but it removes the strongest check, so it costs a little.
    signals.push("NO_DEVICE_ID")
  }

  // The device has a history with accounts other than this pair — the signature
  // of one person cycling through signups on a single phone.
  const otherAccounts = (facts.deviceAccountUserIds ?? []).filter(
    id => id && id !== facts.referredUserId && id !== facts.referrerId
  )
  if (referredDevice && otherAccounts.length > 0) {
    signals.push("DEVICE_REUSED")
  }

  if (facts.deviceFlagged) signals.push("DEVICE_FLAGGED")
  if (facts.referrerUnderReview) signals.push("REFERRER_UNDER_REVIEW")

  if (referrerIp && referredIp && referrerIp === referredIp) {
    // Weak on purpose: a household, an office, or salon wi-fi all share an IP,
    // and CGNAT puts whole neighbourhoods behind one address.
    signals.push("SHARED_IP")
  }

  const priorIps = new Set((facts.priorReferralIps ?? []).map(normalizeIp).filter(Boolean))
  if (referredIp && priorIps.has(referredIp)) {
    signals.push("IP_REUSED_ACROSS_REFERRALS")
  }

  if (Number(facts.recentReferralCount ?? 0) > config.velocityMaxReferrals) {
    signals.push("BURST_VELOCITY")
  }

  const score = signals.reduce((total, key) => total + (REFERRAL_RISK_SIGNALS[key]?.weight ?? 0), 0)

  let verdict = REFERRAL_VERDICTS.AUTO
  if (score >= config.autoRejectMinRisk) verdict = REFERRAL_VERDICTS.REJECT
  else if (score > config.autoApproveMaxRisk) verdict = REFERRAL_VERDICTS.REVIEW

  return { signals, score, verdict, reason: describeRiskSignals(signals) }
}

/**
 * Human-readable summary of why a referral scored the way it did. Stored on
 * rejection so the customer-facing and admin-facing explanations agree.
 *
 * @param {string[]} signals
 * @returns {string}
 */
export function describeRiskSignals(signals) {
  const labels = (signals ?? []).map(key => REFERRAL_RISK_SIGNALS[key]?.label).filter(Boolean)
  if (!labels.length) return "No risk signals detected"
  return labels.join("; ")
}

/**
 * Expands stored signal keys into `{ key, label, weight }` for display.
 *
 * @param {string[]} signals
 */
export function explainRiskSignals(signals) {
  return (signals ?? [])
    .filter(key => REFERRAL_RISK_SIGNALS[key])
    .map(key => ({ key, label: REFERRAL_RISK_SIGNALS[key].label, weight: REFERRAL_RISK_SIGNALS[key].weight }))
}

/** Customer-facing cancellation refund tiers (by time until appointment start). */
export const CUSTOMER_CANCELLATION_POLICY_RULES = [
  {
    id: "FULL",
    condition: "24 hours or more before your appointment",
    refund: "100% refund",
    detail: "The full amount you paid will be credited back to you.",
  },
  {
    id: "PARTIAL",
    condition: "More than 30 minutes, but less than 24 hours before",
    refund: "50% refund",
    detail: "Half of the amount paid is credited back; the stylist slot is freed immediately for others.",
  },
  {
    id: "NONE",
    condition: "30 minutes or less before your appointment",
    refund: "No refund",
    detail: "No payback is issued. The stylist slot is still freed for the salon schedule.",
  },
]

/**
 * @param {{ payableAmount: number, startsAt: string|Date, now?: Date }}
 */
export function computeCancellationRefund({ payableAmount, startsAt, now = new Date() }) {
  const paid = Math.max(0, Number(payableAmount ?? 0))
  const start = new Date(startsAt)
  if (Number.isNaN(start.getTime())) {
    return { canCancel: false, reason: "Invalid appointment time." }
  }
  const minutesUntilStart = (start.getTime() - now.getTime()) / 60_000
  if (minutesUntilStart <= 0) {
    return { canCancel: false, reason: "This appointment has already started or passed." }
  }

  let refundPercent = 0
  let policyKey = "NONE"
  let tierLabel = CUSTOMER_CANCELLATION_POLICY_RULES[2].condition

  if (minutesUntilStart >= 24 * 60) {
    refundPercent = 100
    policyKey = "FULL"
    tierLabel = CUSTOMER_CANCELLATION_POLICY_RULES[0].condition
  } else if (minutesUntilStart > 30) {
    refundPercent = 50
    policyKey = "PARTIAL"
    tierLabel = CUSTOMER_CANCELLATION_POLICY_RULES[1].condition
  } else {
    refundPercent = 0
    policyKey = "NONE"
    tierLabel = CUSTOMER_CANCELLATION_POLICY_RULES[2].condition
  }

  const refundAmount = Math.round(((paid * refundPercent) / 100) * 100) / 100
  const retainedAmount = Math.round((paid - refundAmount) * 100) / 100

  return {
    canCancel: true,
    minutesUntilStart: Math.floor(minutesUntilStart),
    hoursUntilStart: Math.round((minutesUntilStart / 60) * 10) / 10,
    refundPercent,
    refundAmount,
    retainedAmount,
    payableAmount: paid,
    policyKey,
    tierLabel,
    stylistFreedImmediately: true,
  }
}

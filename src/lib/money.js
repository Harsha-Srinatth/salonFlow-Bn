/**
 * Money is stored as NUMERIC(12,2) but computed with JS floats, so `450 - 450 * 0.1 / 100`
 * style arithmetic produces values like 404.99999999999994. Round once at the source of each
 * amount so invoices, payments, refunds and reports all agree to the paisa.
 */
export function roundMoney(value) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) return 0
  return Math.round((number + Number.EPSILON) * 100) / 100
}

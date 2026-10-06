import { pool } from "../lib/db-pool.js"
import { SALON_TIMEZONE, SALON_TODAY_START_SQL } from "../lib/salon-time.js"

const NET_SQL = `CASE WHEN p.source_type = 'REFUND' THEN -p.amount ELSE p.amount END`

/**
 * Data for the admin live revenue chart.
 *  - today: running net revenue since salon-local midnight, one point per payment (unix seconds).
 *  - hourly: average net revenue per salon-local hour over the last `days` days (peak-hour view).
 * Read straight from payment_transactions, so it works whether or not telemetry storage is on.
 */
export async function getLiveRevenue({ days = 28 } = {}) {
  const safeDays = Math.min(Math.max(Math.trunc(Number(days) || 28), 1), 365)
  const [todayRes, hourlyRes] = await Promise.all([
    pool.query(
      `
        SELECT EXTRACT(EPOCH FROM p.collected_at)::bigint AS ts, (${NET_SQL})::float8 AS net
        FROM payment_transactions p
        WHERE p.collected_at >= ${SALON_TODAY_START_SQL}
        ORDER BY p.collected_at ASC
      `
    ),
    pool.query(
      `
        SELECT
          EXTRACT(HOUR FROM p.collected_at AT TIME ZONE '${SALON_TIMEZONE}')::int AS hour,
          SUM(${NET_SQL})::float8 AS net,
          COUNT(*)::int AS payments
        FROM payment_transactions p
        WHERE p.collected_at >= NOW() - ($1::int * interval '1 day')
        GROUP BY 1
      `,
      [safeDays]
    ),
  ])

  let running = 0
  const today = todayRes.rows.map((row) => {
    running += Number(row.net)
    return { time: Number(row.ts), value: Math.round(running * 100) / 100 }
  })

  const byHour = new Map(hourlyRes.rows.map((row) => [row.hour, row]))
  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const row = byHour.get(hour)
    return {
      hour,
      avgNet: row ? Math.round((Number(row.net) / safeDays) * 100) / 100 : 0,
      payments: row ? Number(row.payments) : 0,
    }
  })
  const peakHours = [...hourly]
    .filter((h) => h.avgNet > 0)
    .sort((a, b) => b.avgNet - a.avgNet)
    .slice(0, 3)
    .map((h) => h.hour)

  return { now: Math.floor(Date.now() / 1000), timezone: SALON_TIMEZONE, days: safeDays, todayTotal: running, today, hourly, peakHours }
}

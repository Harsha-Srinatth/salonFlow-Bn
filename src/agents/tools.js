import { pool } from "../lib/db-pool.js"
import { SALON_TIMEZONE, SALON_TODAY_START_SQL, addDaysToDateString, salonDateString } from "../lib/salon-time.js"
import { normalizeCustomerGender } from "../lib/gender.js"
import { roundMoney } from "../lib/money.js"
import { listServiceCatalog, listBookingsForCustomer } from "../bookings/repository.js"
import { listAvailableSlots } from "../bookings/service.js"
import { getCustomerOffersForUser, getMembershipSegmentForUser } from "../offers/service.js"
import { getPublicBusinessInfo } from "../business/service.js"

/**
 * Tools the agents may call. Each tool declares which caller scopes may use it; the runner
 * re-checks that on every call, so a tool can never run for a caller who lacks the scope even if
 * the model asks for it (e.g. after a prompt-injection attempt).
 *
 *   GUEST     anonymous visitor, or staff using the public assistant: public business data only
 *   CUSTOMER  signed-in customer: GUEST + their *own* bookings + booking suggestions
 *   ADMIN     owner/admin: aggregated business metrics and the service-content drafter
 *
 * Tools only read. The one tool that "does" something for the customer
 * (`suggest_services_for_booking`) records a suggestion the UI shows as a button; nothing is
 * added to the cart until the customer clicks it.
 *
 * Tool results never contain other customers' data, staff contact details, or money totals for
 * non-admins.
 */

const DATE_FMT = new Intl.DateTimeFormat("en-IN", {
  timeZone: SALON_TIMEZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
})
const TIME_FMT = new Intl.DateTimeFormat("en-IN", { timeZone: SALON_TIMEZONE, hour: "numeric", minute: "2-digit" })

const SECTION_LABELS = {
  overview: "What it is",
  benefits: "Benefits",
  suitableFor: "Suitable for",
  notRecommendedFor: "Not recommended for",
  precautions: "Precautions",
  expectedResult: "Expected result",
  preparation: "Before your visit",
  aftercare: "Aftercare",
}

async function pricedServicesFor(ctx) {
  let segment = "FREE"
  if (ctx.scope === "CUSTOMER" && ctx.user) {
    segment = ctx.user.membershipSegment ?? (await getMembershipSegmentForUser(ctx.user.id)) ?? "FREE"
  }
  const offers = await getCustomerOffersForUser({ membershipSegment: segment })
  return { offers, priced: new Map((offers?.pricedServices ?? []).map(item => [item.serviceId, item])) }
}

function priceView(service, priced) {
  const p = priced.get(service.id)
  const listPrice = roundMoney(service.basePrice)
  const currentPrice = roundMoney(Number(p?.finalPrice ?? service.basePrice))
  return {
    listPriceInr: listPrice,
    currentPriceInr: currentPrice,
    ...(currentPrice < listPrice ? { discountPercent: Number(p?.appliedPercent ?? 0) } : {}),
  }
}

// Words that say nothing about *which* service is meant.
const STOPWORDS = new Set(
  "a an and any are can do does for from get have how i in is it me much my need of on or please price prices cost costs rate rates service services treatment treatments the to want what which with you your yours list all show tell about there their this that customer customers".split(" ")
)

// British/Indian spellings customers type vs the catalog's spelling.
const SPELLING = [[/colour/g, "color"], [/haircut/g, "hair cut"], [/moustache/g, "mustache"]]

function tokenize(text) {
  let normalized = `${text ?? ""}`.toLowerCase()
  for (const [pattern, replacement] of SPELLING) normalized = normalized.replace(pattern, replacement)
  return normalized
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1 && !STOPWORDS.has(word))
}

/**
 * Simple relevance: query words found in name (x3), category (x2), description/details (x1).
 * `requireNameMatch` (used by basic mode) keeps only services whose name or category matched,
 * so a stray word in a description never produces a confident-looking wrong answer.
 */
export function rankServices(services, query, { requireNameMatch = false } = {}) {
  const words = tokenize(query)
  if (!words.length) return requireNameMatch ? [] : services
  const scored = services.map(service => {
    const name = tokenize(service.name).join(" ")
    const category = `${service.category}`.toLowerCase()
    const body = `${service.description} ${Object.values(service.details ?? {}).join(" ")}`.toLowerCase()
    let score = 0
    let nameHits = 0
    for (const word of words) {
      const stem = word.length > 4 ? word.replace(/(ing|es|s)$/, "") : word
      if (name.includes(stem)) {
        score += 3
        nameHits += 1
      }
      if (category.includes(stem)) {
        score += 2
        nameHits += 1
      }
      if (body.includes(stem)) score += 1
    }
    return { service, score, nameHits }
  })
  return scored
    .filter(item => item.score > 0 && (!requireNameMatch || item.nameHits > 0))
    .sort((a, b) => b.score - a.score || a.service.name.length - b.service.name.length)
    .map(item => item.service)
}

function resolveDate(value) {
  const today = salonDateString(new Date())
  return `${value ?? "today"}`.toLowerCase() === "tomorrow" ? addDaysToDateString(today, 1) : today
}

function periodStartSql(period) {
  if (period === "7d") return `${SALON_TODAY_START_SQL} - interval '6 days'`
  if (period === "30d") return `${SALON_TODAY_START_SQL} - interval '29 days'`
  return SALON_TODAY_START_SQL
}

export const TOOLS = {
  get_business_info: {
    scopes: ["GUEST", "CUSTOMER", "ADMIN"],
    definition: {
      name: "get_business_info",
      description:
        "Returns the salon's official public information: name, about text, contact details (phone, WhatsApp, support email), address and map link, social links, opening hours and lunch break, how far ahead bookings can be made, the cancellation/refund policy, written payment/late-arrival/general policies, and the salon's own FAQ. Fields the salon has not filled in are absent. Call this for any question about contact, location, timings, policies or general questions.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
    },
    async run() {
      const info = await getPublicBusinessInfo()
      const { profile } = info
      const pick = Object.fromEntries(Object.entries(profile).filter(([, value]) => (Array.isArray(value) ? value.length : Boolean(value))))
      return { ...pick, hours: info.hours, cancellationPolicy: info.cancellationPolicy }
    },
  },

  search_services: {
    scopes: ["GUEST", "CUSTOMER", "ADMIN"],
    definition: {
      name: "search_services",
      description:
        "Searches the live service catalog (only services currently offered). Returns id, name, category, who it is for (MEN/WOMEN/UNISEX), duration in minutes and price in INR (listPriceInr, and currentPriceInr after any offer that applies to this customer right now). Pass an empty query to list everything. Use it for questions about what is offered, prices and durations, and to find service ids.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to match, e.g. 'beard', 'hair colour', 'facial'. Empty string lists all services." },
          gender: { type: "string", enum: ["ANY", "MEN", "WOMEN", "UNISEX"], description: "Filter by who the service is for. Use ANY if not specified." },
        },
        required: ["query", "gender"],
        additionalProperties: false,
      },
      strict: true,
    },
    async run(ctx, input) {
      const services = await listServiceCatalog()
      const gender = `${input?.gender ?? "ANY"}`.toUpperCase()
      const filtered = gender === "ANY" ? services : services.filter(s => `${s.gender}`.toUpperCase() === gender || `${s.gender}`.toUpperCase() === "UNISEX")
      const ranked = rankServices(filtered, input?.query).slice(0, 25)
      const { priced } = await pricedServicesFor(ctx)
      return {
        count: ranked.length,
        services: ranked.map(service => ({
          id: service.id,
          name: service.name,
          category: service.category,
          for: service.gender,
          durationMinutes: service.duration,
          ...priceView(service, priced),
          summary: service.description ? service.description.slice(0, 200) : undefined,
        })),
        note: ranked.length ? undefined : "No matching service in the catalog.",
      }
    },
  },

  get_service_details: {
    scopes: ["GUEST", "CUSTOMER", "ADMIN"],
    definition: {
      name: "get_service_details",
      description:
        "Full details of one service from the catalog: description, what it is, benefits, who it suits, who should avoid it, precautions, preparation, aftercare, expected result, variants, price and duration. Sections the salon has not written are absent - do not fill them in yourself.",
      input_schema: {
        type: "object",
        properties: { service_id: { type: "string", description: "Service id from search_services." } },
        required: ["service_id"],
        additionalProperties: false,
      },
      strict: true,
    },
    async run(ctx, input) {
      const services = await listServiceCatalog()
      const service = services.find(item => item.id === `${input?.service_id ?? ""}`.trim())
      if (!service) return { error: "No active service with that id. Use search_services to find the right id." }
      const { priced } = await pricedServicesFor(ctx)
      const details = Object.fromEntries(Object.entries(service.details ?? {}).map(([key, value]) => [SECTION_LABELS[key] ?? key, value]))
      return {
        id: service.id,
        name: service.name,
        category: service.category,
        for: service.gender,
        durationMinutes: service.duration,
        ...priceView(service, priced),
        description: service.description || undefined,
        details: Object.keys(details).length ? details : undefined,
        variants: service.variants?.length ? service.variants : undefined,
        photoCount: service.images?.length ?? 0,
      }
    },
  },

  get_current_offers: {
    scopes: ["GUEST", "CUSTOMER"],
    definition: {
      name: "get_current_offers",
      description:
        "Offers active right now for this visitor: salon-wide discount, per-service discounts and combo packages (with prices). For a signed-in customer this reflects their membership level.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
    },
    async run(ctx) {
      const { offers } = await pricedServicesFor(ctx)
      return {
        salonWide: offers?.globalDiscount ? { label: offers.globalDiscount.label, endsAt: offers.globalDiscount.endAt } : null,
        serviceOffers: (offers?.serviceOffers ?? []).slice(0, 20).map(item => ({
          service: item.serviceName,
          discountPercent: item.discountPercent,
          priceInr: item.finalPrice,
          wasInr: item.originalPrice,
        })),
        combos: (offers?.combos ?? []).slice(0, 10).map(combo => ({
          name: combo.name,
          services: combo.serviceNames ?? undefined,
          priceInr: combo.offerPrice,
          wasInr: combo.actualPrice,
        })),
      }
    },
  },

  check_availability: {
    scopes: ["GUEST", "CUSTOMER"],
    definition: {
      name: "check_availability",
      description:
        "Free appointment start times for one or more services (booked back to back) today or tomorrow, in salon local time. Only today and tomorrow can be booked online. Returns the earliest times and how many there are; it does not reserve anything.",
      input_schema: {
        type: "object",
        properties: {
          service_ids: { type: "array", items: { type: "string" }, description: "Service ids from search_services." },
          day: { type: "string", enum: ["today", "tomorrow"] },
        },
        required: ["service_ids", "day"],
        additionalProperties: false,
      },
      strict: true,
    },
    async run(ctx, input) {
      const ids = Array.from(new Set((Array.isArray(input?.service_ids) ? input.service_ids : []).map(id => `${id}`.trim()).filter(Boolean))).slice(0, 6)
      if (!ids.length) return { error: "Give at least one service id." }
      const customerGender = ctx.scope === "CUSTOMER" ? normalizeCustomerGender(ctx.user?.gender) : "UNSPECIFIED"
      try {
        const date = resolveDate(input?.day)
        const { totalDuration, slots } = await listAvailableSlots({ serviceIds: ids, date, customerGender })
        return {
          day: input?.day === "tomorrow" ? "tomorrow" : "today",
          totalDurationMinutes: totalDuration,
          freeSlotCount: slots.length,
          earliestStartTimes: slots.slice(0, 12).map(slot => TIME_FMT.format(new Date(slot.startsAt))),
          note: slots.length ? "Times are not held until the customer completes a booking." : "No free time on this day for these services.",
        }
      } catch (error) {
        if (error?.code === "BAD_REQUEST") return { error: error.message }
        throw error
      }
    },
  },

  get_my_bookings: {
    scopes: ["CUSTOMER"],
    definition: {
      name: "get_my_bookings",
      description:
        "The signed-in customer's own recent and upcoming appointments (services, date/time, stylist first name, status, amount). Only ever returns this customer's bookings.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
    },
    async run(ctx) {
      // Identity comes from the authenticated session, never from model input.
      const { bookings } = await listBookingsForCustomer({ customerEmail: ctx.user.email, customerPhone: ctx.user.phone, limit: 10, offset: 0 })
      return {
        bookings: bookings.map(booking => ({
          services: booking.services?.length ? booking.services.map(item => item.name).filter(Boolean) : [booking.service],
          when: DATE_FMT.format(new Date(booking.startsAt)),
          upcoming: new Date(booking.startsAt).getTime() > Date.now(),
          status: booking.status,
          stylist: booking.stylistName ? `${booking.stylistName}`.split(" ")[0] : undefined,
          amountInr: booking.payableAmount,
        })),
        howToManage: "Customers can view, cancel (refund per policy) or download invoices from Bookings > History in the app.",
      }
    },
  },

  suggest_services_for_booking: {
    scopes: ["CUSTOMER", "GUEST"],
    definition: {
      name: "suggest_services_for_booking",
      description:
        "Offer the customer a one-tap button to add specific services to their booking. This does NOT book or add anything by itself; the customer must press the button. Use only when the customer has expressed interest in specific services. Guests are asked to sign in first.",
      input_schema: {
        type: "object",
        properties: { service_ids: { type: "array", items: { type: "string" } } },
        required: ["service_ids"],
        additionalProperties: false,
      },
      strict: true,
    },
    async run(ctx, input) {
      const services = await listServiceCatalog()
      const byId = new Map(services.map(s => [s.id, s]))
      const valid = Array.from(new Set((input?.service_ids ?? []).map(id => `${id}`.trim())))
        .map(id => byId.get(id))
        .filter(Boolean)
        .slice(0, 6)
      if (!valid.length) return { error: "None of those ids are active services." }
      ctx.actions.push({ type: "ADD_SERVICES_TO_BOOKING", services: valid.map(s => ({ id: s.id, name: s.name })) })
      return { shownToCustomer: true, services: valid.map(s => s.name), requiresSignIn: ctx.scope !== "CUSTOMER" }
    },
  },

  get_business_metrics: {
    scopes: ["ADMIN"],
    definition: {
      name: "get_business_metrics",
      description:
        "Aggregated business metrics for a period (salon local time): bookings by status, no-show and cancellation rates, revenue collected and refunded by payment mode, top services, new customers, and feedback (average rating, count, unresolved complaints). Aggregates only - no customer details.",
      input_schema: {
        type: "object",
        properties: { period: { type: "string", enum: ["today", "7d", "30d"] } },
        required: ["period"],
        additionalProperties: false,
      },
      strict: true,
    },
    async run(_ctx, input) {
      const period = ["today", "7d", "30d"].includes(input?.period) ? input.period : "7d"
      const start = periodStartSql(period)
      const end = `${SALON_TODAY_START_SQL} + interval '1 day'`
      const [statusRows, revenueRows, topRows, newCustomerRows, feedbackRows] = await Promise.all([
        pool.query(`SELECT status, COUNT(*)::INT AS count FROM bookings WHERE starts_at >= ${start} AND starts_at < ${end} GROUP BY status`),
        pool.query(`
          SELECT payment_mode,
            COALESCE(SUM(amount) FILTER (WHERE source_type IN ('BOOKING','WALKIN')), 0)::numeric AS collected,
            COALESCE(SUM(amount) FILTER (WHERE source_type = 'REFUND'), 0)::numeric AS refunded
          FROM payment_transactions WHERE collected_at >= ${start} AND collected_at < ${end}
          GROUP BY payment_mode`),
        pool.query(`
          SELECT COALESCE(item->>'name', b.service_name) AS service, COUNT(*)::INT AS count
          FROM bookings b
          LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(b.service_items_json) > 0 THEN b.service_items_json ELSE '[null]'::jsonb END) AS item ON TRUE
          WHERE b.starts_at >= ${start} AND b.starts_at < ${end} AND b.status NOT IN ('CANCELLED')
          GROUP BY 1 ORDER BY 2 DESC LIMIT 5`),
        pool.query(`SELECT COUNT(*)::INT AS count FROM users WHERE role = 'USER' AND created_at >= ${start}`),
        pool
          .query(
            `SELECT COUNT(*)::INT AS count, ROUND(AVG(rating)::numeric, 2) AS avg_rating,
               COUNT(*) FILTER (WHERE resolved_at IS NULL AND COALESCE(type, '') ILIKE '%complaint%')::INT AS open_complaints
             FROM feedback WHERE created_at >= ${start}`
          )
          .catch(() => ({ rows: [] })),
      ])
      const byStatus = Object.fromEntries(statusRows.rows.map(row => [row.status, row.count]))
      const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0)
      const rate = n => (total ? Math.round((n / total) * 1000) / 10 : 0)
      const collected = revenueRows.rows.reduce((sum, row) => sum + Number(row.collected), 0)
      const refunded = revenueRows.rows.reduce((sum, row) => sum + Number(row.refunded), 0)
      const feedback = feedbackRows.rows[0]
      return {
        period,
        timezone: SALON_TIMEZONE,
        bookings: { total, byStatus, noShowRatePercent: rate(byStatus["NO-SHOW"] ?? 0), cancellationRatePercent: rate(byStatus.CANCELLED ?? 0) },
        revenueInr: {
          collected: roundMoney(collected),
          refunded: roundMoney(refunded),
          net: roundMoney(collected - refunded),
          byMode: revenueRows.rows.map(row => ({ mode: row.payment_mode, collected: roundMoney(row.collected), refunded: roundMoney(row.refunded) })),
        },
        topServices: topRows.rows.filter(row => row.service),
        newCustomers: newCustomerRows.rows[0]?.count ?? 0,
        feedback: feedback ? { count: feedback.count, averageRating: feedback.avg_rating === null ? null : Number(feedback.avg_rating), openComplaints: feedback.open_complaints } : null,
      }
    },
  },

  get_catalog_health: {
    scopes: ["ADMIN"],
    definition: {
      name: "get_catalog_health",
      description:
        "Lists gaps in the service catalog that hurt customers: services without photos, without a description, or without detail sections (benefits, precautions, aftercare, etc.), and whether the business profile is missing contact fields.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
    },
    async run() {
      const services = await listServiceCatalog()
      const info = await getPublicBusinessInfo()
      return {
        activeServices: services.length,
        withoutPhoto: services.filter(s => !s.images?.length).map(s => s.name),
        withoutDescription: services.filter(s => !s.description).map(s => s.name),
        withoutDetailSections: services.filter(s => !Object.keys(s.details ?? {}).length).map(s => s.name),
        businessProfileMissing: info.missingFields,
      }
    },
  },
}

/** Tool definitions an agent may offer for a given caller scope. */
export function toolDefinitionsFor(toolNames, scope) {
  return toolNames.filter(name => TOOLS[name]?.scopes.includes(scope)).map(name => TOOLS[name].definition)
}

const MAX_TOOL_RESULT_CHARS = 12_000

/**
 * Runs a tool call from the model after re-checking the agent allow-list and the caller scope.
 * Errors become `is_error` tool results (the model is told, the request does not fail).
 */
export async function executeTool({ agent, ctx, name, input }) {
  const tool = TOOLS[name]
  if (!tool || !agent.tools.includes(name) || !tool.scopes.includes(ctx.scope)) {
    return { content: JSON.stringify({ error: "This tool is not available here." }), isError: true }
  }
  try {
    const result = await tool.run(ctx, input ?? {})
    let text = JSON.stringify(result)
    if (text.length > MAX_TOOL_RESULT_CHARS) text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)`
    return { content: text, isError: Boolean(result?.error) }
  } catch (error) {
    console.error("agent_tool_failed", { tool: name, message: error instanceof Error ? error.message : error })
    return { content: JSON.stringify({ error: "The tool failed. Tell the user you could not look this up right now." }), isError: true }
  }
}

/**
 * Variant and member pricing for the service catalog.
 *
 * A catalog service has one list price (`basePrice`) and an optional member price
 * (`memberPrice`). A service sold in sizes/lengths/areas carries `variants`
 * ({name, price, memberPrice, duration}); `basePrice` is then the lowest variant price shown
 * as "from". `memberPrice` null means the menu printed "NA" - not free.
 */

/** Membership tiers charged the member rate. BASIC rates are not published yet. */
export const MEMBER_PRICE_SEGMENTS = ["PREMIUM"]

function badRequest(message) {
  return Object.assign(new Error(message), { code: "BAD_REQUEST" })
}

export function isMemberPriceSegment(segment) {
  return MEMBER_PRICE_SEGMENTS.includes(`${segment ?? ""}`.trim().toUpperCase())
}

/** Accepts `{serviceId: variantName}` or its JSON string (query-string form). */
export function parseVariantSelections(input) {
  let value = input
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return {}
    try {
      value = JSON.parse(text)
    } catch {
      throw badRequest("variantSelections must be valid JSON")
    }
  }
  if (value == null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw badRequest("variantSelections must be an object")
  const out = {}
  for (const [id, name] of Object.entries(value)) {
    const key = `${id}`.trim()
    const label = `${name ?? ""}`.trim()
    if (key && label) out[key] = label
  }
  return out
}

/** Validates admin-entered variants; price/memberPrice/duration are normalised numbers (or null). */
export function normalizeVariants(raw, { defaultDuration = 30 } = {}) {
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set()
  return list.map(item => {
    const name = `${item?.name ?? ""}`.trim()
    const price = Number(item?.price ?? 0)
    const memberRaw = item?.memberPrice
    const memberPrice = memberRaw === null || memberRaw === undefined || `${memberRaw}`.trim() === "" ? null : Number(memberRaw)
    const durationRaw = item?.duration
    const duration = durationRaw === null || durationRaw === undefined || `${durationRaw}`.trim() === "" ? defaultDuration : Number(durationRaw)
    if (!name) throw badRequest("Variant name is required")
    if (seen.has(name.toLowerCase())) throw badRequest(`Variant "${name}" is listed twice`)
    seen.add(name.toLowerCase())
    if (!Number.isFinite(price) || price <= 0) throw badRequest("Variant price must be greater than 0")
    if (memberPrice !== null && (!Number.isFinite(memberPrice) || memberPrice <= 0)) {
      throw badRequest("Variant member price must be greater than 0, or left empty")
    }
    if (!Number.isFinite(duration) || duration < 10 || duration > 480) {
      throw badRequest("Variant duration must be between 10 and 480 minutes")
    }
    return { name, price, memberPrice, duration }
  })
}

/**
 * Returns the catalog with every service in `serviceIds` priced for this booking: the chosen
 * variant (required when the service has variants and `strict`), and the member rate for member
 * tiers. Selected entries get the final `basePrice`, `duration` and a display `name`; the rest of
 * the catalog is returned untouched so downstream offer logic keeps working unchanged.
 */
export function priceCatalogForBooking({ catalog, serviceIds, selections, membershipSegment, strict = true }) {
  const wanted = new Set(serviceIds)
  const useMemberRate = isMemberPriceSegment(membershipSegment)
  return catalog.map(service => {
    if (!wanted.has(service.id)) return service
    const variants = Array.isArray(service.variants) ? service.variants.filter(v => v?.name) : []
    let listPrice = Number(service.basePrice ?? 0)
    let memberPrice = service.memberPrice == null ? null : Number(service.memberPrice)
    let duration = Number(service.duration ?? service.durationMinutes ?? 0)
    let name = service.name
    let variantName = null
    if (variants.length) {
      const chosen = `${selections?.[service.id] ?? ""}`.trim().toLowerCase()
      const variant = chosen ? variants.find(v => `${v.name}`.trim().toLowerCase() === chosen) : null
      if (chosen && !variant) throw badRequest(`"${selections[service.id]}" is not an option for ${service.name}`)
      if (variant) {
        listPrice = Number(variant.price)
        memberPrice = variant.memberPrice == null ? null : Number(variant.memberPrice)
        if (Number(variant.duration) > 0) duration = Number(variant.duration)
        name = `${service.name} (${variant.name})`
        variantName = variant.name
      } else if (strict) {
        throw badRequest(`Choose an option for ${service.name}`)
      } else {
        listPrice = Math.min(...variants.map(v => Number(v.price)))
      }
    }
    const price = useMemberRate && memberPrice != null && memberPrice > 0 ? memberPrice : listPrice
    return { ...service, name, basePrice: price, duration, variantName, listPrice }
  })
}

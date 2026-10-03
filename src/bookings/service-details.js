/**
 * Long-form service information shown on the customer "service details" view and used by the
 * support assistant. Stored as `service_catalog.details_json` (text sections) and
 * `service_catalog.gallery_json` (extra photo URLs). Every section is optional: the UI hides
 * an empty one rather than inventing content.
 */

/** Section key -> max characters. Order here is the display order. */
export const SERVICE_DETAIL_SECTIONS = {
  overview: 1500, // what the service is
  benefits: 1500, // why it is useful
  suitableFor: 1000, // who it suits
  notRecommendedFor: 1000, // who should avoid it
  precautions: 1500, // important precautions / requirements
  expectedResult: 1000, // expected experience / result
  preparation: 1000, // before the appointment
  aftercare: 1500, // after the appointment
}

export const MAX_GALLERY_IMAGES = 8

function badRequest(message) {
  return Object.assign(new Error(message), { code: "BAD_REQUEST" })
}

/** Accepts only absolute https URLs (service photos come from Cloudinary or another https CDN). */
export function normalizeImageUrl(value, label = "Image URL") {
  const text = `${value ?? ""}`.trim()
  if (!text) return ""
  let url
  try {
    url = new URL(text)
  } catch {
    throw badRequest(`${label} must be a full https:// link`)
  }
  if (url.protocol !== "https:") throw badRequest(`${label} must use https://`)
  if (url.toString().length > 1000) throw badRequest(`${label} is too long`)
  return url.toString()
}

/** @returns {Record<string, string>} only non-empty sections */
export function normalizeServiceDetails(input) {
  if (input == null) return {}
  if (typeof input !== "object" || Array.isArray(input)) throw badRequest("Service details must be an object")
  const details = {}
  for (const [key, max] of Object.entries(SERVICE_DETAIL_SECTIONS)) {
    const text = `${input[key] ?? ""}`.trim()
    if (!text) continue
    if (text.length > max) throw badRequest(`"${key}" is longer than ${max} characters`)
    details[key] = text
  }
  return details
}

/** De-duplicated list of https photo URLs, at most MAX_GALLERY_IMAGES. */
export function normalizeGallery(input) {
  if (input == null) return []
  if (!Array.isArray(input)) throw badRequest("Gallery must be a list of image URLs")
  const seen = new Set()
  const out = []
  for (const item of input) {
    const url = normalizeImageUrl(item, "Gallery image")
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  if (out.length > MAX_GALLERY_IMAGES) throw badRequest(`At most ${MAX_GALLERY_IMAGES} gallery photos`)
  return out
}

/** Primary image first, then gallery photos, without duplicates. */
export function buildServiceImageList(primary, gallery) {
  const list = []
  for (const url of [primary, ...(Array.isArray(gallery) ? gallery : [])]) {
    if (typeof url === "string" && url && !list.includes(url)) list.push(url)
  }
  return list
}

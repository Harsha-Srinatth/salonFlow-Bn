import { listServiceCatalog } from "../bookings/repository.js"
import { getPublicBusinessInfo } from "../business/service.js"
import { rankServices } from "./tools.js"

/**
 * "Basic mode" for the support assistant: answers straight from the database with simple
 * intent rules when the language model is not configured, is rate-limited or fails. It can only
 * repeat stored facts (hours, contact, policy, catalog, FAQ), so it cannot invent anything; for
 * anything it does not recognise it says so and points to the salon's contact details.
 */

const rupees = value => `₹${Math.round(Number(value) || 0).toLocaleString("en-IN")}`

function contactLines(profile) {
  const lines = []
  if (profile.phone) lines.push(`Phone: ${profile.phone}`)
  if (profile.whatsapp) lines.push(`WhatsApp: ${profile.whatsapp}`)
  if (profile.supportEmail) lines.push(`Email: ${profile.supportEmail}`)
  return lines
}

function addressLine(profile) {
  return [profile.addressLine1, profile.addressLine2, profile.city, profile.state, profile.postalCode].filter(Boolean).join(", ")
}

function contactFallback(profile) {
  const lines = contactLines(profile)
  return lines.length
    ? `I don't have that information. Please contact the salon directly:\n${lines.join("\n")}`
    : "I don't have that information, and the salon's contact details haven't been published yet. Please ask at the reception desk."
}

const words = text => new Set(`${text}`.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2))

function bestFaqMatch(faq, question) {
  const asked = words(question)
  let best = null
  for (const item of faq ?? []) {
    const qWords = words(item.question)
    let overlap = 0
    for (const w of qWords) if (asked.has(w)) overlap += 1
    const score = qWords.size ? overlap / qWords.size : 0
    if (overlap >= 2 && score >= 0.5 && (!best || score > best.score)) best = { item, score }
  }
  return best?.item ?? null
}

export async function answerWithoutModel(question) {
  const text = `${question ?? ""}`.toLowerCase()
  const info = await getPublicBusinessInfo()
  const { profile, hours, cancellationPolicy } = info

  const faq = bestFaqMatch(profile.faq, text)
  if (faq) return faq.answer

  if (/\b(hours?|timings?|time|open|opens|close|closes|closing|opening|lunch)\b/.test(text) && !/\b(slot|available|availability|book)\b/.test(text)) {
    return `We're open ${hours.days.toLowerCase()} from ${hours.opens} to ${hours.closes}, with a lunch break from ${hours.lunchBreak.from} to ${hours.lunchBreak.to}. ${hours.bookingWindow}`
  }
  if (/\b(cancel|cancell?ation|refunds?|reschedul)/.test(text)) {
    return `Cancellation and refunds:\n${cancellationPolicy.map(rule => `• ${rule.when}: ${rule.refund}`).join("\n")}\nYou can cancel from Bookings > History; the exact refund is shown before you confirm.`
  }
  if (/\b(where|address|location|located|directions?|map)\b/.test(text)) {
    const address = addressLine(profile)
    if (address) return `${profile.businessName || "We"} ${profile.businessName ? "is" : "are"} at ${address}.${profile.mapsUrl ? `\nMap: ${profile.mapsUrl}` : ""}`
    return contactFallback(profile)
  }
  if (/\b(contact|phone|call|number|e-?mail|mail|whatsapp|reach)\b/.test(text)) {
    const lines = contactLines(profile)
    return lines.length ? `You can reach us here:\n${lines.join("\n")}` : contactFallback(profile)
  }
  if (/\b(my|upcoming|next)\b.*\b(bookings?|appointments?|visit)\b/.test(text)) {
    return "You can see all your bookings, cancel one (with the refund shown before you confirm) or download an invoice under Bookings > History in the app."
  }
  if (/\b(pay|payment|upi|card|cash)\b/.test(text) && profile.paymentPolicy) return profile.paymentPolicy
  if (/\b(late|delay)\b/.test(text) && profile.lateArrivalPolicy) return profile.lateArrivalPolicy

  const services = await listServiceCatalog()
  const matches = rankServices(services, text, { requireNameMatch: true }).slice(0, 4)
  if (matches.length) {
    const lines = matches.map(s => `• ${s.name}: ${rupees(s.basePrice)}, about ${s.duration} min${s.description ? ` — ${s.description.slice(0, 120)}` : ""}`)
    return `Here's what I found in our service menu (listed prices; any active offers are applied when you book):\n${lines.join("\n")}`
  }
  // "Do you do X?" with no catalog match: say it isn't on the menu rather than listing everything.
  if (/\b(do you (do|have|offer|provide)|is there|can i get)\b/.test(text) && !/\bservices\b/.test(text)) {
    const lines = contactLines(profile)
    return `I couldn't find that in our current service menu.${lines.length ? ` To check whether it can be arranged, contact the salon:\n${lines.join("\n")}` : " Please ask at the reception desk."}`
  }
  if (/\b(service|services|menu|offer|price|cost|rate)\b/.test(text)) {
    const categories = Array.from(new Set(services.map(s => `${s.category}`.toLowerCase()))).join(", ")
    return categories
      ? `We offer ${services.length} services across: ${categories}. Ask me about any of them, e.g. "How much is a haircut?"`
      : "Our service menu isn't available right now."
  }
  return contactFallback(profile)
}

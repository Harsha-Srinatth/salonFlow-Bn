#!/usr/bin/env node
/**
 * Read-only WhatsApp configuration check. Sends NO messages and changes nothing in Meta.
 *
 *   node scripts/whatsapp-check.mjs
 *
 * 1. Validates the WHATSAPP_* environment (same rules the server enforces).
 * 2. Reads the phone number (GET /{phone-number-id}): display number, verified name,
 *    quality rating, platform type, name status.
 * 3. Lists the WABA's templates (GET /{waba-id}/message_templates) and checks every
 *    configured WHATSAPP_TEMPLATE_* name: exists, APPROVED in the configured language,
 *    right category, and body has the number of {{n}} parameters the code sends.
 *
 * Secrets are never printed.
 */
import "dotenv/config"
import { TEMPLATE_KEYS, validateWhatsAppConfig, whatsappConfig } from "../src/whatsapp/config.js"
import { graphGet } from "../src/whatsapp/client.js"

const EXPECTED = {
  [TEMPLATE_KEYS.OTP]: { category: "AUTHENTICATION", params: 1 },
  [TEMPLATE_KEYS.WELCOME]: { category: "UTILITY", params: 1, alsoAllowed: ["MARKETING"] },
  [TEMPLATE_KEYS.BOOKING_CONFIRMED]: { category: "UTILITY", params: 7 },
  [TEMPLATE_KEYS.BOOKING_RESCHEDULED]: { category: "UTILITY", params: 7 },
  [TEMPLATE_KEYS.APPOINTMENT_REMINDER]: { category: "UTILITY", params: 7 },
  [TEMPLATE_KEYS.BOOKING_CANCELLED]: { category: "UTILITY", params: 6 },
  [TEMPLATE_KEYS.OFFER]: { category: "MARKETING", params: 3 },
}

const config = whatsappConfig()
let failures = 0
const ok = message => console.log(`  ok    ${message}`)
const bad = message => {
  failures += 1
  console.log(`  FAIL  ${message}`)
}
const info = message => console.log(`  info  ${message}`)

console.log("Environment")
const problems = validateWhatsAppConfig(config)
if (!config.enabled) info("WHATSAPP_ENABLED is not true: the server will not send anything")
for (const problem of problems) bad(problem)
if (!problems.length) ok(`configuration valid (Graph ${config.apiVersion})`)

if (!config.accessToken || !config.phoneNumberId) {
  console.log("\nSet WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID to check Meta.")
  process.exit(failures ? 1 : 0)
}

const live = { ...config, enabled: true }

console.log("\nPhone number")
try {
  const phone = await graphGet(
    `${config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,platform_type,name_status,code_verification_status,throughput`,
    live
  )
  ok(`${phone.display_phone_number} "${phone.verified_name}"`)
  info(`platform_type=${phone.platform_type ?? "?"} quality=${phone.quality_rating ?? "?"} name_status=${phone.name_status ?? "?"} throughput=${phone.throughput?.level ?? "?"}`)
  if (phone.platform_type && phone.platform_type !== "CLOUD_API") bad("number is not registered on Cloud API (platform_type should be CLOUD_API)")
} catch (error) {
  bad(`could not read the phone number: ${error.message}`)
}

console.log("\nTemplates")
if (!config.businessAccountId) {
  info("WHATSAPP_BUSINESS_ACCOUNT_ID not set: skipping template check")
} else {
  try {
    const templates = []
    let path = `${config.businessAccountId}/message_templates?fields=name,language,status,category,components&limit=200`
    for (let page = 0; path && page < 10; page += 1) {
      const result = await graphGet(path, live)
      templates.push(...(result.data ?? []))
      const next = result.paging?.next
      path = next ? next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, "") : null
    }
    info(`${templates.length} template(s) in the account`)
    for (const [key, expected] of Object.entries(EXPECTED)) {
      const configured = config.templates[key]
      if (!configured) {
        info(`WHATSAPP_TEMPLATE_${key} not set: this message type is switched off`)
        continue
      }
      const match = templates.find(t => t.name === configured.name && t.language === configured.language)
      if (!match) {
        const other = templates.filter(t => t.name === configured.name).map(t => t.language)
        bad(`${key}: "${configured.name}" (${configured.language}) not found${other.length ? `; exists in ${other.join(", ")}` : ""}`)
        continue
      }
      if (match.status !== "APPROVED") bad(`${key}: "${configured.name}" status is ${match.status}`)
      const categories = [expected.category, ...(expected.alsoAllowed ?? [])]
      if (!categories.includes(match.category)) bad(`${key}: category is ${match.category}, expected ${categories.join(" or ")}`)
      const body = (match.components ?? []).find(c => c.type === "BODY")
      const params = new Set(`${body?.text ?? ""}`.match(/\{\{\d+\}\}/g) ?? []).size
      if (params !== expected.params) bad(`${key}: body has ${params} parameter(s), the code sends ${expected.params}`)
      if (match.status === "APPROVED" && categories.includes(match.category) && params === expected.params) {
        ok(`${key}: "${configured.name}" (${configured.language}) approved`)
      }
    }
  } catch (error) {
    bad(`could not list templates: ${error.message}`)
  }
}

console.log(failures ? `\n${failures} problem(s) found.` : "\nAll checks passed.")
process.exit(failures ? 1 : 0)

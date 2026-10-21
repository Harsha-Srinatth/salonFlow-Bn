/**
 * Minimal client for Meta's WhatsApp Cloud API (Graph API `/{phone-number-id}/messages`).
 *
 * Plain `fetch`, no SDK: the API surface used here is two endpoints, and an SDK would add a
 * dependency without removing any of the error handling below.
 *
 * A 200 from Meta means "accepted for delivery", not "delivered". Delivery, read and late
 * failure arrive later on the webhook (see `webhook.js`), which is what moves a message
 * past SENT.
 */
import { whatsappConfig, isWhatsAppSendingAvailable, validateWhatsAppConfig } from "./config.js"
import { toWaRecipient } from "./phone.js"

/**
 * Meta error codes that will not succeed on retry. Anything not listed is treated as
 * transient only when the HTTP status or code says so (see `classifyGraphError`).
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const PERMANENT_CODES = new Set([
  100, // invalid parameter
  131008, // required parameter missing
  131009, // parameter value not valid
  131021, // recipient cannot be sender
  131026, // message undeliverable (number not on WhatsApp, old app, or not accepted terms)
  131030, // recipient not in allowed list (test number)
  131045, // phone number not registered / certificate
  131047, // re-engagement: more than 24h since last customer message (free-form text)
  131050, // user stopped marketing messages
  131051, // unsupported message type
  131052, // media download error
  132000, // template parameter count mismatch
  132001, // template does not exist / not approved in this language
  132005, // translated text too long
  132007, // template format character policy violated
  132012, // parameter format mismatch
  132015, // template paused
  132016, // template disabled
  133010, // phone number not registered on Cloud API
])

/** Codes that mean our credentials or account are broken: retrying only burns attempts. */
const CONFIGURATION_CODES = new Set([
  0, // AuthException
  3, // capability / permission
  10, // permission denied
  190, // access token expired or invalid
  200, // permission error
  131031, // business account locked
  131042, // business eligibility / payment issue
  131048, // spam rate limit (account quality)
  368, // temporarily blocked for policy violations
])

const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131056, 131049])

export class WhatsAppApiError extends Error {
  /**
   * @param {string} message safe to log: never contains the token or message contents
   * @param {{ code?: number|string, httpStatus?: number, retryable: boolean, kind: string, retryAfterMs?: number, details?: string }} info
   */
  constructor(message, info) {
    super(message)
    this.name = "WhatsAppApiError"
    this.code = info.code ?? null
    this.httpStatus = info.httpStatus ?? null
    this.retryable = info.retryable
    this.kind = info.kind
    this.retryAfterMs = info.retryAfterMs ?? null
    this.details = info.details ?? null
  }
}

/**
 * Turns a Graph API error response into retry guidance.
 *
 * @param {number} httpStatus
 * @param {any} body parsed response body
 * @param {Headers} [headers]
 */
export function classifyGraphError(httpStatus, body, headers) {
  const error = body?.error ?? {}
  const code = Number.isFinite(Number(error.code)) ? Number(error.code) : null
  const title = `${error.error_user_title ?? error.type ?? "GraphError"}`.slice(0, 120)
  const details = `${error.error_data?.details ?? error.message ?? ""}`.slice(0, 300)
  const retryAfterHeader = Number(headers?.get?.("retry-after"))
  const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : null
  const message = `WhatsApp API ${httpStatus}${code !== null ? ` code ${code}` : ""}: ${title}`
  if (code !== null && RATE_LIMIT_CODES.has(code)) {
    return new WhatsAppApiError(message, { code, httpStatus, retryable: true, kind: "RATE_LIMITED", retryAfterMs, details })
  }
  if (code !== null && CONFIGURATION_CODES.has(code)) {
    return new WhatsAppApiError(message, { code, httpStatus, retryable: false, kind: "CONFIGURATION", details })
  }
  if (code !== null && PERMANENT_CODES.has(code)) {
    return new WhatsAppApiError(message, { code, httpStatus, retryable: false, kind: "PERMANENT", details })
  }
  if (httpStatus === 429) {
    return new WhatsAppApiError(message, { code, httpStatus, retryable: true, kind: "RATE_LIMITED", retryAfterMs, details })
  }
  if (httpStatus >= 500 || code === 1 || code === 2 || code === 131000 || code === 131016) {
    return new WhatsAppApiError(message, { code, httpStatus, retryable: true, kind: "TRANSIENT", retryAfterMs, details })
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return new WhatsAppApiError(message, { code, httpStatus, retryable: false, kind: "CONFIGURATION", details })
  }
  return new WhatsAppApiError(message, { code, httpStatus, retryable: false, kind: "PERMANENT", details })
}

let fetchImpl = (...args) => globalThis.fetch(...args)

/** Test hook: replace the HTTP transport. Returns a function that restores the real one. */
export function setWhatsAppFetchForTests(replacement) {
  const previous = fetchImpl
  fetchImpl = replacement
  return () => {
    fetchImpl = previous
  }
}

async function graphRequest(method, path, { body, config = whatsappConfig() } = {}) {
  const url = `${config.graphBaseUrl}/${config.apiVersion}/${path}`
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    })
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError"
    // Ambiguous for a send: Meta may have accepted the message before the connection
    // dropped. Retrying risks one duplicate; not retrying risks a lost notification.
    // The outbox retries (bounded), which is the better trade for reminders/confirmations.
    throw new WhatsAppApiError(timedOut ? "WhatsApp API request timed out" : "WhatsApp API unreachable", {
      retryable: true,
      kind: timedOut ? "TIMEOUT" : "NETWORK",
    })
  }
  const textBody = await response.text().catch(() => "")
  let parsed = {}
  try {
    parsed = textBody ? JSON.parse(textBody) : {}
  } catch {
    parsed = {}
  }
  if (!response.ok || parsed?.error) throw classifyGraphError(response.status, parsed, response.headers)
  return parsed
}

function assertSendable(config) {
  if (!config.enabled) {
    throw new WhatsAppApiError("WhatsApp is disabled (WHATSAPP_ENABLED is not true)", { retryable: false, kind: "DISABLED" })
  }
  if (!isWhatsAppSendingAvailable(config)) {
    throw new WhatsAppApiError(`WhatsApp is not configured: ${validateWhatsAppConfig(config).join("; ")}`, {
      retryable: false,
      kind: "NOT_CONFIGURED",
    })
  }
}

function readMessageId(response) {
  const id = response?.messages?.[0]?.id
  if (typeof id !== "string" || !id) {
    // A 200 without a message id is not proof of anything; do not record it as sent.
    throw new WhatsAppApiError("WhatsApp API returned no message id", { retryable: true, kind: "TRANSIENT" })
  }
  return { messageId: id, waId: response?.contacts?.[0]?.wa_id ?? null }
}

/**
 * Sends an approved template.
 *
 * @param {{ to: string, name: string, language: string, components?: object[] }} message `to` in E.164
 * @returns {Promise<{ messageId: string, waId: string | null }>}
 */
export async function sendTemplateMessage({ to, name, language, components = [] }, config = whatsappConfig()) {
  assertSendable(config)
  const response = await graphRequest("POST", `${config.phoneNumberId}/messages`, {
    config,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toWaRecipient(to),
      type: "template",
      template: { name, language: { code: language }, ...(components.length ? { components } : {}) },
    },
  })
  return readMessageId(response)
}

/**
 * Sends free-form text. Only allowed inside the 24-hour customer service window (i.e. as a
 * reply to a message the customer sent); used for the opt-out acknowledgement.
 */
export async function sendTextMessage({ to, body }, config = whatsappConfig()) {
  assertSendable(config)
  const response = await graphRequest("POST", `${config.phoneNumberId}/messages`, {
    config,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toWaRecipient(to),
      type: "text",
      text: { preview_url: false, body },
    },
  })
  return readMessageId(response)
}

/** Read-only Graph GET, used by the configuration check script. */
export async function graphGet(path, config = whatsappConfig()) {
  return graphRequest("GET", path, { config })
}

/** Body + copy-code button parameters for an AUTHENTICATION template (the code goes in twice). */
export function authenticationTemplateComponents(code) {
  return [
    { type: "body", parameters: [{ type: "text", text: code }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
  ]
}

/** Positional body parameters, `{{1}}..{{n}}`. Empty values are sent as "-" (Meta rejects blanks). */
export function bodyComponents(values) {
  return [
    {
      type: "body",
      parameters: values.map(value => ({ type: "text", text: `${value ?? ""}`.trim().slice(0, 1000) || "-" })),
    },
  ]
}

/**
 * Minimal MSG91 client (Flow API). This is the only file that knows the provider: moving to
 * another DLT-registered SMS company means replacing `sendReminderSms`.
 *
 * Success here means MSG91 accepted the message, not that the phone received it.
 */
import { smsConfig, isSmsAvailable, validateSmsConfig } from "./config.js"

export class SmsApiError extends Error {
  /** @param {string} message safe to log @param {{ retryable: boolean, kind: string, status?: number }} info */
  constructor(message, info) {
    super(message)
    this.name = "SmsApiError"
    this.retryable = info.retryable
    this.kind = info.kind
    this.status = info.status ?? null
  }
}

let fetchImpl = (...args) => globalThis.fetch(...args)

/** Test hook: replace the HTTP transport. Returns a function that restores the real one. */
export function setSmsFetchForTests(replacement) {
  const previous = fetchImpl
  fetchImpl = replacement
  return () => {
    fetchImpl = previous
  }
}

/**
 * Sends the approved reminder template.
 *
 * @param {{ to: string, variables: string[] }} message `to` is "91XXXXXXXXXX"; variables fill VAR1..VARn
 * @returns {Promise<{ messageId: string | null }>}
 */
export async function sendReminderSms({ to, variables }, config = smsConfig()) {
  if (!isSmsAvailable(config)) {
    const detail = config.enabled ? validateSmsConfig(config).join("; ") : "SMS_ENABLED is not true"
    throw new SmsApiError(`SMS is not available: ${detail}`, { retryable: false, kind: "NOT_CONFIGURED" })
  }
  const body = { template_id: config.reminderTemplateId, short_url: "0", mobiles: to }
  variables.forEach((value, index) => {
    body[`VAR${index + 1}`] = value
  })
  let response
  try {
    response = await fetchImpl(config.apiUrl, {
      method: "POST",
      headers: { authkey: config.authKey, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    })
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError"
    throw new SmsApiError(timedOut ? "SMS API request timed out" : "SMS API unreachable", { retryable: true, kind: timedOut ? "TIMEOUT" : "NETWORK" })
  }
  const parsed = await response.json().catch(() => ({}))
  const status = response.status
  if (status === 429 || status >= 500) throw new SmsApiError(`SMS API ${status}`, { retryable: true, kind: "TRANSIENT", status })
  if (status === 401 || status === 403) throw new SmsApiError(`SMS API ${status}: check MSG91_AUTH_KEY`, { retryable: false, kind: "CONFIGURATION", status })
  // MSG91 can answer 200 with { type: "error" }; only an explicit success counts as sent.
  if (!response.ok || parsed?.type !== "success") {
    throw new SmsApiError(`SMS API rejected the message (${status}): ${`${parsed?.message ?? "no details"}`.slice(0, 200)}`, { retryable: false, kind: "REJECTED", status })
  }
  return { messageId: typeof parsed.message === "string" ? parsed.message.slice(0, 128) : null }
}

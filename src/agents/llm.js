import Anthropic from "@anthropic-ai/sdk"

/**
 * One shared Claude client for every agent. The API key lives only in the backend environment
 * (ANTHROPIC_API_KEY); the browser never talks to the model directly and never sees the key.
 *
 * Without a key the agents still run: the support assistant answers from the database with
 * deterministic rules (agents/fallback.js) and the admin agents report "not configured".
 */

export const AGENT_MODEL = `${process.env.ASSISTANT_MODEL ?? "claude-opus-5-5"}`.trim() || "claude-opus-5-5"

let client = null

export function isLlmConfigured() {
  return Boolean(`${process.env.ANTHROPIC_API_KEY ?? ""}`.trim()) && process.env.ASSISTANT_LLM_DISABLED !== "true"
}

export function getLlmClient() {
  if (!isLlmConfigured()) return null
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // A chat turn must not hold an HTTP request (and a pool slot upstream) for minutes.
      timeout: Number(process.env.ASSISTANT_LLM_TIMEOUT_MS ?? 45_000),
      maxRetries: 1,
    })
  }
  return client
}

/**
 * One Messages API call with the project defaults: the configured model, server-side refusal
 * fallback (a declined request is retried on Anthropic's recommended fallback model inside the
 * same call), and an explicit effort level per route.
 */
export async function createMessage({ system, messages, tools, maxTokens, effort = "low", outputFormat }) {
  const llm = getLlmClient()
  if (!llm) throw Object.assign(new Error("Assistant model is not configured"), { code: "LLM_NOT_CONFIGURED" })
  const outputConfig = { effort }
  if (outputFormat) outputConfig.format = outputFormat
  return llm.beta.messages.create({
    model: AGENT_MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    system,
    messages,
    ...(tools?.length ? { tools } : {}),
    output_config: outputConfig,
  })
}

/** Maps SDK errors to a short, non-sensitive code for logs and API responses. */
export function classifyLlmError(error) {
  if (error?.code === "LLM_NOT_CONFIGURED") return "not_configured"
  if (error instanceof Anthropic.RateLimitError) return "rate_limited"
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return "auth_error"
  if (error instanceof Anthropic.BadRequestError) return "bad_request"
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "timeout"
  if (error instanceof Anthropic.APIConnectionError) return "connection_error"
  if (error instanceof Anthropic.APIError) return `api_error_${error.status ?? "unknown"}`
  return "unknown_error"
}

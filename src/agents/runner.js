import { getBusinessProfile } from "../business/service.js"
import { listServiceCatalog } from "../bookings/repository.js"
import { SERVICE_DETAIL_SECTIONS, normalizeServiceDetails } from "../bookings/service-details.js"
import { logAgentRun } from "./agent-log.js"
import { answerWithoutModel } from "./fallback.js"
import { classifyLlmError, createMessage, isLlmConfigured } from "./llm.js"
import { SERVICE_CONTENT_AGENT, getAgent } from "./registry.js"
import { executeTool, toolDefinitionsFor } from "./tools.js"

export const MAX_HISTORY_MESSAGES = 12
export const MAX_USER_MESSAGE_CHARS = 1000
const MAX_ASSISTANT_MESSAGE_CHARS = 4000

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, expose: true })
}

/** Maps the authenticated caller to an agent scope. Staff using the public assistant act as guests. */
export function scopeForUser(appUser) {
  if (!appUser) return "GUEST"
  if (appUser.role === "USER") return "CUSTOMER"
  if (appUser.role === "ADMIN") return "ADMIN"
  return "GUEST"
}

/**
 * Validates client-supplied history. The server is stateless, so history comes from the browser
 * and is untrusted: only plain text, alternating roles, bounded size. A forged "assistant" turn
 * cannot grant anything, because tools and data access are decided server-side by scope.
 */
export function sanitizeConversation(raw) {
  if (!Array.isArray(raw) || !raw.length) throw badRequest("Send at least one message")
  const recent = raw.slice(-MAX_HISTORY_MESSAGES)
  const messages = []
  for (const item of recent) {
    const role = item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : null
    const text = typeof item?.content === "string" ? item.content.trim() : ""
    if (!role || !text) continue
    const limit = role === "user" ? MAX_USER_MESSAGE_CHARS : MAX_ASSISTANT_MESSAGE_CHARS
    if (role === "user" && text.length > limit) throw badRequest(`Messages can be at most ${MAX_USER_MESSAGE_CHARS} characters`)
    const content = text.slice(0, limit)
    const last = messages[messages.length - 1]
    if (last?.role === role) last.content = `${last.content}\n\n${content}`
    else messages.push({ role, content })
  }
  while (messages.length && messages[0].role !== "user") messages.shift()
  if (!messages.length || messages[messages.length - 1].role !== "user") throw badRequest("The last message must be from the user")
  return messages
}

function textOf(content) {
  return (content ?? [])
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim()
}

async function businessNameForPrompt() {
  try {
    const { profile } = await getBusinessProfile()
    return profile.businessName || "this salon"
  } catch {
    return "this salon"
  }
}

/**
 * Runs a tool-using agent for one user turn.
 *
 * @returns {Promise<{ reply: string, actions: object[], mode: "ai" | "basic", notice?: string }>}
 */
export async function runConversationalAgent({ agentId, appUser, conversation }) {
  const agent = getAgent(agentId)
  if (!agent) throw Object.assign(new Error("Unknown agent"), { status: 404 })
  const scope = scopeForUser(appUser)
  if (!agent.scopes.includes(scope)) throw Object.assign(new Error("Forbidden"), { status: 403 })

  const messages = sanitizeConversation(conversation)
  const lastQuestion = messages[messages.length - 1].content
  const started = Date.now()
  const ctx = { scope, user: appUser, actions: [] }
  const toolsUsed = []
  let inputTokens = 0
  let outputTokens = 0
  let iterations = 0
  const log = (fields) =>
    logAgentRun({
      agentId,
      actorRole: scope,
      actorUserId: appUser?.id,
      toolsUsed,
      iterations,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - started,
      ...fields,
    })

  const basicAnswer = async (errorCode) => {
    if (agentId !== "support-assistant") {
      log({ mode: "basic", outcome: "unavailable", errorCode })
      throw Object.assign(new Error("The AI assistant is not available right now. Please try again later."), { status: 503, expose: true })
    }
    const reply = await answerWithoutModel(lastQuestion)
    log({ mode: "basic", outcome: "fallback_answered", errorCode })
    return { reply, actions: [], mode: "basic" }
  }

  if (!isLlmConfigured()) return basicAnswer("not_configured")

  const businessName = await businessNameForPrompt()
  const system = [
    { type: "text", text: agent.system(businessName) },
    { type: "text", text: agent.scopeNote?.[scope] ?? "" },
  ].filter(block => block.text)
  const tools = toolDefinitionsFor(agent.tools, scope)
  const working = messages.map(m => ({ role: m.role, content: m.content }))

  try {
    while (iterations < agent.maxIterations) {
      iterations += 1
      const response = await createMessage({ system, messages: working, tools, maxTokens: agent.maxTokens, effort: agent.effort })
      inputTokens += Number(response.usage?.input_tokens ?? 0) + Number(response.usage?.cache_read_input_tokens ?? 0)
      outputTokens += Number(response.usage?.output_tokens ?? 0)

      if (response.stop_reason === "refusal") {
        log({ mode: "ai", outcome: "refused" })
        return { reply: "Sorry, I can't help with that. I can answer questions about our services, prices, timings and policies.", actions: [], mode: "ai" }
      }
      // Append the full content unchanged (thinking blocks included) so the next call is a
      // strict continuation of this one.
      working.push({ role: "assistant", content: response.content })

      if (response.stop_reason === "pause_turn") continue
      const toolCalls = response.content.filter(block => block.type === "tool_use")
      if (response.stop_reason === "tool_use" && toolCalls.length) {
        const results = await Promise.all(
          toolCalls.map(async call => {
            toolsUsed.push(call.name)
            const result = await executeTool({ agent, ctx, name: call.name, input: call.input })
            return { type: "tool_result", tool_use_id: call.id, content: result.content, ...(result.isError ? { is_error: true } : {}) }
          })
        )
        working.push({ role: "user", content: results })
        continue
      }

      const reply = textOf(response.content)
      if (!reply) return basicAnswer(`empty_${response.stop_reason}`)
      log({ mode: "ai", outcome: "ok" })
      return { reply, actions: dedupeActions(ctx.actions), mode: "ai" }
    }
    return basicAnswer("max_iterations")
  } catch (error) {
    const code = classifyLlmError(error)
    console.error("agent_llm_failed", { agentId, code, message: error instanceof Error ? error.message : error })
    return basicAnswer(code)
  }
}

function dedupeActions(actions) {
  const seen = new Set()
  return actions.filter(action => {
    const key = JSON.stringify(action)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const SERVICE_CONTENT_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(Object.keys(SERVICE_DETAIL_SECTIONS).map(key => [key, { type: "string" }])),
  required: Object.keys(SERVICE_DETAIL_SECTIONS),
  additionalProperties: false,
}

/**
 * Service-content drafter: proposes detail sections for one service. The admin reviews and edits
 * the draft in the form and must press Save; nothing is written here.
 */
export async function draftServiceContent({ serviceId, appUser, instructions }) {
  if (scopeForUser(appUser) !== "ADMIN") throw Object.assign(new Error("Forbidden"), { status: 403 })
  const started = Date.now()
  const services = await listServiceCatalog({ includeInactive: true })
  const service = services.find(item => item.id === serviceId)
  if (!service) throw Object.assign(new Error("Service not found"), { status: 404, expose: true })
  if (!isLlmConfigured()) {
    logAgentRun({ agentId: SERVICE_CONTENT_AGENT.id, actorRole: "ADMIN", actorUserId: appUser.id, mode: "basic", outcome: "unavailable", errorCode: "not_configured", latencyMs: 0 })
    throw Object.assign(new Error("AI drafting is not configured on this server (ANTHROPIC_API_KEY is not set)."), { status: 503, expose: true })
  }
  const note = `${instructions ?? ""}`.trim().slice(0, 500)
  const businessName = await businessNameForPrompt()
  const limits = Object.entries(SERVICE_DETAIL_SECTIONS)
    .map(([key, max]) => `${key} (max ${Math.min(max, 600)} characters)`)
    .join(", ")
  const system = `You write clear, honest customer-facing descriptions of salon services for ${businessName}. The admin will review and edit your draft before anything is published.
Rules:
- Describe the service in general, widely accepted terms. Do not invent salon-specific facts: no prices, durations, brand or product names, staff names, guarantees, discounts or results that depend on the person.
- No medical claims or promises. In precautions/notRecommendedFor, mention common, conservative cautions where relevant (e.g. allergies or sensitive skin and patch tests for chemical treatments, open wounds or active skin conditions, recent procedures, pregnancy for certain treatments) and suggest consulting a doctor when in doubt.
- Each section: 1-3 short sentences or a few short lines starting with "- ". Plain text, friendly and specific to this service. Use an empty string for a section that genuinely does not apply.
- Sections: ${limits}.`
  const user = `Service: ${service.name}
Category: ${service.category}
For: ${service.gender}
Current short description: ${service.description || "(none)"}
${note ? `Admin's notes for the draft: ${note}` : ""}`
  try {
    const response = await createMessage({
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: SERVICE_CONTENT_AGENT.maxTokens,
      effort: SERVICE_CONTENT_AGENT.effort,
      outputFormat: { type: "json_schema", schema: SERVICE_CONTENT_SCHEMA },
    })
    const usage = { inputTokens: Number(response.usage?.input_tokens ?? 0), outputTokens: Number(response.usage?.output_tokens ?? 0) }
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      logAgentRun({ agentId: SERVICE_CONTENT_AGENT.id, actorRole: "ADMIN", actorUserId: appUser.id, mode: "ai", outcome: response.stop_reason, latencyMs: Date.now() - started, ...usage })
      throw Object.assign(new Error("The assistant could not draft this service. Please write the details manually."), { status: 502, expose: true })
    }
    let parsed
    try {
      parsed = JSON.parse(textOf(response.content))
    } catch {
      throw Object.assign(new Error("The assistant returned an unreadable draft. Please try again."), { status: 502, expose: true })
    }
    // Trim to the stored limits so the draft always passes the same validation as a manual edit.
    const trimmed = Object.fromEntries(Object.entries(SERVICE_DETAIL_SECTIONS).map(([key, max]) => [key, `${parsed?.[key] ?? ""}`.trim().slice(0, max)]))
    const draft = normalizeServiceDetails(trimmed)
    logAgentRun({ agentId: SERVICE_CONTENT_AGENT.id, actorRole: "ADMIN", actorUserId: appUser.id, mode: "ai", outcome: "ok", latencyMs: Date.now() - started, iterations: 1, ...usage })
    return { draft }
  } catch (error) {
    if (error?.expose) throw error
    const code = classifyLlmError(error)
    console.error("agent_llm_failed", { agentId: SERVICE_CONTENT_AGENT.id, code, message: error instanceof Error ? error.message : error })
    logAgentRun({ agentId: SERVICE_CONTENT_AGENT.id, actorRole: "ADMIN", actorUserId: appUser.id, mode: "ai", outcome: "error", errorCode: code, latencyMs: Date.now() - started })
    throw Object.assign(new Error("The AI drafting service is unavailable right now. Please try again later."), { status: 503, expose: true })
  }
}

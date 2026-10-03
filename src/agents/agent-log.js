import { v4 as uuid } from "uuid"
import { pool } from "../lib/db-pool.js"
import { createSchemaEnsurer } from "../lib/schema-guard.js"

/**
 * One row per agent run, for cost/quality monitoring and abuse investigation. Metadata only:
 * the conversation text is NOT stored (customers type phone numbers, health details, etc. into
 * chat boxes), only which agent ran, for whom, which tools it used, how long it took, the token
 * usage and the outcome.
 */
export const ensureAgentSchema = createSchemaEnsurer({
  name: "agents",
  async migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id UUID PRIMARY KEY,
        agent_id VARCHAR(64) NOT NULL,
        actor_role VARCHAR(16) NOT NULL,
        actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        mode VARCHAR(16) NOT NULL,
        outcome VARCHAR(32) NOT NULL,
        tools_used TEXT[] NOT NULL DEFAULT '{}',
        iterations INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        error_code VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS agent_runs_created_at_idx ON agent_runs (created_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS agent_runs_agent_created_idx ON agent_runs (agent_id, created_at DESC)`)
  },
})

const RETENTION_DAYS = Number(process.env.AGENT_RUN_RETENTION_DAYS ?? 90)

/** Fire-and-forget: logging must never fail or slow down the user's request. */
export function logAgentRun(entry) {
  void (async () => {
    try {
      await ensureAgentSchema()
      await pool.query(
        `
          INSERT INTO agent_runs (id, agent_id, actor_role, actor_user_id, mode, outcome, tools_used, iterations, input_tokens, output_tokens, latency_ms, error_code)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `,
        [
          uuid(),
          entry.agentId,
          entry.actorRole,
          entry.actorUserId ?? null,
          entry.mode,
          entry.outcome,
          entry.toolsUsed ?? [],
          entry.iterations ?? 0,
          entry.inputTokens ?? 0,
          entry.outputTokens ?? 0,
          Math.round(entry.latencyMs ?? 0),
          entry.errorCode ?? null,
        ]
      )
      // Cheap opportunistic retention instead of another timer.
      if (Math.random() < 0.01) {
        await pool.query(`DELETE FROM agent_runs WHERE created_at < NOW() - make_interval(days => $1)`, [RETENTION_DAYS])
      }
    } catch (error) {
      console.error("agent_run_log_failed", { message: error instanceof Error ? error.message : error })
    }
  })()
  console.log("agent_run", {
    agent: entry.agentId,
    role: entry.actorRole,
    mode: entry.mode,
    outcome: entry.outcome,
    tools: entry.toolsUsed,
    ms: Math.round(entry.latencyMs ?? 0),
    error: entry.errorCode ?? undefined,
  })
}

/** Admin overview: runs, failures and token usage per agent over the last N days. */
export async function getAgentUsageSummary({ days = 7 } = {}) {
  await ensureAgentSchema()
  const { rows } = await pool.query(
    `
      SELECT agent_id, mode,
        COUNT(*)::INT AS runs,
        COUNT(*) FILTER (WHERE outcome NOT IN ('ok', 'fallback_answered'))::INT AS problems,
        COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
        COALESCE(ROUND(AVG(latency_ms)), 0)::INT AS avg_latency_ms
      FROM agent_runs
      WHERE created_at >= NOW() - make_interval(days => $1)
      GROUP BY agent_id, mode
      ORDER BY agent_id, mode
    `,
    [days]
  )
  return rows.map(row => ({ ...row, input_tokens: Number(row.input_tokens), output_tokens: Number(row.output_tokens) }))
}

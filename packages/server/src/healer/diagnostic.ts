// ════════════════════════════════════════
// Healer Diagnostic Report Compiler
//
// Reads logs, DB state, and agent health to produce
// a structured diagnostic report for the Healer agent.
// This is engine-level — no LLM involved.
//
// v2.3.19 (error-handling-spec Phase 3) — every collector is wrapped in
// a per-collector char cap. This is the Dreamer-pattern hardening: the
// Healer must never receive a runaway diagnostic that blows its context
// window. Total cycle-message budget is enforced separately in
// healer-agent.ts:buildHealerCycleMessage.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { v4 as uuidv4 } from 'uuid';

const logger = createLogger('healer-diagnostic');

// Per-collector char caps. Source: docs/error-handling-spec.md "Healer
// log access — Dreamer-pattern hardening". Each collector's items are
// rendered to text and the rendered total is capped here. If a
// collector would emit more, the engine drops the lowest-severity items
// first (we always keep critical).
const COLLECTOR_CAPS = {
  agent_anomalies: 4000,
  error_digest: 2000,
  model_performance: 1000,
  tracker_health: 2000,
  bulletproof_health: 1500,
  nudge_stats: 500,
  budget: 500,
  context_health: 1500,
} as const;

/**
 * Cap a list of items so the rendered text stays under `maxChars`. Drops
 * lowest-severity items first (info → warning → critical). If even the
 * critical items overflow, truncates titles and details.
 */
// Exported for tests. Pure function — no DB access. See
// healer/__tests__/healer-hardening.test.ts.
export function capItemsByText(
  items: DiagnosticItem[],
  maxChars: number,
  collectorLabel: string,
): DiagnosticItem[] {
  const renderLength = (xs: DiagnosticItem[]): number =>
    xs.reduce((sum, i) => sum + i.title.length + i.detail.length + 12, 0);

  if (renderLength(items) <= maxChars) return items;

  // Sort: keep critical, then warning, then info. Truncate from the tail.
  const sevOrder: Record<DiagnosticItem['severity'], number> = {
    critical: 0, warning: 1, info: 2,
  };
  const sorted = [...items].sort(
    (a, b) => sevOrder[a.severity] - sevOrder[b.severity],
  );

  const kept: DiagnosticItem[] = [];
  let len = 0;
  let dropped = 0;
  for (const item of sorted) {
    const itemLen = item.title.length + item.detail.length + 12;
    if (len + itemLen <= maxChars) {
      kept.push(item);
      len += itemLen;
    } else {
      dropped++;
    }
  }

  if (dropped > 0) {
    logger.warn('Diagnostic collector cap fired — dropping low-severity items', {
      collector: collectorLabel,
      total: items.length,
      kept: kept.length,
      dropped,
      maxChars,
    });
  }

  return kept;
}

export interface DiagnosticItem {
  severity: 'critical' | 'warning' | 'info';
  code: string;
  title: string;
  detail: string;
  agentId?: string;
  agentName?: string;
}

export interface DiagnosticReport {
  id: string;
  timestamp: string;
  items: DiagnosticItem[];
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  reportText: string;
}

// ── Data Collectors ──

function getAgentStatusAnomalies(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  // Agents in error or paused state
  // Skip dormant agents (no activity in 7+ days) to avoid false alarms from
  // old test groups or paused projects.
  const troubled = db.prepare(`
    SELECT id, name, status, updated_at FROM agents
    WHERE status IN ('error', 'paused', 'rate_limited')
      AND status != 'terminated'
  `).all() as Array<{ id: string; name: string; status: string; updated_at: string }>;

  const DORMANT_THRESHOLD_MS = 7 * 86400000;
  for (const agent of troubled) {
    // Check if this agent is dormant (no messages in 7+ days).
    // EXCEPTION: if the agent's status was updated recently (e.g., a server
    // restart set it to error), it's a real issue even if messages are old.
    const agentUpdatedMs = new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z').getTime();
    const statusIsRecent = (Date.now() - agentUpdatedMs) < DORMANT_THRESHOLD_MS;
    if (!statusIsRecent) {
      const lastMsg = db.prepare(
        'SELECT created_at FROM messages WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
      ).get(agent.id) as { created_at: string } | undefined;
      if (lastMsg) {
        const lastTs = lastMsg.created_at.includes('Z') ? lastMsg.created_at : lastMsg.created_at + 'Z';
        if (Date.now() - new Date(lastTs).getTime() >= DORMANT_THRESHOLD_MS) continue; // dormant — skip
      } else {
        continue; // no messages at all — skip
      }
    }
    const updatedMs = new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z').getTime();
    const durationMin = Math.floor((Date.now() - updatedMs) / 60000);

    if (agent.status === 'paused') {
      const hours = Math.floor(durationMin / 60);
      const timeStr = hours > 0 ? `${hours} hour${hours > 1 ? 's' : ''}` : `${durationMin} minutes`;
      items.push({
        severity: durationMin > 60 ? 'critical' : 'warning',
        code: 'AGENT_PAUSED',
        title: `${agent.name} has been paused for ${timeStr}`,
        detail: `${agent.name} ran into repeated errors and was automatically paused to prevent further issues. The Healer can try restarting it.`,
        agentId: agent.id,
        agentName: agent.name,
      });
    } else if (agent.status === 'error') {
      const hours = Math.floor(durationMin / 60);
      const timeStr = hours > 0 ? `${hours} hour${hours > 1 ? 's' : ''}` : `${durationMin} minutes`;
      items.push({
        severity: durationMin > 30 ? 'critical' : 'warning',
        code: 'AGENT_ERROR',
        title: `${agent.name} has been in an error state for ${timeStr}`,
        detail: `Something went wrong with ${agent.name} and it stopped working. It may need to be restarted or have its conversation cleared.`,
        agentId: agent.id,
        agentName: agent.name,
      });
    } else if (agent.status === 'rate_limited') {
      items.push({
        severity: durationMin > 60 ? 'warning' : 'info',
        code: 'AGENT_RATE_LIMITED',
        title: `${agent.name} is being throttled by its AI provider`,
        detail: `${agent.name} is making too many requests and the AI service is asking it to slow down. It will automatically retry.`,
        agentId: agent.id,
        agentName: agent.name,
      });
    }
  }

  // Agents stuck in working state
  const stuck = db.prepare(`
    SELECT id, name, updated_at FROM agents
    WHERE status = 'working'
      AND updated_at < datetime('now', '-10 minutes')
  `).all() as Array<{ id: string; name: string; updated_at: string }>;

  for (const agent of stuck) {
    // Skip dormant agents (no messages in 7+ days), unless their status
    // was updated recently (e.g., server restart set them to working).
    const stuckUpdatedMs = new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z').getTime();
    const stuckStatusRecent = (Date.now() - stuckUpdatedMs) < DORMANT_THRESHOLD_MS;
    if (!stuckStatusRecent) {
      const stuckLastMsg = db.prepare(
        'SELECT created_at FROM messages WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
      ).get(agent.id) as { created_at: string } | undefined;
      if (stuckLastMsg) {
        const stuckTs = stuckLastMsg.created_at.includes('Z') ? stuckLastMsg.created_at : stuckLastMsg.created_at + 'Z';
        if (Date.now() - new Date(stuckTs).getTime() >= DORMANT_THRESHOLD_MS) continue;
      } else {
        continue;
      }
    }

    const updatedMs = new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z').getTime();
    const durationMin = Math.floor((Date.now() - updatedMs) / 60000);
    const hours = Math.floor(durationMin / 60);
    const timeStr = hours > 0 ? `${hours} hour${hours > 1 ? 's' : ''}` : `${durationMin} minutes`;
    items.push({
      severity: 'critical',
      code: 'STUCK_AGENT',
      title: `${agent.name} appears to be frozen (${timeStr})`,
      detail: `${agent.name} started working on something but never finished. It's been stuck for ${timeStr} and needs to be reset.`,
      agentId: agent.id,
      agentName: agent.name,
    });
  }

  return items;
}

function getErrorDigest(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  // Count errors per agent in last 24h from audit_log
  const errors = db.prepare(`
    SELECT agent_id, result, COUNT(*) as cnt,
           GROUP_CONCAT(DISTINCT substr(detail, 1, 100)) as sample_details
    FROM audit_log
    WHERE result = 'error' AND created_at > datetime('now', '-24 hours')
    GROUP BY agent_id
    HAVING cnt >= 3
    ORDER BY cnt DESC
  `).all() as Array<{ agent_id: string; result: string; cnt: number; sample_details: string }>;

  for (const row of errors) {
    const agentName = getAgentName(row.agent_id);
    items.push({
      severity: row.cnt >= 10 ? 'critical' : 'warning',
      code: 'HIGH_ERROR_COUNT',
      title: `${agentName} ran into ${row.cnt} errors in the last 24 hours`,
      detail: `${agentName} is having trouble completing tasks. This could be a problem with its model, its permissions, or the tasks it's being given.`,
      agentId: row.agent_id,
      agentName,
    });
  }

  return items;
}

function getModelPerformance(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  // Per-model error rates from audit_log
  const models = db.prepare(`
    SELECT target as model_id,
           COUNT(*) as total,
           SUM(CASE WHEN result = 'error' THEN 1 ELSE 0 END) as errors
    FROM audit_log
    WHERE action_type = 'model_call' AND created_at > datetime('now', '-24 hours')
    GROUP BY target
    HAVING total >= 5
  `).all() as Array<{ model_id: string; total: number; errors: number }>;

  for (const model of models) {
    const errorRate = model.errors / model.total;
    if (errorRate > 0.1) {
      const modelName = getModelName(model.model_id);
      const pct = Math.round(errorRate * 100);
      items.push({
        severity: errorRate > 0.3 ? 'warning' : 'info',
        code: 'HIGH_ERROR_RATE',
        title: `The ${modelName} model is failing ${pct}% of the time`,
        detail: `${model.errors} out of ${model.total} requests to this model failed in the last 24 hours. Agents using this model may be slow or unresponsive.`,
      });
    }
  }

  return items;
}

function getContextHealth(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  // Check for agents with orphaned tool messages
  const agents = db.prepare(`
    SELECT DISTINCT agent_id FROM messages
    WHERE role = 'tool' AND created_at > datetime('now', '-24 hours')
  `).all() as Array<{ agent_id: string }>;

  for (const { agent_id } of agents) {
    // Count tool_result messages that reference IDs not in preceding assistant messages
    const toolMsgs = db.prepare(`
      SELECT content FROM messages
      WHERE agent_id = ? AND role IN ('tool', 'assistant')
        AND (content LIKE '%tool_use%' OR content LIKE '%tool_result%')
      ORDER BY created_at DESC LIMIT 20
    `).all(agent_id) as Array<{ content: string }>;

    let orphanedCount = 0;
    for (const msg of toolMsgs) {
      try {
        const blocks = JSON.parse(msg.content);
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b.type === 'tool_result' && b.tool_use_id?.startsWith('text_tool_')) {
              orphanedCount++;
            }
          }
        }
      } catch { /* not JSON */ }
    }

    if (orphanedCount > 0) {
      const agentName = getAgentName(agent_id);
      items.push({
        severity: 'warning',
        code: 'ORPHANED_TOOL_MESSAGES',
        title: `${agentName} has corrupted messages that could cause crashes`,
        detail: `${agentName} has ${orphanedCount} leftover message(s) from a previous model that may cause errors. Cleaning these up should fix it.`,
        agentId: agent_id,
        agentName,
      });
    }
  }

  return items;
}

function getTrackerHealth(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  // Tasks stuck in_progress for >24h
  const staleTasks = db.prepare(`
    SELECT t.id, t.title, t.assigned_to, t.updated_at,
           a.name as agent_name, a.status as agent_status
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.assigned_to
    WHERE t.status = 'in_progress'
      AND t.updated_at < datetime('now', '-24 hours')
  `).all() as Array<{ id: string; title: string; assigned_to: string | null; updated_at: string; agent_name: string | null; agent_status: string | null }>;

  for (const task of staleTasks) {
    const updatedMs = new Date(task.updated_at.includes('Z') ? task.updated_at : task.updated_at + 'Z').getTime();
    const hours = Math.floor((Date.now() - updatedMs) / 3600000);
    items.push({
      severity: 'warning',
      code: 'TRACKER_STALE',
      title: `"${task.title}" has been in progress for ${hours}+ hours with no update`,
      detail: `This task is assigned to ${task.agent_name ?? 'an unknown agent'} but hasn't been updated in over a day. It may be stuck or forgotten.`,
      agentId: task.assigned_to ?? undefined,
      agentName: task.agent_name ?? undefined,
    });
  }

  // Tasks assigned to terminated agents
  const orphanedTasks = db.prepare(`
    SELECT t.id, t.title, t.assigned_to, a.name as agent_name
    FROM tasks t
    JOIN agents a ON a.id = t.assigned_to
    WHERE t.status IN ('in_progress', 'on_deck', 'paused')
      AND a.status = 'terminated'
  `).all() as Array<{ id: string; title: string; assigned_to: string; agent_name: string }>;

  for (const task of orphanedTasks) {
    items.push({
      severity: 'critical',
      code: 'ORPHANED_TASK',
      title: `"${task.title}" is assigned to ${task.agent_name}, but that agent no longer exists`,
      detail: `${task.agent_name} was shut down but this task is still assigned to them. It needs to be reassigned to someone else.`,
      agentId: task.assigned_to,
      agentName: task.agent_name,
    });
  }

  // Projects with all tasks complete but project still active
  const orphanedProjects = db.prepare(`
    SELECT p.id, p.title
    FROM projects p
    WHERE p.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.project_id = p.id AND t.status NOT IN ('complete', 'fallen')
      )
      AND EXISTS (SELECT 1 FROM tasks t2 WHERE t2.project_id = p.id)
  `).all() as Array<{ id: string; title: string }>;

  for (const project of orphanedProjects) {
    items.push({
      severity: 'info',
      code: 'ORPHANED_PROJECT',
      title: `"${project.title}" is finished but wasn't closed out`,
      detail: `All tasks in this project are done, but the project itself is still marked as active. It just needs to be marked complete.`,
    });
  }

  return items;
}

// ── Bulletproof tool diagnostics ─────────────────────────────────────────
//
// These checks watch for failure modes the v2 tool audit hardened against.
// The hardening fixes the underlying causes; these diagnostics catch any
// stragglers (legacy data, new code paths that bypassed the helpers, edge
// cases not yet covered) and surface them as healer proposals so production
// hits become user-visible instead of silent breaks.

function getBulletproofToolHealth(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  // 1. Apprentice split-brain: agent is idle/working but their assigned
  //    task is already complete. The completeAgent fallback in spawner.ts
  //    auto-fixes new occurrences, so this catches legacy or post-restart
  //    stragglers — and any future regression where a non-apprentice path
  //    completes a task without terminating the agent.
  const splitBrain = db.prepare(`
    SELECT a.id, a.name, t.id as task_id, t.title as task_title
    FROM agents a
    JOIN tasks t ON t.assigned_to = a.id
    WHERE a.status IN ('idle', 'working')
      AND a.classification = 'apprentice'
      AND t.status = 'complete'
      AND t.completed_at > datetime('now', '-7 days')
  `).all() as Array<{ id: string; name: string; task_id: string; task_title: string }>;

  for (const row of splitBrain) {
    items.push({
      severity: 'warning',
      code: 'APPRENTICE_DANGLING',
      title: `"${row.name}" finished their task but wasn't terminated`,
      detail: `The task "${row.task_title}" is marked complete but ${row.name} is still alive (${row.id}). They should have called complete_task to finalize. Safe to terminate.`,
      agentId: row.id,
      agentName: row.name,
    });
  }

  // 2. Cryptic tool errors leaking through to the model. If the audit log
  //    shows raw SQLite or JS exceptions in the last 24h, a tool somewhere
  //    is missing input validation or DB error wrapping. The model can't
  //    act on these — they're noise that wastes turns.
  const crypticErrors = db.prepare(`
    SELECT COUNT(*) as cnt, MAX(target) as sample
    FROM audit_log
    WHERE action_type = 'tool_call'
      AND result = 'error'
      AND created_at > datetime('now', '-24 hours')
      AND (
        target LIKE '%FOREIGN KEY constraint%'
        OR target LIKE '%NOT NULL constraint%'
        OR target LIKE '%Cannot read properties%'
        OR target LIKE '%toLowerCase%'
        OR target LIKE '%is not a function%'
        OR target LIKE '%undefined%'
      )
  `).get() as { cnt: number; sample: string | null };

  if (crypticErrors.cnt > 0) {
    items.push({
      severity: crypticErrors.cnt >= 5 ? 'critical' : 'warning',
      code: 'TOOL_ERROR_LEAK',
      title: `${crypticErrors.cnt} cryptic tool error(s) leaked to agents in the last 24h`,
      detail: `Tools should never surface raw SQLite/JS errors to the model — wrap them via friendlyDbError / checkRequired in tool-helpers.ts. Sample: ${(crypticErrors.sample ?? '').slice(0, 200)}.`,
    });
  }

  // 3. Idle apprentices with assigned tasks that have never been poked.
  //    Could indicate a caller spawned with auto_start: false but forgot
  //    to wake the agent. Worth flagging at 30+ min so quick test runs
  //    don't trigger it.
  const neverPoked = db.prepare(`
    SELECT a.id, a.name, t.title as task_title, t.id as task_id, a.created_at
    FROM agents a
    JOIN tasks t ON t.assigned_to = a.id
    WHERE a.status = 'idle'
      AND a.classification = 'apprentice'
      AND t.status IN ('on_deck', 'in_progress')
      AND a.created_at < datetime('now', '-30 minutes')
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.agent_id = a.id AND m.role = 'assistant'
      )
  `).all() as Array<{ id: string; name: string; task_title: string; task_id: string; created_at: string }>;

  for (const row of neverPoked) {
    items.push({
      severity: 'info',
      code: 'APPRENTICE_NEVER_POKED',
      title: `"${row.name}" was spawned 30+ min ago and never started their task`,
      detail: `${row.name} (${row.id}) has been idle since spawn — their assigned task "${row.task_title}" hasn't been worked on. If you spawned them with auto_start: false, send_to_agent or assign a task to wake them. Otherwise, terminate them.`,
      agentId: row.id,
      agentName: row.name,
    });
  }

  // 4. Vault dreaming backlog. If unprocessed conversations pile up >25
  //    the Dreamer isn't running. Kevin can now trigger it on demand via
  //    dreamer_run_now — surface this as an info-level item.
  const backlog = db.prepare(`
    SELECT COUNT(*) as cnt FROM vault_conversations WHERE is_processed = 0
  `).get() as { cnt: number };
  if (backlog.cnt >= 25) {
    items.push({
      severity: 'info',
      code: 'DREAM_BACKLOG',
      title: `${backlog.cnt} conversations are waiting to be dreamed`,
      detail: `The Dreamer hasn't processed these archives yet. Memories from these conversations aren't searchable until it runs. Trigger a cycle now with dreamer_run_now, or wait for the next scheduled run.`,
    });
  }

  return items;
}

function getNudgeStats(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  // Count empty response / model failure events per agent in last 24h from audit_log
  // (nudges are in-memory only now, so we check for model failures as a proxy)
  const nudges = db.prepare(`
    SELECT agent_id, COUNT(*) as cnt
    FROM audit_log
    WHERE action_type = 'model_call' AND result = 'error'
      AND created_at > datetime('now', '-24 hours')
    GROUP BY agent_id
    HAVING cnt >= 3
  `).all() as Array<{ agent_id: string; cnt: number }>;

  for (const row of nudges) {
    const agentName = getAgentName(row.agent_id);
    items.push({
      severity: row.cnt >= 8 ? 'warning' : 'info',
      code: 'NUDGE_HEAVY',
      title: `${agentName} needed help ${row.cnt} times to finish responses`,
      detail: `${agentName} kept giving blank or incomplete answers and had to be prompted to try again. This usually means the model it's running on isn't powerful enough for its job.`,
      agentId: row.agent_id,
      agentName,
    });
  }

  return items;
}

// v2.3.19 (error-handling-spec Phase 4) — provider-wide outage detector.
//
// When 3+ agents on the same provider hit errors classified as transient
// (5xx / network / overloaded) within the last hour, that's a provider
// problem, not an agent problem. The Healer should propose failover to
// a different provider rather than auto-fixing each agent in isolation.
function getProviderOutagePatterns(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];
  try {
    // Look back 1 hour at agents with last_error matching transient
    // patterns, grouped by their provider.
    const rows = db.prepare(`
      SELECT p.name AS provider_name,
             COUNT(DISTINCT a.id) AS agent_count,
             GROUP_CONCAT(DISTINCT a.name) AS agent_names
      FROM agents a
      JOIN models m ON m.id = a.model_id
      JOIN providers p ON p.id = m.provider_id
      WHERE a.last_error IS NOT NULL
        AND a.last_error_at > datetime('now', '-1 hours')
        AND (
          a.last_error LIKE '%500%'
          OR a.last_error LIKE '%502%'
          OR a.last_error LIKE '%503%'
          OR a.last_error LIKE '%504%'
          OR a.last_error LIKE '%529%'
          OR a.last_error LIKE '%overloaded%'
          OR a.last_error LIKE '%fetch failed%'
          OR a.last_error LIKE '%ECONNRESET%'
          OR a.last_error LIKE '%ETIMEDOUT%'
        )
      GROUP BY p.name
      HAVING agent_count >= 3
    `).all() as Array<{ provider_name: string; agent_count: number; agent_names: string }>;

    for (const row of rows) {
      items.push({
        severity: 'warning',
        code: 'PROVIDER_OUTAGE_PATTERN',
        title: `${row.provider_name} appears to be having problems`,
        detail: `${row.agent_count} agents (${row.agent_names}) hit a transient ${row.provider_name} error in the last hour. Consider routing affected agents to a different provider until this clears.`,
      });
    }
  } catch (err) {
    logger.warn('Provider outage pattern collector failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return items;
}

function getBudgetStatus(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  try {
    const budgetRow = db.prepare("SELECT value FROM config WHERE key = 'daily_budget_usd'").get() as { value: string } | undefined;
    const budget = budgetRow ? parseFloat(budgetRow.value) : 25;

    const today = new Date().toISOString().split('T')[0];
    const spendRow = db.prepare(`
      SELECT COALESCE(SUM(cost), 0) as total FROM audit_log
      WHERE action_type = 'model_call' AND created_at >= ?
    `).get(today) as { total: number };

    const percentage = (spendRow.total / budget) * 100;
    items.push({
      severity: percentage > 80 ? 'warning' : 'info',
      code: percentage > 80 ? 'BUDGET_HIGH' : 'BUDGET_OK',
      title: percentage > 80
        ? `Spending is getting close to the daily limit ($${spendRow.total.toFixed(2)} of $${budget})`
        : `Spending is normal ($${spendRow.total.toFixed(2)} of $${budget} daily limit)`,
      detail: percentage > 80
        ? `The dojo has used ${percentage.toFixed(0)}% of today's budget. Agents may be slowed or stopped if the limit is reached.`
        : `Everything is within the daily budget. No action needed.`,
    });
  } catch { /* budget tracking may not be set up */ }

  return items;
}

// ── Helpers ──

function getAgentName(agentId: string): string {
  try {
    const db = getDb();
    const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    return row?.name ?? agentId;
  } catch { return agentId; }
}

function getModelName(modelId: string): string {
  try {
    const db = getDb();
    const row = db.prepare('SELECT name, api_model_id FROM models WHERE id = ?').get(modelId) as { name: string; api_model_id: string } | undefined;
    return row ? `${row.name} (${row.api_model_id})` : modelId;
  } catch { return modelId; }
}

// ── Main Compiler ──

export function compileDiagnosticReport(): DiagnosticReport {
  // v2.3.19 — apply per-collector caps so a runaway collector can't
  // drown the report. Critical items are always preserved; warning/info
  // items get dropped first when the cap fires.
  const items: DiagnosticItem[] = [
    ...capItemsByText(getAgentStatusAnomalies(), COLLECTOR_CAPS.agent_anomalies, 'agent_anomalies'),
    ...capItemsByText(getErrorDigest(), COLLECTOR_CAPS.error_digest, 'error_digest'),
    ...capItemsByText(getModelPerformance(), COLLECTOR_CAPS.model_performance, 'model_performance'),
    ...capItemsByText(getContextHealth(), COLLECTOR_CAPS.context_health, 'context_health'),
    ...capItemsByText(getTrackerHealth(), COLLECTOR_CAPS.tracker_health, 'tracker_health'),
    ...capItemsByText(getBulletproofToolHealth(), COLLECTOR_CAPS.bulletproof_health, 'bulletproof_health'),
    ...capItemsByText(getNudgeStats(), COLLECTOR_CAPS.nudge_stats, 'nudge_stats'),
    ...capItemsByText(getProviderOutagePatterns(), 1500, 'provider_outage'),
    ...capItemsByText(getBudgetStatus(), COLLECTOR_CAPS.budget, 'budget'),
  ];

  // Sort: critical first, then warning, then info
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const criticalCount = items.filter(i => i.severity === 'critical').length;
  const warningCount = items.filter(i => i.severity === 'warning').length;
  const infoCount = items.filter(i => i.severity === 'info').length;

  // Build report text
  const lines: string[] = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
  lines.push(`═══ DOJO DAILY DIAGNOSTIC — ${now} ═══`);
  lines.push('');

  if (criticalCount > 0) {
    lines.push('NEEDS ATTENTION:');
    let n = 1;
    for (const item of items.filter(i => i.severity === 'critical')) {
      lines.push(`  ${n}. ${item.title}`);
      lines.push(`     ${item.detail}`);
      lines.push('');
      n++;
    }
  }

  if (warningCount > 0) {
    lines.push('THINGS TO KEEP AN EYE ON:');
    let n = 1;
    for (const item of items.filter(i => i.severity === 'warning')) {
      lines.push(`  ${n}. ${item.title}`);
      lines.push(`     ${item.detail}`);
      lines.push('');
      n++;
    }
  }

  if (infoCount > 0) {
    lines.push('ALL GOOD:');
    let n = 1;
    for (const item of items.filter(i => i.severity === 'info')) {
      lines.push(`  ${n}. ${item.title}`);
      lines.push(`     ${item.detail}`);
      lines.push('');
      n++;
    }
  }

  if (items.length === 0) {
    lines.push('Everything looks good — no issues found in the last 24 hours.');
    lines.push('');
  }

  lines.push('═══ END DIAGNOSTIC ═══');

  const reportText = lines.join('\n');
  const id = uuidv4();

  // Persist the diagnostic snapshot
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO healer_diagnostics (id, report, critical_count, warning_count, info_count, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(id, reportText, criticalCount, warningCount, infoCount);
  } catch (err) {
    logger.warn('Failed to persist diagnostic report', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('Diagnostic report compiled', {
    criticalCount, warningCount, infoCount, totalItems: items.length,
  });

  return { id, timestamp: now, items, criticalCount, warningCount, infoCount, reportText };
}

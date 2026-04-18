// ════════════════════════════════════════
// Healer Diagnostic Report Compiler
//
// Reads logs, DB state, and agent health to produce
// a structured diagnostic report for the Healer agent.
// This is engine-level — no LLM involved.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { v4 as uuidv4 } from 'uuid';

const logger = createLogger('healer-diagnostic');

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
  const troubled = db.prepare(`
    SELECT id, name, status, updated_at FROM agents
    WHERE status IN ('error', 'paused', 'rate_limited')
      AND status != 'terminated'
  `).all() as Array<{ id: string; name: string; status: string; updated_at: string }>;

  for (const agent of troubled) {
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
  const items: DiagnosticItem[] = [
    ...getAgentStatusAnomalies(),
    ...getErrorDigest(),
    ...getModelPerformance(),
    ...getContextHealth(),
    ...getTrackerHealth(),
    ...getNudgeStats(),
    ...getBudgetStatus(),
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

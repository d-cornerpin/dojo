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
import { HEALER_WORKING_STUCK_MINUTES, DORMANT_THRESHOLD_DAYS } from '../agent/stuck-thresholds.js';
import { createLogger } from '../logger.js';
import { v4 as uuidv4 } from 'uuid';
import { getVaultStats, getPoisonedArchiveStats } from '../vault/store.js';
import { getUpdateCheckHealth } from '../gateway/routes/update.js';
import { readMarker } from '../update-state.js';
import { taskScope, projectScope, msToText } from '../work/tracker-view.js';

const logger = createLogger('healer-diagnostic');

// ── Vault dreaming health thresholds ──
//
// The Dreamer is the nightly memory distiller: it turns raw conversation
// archives (vault_conversations, is_processed = 0) into long-term vault
// entries. If it silently dies (a restart mid-cycle, a poison archive, or
// model failures), unfiled archives pile up, no memories are distilled,
// and the FN-1 recall bridge keeps serving the raw archives, so behaviour
// looks normal while long-term memory silently stops being built. These
// thresholds drive the diagnostic items that surface that.
const DREAM_BACKLOG_INFO_THRESHOLD = 25;   // info: a fresh box's day-one backlog is expected; stay quiet
const DREAM_BACKLOG_WARN_THRESHOLD = 200;  // warning: a backlog this deep means the Dreamer is not keeping up
const DREAM_STALE_HOURS = 48;              // warning: an archive unfiled this long = >= 2 nightly cycles missed

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
  dream_health: 1500,
  update_check: 800,
  auto_rollback: 900,
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

  // PHASE-6 T10: from the ONE stuck-threshold table (7 days, unchanged).
  const DORMANT_THRESHOLD_MS = DORMANT_THRESHOLD_DAYS * 86400000;
  for (const agent of troubled) {
    // Check if this agent is dormant (no messages in 7+ days).
    // EXCEPTION: if the agent's status was updated recently (e.g., a server
    // restart set it to error), it's a real issue even if messages are old.
    const agentUpdatedMs = new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z').getTime();
    const statusIsRecent = (Date.now() - agentUpdatedMs) < DORMANT_THRESHOLD_MS;
    if (!statusIsRecent) {
      const lastMsg = db.prepare(
        `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
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

  // Agents stuck in working state.
  // PHASE-6 T10: this was a bare `'-10 minutes'` SQL literal — the Healer's duplicate stuck
  // detector, duplicating a number that had no name to duplicate. It reads the ONE table now;
  // the value is unchanged and is the same cliff `healer-agent.ts`'s self-watchdog uses.
  const stuck = db.prepare(`
    SELECT id, name, updated_at FROM agents
    WHERE status = 'working'
      AND updated_at < datetime('now', '-${HEALER_WORKING_STUCK_MINUTES} minutes')
  `).all() as Array<{ id: string; name: string; updated_at: string }>;

  for (const agent of stuck) {
    // Skip dormant agents (no messages in 7+ days), unless their status
    // was updated recently (e.g., server restart set them to working).
    const stuckUpdatedMs = new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z').getTime();
    const stuckStatusRecent = (Date.now() - stuckUpdatedMs) < DORMANT_THRESHOLD_MS;
    if (!stuckStatusRecent) {
      const stuckLastMsg = db.prepare(
        `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
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
    WHERE role = 'tool' AND created_at > (unixepoch('now', '-24 hours') * 1000)
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
    SELECT t.id, t.title, t.agent_id AS assigned_to, ${msToText('t.updated_at')} AS updated_at,
           a.name as agent_name, a.status as agent_status
    FROM work t
    LEFT JOIN agents a ON a.id = t.agent_id
    WHERE ${taskScope('t')} AND t.state = 'claimed'
      AND t.updated_at < ?
  `).all(Date.now() - 24 * 3600 * 1000) as Array<{ id: string; title: string; assigned_to: string | null; updated_at: string; agent_name: string | null; agent_status: string | null }>;

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
    SELECT t.id, t.title, t.agent_id AS assigned_to, a.name as agent_name
    FROM work t
    JOIN agents a ON a.id = t.agent_id
    WHERE ${taskScope('t')} AND t.state IN ('claimed', 'on_deck', 'paused')
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

  // Projects where EVERY task is complete but the project is still active.
  // D-K (owner decision): a project that ran out of open tasks but has at
  // least one FALLEN task is deliberately left open for attention, it is NOT
  // an orphan to be closed. So the predicate is `status != 'complete'` (a
  // fallen task counts as "not done"), matching fixOrphanedProject. This is
  // what stops the Healer from re-detecting and re-offering to close a
  // fallen-containing project on every cycle (no infinite re-detect loop).
  const orphanedProjects = db.prepare(`
    SELECT p.id, p.title
    FROM work p
    WHERE ${projectScope('p')} AND p.state = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM work t
        WHERE t.parent_id = p.id AND t.kind = 'task' AND t.state <> 'done'
      )
      AND EXISTS (SELECT 1 FROM work t2 WHERE t2.parent_id = p.id AND t2.kind = 'task')
  `).all() as Array<{ id: string; title: string }>;

  for (const project of orphanedProjects) {
    items.push({
      severity: 'info',
      code: 'ORPHANED_PROJECT',
      title: `"${project.title}" is finished but wasn't closed out`,
      detail: `Every task in this project is complete, but the project itself is still marked as active. It just needs to be marked complete.`,
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
  //
  //    Exclude persistent agents. An apprentice with config.persist=true
  //    OR agent_type='persistent' is INTENTIONALLY kept alive after
  //    complete_task so it can handle its next scheduled fire (think:
  //    daily dispatcher, weekly delivery agent). Pre-fix this query
  //    flagged a persistent dispatcher every day for 19 consecutive days
  //    and the healer ended up proposing an "auto-terminate idle agents"
  //    fix that would have broken the next day's run. The persist signal
  //    lives in agents.config (JSON) so we extract it with json_extract.
  const splitBrain = db.prepare(`
    SELECT a.id, a.name, t.id as task_id, t.title as task_title
    FROM agents a
    JOIN work t ON t.agent_id = a.id AND ${taskScope('t')}
    WHERE a.status IN ('idle', 'working')
      AND a.classification = 'apprentice'
      AND COALESCE(a.agent_type, '') != 'persistent'
      AND COALESCE(json_extract(a.config, '$.persist'), 0) != 1
      AND t.state = 'done'
      AND t.closed_at > (CAST(strftime('%s', 'now', '-7 days') AS INTEGER) * 1000)
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
    JOIN work t ON t.agent_id = a.id AND ${taskScope('t')}
    WHERE a.status = 'idle'
      AND a.classification = 'apprentice'
      AND t.state IN ('on_deck', 'claimed')
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

  // Vault dreaming health (backlog + staleness) is its own collector,
  // getDreamHealth, so it can key off archive age and the dreaming-enabled
  // door rather than a bare count.

  return items;
}

// ── Vault dreaming health ─────────────────────────────────────────────────
//
// Surfaces a silently-dead Dreamer. Two independent signals:
//
//   DREAM_BACKLOG, volume. Unprocessed archives past a count threshold.
//                   info at >= 25 (a fresh box's day-one backlog is
//                   expected, stay quiet), warning at >= 200 (a backlog
//                   this deep means the Dreamer is not keeping up).
//   DREAM_STALE  , age. The OLDEST unprocessed archive is older than
//                   DREAM_STALE_HOURS. A healthy nightly Dreamer files
//                   every archive within one cycle (< 24h), so an archive
//                   still unfiled after 48h means >= 2 nightly cycles
//                   failed. Keying off archive AGE (not a count, and not
//                   lastDreamAt) is deliberate: it stays quiet on a
//                   genuinely fresh box (all archives younger than the
//                   threshold), trips on a box that has NEVER dreamed but
//                   has old unfiled archives, and still catches a poison
//                   archive that a recent, otherwise-successful cycle keeps
//                   skipping (where lastDreamAt would look fresh).
//
// The Healer cannot start the Dreamer itself: dreamer_run_now is hard
// primary-gated (tools.ts) and is not in the Healer's allow-list, so the
// warning guidance steers the Healer to notify the owner in plain language
// and ask the main agent to run it. It must NOT propose swapping the
// Dreamer's model (HEALER-SOUL forbids "switch to a better model").
function getDreamHealth(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  const stats = getVaultStats();
  const backlog = stats.unprocessedArchives; // FA-V4: already excludes poisoned rows
  // FA-V4: poisoned archives are the Dreamer's escalation surface, computed up
  // front so their signal survives even when the (poison-excluding) backlog is 0.
  const poison = getPoisonedArchiveStats();
  if (backlog === 0 && poison.count === 0) return items; // nothing unfiled or parked, nothing to report

  // Same 'dreaming_mode' config key getDreamingConfig() reads: default
  // 'full', only 'off' disables dreaming. When dreaming is deliberately
  // off, a backlog is expected, so the warning lanes stay silent (the
  // info lane is preserved exactly, see below).
  const dreamModeRow = db
    .prepare("SELECT value FROM config WHERE key = 'dreaming_mode'")
    .get() as { value: string } | undefined;
  const dreamingEnabled = (dreamModeRow?.value ?? 'full') !== 'off';

  // Age of the OLDEST still-unprocessed archive, in hours. julianday keeps
  // both sides in UTC, so no Z-suffix parsing is needed.
  // FA-V4: exclude poisoned archives from the age signal. A parked (poisoned)
  // archive stays is_processed=0 forever by design (it was never distilled), so
  // without this filter one poison archive would permanently trip DREAM_STALE.
  // Poisoned archives are surfaced by DREAM_POISONED below instead.
  const oldestRow = db.prepare(`
    SELECT MAX((julianday('now') - julianday(created_at)) * 24.0) AS oldest_hours
    FROM vault_conversations WHERE is_processed = 0 AND poisoned = 0
  `).get() as { oldest_hours: number | null };
  const oldestHours = oldestRow.oldest_hours ?? 0;

  // Plain-language summary of when the Dreamer last completed a full cycle.
  const lastDreamPhrase = stats.lastDreamAt
    ? `about ${Math.max(1, Math.round(
        (Date.now() - new Date(stats.lastDreamAt.includes('Z') ? stats.lastDreamAt : stats.lastDreamAt + 'Z').getTime()) / 3_600_000,
      ))} hours ago`
    : 'never (no completed cycle on record for this box)';

  // ── DREAM_STALE (age signal), only when dreaming is enabled ──
  if (dreamingEnabled && oldestHours >= DREAM_STALE_HOURS) {
    const days = Math.floor(oldestHours / 24);
    const ageStr = days >= 1 ? `${days} day${days > 1 ? 's' : ''}` : `${Math.round(oldestHours)} hours`;
    items.push({
      severity: 'warning',
      code: 'DREAM_STALE',
      title: `Nightly memory processing hasn't run in over ${Math.floor(DREAM_STALE_HOURS / 24)} days`,
      detail:
        `The dojo's nightly memory catch-up (the Dreamer) hasn't finished a cycle recently ` +
        `(last successful run: ${lastDreamPhrase}), and unfiled conversation memory is piling up ` +
        `(${backlog} conversation${backlog === 1 ? '' : 's'} waiting, the oldest ${ageStr} old). ` +
        `Recent conversations are still remembered short-term but are NOT yet saved to long-term memory, ` +
        `so everything can look normal while long-term memory quietly stops growing. ` +
        `Let the owner know in plain language that the nightly memory save-up has stalled and recent ` +
        `conversations aren't in long-term memory yet. You can't start the Dreamer yourself ` +
        `(dreamer_run_now is the main agent's tool), so ask the main agent to run it, or leave it for ` +
        `tonight's scheduled cycle. Do NOT change the Dreamer's model, the fix is getting the existing ` +
        `cycle to complete, not swapping models.`,
    });
  }

  // ── DREAM_BACKLOG (volume signal) ──
  // Preserve the exact prior behaviour: info at >= 25 so a fresh box's
  // day-one backlog stays quiet. Additive warning tier at >= 200, only
  // when dreaming is enabled (a deliberately-off Dreamer shouldn't nag).
  if (dreamingEnabled && backlog >= DREAM_BACKLOG_WARN_THRESHOLD) {
    items.push({
      severity: 'warning',
      code: 'DREAM_BACKLOG',
      title: `${backlog} conversations are stuck waiting to be saved to memory`,
      detail:
        `Unfiled conversation archives have piled up to ${backlog}, which means the Dreamer isn't ` +
        `keeping up and long-term memory is falling behind. Let the owner know in plain language, and ` +
        `ask the main agent to run dreamer_run_now to clear the backlog (you don't have that tool ` +
        `yourself). Do NOT change the Dreamer's model, the goal is to get the existing cycle running again.`,
    });
  } else if (backlog >= DREAM_BACKLOG_INFO_THRESHOLD) {
    items.push({
      severity: 'info',
      code: 'DREAM_BACKLOG',
      title: `${backlog} conversations are waiting to be dreamed`,
      detail: `The Dreamer hasn't processed these archives yet. Memories from these conversations aren't searchable until it runs. Trigger a cycle now with dreamer_run_now, or wait for the next scheduled run.`,
    });
  }

  // ── DREAM_POISONED (FA-V4 escalation surface) ──
  // An archive the Dreamer failed to distill after MAX_DREAM_ATTEMPTS terminal
  // passes is parked (poisoned): excluded from the work queue, the backlog
  // count, and the DREAM_STALE age signal above so it cannot retry forever nor
  // permanently trip staleness. It is surfaced HERE instead so a human sees it.
  // Ungated by the dreaming-enabled door: a parked archive is a discrete past
  // failure worth flagging even if dreaming was later switched off.
  if (poison.count > 0) {
    items.push({
      severity: 'warning',
      code: 'DREAM_POISONED',
      title: `${poison.count} conversation${poison.count === 1 ? '' : 's'} couldn't be saved to memory after repeated tries`,
      detail:
        `The nightly memory processor (the Dreamer) tried to file ${poison.count} conversation${poison.count === 1 ? '' : 's'} ` +
        `several times and gave up, so ${poison.count === 1 ? 'it was' : 'they were'} set aside instead of retrying forever ` +
        `(${poison.count === 1 ? 'it no longer counts' : 'they no longer count'} as backlog). This usually means a conversation ` +
        `is malformed or too large for the current memory model to digest. Let the owner know in plain language that a few ` +
        `conversations could not be saved to long-term memory and were parked. ` +
        `${poison.latestReason ? `Most recent reason: ${poison.latestReason} ` : ''}` +
        `Do NOT change the Dreamer's model on your own; flag it for the main agent to look at.`,
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

// Shared transient-provider-error SQL predicate. This is a boolean fragment
// that references the `a` alias (agents a) and matches the 5xx / overloaded /
// network-reset last_error strings we treat as a provider (not per-agent)
// fault. FA-X5: injury-recovery's provider-pattern dedup mirrors this EXACT
// filter, so the canonical copy lives here next to the outage detector and
// both import it. Keeping one source prevents the two provider-outage
// predicates from drifting apart (they classified "transient" differently
// before, so the dedup over-counted against a stricter detector).
export const TRANSIENT_PROVIDER_ERROR_SQL = `(
          a.last_error LIKE '%500%'
          OR a.last_error LIKE '%502%'
          OR a.last_error LIKE '%503%'
          OR a.last_error LIKE '%504%'
          OR a.last_error LIKE '%529%'
          OR a.last_error LIKE '%overloaded%'
          OR a.last_error LIKE '%fetch failed%'
          OR a.last_error LIKE '%ECONNRESET%'
          OR a.last_error LIKE '%ETIMEDOUT%'
        )`;

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
        AND ${TRANSIENT_PROVIDER_ERROR_SQL}
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

// ── Update-check pipeline health (FA-D6) ─────────────────────────────────
//
// The daily update check never throws; a GitHub outage, a renamed repo, or a
// sustained rate-limit just comes back as an error, so a box can silently
// strand OFF updates (fixes included) for weeks. update.ts counts consecutive
// failed checks and stamps a failing-since anchor once the pipeline crosses
// UPDATE_CHECK_FAILURE_THRESHOLD; here we surface that as a notify-only warning
// so the Healer can tell the owner in plain language. This is NOT an update
// notification (we never push those), it is a health signal that the CHECK
// itself is broken. The Healer must NOT try to force an update from this.
function getUpdateCheckHealthItems(): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];
  try {
    const health = getUpdateCheckHealth();
    if (!health.failing) return items;

    let sincePhrase = 'recently';
    if (health.failingSince) {
      const ms = Date.now() - new Date(
        health.failingSince.includes('Z') ? health.failingSince : health.failingSince + 'Z',
      ).getTime();
      const days = Math.floor(ms / 86_400_000);
      sincePhrase = days >= 1 ? `for about ${days} day${days > 1 ? 's' : ''}` : 'since earlier today';
    }

    items.push({
      severity: 'warning',
      code: 'UPDATE_CHECK_FAILING',
      title: `The dojo hasn't been able to check for updates ${sincePhrase}`,
      detail:
        `The daily check that looks for new dojo versions has failed ${health.consecutiveFailures} times in a row` +
        `${health.lastError ? ` (last error: ${health.lastError.slice(0, 160)})` : ''}. ` +
        `That usually means GitHub is unreachable from this box, the internet is down, or a rate limit is in effect. ` +
        `Nothing is wrong with the running dojo and NO update will be installed automatically, but while this ` +
        `keeps failing, the box can't see new versions, including fixes. Let the owner know in plain language that ` +
        `automatic update checks are failing and it may be worth checking the box's internet connection. Do NOT try ` +
        `to force an update; the fix is getting the check to reach GitHub again.`,
    });
  } catch (err) {
    logger.warn('Update-check health collector failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return items;
}

// ── Self-update auto-rollback state (D-F) ────────────────────────────────
//
// The independent watchdog can auto-roll-back a self-update that fails to boot
// (code only, owner decision 2026-07-06). The PRIMARY owner signal is the
// watchdog's iMessage at the moment it acts; THIS is the durable, dashboard-
// visible signal so the state is not lost if that text was missed. It reads the
// same ~/.dojo/update-state.json marker the watchdog writes. Two phases matter:
//   rolled-back        -> the box undid a bad update and is on the previous build
//   failed-permanently -> a failed update could NOT be safely undone; needs a person
// (A healthy/idle/pending marker produces no item; this is notify-only, the
// Healer must NOT try to force an update from it.)
function getUpdateRollbackItems(): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];
  try {
    const marker = readMarker();
    if (!marker) return items;

    if (marker.phase === 'failed-permanently') {
      items.push({
        severity: 'critical',
        code: 'UPDATE_FAILED_PERMANENTLY',
        title: 'A dojo update failed to start and could not be safely undone',
        detail:
          `A recent dojo update did not boot correctly, and the system did NOT automatically put the old version ` +
          `back because doing so could have made things worse (for example, the update had already changed the ` +
          `database). The box may keep restarting or stay on a version that will not run. This needs a person: open ` +
          `the dojo dashboard and restore a previous version from the update screen, or get help. Let the owner know ` +
          `in plain language that a dojo update failed and the box needs manual attention. Do NOT try to force ` +
          `another update.`,
      });
    } else if (marker.phase === 'rolled-back') {
      const toVer = marker.previousVersion ? ` (version ${marker.previousVersion})` : '';
      items.push({
        severity: 'warning',
        code: 'UPDATE_ROLLED_BACK',
        title: 'A failed dojo update was automatically undone',
        detail:
          `A recent dojo update did not start up correctly, so the system automatically put the previous version` +
          `${toVer} back, and the box is running normally on it. No data was lost. The newer version still has a ` +
          `problem on this box, so let the owner know in plain language that an update was rolled back and it may be ` +
          `worth waiting for the next version before updating again. Do NOT re-apply the same update.`,
      });
    }
  } catch (err) {
    logger.warn('Update auto-rollback health collector failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
    ...capItemsByText(getDreamHealth(), COLLECTOR_CAPS.dream_health, 'dream_health'),
    ...capItemsByText(getNudgeStats(), COLLECTOR_CAPS.nudge_stats, 'nudge_stats'),
    ...capItemsByText(getProviderOutagePatterns(), 1500, 'provider_outage'),
    ...capItemsByText(getBudgetStatus(), COLLECTOR_CAPS.budget, 'budget'),
    ...capItemsByText(getUpdateCheckHealthItems(), COLLECTOR_CAPS.update_check, 'update_check'),
    ...capItemsByText(getUpdateRollbackItems(), COLLECTOR_CAPS.auto_rollback, 'auto_rollback'),
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

  // Stash the structured items (with their codes + agent scope) so
  // healer_propose can auto-fill provenance on the proposal it writes.
  // The persisted healer_diagnostics row only stores the human report
  // TEXT, not the codes, so this in-memory snapshot is the only place a
  // later caller can read the current run's codes. healer_propose fires
  // seconds after this during the same cycle, so the snapshot is fresh.
  latestDiagnosticSnapshot = { id, items, at: Date.now() };

  return { id, timestamp: now, items, criticalCount, warningCount, infoCount, reportText };
}

// ── Latest-run snapshot (for proposal provenance auto-fill) ──
// In-memory only; not persisted. Consumers must treat a missing/stale
// snapshot as "no auto-fill available" and fall back to model-supplied
// values.
let latestDiagnosticSnapshot: { id: string; items: DiagnosticItem[]; at: number } | null = null;

/**
 * Return the most recently compiled diagnostic snapshot if it is fresh
 * enough to trust for provenance auto-fill, otherwise null. Freshness
 * guards against tagging a proposal with a code from a run that is no
 * longer the current one (which could make the sweep auto-resolve it
 * early).
 */
export function getFreshDiagnosticSnapshot(maxAgeMs = 10 * 60 * 1000): { id: string; items: DiagnosticItem[] } | null {
  if (!latestDiagnosticSnapshot) return null;
  if (Date.now() - latestDiagnosticSnapshot.at > maxAgeMs) return null;
  return { id: latestDiagnosticSnapshot.id, items: latestDiagnosticSnapshot.items };
}

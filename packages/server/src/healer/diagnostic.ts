// Healer diagnostic report compiler: reads logs, DB state and agent health into a structured report.
// Engine-level, no LLM. Every collector is char-capped so the Healer never gets a runaway report; the
// total cycle-message budget is enforced in healer-agent.ts buildHealerCycleMessage.

import { getDb } from '../db/connection.js';
import { summaryCheckLine } from '../memory/summary-check.js';
import { HEALER_WORKING_STUCK_MINUTES, DORMANT_THRESHOLD_DAYS } from '../agent/stuck-thresholds.js';
// The ONE budget owner and the ONE spend reader. See getBudgetStatus.
import { getBudgets } from '../costs/budget.js';
import { getDailySpend } from '../costs/tracker.js';
import { createLogger } from '../logger.js';
import { v4 as uuidv4 } from 'uuid';
import { getRecurringToolErrors } from './recurring-tool-errors.js';
import { collect } from './collect-guard.js';
import { capItemsByText, capItemsShowingOmissions, type DiagnosticItem } from './item-cap.js';
export { capItemsByText, capItemsShowingOmissions };
export type { DiagnosticItem };
import { getVaultStats, getPoisonedArchiveStats } from '../vault/store.js';
import { getUpdateCheckHealth } from '../gateway/routes/update.js';
import { readMarker } from '../update-state.js';
import { taskScope, msToText } from '../work/tracker-view.js';
// "What counts as orphaned" has ONE definition, shared with the version-gap reconciliation pass.
import { ORPHANED_TASK_WHERE, ORPHANED_TASK_JOIN } from '../tracker/version-gap-reconcile.js';
import { workingExpr } from '../work/done/hold.js';
import { activeRuns } from '../agent/shared-state.js';

const logger = createLogger('healer-diagnostic');

// ── Vault dreaming health thresholds ──
// A silently dead Dreamer leaves archives unfiled while recall keeps serving the raw archives, so
// behaviour looks normal; these thresholds drive the items that surface it.
const DREAM_BACKLOG_INFO_THRESHOLD = 25;   // info: a fresh box's day-one backlog is expected; stay quiet
const DREAM_BACKLOG_WARN_THRESHOLD = 200;  // warning: a backlog this deep means the Dreamer is not keeping up
const DREAM_STALE_HOURS = 48;              // warning: an archive unfiled this long = >= 2 nightly cycles missed

// Per-collector char caps on the rendered items; over the cap the engine drops the lowest-severity
// items first and always keeps critical.
const COLLECTOR_CAPS = {
  agent_anomalies: 4000,
  error_digest: 2000,
  tracker_health: 2000,
  bulletproof_health: 1500,
  budget: 500,
  dream_health: 1500,
  update_check: 800,
  auto_rollback: 900,
} as const;

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

  // Agents in error or paused state; dormant agents (no activity in 7+ days) are skipped to avoid
  // false alarms from old test groups or paused projects.
  const troubled = db.prepare(`
    SELECT id, name, status, updated_at FROM agents
    WHERE status IN ('error', 'paused', 'rate_limited')
      AND status != 'terminated' AND instr(COALESCE(last_error, ''), '[budget_stop]') != 1 AND instr(COALESCE(last_error, ''), '[no_model_fits]') != 1  -- t148: a parked agent is not an injury
  `).all() as Array<{ id: string; name: string; status: string; updated_at: string }>;

  // From the one stuck-threshold table (7 days).
  const DORMANT_THRESHOLD_MS = DORMANT_THRESHOLD_DAYS * 86400000;
  for (const agent of troubled) {
    // Dormant means no messages in 7+ days, unless the status was updated recently (a restart set it
    // to error), which is a real issue even when messages are old.
    const agentUpdatedMs = new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z').getTime();
    const statusIsRecent = (Date.now() - agentUpdatedMs) < DORMANT_THRESHOLD_MS;
    if (!statusIsRecent) {
      const lastMsg = db.prepare(
        `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
      ).get(agent.id) as { created_at: string } | undefined;
      if (lastMsg) {
        const lastTs = lastMsg.created_at.includes('Z') ? lastMsg.created_at : lastMsg.created_at + 'Z';
        if (Date.now() - new Date(lastTs).getTime() >= DORMANT_THRESHOLD_MS) continue; // dormant, skip
      } else {
        continue; // no messages at all, skip
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

  // Agents stuck in working state; the threshold is the one healer-agent.ts's self-watchdog also uses.
  const stuck = db.prepare(`
    SELECT id, name, updated_at FROM agents
    WHERE status = 'working'
      AND updated_at < datetime('now', '-${HEALER_WORKING_STUCK_MINUTES} minutes')
  `).all() as Array<{ id: string; name: string; updated_at: string }>;

  for (const agent of stuck) {
    if (activeRuns.has(agent.id)) continue;   // a run live in this process is working, however long the turn
    // Skip dormant agents unless their status was updated recently (a restart set them to working).
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

function getTrackerHealth(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  // Tasks stuck in_progress for >24h
  const staleTasks = db.prepare(`
    SELECT t.id, t.title, t.agent_id AS assigned_to, ${msToText('t.updated_at')} AS updated_at,
           a.name as agent_name, a.status as agent_status
    FROM work t
    LEFT JOIN agents a ON a.id = t.agent_id
    WHERE ${taskScope('t')} AND ${workingExpr('t')}
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

  // Tasks assigned to terminated agents. Predicate and JOIN come from the shared definition (also used by
  // the version-gap pass and the auto-fix), which keys on the assignee so all three agree on what is orphaned.
  const orphanedTasks = db.prepare(`
    SELECT t.id, t.title, t.assignee_agent AS assigned_to, a.name as agent_name
    FROM work t
    ${ORPHANED_TASK_JOIN('t', 'a')}
    WHERE ${ORPHANED_TASK_WHERE('t', 'a')}
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

  return items;
}

// ── Bulletproof tool diagnostics ──
// Catch stragglers the tool hardening missed (legacy data, code paths that bypassed the helpers) and
// surface them as healer proposals instead of silent breaks.

function getBulletproofToolHealth(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  // 1. Apprentice split-brain: agent idle/working but its assigned task is already complete (the
  //    completeAgent fallback in spawner.ts fixes new cases; this catches stragglers and regressions).
  //    Persistent agents (config.persist=true or agent_type='persistent') are excluded: they stay alive on
  //    purpose for their next scheduled fire. The persist signal lives in agents.config JSON (json_extract).
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

  // 2. Idle apprentices with assigned tasks that were never poked (a caller may have spawned with
  //    auto_start: false and forgotten to wake the agent); flagged at 30+ min so quick test runs stay quiet.
  const neverPoked = db.prepare(`
    SELECT a.id, a.name, t.title as task_title, t.id as task_id, a.created_at
    FROM agents a
    JOIN work t ON t.agent_id = a.id AND ${taskScope('t')}
    WHERE a.status = 'idle'
      AND a.classification = 'apprentice'
      AND ${workingExpr('t', true)}
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

  // Vault dreaming health is its own collector (getDreamHealth), keyed off archive age.

  return items;
}

// ── Vault dreaming health ──
// Surfaces a silently dead Dreamer with two independent signals:
//   DREAM_BACKLOG (volume): unprocessed archives past a count (info at >= 25, warning at >= 200).
//   DREAM_STALE (age): the OLDEST unprocessed archive is older than DREAM_STALE_HOURS. Keying on age, not a
//   count or lastDreamAt, stays quiet on a fresh box, trips on a box that never dreamed, and catches a
//   poison archive that a recent successful cycle keeps skipping.
// The Healer cannot start the Dreamer (dreamer_run_now is primary-only, agent/tools/gates.ts), so the
// warning steers it to notify the owner and ask the main agent; it must NOT propose swapping the model.
function getDreamHealth(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];

  const stats = getVaultStats();
  const backlog = stats.unprocessedArchives; // already excludes poisoned rows
  // Poisoned archives are computed up front so their signal survives even when the backlog is 0.
  const poison = getPoisonedArchiveStats();
  if (backlog === 0 && poison.count === 0) return items; // nothing unfiled or parked, nothing to report

  // Age of the OLDEST unprocessed archive in hours (julianday keeps both sides in UTC). Poisoned archives
  // are excluded: a parked one stays is_processed=0 forever and would permanently trip DREAM_STALE.
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
  if (oldestHours >= DREAM_STALE_HOURS) {
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
  // Info at >= 25 keeps a fresh box quiet; the warning tier at >= 200 applies only when dreaming is enabled.
  if (backlog >= DREAM_BACKLOG_WARN_THRESHOLD) {
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

  // ── DREAM_POISONED ──
  // An archive that failed MAX_DREAM_ATTEMPTS terminal passes is parked: excluded from the work queue, the
  // backlog and the DREAM_STALE age, and surfaced here so a human sees it. Not gated on dreaming being on.
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

// Shared transient-provider-error SQL predicate on the `a` (agents) alias: 5xx / overloaded / network-reset
// last_error strings are a provider fault, not a per-agent one. injury-recovery's provider-pattern dedup
// imports this exact filter so the two outage predicates cannot drift apart.
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

// Provider-wide outage detector: 3+ agents on one provider with transient errors (5xx / network /
// overloaded) in the last hour is a provider problem, so the Healer should propose failover.
function getProviderOutagePatterns(): DiagnosticItem[] {
  const db = getDb();
  const items: DiagnosticItem[] = [];
  try {
    // Agents with a transient last_error in the last hour, grouped by provider.
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

// The budget item keeps no ledger of its own: the limit comes from costs/budget.ts and the spend from
// costs/tracker.ts. getDailySpend() is a ROLLING 24 HOURS, the window the budget wall enforces, so the
// health page and the wall answer the same question.
function getBudgetStatus(): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];

  try {
    const limit = getBudgets().global?.limitUsd;
    // No budget configured is not a fault: say nothing rather than invent a cap.
    if (limit === undefined || !(limit > 0)) return items;
    const spend = getDailySpend();

    const percentage = (spend / limit) * 100;
    items.push({
      severity: percentage > 80 ? 'warning' : 'info',
      code: percentage > 80 ? 'BUDGET_HIGH' : 'BUDGET_OK',
      title: percentage > 80
        ? `Spending is getting close to the daily limit ($${spend.toFixed(2)} of $${limit})`
        : `Spending is normal ($${spend.toFixed(2)} of $${limit} daily limit)`,
      detail: percentage > 80
        ? `The dojo has used ${percentage.toFixed(0)}% of today's budget. Agents may be slowed or stopped if the limit is reached.`
        : `Everything is within the daily budget. No action needed.`,
    });
  } catch { /* budget tracking may not be set up */ }

  return items;
}

// ── Update-check pipeline health ──
// The daily update check never throws; a failing pipeline just returns an error, so a box can silently
// miss updates for weeks. update.ts stamps a failing-since anchor past UPDATE_CHECK_FAILURE_THRESHOLD and
// this surfaces it as a notify-only warning: a health signal that the CHECK is broken, not an update
// notice. The Healer must NOT try to force an update from it.
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

// ── Self-update auto-rollback state ──
// A durable, dashboard-visible signal for the watchdog's auto-rollback of a self-update that fails to boot
// (the watchdog's iMessage is the primary owner signal). Reads the ~/.dojo/update-state.json marker:
//   rolled-back        -> the box undid a bad update and is on the previous build
//   failed-permanently -> a failed update could not be safely undone; needs a person
//   interrupted        -> the installer was cut off before it changed anything; info only
// A healthy/idle/pending marker produces no item. Notify-only: the Healer must NOT force an update.
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
          `A recent dojo update did not boot correctly, and the system could not undo it automatically (the watchdog ` +
          `told the owner why). The box may keep restarting or stay on a version that will not run. ` +
          `This needs a person: open the dojo dashboard and restore a previous version from the update screen, or ` +
          `get help. Let the owner know in plain language that a dojo update failed and the box needs manual ` +
          `attention. Do NOT try to force another update.`,
      });
    } else if (marker.phase === 'interrupted') {
      // Cut off before anything switched: info only (the watchdog texts the owner once, then idles it).
      items.push({
        severity: 'info',
        code: 'UPDATE_INTERRUPTED',
        title: 'A dojo update was interrupted before it changed anything',
        detail:
          `A recent dojo update was cut off before it switched anything over. Nothing was changed: the box is still ` +
          `running its previous version${marker.previousVersion ? ` (version ${marker.previousVersion})` : ''}, exactly as it ` +
          `was. Nothing needs fixing; if it comes up, tell the owner they can run the update again whenever they like. ` +
          `Do NOT force an update and do NOT try to roll anything back.`,
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

/** The summary check's running numbers, when anything was checked. */
function summaryCheckItems(): DiagnosticItem[] {
  const line = summaryCheckLine();
  return line ? [{ severity: 'info', code: 'summary_check', title: 'The summary check', detail: line }] : [];
}

// ── Main Compiler ──

export function compileDiagnosticReport(): DiagnosticReport {
  // Per-collector caps keep a runaway collector from drowning the report (warning/info items drop
  // first); each check runs in `collect`, so one that throws shows as a warning instead of sinking it.
  const items: DiagnosticItem[] = [
    ...collect('agent status', () => capItemsShowingOmissions(getAgentStatusAnomalies(), COLLECTOR_CAPS.agent_anomalies, 'agent_anomalies')),
    ...collect('error digest', () => capItemsShowingOmissions(getErrorDigest(), COLLECTOR_CAPS.error_digest, 'error_digest')),
    ...collect('tracker health', () => capItemsShowingOmissions(getTrackerHealth(), COLLECTOR_CAPS.tracker_health, 'tracker_health')),
    ...collect('tool health', () => capItemsShowingOmissions(getBulletproofToolHealth(), COLLECTOR_CAPS.bulletproof_health, 'bulletproof_health')),
    ...collect('recurring tool errors', getRecurringToolErrors),   // uncapped: a cap drops a whole section
    ...collect('dream health', () => capItemsShowingOmissions(getDreamHealth(), COLLECTOR_CAPS.dream_health, 'dream_health')),
    ...collect('provider outage', () => capItemsShowingOmissions(getProviderOutagePatterns(), 1500, 'provider_outage')),
    ...collect('budget', () => capItemsShowingOmissions(getBudgetStatus(), COLLECTOR_CAPS.budget, 'budget')),
    ...collect('update check', () => capItemsShowingOmissions(getUpdateCheckHealthItems(), COLLECTOR_CAPS.update_check, 'update_check')),
    ...collect('automatic rollback', () => capItemsShowingOmissions(getUpdateRollbackItems(), COLLECTOR_CAPS.auto_rollback, 'auto_rollback')),
    ...collect('summary check', () => summaryCheckItems()),
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

  // Stash the structured items (codes plus agent scope) so healer_propose, firing seconds later in the same
  // cycle, can auto-fill provenance; the persisted report row stores only the text, not the codes.
  latestDiagnosticSnapshot = { id, items, at: Date.now() };

  return { id, timestamp: now, items, criticalCount, warningCount, infoCount, reportText };
}

// ── Latest-run snapshot (for proposal provenance auto-fill) ──
// In-memory only. A missing or stale snapshot means no auto-fill: callers fall back to model-supplied values.
let latestDiagnosticSnapshot: { id: string; items: DiagnosticItem[]; at: number } | null = null;

/**
 * The latest compiled snapshot if it is fresh enough to trust for provenance auto-fill, else null: a stale
 * one could tag a proposal with a code from a run that is no longer current and make the sweep resolve it early.
 */
export function getFreshDiagnosticSnapshot(maxAgeMs = 10 * 60 * 1000): { id: string; items: DiagnosticItem[] } | null {
  if (!latestDiagnosticSnapshot) return null;
  if (Date.now() - latestDiagnosticSnapshot.at > maxAgeMs) return null;
  return { id: latestDiagnosticSnapshot.id, items: latestDiagnosticSnapshot.items };
}

// Healer Tier 1 auto-fixes: deterministic repairs that need no LLM reasoning, run before the
// Healer agent's LLM cycle.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
// The orphan definition (predicate and join key) comes from its one source.
import { ORPHANED_TASK_JOIN, ORPHANED_TASK_WHERE } from '../tracker/version-gap-reconcile.js';
import { broadcast } from '../gateway/ws.js';
// The Healer's status resets go through the one status writer; the broadcast stays at each site.
import { writeAgentStatus } from '../agent/agent-status.js';
// activeRuns is the in-memory concurrency guard. shared-state.ts is a leaf module (imports only the
// logger), so importing it here cannot form a cycle with agent/runtime.ts.
import { activeRuns } from '../agent/shared-state.js';
import { v4 as uuidv4 } from 'uuid';
import type { DiagnosticItem } from './diagnostic.js';
import { setTrackerStatus } from '../work/tracker-store.js';
import { workSettled } from '../work/store.js';
import { writeAssignee } from '../work/row-authority.js';
import { recordMove } from '../work/move-record.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE } from '../agent/stream-patience.js';
import { holdOf } from '../work/done/hold.js';
import { endRoomWaitsThatFit } from '../memory/writer.js';

const logger = createLogger('healer-autofix');

interface AutoFixResult {
  applied: boolean;
  description: string;
  agentId?: string;
}

// A status write alone leaves the Healer suppression window, wake and grace timers and the injury toast
// stale. onAgentRecovered with 'cooldown' clears those (harmless for a never-injured agent) but withholds
// the evidence-only clears (attempt ladder, error text, doomed-dial marker): a clock is not evidence.
function clearRecoveryBookkeeping(agentId: string): void {
  import('./injury-recovery.js')
    .then((m) => { try { m.onAgentRecovered(agentId, 'cooldown'); } catch { /* best effort */ } })
    .catch(() => { /* best effort */ });
}

/**
 * May a cooldown sweep touch this agent at all? Not when its last failure was a declared-patience
 * refusal: a fresh start cannot fix it, and clearing it every half hour would hide the honest error.
 */
function cooldownSweepMayRecover(agentId: string): { ok: true } | { ok: false; why: string } {
  try {
    const row = getDb().prepare('SELECT last_error FROM agents WHERE id = ?').get(agentId) as
      | { last_error: string | null } | undefined;
    const lastError = row?.last_error ?? '';
    if (lastError.includes(DECLARED_PATIENCE_EXCEEDED_CODE)) {
      return {
        ok: false,
        why: 'its last failure was a declared-patience refusal, which a restart cannot fix: '
          + 'the request cannot finish inside the patience this provider declares, so the honest '
          + 'error stays visible instead of being cleared every 30 minutes',
      };
    }
    return { ok: true };
  } catch {
    // Unreadable row: do not invent permission; leave the agent as the human last saw it.
    return { ok: false, why: 'its last error could not be read, so the sweep made no claim about it' };
  }
}

// Frequent sweep: every 5 minutes, outside the daily Healer cycle. Status recovery only (long-paused,
// long-errored); the other auto-fixes need the full diagnostic and stay in the daily cycle.
// Stuck-working recovery lives in runtime.ts recoverStuckAgents.

const FREQUENT_AUTOFIX_INTERVAL_MS = 5 * 60 * 1000;
const PAUSED_COOLDOWN_MS = 30 * 60 * 1000;
const ERROR_COOLDOWN_MS = 30 * 60 * 1000;
let frequentAutoFixTimer: ReturnType<typeof setInterval> | null = null;

export function runFrequentAutoFixes(): void {
  // The heartbeat is DEBUG: only actual recoveries log at INFO (each also gets a healer_actions row).
  logger.debug('Frequent auto-fix sweep firing');
  try {
    const db = getDb();

    void endRoomWaitsThatFit();   // a summary writer refused for low memory is asked again once memory is free

    // Long-paused agents (status='paused' for >30 min).
    const longPaused = db.prepare(`
      SELECT id, name, status, updated_at FROM agents
      WHERE status = 'paused' AND instr(COALESCE(last_error, ''), '[budget_stop]') != 1 AND instr(COALESCE(last_error, ''), '[no_model_fits]') != 1  -- t148: a clock is not evidence a parked agent's condition cleared
        AND updated_at < datetime('now', '-${PAUSED_COOLDOWN_MS / 1000} seconds')
    `).all() as Array<{ id: string; name: string; status: string; updated_at: string }>;

    for (const a of longPaused) {
      // Same cause check as the daily-cycle fixer: a clock is not evidence the refusal cleared.
      const mayPaused = cooldownSweepMayRecover(a.id);
      if (!mayPaused.ok) {
        logger.info('frequent auto-fix: declining to restart a paused agent', { agentId: a.id, why: mayPaused.why });
        continue;
      }
      writeAgentStatus(a.id, 'idle');
      broadcast({ type: 'agent:status', agentId: a.id, status: 'idle' });
      logger.info('Frequent auto-fix: resumed long-paused agent', {
        agentId: a.id, agentName: a.name, pausedSince: a.updated_at,
      });
      void persistAction(`Resumed ${a.name} — it had been paused for over 30 minutes`, 'success', a.id);
      clearRecoveryBookkeeping(a.id);
    }

    // Long-errored agents (status='error' for >30 min).
    const longErrored = db.prepare(`
      SELECT id, name, status, updated_at FROM agents
      WHERE status = 'error'
        AND updated_at < datetime('now', '-${ERROR_COOLDOWN_MS / 1000} seconds')
    `).all() as Array<{ id: string; name: string; status: string; updated_at: string }>;

    for (const a of longErrored) {
      // Same cause check as the daily-cycle fixer: a clock is not evidence the refusal cleared.
      const mayError = cooldownSweepMayRecover(a.id);
      if (!mayError.ok) {
        logger.info('frequent auto-fix: declining to reset an errored agent', { agentId: a.id, why: mayError.why });
        continue;
      }
      writeAgentStatus(a.id, 'idle');
      broadcast({ type: 'agent:status', agentId: a.id, status: 'idle' });
      logger.info('Frequent auto-fix: reset long-errored agent', {
        agentId: a.id, agentName: a.name, erroredSince: a.updated_at,
      });
      void persistAction(`Reset ${a.name}: it had been in an error state for over 30 minutes`, 'success', a.id);
      clearRecoveryBookkeeping(a.id);
    }
  } catch (err) {
    logger.error('runFrequentAutoFixes failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function persistAction(description: string, result: string, agentId: string | null): Promise<void> {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO healer_actions (id, category, description, action_taken, result, agent_id, created_at)
      VALUES (?, 'frequent_autofix', ?, 'auto_reset_status', ?, ?, datetime('now'))
    `).run(uuidv4(), description, result, agentId);
  } catch (err) {
    logger.warn('persistAction failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startFrequentAutoFixes(): void {
  if (frequentAutoFixTimer) return;
  frequentAutoFixTimer = setInterval(runFrequentAutoFixes, FREQUENT_AUTOFIX_INTERVAL_MS);
  setTimeout(runFrequentAutoFixes, 60_000); // first run 1 min after start
  logger.info('Frequent auto-fix sweep started', { intervalMs: FREQUENT_AUTOFIX_INTERVAL_MS });
}

// ── Individual Fix Functions ──

function fixStuckAgent(item: DiagnosticItem): AutoFixResult {
  if (item.code !== 'STUCK_AGENT' || !item.agentId) return { applied: false, description: '' };

  // Never reap a run THIS process knows is live: flipping the row to 'idle' under a running turn lets a
  // new inbound start a SECOND concurrent turn on the same context. Mirrors the recoverStuckAgents guard.
  if (activeRuns.has(item.agentId)) {
    logger.warn('Auto-fix STUCK_AGENT: row is stale but run is live in-process, not resetting', {
      agentId: item.agentId, agentName: item.agentName,
    });
    return { applied: false, description: '' };
  }

  writeAgentStatus(item.agentId, 'idle');
  broadcast({ type: 'agent:status', agentId: item.agentId, status: 'idle' });
  clearRecoveryBookkeeping(item.agentId);

  return {
    applied: true,
    description: `Unfroze ${item.agentName ?? item.agentId}: it was stuck and not responding`,
    agentId: item.agentId,
  };
}

function fixPausedAgent(item: DiagnosticItem): AutoFixResult {
  if (item.code !== 'AGENT_PAUSED' || !item.agentId) return { applied: false, description: '' };

  // Only resume if the agent has been paused for >30 minutes (cooldown period)
  const db = getDb();
  const agent = db.prepare('SELECT updated_at FROM agents WHERE id = ?').get(item.agentId) as { updated_at: string } | undefined;
  if (!agent) return { applied: false, description: '' };

  const pausedMs = Date.now() - new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z').getTime();
  if (pausedMs < 30 * 60 * 1000) {
    return { applied: false, description: `${item.agentName} was paused recently, so it gets time to cool down before a restart` };
  }

  // Read the cause BEFORE writing status, so a fault a restart cannot fix keeps its diagnostic.
  const mayPaused = cooldownSweepMayRecover(item.agentId);
  if (!mayPaused.ok) {
    logger.info('frequent auto-fix: declining to restart a paused agent', { agentId: item.agentId, why: mayPaused.why });
    return { applied: false, description: `${item.agentName ?? item.agentId} was left paused: ${mayPaused.why}` };
  }

  writeAgentStatus(item.agentId, 'idle');
  broadcast({ type: 'agent:status', agentId: item.agentId, status: 'idle' });
  clearRecoveryBookkeeping(item.agentId);

  return {
    applied: true,
    description: `Restarted ${item.agentName ?? item.agentId}: it was paused after repeated errors and has had time to recover`,
    agentId: item.agentId,
  };
}

function fixErrorAgent(item: DiagnosticItem): AutoFixResult {
  if (item.code !== 'AGENT_ERROR' || !item.agentId) return { applied: false, description: '' };

  // Only reset error agents that have been in error state for >30 minutes
  const db = getDb();
  const agent = db.prepare('SELECT updated_at FROM agents WHERE id = ?').get(item.agentId) as { updated_at: string } | undefined;
  if (!agent) return { applied: false, description: '' };

  const errorMs = Date.now() - new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z').getTime();
  if (errorMs < 30 * 60 * 1000) {
    return { applied: false, description: '' };
  }

  // Same cause check as the paused arm.
  const mayError = cooldownSweepMayRecover(item.agentId);
  if (!mayError.ok) {
    logger.info('frequent auto-fix: declining to reset an errored agent', { agentId: item.agentId, why: mayError.why });
    return { applied: false, description: `${item.agentName ?? item.agentId} was left in error: ${mayError.why}` };
  }

  writeAgentStatus(item.agentId, 'idle');
  broadcast({ type: 'agent:status', agentId: item.agentId, status: 'idle' });
  clearRecoveryBookkeeping(item.agentId);

  return {
    applied: true,
    description: `Restarted ${item.agentName ?? item.agentId}: it had been in an error state and needed a fresh start`,
    agentId: item.agentId,
  };
}

function fixOrphanedTask(item: DiagnosticItem): AutoFixResult {
  if (item.code !== 'ORPHANED_TASK') return { applied: false, description: '' };

  // Unassign tasks from terminated agents: a paused hold stays (the owner paused it on purpose); any
  // other task returns to on_deck through a recorded transition. The ASSIGNEE is cleared and the
  // holder kept (work.agent_id is NOT NULL, so nulling it aborts). ORPHANED_TASK_JOIN/_WHERE (shared with
  // diagnostic.ts) key on the assignee, so a cleared row is no longer selected and the diagnostic agrees.
  const db = getDb();
  const orphans = db.prepare(`
    SELECT w.id AS id, w.assignee_agent AS assignee
      FROM work w ${ORPHANED_TASK_JOIN('w', 'a')}
     WHERE ${ORPHANED_TASK_WHERE('w', 'a')}
  `).all() as Array<{ id: string; assignee: string }>;
  let changed = 0;
  for (const o of orphans) {
    // One failing row must not end the sweep: a per-row fault is caught and logged.
    try {
      if (holdOf(o.id)?.kind !== 'paused') {
        const r = setTrackerStatus(o.id, 'on_deck', {
          by: 'healer', actorId: 'healer',
          reason: 'assigned agent no longer exists; returned to the deck for reassignment',
        });
        if (!workSettled(r)) continue;
      }
      // The gate's one writer clears the assignee (an agent and a group assignee exclude each other),
      // and the move is recorded like every move.
      if (writeAssignee(o.id, { clear: true }) === 0) continue;
      recordMove({ taskId: o.id, actor: 'healer', from: o.assignee, to: null, cause: 'assignee_gone', door: 'healer orphan sweep' });
      changed++;
    } catch (err) {
      logger.warn('healer: could not unassign one orphaned task; the rest of the sweep continues', {
        taskId: o.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const orphaned = { changes: changed };

  if (orphaned.changes > 0) {
    return {
      applied: true,
      description: `Unassigned ${orphaned.changes} task(s) that were stuck on agents that no longer exist`,
    };
  }

  return { applied: false, description: '' };
}


// ── Fix Dispatcher ──

const FIX_MAP: Record<string, (item: DiagnosticItem) => AutoFixResult> = {
  STUCK_AGENT: fixStuckAgent,
  AGENT_PAUSED: fixPausedAgent,
  AGENT_ERROR: fixErrorAgent,
  ORPHANED_TASK: fixOrphanedTask,
};

// ── Main Entry Point ──

export function runAutoFixes(diagnosticId: string, items: DiagnosticItem[]): { fixCount: number; fixes: string[] } {
  const db = getDb();
  const fixes: string[] = [];
  let fixCount = 0;

  for (const item of items) {
    const fixer = FIX_MAP[item.code];
    if (!fixer) continue;

    try {
      const result = fixer(item);
      if (result.applied) {
        fixCount++;
        fixes.push(result.description);

        db.prepare(`
          INSERT INTO healer_actions (id, diagnostic_id, category, description, agent_id, action_taken, result, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'success', datetime('now'))
        `).run(uuidv4(), diagnosticId, item.code, result.description, result.agentId ?? null, item.code);

        logger.info('Auto-fix applied', {
          category: item.code,
          description: result.description,
          agentId: result.agentId,
        });
      }
    } catch (err) {
      logger.error('Auto-fix failed', {
        category: item.code,
        error: err instanceof Error ? err.message : String(err),
      });

      db.prepare(`
        INSERT INTO healer_actions (id, diagnostic_id, category, description, agent_id, action_taken, result, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'failed', datetime('now'))
      `).run(uuidv4(), diagnosticId, item.code, `Failed: ${err instanceof Error ? err.message : String(err)}`, item.agentId ?? null, item.code);
    }
  }

  // No per-cycle note to the primary: this also runs on the 5-minute cadence, and the daily heartbeat
  // (runHealingCycle) reports routine fixes. Per-fix detail lives in healer_actions.

  logger.info('Auto-fix cycle complete', { fixCount, diagnosticId });
  return { fixCount, fixes };
}

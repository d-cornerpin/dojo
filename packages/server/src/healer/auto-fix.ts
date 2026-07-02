// ════════════════════════════════════════
// Healer Auto-Fix Engine (Tier 1)
//
// Deterministic fixes that don't need LLM reasoning.
// These run BEFORE the Healer agent's LLM cycle.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { v4 as uuidv4 } from 'uuid';
import { sanitizeMessagesOnModelChange } from '../agent/model-switch.js';
import type { DiagnosticItem } from './diagnostic.js';

const logger = createLogger('healer-autofix');

interface AutoFixResult {
  applied: boolean;
  description: string;
  agentId?: string;
}

// ── v2.3.19 (error-handling-spec Phase 4) — frequent auto-fix sweep ──
//
// Runs every 5 minutes engine-level, bypassing the daily Healer cycle.
// Targets the deterministic status-recovery fixes only (stuck-working,
// long-paused, long-errored). Other auto-fixes (orphaned messages,
// orphaned tasks/projects) need the full diagnostic and stay in the
// daily cycle.
//
// This replaces the pre-spec "wait until 04:00 for a stuck agent to be
// unstuck" behavior. Stuck-working detection (>10 min) was already at
// runtime.ts:recoverStuckAgents on 5-min cadence; this adds the long-
// paused (>30 min) and long-errored (>30 min) recovery to the same
// cadence.

const FREQUENT_AUTOFIX_INTERVAL_MS = 5 * 60 * 1000;
const PAUSED_COOLDOWN_MS = 30 * 60 * 1000;
const ERROR_COOLDOWN_MS = 30 * 60 * 1000;
let frequentAutoFixTimer: ReturnType<typeof setInterval> | null = null;

export function runFrequentAutoFixes(): void {
  // v2.5.8 — Heartbeat demoted to DEBUG. Pre-spec we logged at INFO so a
  // silent sweep could be distinguished from a dead timer. That concern
  // was a one-time debugging need; in production it just spams the Health
  // page log viewer every 5 min with no actionable information. The
  // actual recoveries below (resumed/reset paths) still log at INFO, AND
  // get their own healer_actions DB row — those are the only events worth
  // surfacing. The startup log in startFrequentAutoFixes still confirms
  // the timer kicked off.
  logger.debug('Frequent auto-fix sweep firing');
  try {
    const db = getDb();
    const now = Date.now();

    // Long-paused agents (status='paused' for >30 min).
    const longPaused = db.prepare(`
      SELECT id, name, status, updated_at FROM agents
      WHERE status = 'paused'
        AND updated_at < datetime('now', '-${PAUSED_COOLDOWN_MS / 1000} seconds')
    `).all() as Array<{ id: string; name: string; status: string; updated_at: string }>;

    for (const a of longPaused) {
      db.prepare(`UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?`).run(a.id);
      broadcast({ type: 'agent:status', agentId: a.id, status: 'idle' });
      logger.info('Frequent auto-fix: resumed long-paused agent', {
        agentId: a.id, agentName: a.name, pausedSince: a.updated_at,
      });
      void persistAction(`Resumed ${a.name} — it had been paused for over 30 minutes`, 'success', a.id);
    }

    // Long-errored agents (status='error' for >30 min).
    const longErrored = db.prepare(`
      SELECT id, name, status, updated_at FROM agents
      WHERE status = 'error'
        AND updated_at < datetime('now', '-${ERROR_COOLDOWN_MS / 1000} seconds')
    `).all() as Array<{ id: string; name: string; status: string; updated_at: string }>;

    for (const a of longErrored) {
      db.prepare(`UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?`).run(a.id);
      broadcast({ type: 'agent:status', agentId: a.id, status: 'idle' });
      logger.info('Frequent auto-fix: reset long-errored agent', {
        agentId: a.id, agentName: a.name, erroredSince: a.updated_at,
      });
      void persistAction(`Reset ${a.name} — it had been in error state for over 30 minutes`, 'success', a.id);
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

  const db = getDb();
  db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(item.agentId);
  broadcast({ type: 'agent:status', agentId: item.agentId, status: 'idle' });

  return {
    applied: true,
    description: `Unfroze ${item.agentName ?? item.agentId} — it was stuck and not responding`,
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
    return { applied: false, description: `${item.agentName} was paused recently — giving it time to cool down before restarting` };
  }

  db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(item.agentId);
  broadcast({ type: 'agent:status', agentId: item.agentId, status: 'idle' });

  return {
    applied: true,
    description: `Restarted ${item.agentName ?? item.agentId} — it was paused after repeated errors but has had time to recover`,
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

  db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(item.agentId);
  broadcast({ type: 'agent:status', agentId: item.agentId, status: 'idle' });

  return {
    applied: true,
    description: `Restarted ${item.agentName ?? item.agentId} — it had been in an error state and needed a fresh start`,
    agentId: item.agentId,
  };
}

function fixOrphanedToolMessages(item: DiagnosticItem): AutoFixResult {
  if (item.code !== 'ORPHANED_TOOL_MESSAGES' || !item.agentId) return { applied: false, description: '' };

  const result = sanitizeMessagesOnModelChange(item.agentId);

  if (result.collapsed > 0) {
    return {
      applied: true,
      description: `Cleaned up ${result.collapsed} corrupted message(s) in ${item.agentName ?? item.agentId}'s conversation`,
      agentId: item.agentId,
    };
  }

  return { applied: false, description: '' };
}

function fixOrphanedTask(item: DiagnosticItem): AutoFixResult {
  if (item.code !== 'ORPHANED_TASK') return { applied: false, description: '' };

  // Unassign tasks from terminated agents. Paused tasks stay paused
  // (the user explicitly paused them — don't silently unpause).
  // Non-paused tasks move to on_deck so they can be reassigned.
  const db = getDb();
  const unpaused = db.prepare(`
    UPDATE tasks SET assigned_to = NULL, status = 'on_deck', updated_at = datetime('now')
    WHERE assigned_to IN (SELECT id FROM agents WHERE status = 'terminated')
      AND status IN ('in_progress', 'on_deck')
  `).run();
  const pausedOrphans = db.prepare(`
    UPDATE tasks SET assigned_to = NULL, updated_at = datetime('now')
    WHERE assigned_to IN (SELECT id FROM agents WHERE status = 'terminated')
      AND status = 'paused'
  `).run();
  const orphaned = { changes: unpaused.changes + pausedOrphans.changes };

  if (orphaned.changes > 0) {
    return {
      applied: true,
      description: `Unassigned ${orphaned.changes} task(s) that were stuck on agents that no longer exist`,
    };
  }

  return { applied: false, description: '' };
}

function fixOrphanedProject(item: DiagnosticItem): AutoFixResult {
  if (item.code !== 'ORPHANED_PROJECT') return { applied: false, description: '' };

  const db = getDb();
  const updated = db.prepare(`
    UPDATE projects SET status = 'complete', completed_at = datetime('now'), updated_at = datetime('now')
    WHERE status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.project_id = projects.id AND t.status NOT IN ('complete', 'fallen')
      )
      AND EXISTS (SELECT 1 FROM tasks t2 WHERE t2.project_id = projects.id)
  `).run();

  if (updated.changes > 0) {
    return {
      applied: true,
      description: `Closed out ${updated.changes} project(s) that were already finished but hadn't been marked complete`,
    };
  }

  return { applied: false, description: '' };
}

function fixStaleRateLimit(item: DiagnosticItem): AutoFixResult {
  if (item.code !== 'AGENT_RATE_LIMITED' || !item.agentId) return { applied: false, description: '' };

  // Only clear if rate limited for >1 hour
  const db = getDb();
  const agent = db.prepare('SELECT updated_at FROM agents WHERE id = ? AND status = ?').get(item.agentId, 'rate_limited') as { updated_at: string } | undefined;
  if (!agent) return { applied: false, description: '' };

  const limitedMs = Date.now() - new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z').getTime();
  if (limitedMs < 60 * 60 * 1000) {
    return { applied: false, description: '' };
  }

  db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(item.agentId);
  broadcast({ type: 'agent:status', agentId: item.agentId, status: 'idle' });

  return {
    applied: true,
    description: `Cleared the throttle on ${item.agentName ?? item.agentId} — the AI provider stopped slowing it down`,
    agentId: item.agentId,
  };
}

// ── Fix Dispatcher ──

const FIX_MAP: Record<string, (item: DiagnosticItem) => AutoFixResult> = {
  STUCK_AGENT: fixStuckAgent,
  AGENT_PAUSED: fixPausedAgent,
  AGENT_ERROR: fixErrorAgent,
  ORPHANED_TOOL_MESSAGES: fixOrphanedToolMessages,
  ORPHANED_TASK: fixOrphanedTask,
  ORPHANED_PROJECT: fixOrphanedProject,
  AGENT_RATE_LIMITED: fixStaleRateLimit,
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

        // Log to healer_actions table
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

      // Log failure
      db.prepare(`
        INSERT INTO healer_actions (id, diagnostic_id, category, description, agent_id, action_taken, result, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'failed', datetime('now'))
      `).run(uuidv4(), diagnosticId, item.code, `Failed: ${err instanceof Error ? err.message : String(err)}`, item.agentId ?? null, item.code);
    }
  }

  // NOTE: the per-cycle "applied N fixes — nothing needs your attention" note to the
  // primary was REMOVED here. It is superseded by the Healer's single once-daily health
  // heartbeat (runHealingCycle Step 5), which reports "all systems operational" (or what
  // needs attention) exactly once per day and folds the routine-fix count into that. The
  // full per-fix detail remains in the healer_actions table (the vitals panel reads it).
  // runAutoFixes ALSO runs on the 5-minute frequent cadence, where a note every few
  // minutes would itself be the firehose we're removing.

  logger.info('Auto-fix cycle complete', { fixCount, diagnosticId });
  return { fixCount, fixes };
}

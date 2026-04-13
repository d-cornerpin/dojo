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
import { getPrimaryAgentId } from '../config/platform.js';
import type { DiagnosticItem } from './diagnostic.js';

const logger = createLogger('healer-autofix');

interface AutoFixResult {
  applied: boolean;
  description: string;
  agentId?: string;
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

  // Extract task info from the detail — unassign the task
  const db = getDb();
  // Find tasks assigned to terminated agents
  const orphaned = db.prepare(`
    UPDATE tasks SET assigned_to = NULL, status = 'on_deck', updated_at = datetime('now')
    WHERE assigned_to IN (SELECT id FROM agents WHERE status = 'terminated')
      AND status IN ('in_progress', 'on_deck')
  `).run();

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

  // Notify primary agent of auto-fixes (if any)
  if (fixCount > 0) {
    try {
      const primaryId = getPrimaryAgentId();
      const msgId = uuidv4();
      const content = `[SOURCE: HEALER AUTO-FIX REPORT — automated maintenance, not a message from the user. No reply needed.]\n\nThe Healer performed ${fixCount} automatic fix(es):\n${fixes.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nNo action needed — these are routine maintenance tasks.`;

      db.prepare(`
        INSERT INTO messages (id, agent_id, role, content, created_at)
        VALUES (?, ?, 'system', ?, datetime('now'))
      `).run(msgId, primaryId, content);

      broadcast({
        type: 'chat:message',
        agentId: primaryId,
        message: { id: msgId, agentId: primaryId, role: 'system' as const, content, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
      });
    } catch { /* best effort */ }
  }

  logger.info('Auto-fix cycle complete', { fixCount, diagnosticId });
  return { fixCount, fixes };
}

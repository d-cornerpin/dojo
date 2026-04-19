// ════════════════════════════════════════
// Injury Recovery — Event-Driven Agent Healing
//
// When an agent enters 'error' status, the system schedules a delayed
// notification to the Healer agent. After a 5-minute grace period (to
// let transient errors resolve), if the agent is still injured, the
// Healer is woken with a diagnostic message and can use its tools to
// investigate and attempt recovery.
//
// When an agent recovers, the Healer is notified so it has full context.
//
// This replaces the polling approach — no interval timer, just
// event-driven setTimeout per injured agent.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { sendAlert } from '../services/imessage-bridge.js';

const logger = createLogger('injury-recovery');

// Grace period before notifying the healer (gives transient errors time to self-resolve)
const GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

// Max recovery attempts per agent before giving up and alerting the user
const MAX_RECOVERY_ATTEMPTS = 3;

// Pending recovery timers — keyed by agent ID. Cancelled if the agent recovers
// within the grace period (no need to bother the healer).
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Track how many times the healer has been notified per agent.
// Prevents infinite poke loops. Cleared on recovery.
const recoveryAttempts = new Map<string, number>();

// Classify the error for the healer's diagnostic context
function classifyError(error: string | null): string {
  if (!error) return 'unknown';
  const lower = error.toLowerCase();

  if (lower.includes('429') || lower.includes('rate_limit') || lower.includes('rate limit') ||
      lower.includes('overloaded') || lower.includes('529')) return 'rate_limit';
  if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('etimedout') ||
      lower.includes('fetch failed') || lower.includes('network') || lower.includes('socket') ||
      lower.includes('timeout') || lower.includes('timed out') ||
      lower.includes('503') || lower.includes('502') || lower.includes('500')) return 'network';
  if (lower.includes('tool_use_id') || lower.includes('tool_result') ||
      lower.includes('invalid_request') || lower.includes('malformed') ||
      lower.includes('messages.0') || lower.includes('content block')) return 'context_corruption';
  if (lower.includes('no model') || lower.includes('agent not found')) return 'config';
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') ||
      lower.includes('invalid_api_key') || lower.includes('api key')) return 'auth';

  return 'unknown';
}

/**
 * Called when an agent enters 'error' or 'paused' (error loop) status.
 * Starts a grace period timer. If the agent is still injured after the
 * grace period, notifies the Healer agent.
 */
export function onAgentInjured(agentId: string, errorMessage: string): void {
  // The healer cannot heal itself — that would create an infinite loop.
  // Instead, alert the user directly via iMessage.
  try {
    const db = getDb();
    const healerRow = db.prepare("SELECT value FROM config WHERE key = 'healer_agent_id'").get() as { value: string } | undefined;
    if (healerRow && agentId === healerRow.value) {
      logger.warn('Healer agent is injured — alerting user directly (cannot self-heal)', { agentId });
      const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
      sendAlert(
        `The Healer agent${agent ? ` (${agent.name})` : ''} is injured and cannot self-heal. Error: ${errorMessage.slice(0, 200)}. Check the dashboard.`,
        'critical',
      );
      return;
    }
  } catch { /* config not available */ }

  // Check if we've already hit the max recovery attempts for this agent.
  // If so, don't schedule another healer notification — alert the user instead.
  const attempts = recoveryAttempts.get(agentId) ?? 0;
  if (attempts >= MAX_RECOVERY_ATTEMPTS) {
    logger.warn('Max recovery attempts reached for agent — alerting user', {
      agentId, attempts, max: MAX_RECOVERY_ATTEMPTS,
    });
    try {
      const db = getDb();
      const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
      sendAlert(
        `${agent?.name ?? agentId} has been injured ${attempts} times and auto-recovery has not worked. Error: ${errorMessage.slice(0, 200)}. Manual intervention needed.`,
        'warning',
      );
    } catch { /* best effort */ }
    return;
  }

  // Cancel any existing timer for this agent (in case of rapid re-injury)
  const existing = pendingTimers.get(agentId);
  if (existing) clearTimeout(existing);

  logger.info('Agent injured — scheduling healer notification', {
    agentId,
    gracePeriodMs: GRACE_PERIOD_MS,
    attempt: attempts + 1,
    maxAttempts: MAX_RECOVERY_ATTEMPTS,
  });

  const timer = setTimeout(() => {
    pendingTimers.delete(agentId);
    recoveryAttempts.set(agentId, attempts + 1);
    notifyHealerOfInjury(agentId, errorMessage);
  }, GRACE_PERIOD_MS);

  pendingTimers.set(agentId, timer);
}

/**
 * Called when an agent recovers (transitions from error/paused to idle/working).
 * Cancels the grace period timer if still pending, and notifies the Healer
 * that the agent recovered.
 */
export function onAgentRecovered(agentId: string): void {
  // Clear recovery attempt counter — the agent is healthy again.
  // If it errors again later, the counter starts fresh.
  recoveryAttempts.delete(agentId);

  const timer = pendingTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(agentId);
    logger.info('Agent recovered within grace period — healer not notified', { agentId });
    return; // Recovered before the healer needed to know
  }

  // Agent recovered AFTER the healer was notified — let the healer know
  // so it can close the loop in its records.
  notifyHealerOfRecovery(agentId);
}

function notifyHealerOfInjury(agentId: string, errorMessage: string): void {
  try {
    const db = getDb();

    // Verify the agent is still injured (might have recovered between timer start and fire)
    const agent = db.prepare('SELECT id, name, status, classification, last_error FROM agents WHERE id = ?')
      .get(agentId) as { id: string; name: string; status: string; classification: string; last_error: string | null } | undefined;
    if (!agent || (agent.status !== 'error' && agent.status !== 'paused')) {
      logger.debug('Agent recovered before healer notification fired — skipping', { agentId });
      return;
    }

    const healerRow = db.prepare("SELECT value FROM config WHERE key = 'healer_agent_id'")
      .get() as { value: string } | undefined;
    const healerId = healerRow?.value ?? 'healer';

    // Verify the healer exists and is not terminated
    const healer = db.prepare("SELECT id, status FROM agents WHERE id = ? AND status != 'terminated'")
      .get(healerId) as { id: string; status: string } | undefined;
    if (!healer) {
      logger.warn('Healer agent not available — cannot auto-recover injured agent', { agentId, healerId });
      return;
    }

    const errorClass = classifyError(agent.last_error ?? errorMessage);
    const errorSnippet = (agent.last_error ?? errorMessage).slice(0, 400);

    // Find tasks stalled on this agent
    interface StalledTask { id: string; title: string; status: string }
    const stalledTasks = db.prepare(`
      SELECT id, title, status FROM tasks
      WHERE assigned_to = ? AND status IN ('in_progress', 'on_deck')
      ORDER BY updated_at DESC LIMIT 5
    `).all(agentId) as StalledTask[];

    const parts: string[] = [];
    parts.push(`[INJURY ALERT] ${agent.name} (${agent.classification}, ID: ${agentId}) has been injured for 5+ minutes and has not recovered on its own.`);
    parts.push('');
    parts.push(`Status: ${agent.status}`);
    parts.push(`Error type: ${errorClass}`);
    parts.push(`Error: ${errorSnippet}`);

    if (stalledTasks.length > 0) {
      parts.push('');
      parts.push('Tasks stalled on this agent:');
      for (const t of stalledTasks) {
        parts.push(`  - ${t.title} (${t.status}, ID: ${t.id.slice(0, 8)})`);
      }
    }

    parts.push('');
    parts.push('Please investigate and attempt recovery:');
    parts.push(`1. If the error is transient (network, rate limit): send_to_agent(agent="${agentId}", message="...") to poke them and see if they can resume.`);
    parts.push(`2. If the error is context corruption: reset_session(agent_id="${agentId}") to clear their context and let them start fresh.`);
    parts.push('3. If the error is a config issue (wrong model, auth failure): note it in your chat — you cannot fix this, the user needs to intervene.');
    parts.push('4. If nothing works after your attempt: send an iMessage alert to the user via imessage_send explaining that the agent is down and needs manual help.');

    const content = parts.join('\n');
    const msgId = uuidv4();

    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, datetime('now'))
    `).run(msgId, healerId, content);

    broadcast({
      type: 'chat:message',
      agentId: healerId,
      message: {
        id: msgId,
        agentId: healerId,
        role: 'user' as const,
        content,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });

    // Wake the healer
    const runtime = getAgentRuntime();
    runtime.handleMessage(healerId, content).catch(err => {
      logger.error('Failed to wake healer for injury recovery', {
        healerId,
        injuredAgentId: agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info('Healer notified of injured agent', {
      healerId,
      injuredAgentId: agentId,
      injuredName: agent.name,
      errorClass,
      stalledTaskCount: stalledTasks.length,
    });
  } catch (err) {
    logger.error('Failed to notify healer of injury', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function notifyHealerOfRecovery(agentId: string): void {
  try {
    const db = getDb();

    const agent = db.prepare('SELECT name FROM agents WHERE id = ?')
      .get(agentId) as { name: string } | undefined;
    if (!agent) return;

    const healerRow = db.prepare("SELECT value FROM config WHERE key = 'healer_agent_id'")
      .get() as { value: string } | undefined;
    const healerId = healerRow?.value ?? 'healer';

    const healer = db.prepare("SELECT id, status FROM agents WHERE id = ? AND status != 'terminated'")
      .get(healerId) as { id: string; status: string } | undefined;
    if (!healer) return;

    const content = `[RECOVERY NOTICE] ${agent.name} (ID: ${agentId}) has recovered from its injured state and is back online. No further action needed for this agent.`;
    const msgId = uuidv4();

    // Insert as system role — informational, doesn't need the healer to wake up and respond
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(msgId, healerId, content);

    broadcast({
      type: 'chat:message',
      agentId: healerId,
      message: {
        id: msgId,
        agentId: healerId,
        role: 'system' as const,
        content,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });

    logger.info('Healer notified of agent recovery', { agentId, agentName: agent.name });
  } catch (err) {
    logger.debug('Failed to notify healer of recovery (non-fatal)', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Called at server startup to pick up agents that were injured before a
 * restart. In-memory timers are lost on restart, so we scan the DB for
 * agents in error/paused status and schedule healer notifications for each.
 */
export function rehydrateInjuredAgents(): void {
  try {
    const db = getDb();
    const injured = db.prepare(`
      SELECT id, last_error FROM agents
      WHERE status IN ('error', 'paused')
        AND status != 'terminated'
        AND last_error IS NOT NULL
    `).all() as Array<{ id: string; last_error: string | null }>;

    if (injured.length > 0) {
      logger.info('Rehydrating injured agents after server restart', {
        count: injured.length,
        agentIds: injured.map(a => a.id),
      });
      for (const agent of injured) {
        onAgentInjured(agent.id, agent.last_error ?? 'Unknown error (pre-restart)');
      }
    }
  } catch (err) {
    logger.warn('Failed to rehydrate injured agents', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

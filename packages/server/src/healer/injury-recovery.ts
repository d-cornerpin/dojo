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

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { broadcast } from '../gateway/ws.js';

const logger = createLogger('injury-recovery');

// ── Persisted attempt counter ──
// The counter lives on agents.recovery_attempts (migration 035) so it
// survives restarts and can be inspected/reset. Pre-2026-04-29 it was
// in-memory only, which meant a long-running server could silently
// accumulate attempts past MAX_RECOVERY_ATTEMPTS and the healer would
// stop trying for that agent.
function getAttempts(agentId: string): number {
  try {
    const db = getDb();
    const row = db.prepare('SELECT recovery_attempts FROM agents WHERE id = ?').get(agentId) as { recovery_attempts: number | null } | undefined;
    return row?.recovery_attempts ?? 0;
  } catch { return 0; }
}
function setAttempts(agentId: string, value: number): void {
  try {
    const db = getDb();
    db.prepare("UPDATE agents SET recovery_attempts = ?, updated_at = datetime('now') WHERE id = ?").run(value, agentId);
  } catch { /* best effort */ }
}

// Broadcast a chat:error so the dashboard surfaces healer activity.
// Without this, every silent return path (max attempts hit, healer missing,
// agent already recovered) leaves the user staring at a stuck agent with no
// idea what's happening.
type HealerEventCode =
  | 'HEALER_DISPATCHED'
  | 'HEALER_SUPPRESSED_MAX_ATTEMPTS'
  | 'HEALER_MISSING'
  | 'HEALER_SELF_INJURED'
  | 'HEALER_DELIVERY_FAILED';
function broadcastInjuryEvent(agentId: string, severity: 'info' | 'warning' | 'error', message: string, code: HealerEventCode): void {
  try {
    broadcast({
      type: 'chat:error',
      agentId,
      error: message,
      code,
      severity,
      retryable: false,
    });
  } catch { /* best effort */ }
}

// Auto-wake delay — fires once before the Healer is involved. Functions as
// a free "are you ok?" poke: the engine just re-runs the agent's loop.
// If it succeeds (transient error cleared) or in-loop recovery handles it,
// the agent recovers without ever bothering the Healer. If it re-injures,
// the Healer dispatches at the (much shorter) grace period below.
const AUTO_WAKE_DELAY_MS = 5 * 1000; // 5s — enough for DB writes to settle

// Grace period before notifying the Healer. With the auto-wake step above,
// the Healer's job is now "agent is genuinely stuck after a free retry
// didn't fix it" — not "let's wait and see if it self-resolves". Cut hard.
// Transient errors (rate limit, network) keep a longer grace because they
// may need an upstream window to tick over.
// History:
//   - pre-2026-04-29: single 5-minute period for everything
//   - 2026-04-29:     60s transient / 15s non-transient
//   - 2026-04-29 v2:  30s transient / 5s non-transient (this version,
//                     paired with engine auto-wake)
const GRACE_PERIOD_MS_TRANSIENT = 30 * 1000;
const GRACE_PERIOD_MS_NON_TRANSIENT = 5 * 1000;

// Max recovery attempts per agent before giving up and alerting the user
const MAX_RECOVERY_ATTEMPTS = 3;

// Pending recovery timers — keyed by agent ID. Cancelled if the agent recovers
// within the grace period (no need to bother the healer).
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Pending auto-wake timers — same lifecycle as pendingTimers but for the
// engine-level "are you ok?" poke that fires before the Healer is involved.
const autoWakeTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  // Phase 8 F1 fix: bucket generic 4xx provider errors instead of falling
  // through to 'unknown'. The user-facing toast went "(error: unknown)" for
  // anything not matched above, even when the message was clearly a 400.
  if (lower.includes('400') || lower.includes('404') || lower.includes('422')) return 'provider_error';

  return 'unknown';
}

/**
 * Called when an agent enters 'error' or 'paused' (error loop) status.
 * Starts a grace period timer. If the agent is still injured after the
 * grace period, notifies the Healer agent.
 */
export function onAgentInjured(agentId: string, errorMessage: string): void {
  // The healer cannot heal itself — that would create an infinite loop.
  // Instead, alert the user directly via iMessage AND broadcast to the
  // dashboard so the user sees the alert without needing iMessage.
  try {
    const db = getDb();
    const healerRow = db.prepare("SELECT value FROM config WHERE key = 'healer_agent_id'").get() as { value: string } | undefined;
    if (healerRow && agentId === healerRow.value) {
      logger.warn('Healer agent is injured — alerting user directly (cannot self-heal)', { agentId });
      const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
      // sendAlert (iMessage to owner) keeps the technical detail; the toast
      // shows a concise version with a clear instruction.
      const techMsg = `The Healer agent${agent ? ` (${agent.name})` : ''} is injured and cannot self-heal. Error: ${errorMessage.slice(0, 200)}. Manual intervention needed.`;
      const userMsg = `The Healer agent is broken and can't auto-fix itself. Open the Healer's detail page to investigate, or restart it from Settings.`;
      sendAlert(techMsg, 'critical');
      broadcastInjuryEvent(agentId, 'error', userMsg, 'HEALER_SELF_INJURED');
      return;
    }
  } catch { /* config not available */ }

  // Check if we've already hit the max recovery attempts for this agent.
  // If so, don't schedule another healer notification — alert the user
  // instead, AND broadcast to the dashboard. Pre-2026-04-29 this only sent
  // an iMessage which the user could miss, leaving an agent silently stuck.
  const attempts = getAttempts(agentId);
  if (attempts >= MAX_RECOVERY_ATTEMPTS) {
    logger.warn('Max recovery attempts reached for agent — alerting user', {
      agentId, attempts, max: MAX_RECOVERY_ATTEMPTS,
    });
    try {
      const db = getDb();
      const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
      const techMsg = `${agent?.name ?? agentId} has been injured ${attempts} times and auto-recovery has not worked. Healer is suppressed for this agent until it recovers. To unstick: send a message, call reset_session, or use update_agent_profile. Last error: ${errorMessage.slice(0, 200)}`;
      const userMsg = `${agent?.name ?? agentId} is stuck and auto-recovery isn't working. Send a message or reset the session from the agent's detail page to unstick it.`;
      sendAlert(techMsg, 'warning');
      broadcastInjuryEvent(agentId, 'warning', userMsg, 'HEALER_SUPPRESSED_MAX_ATTEMPTS');
    } catch { /* best effort */ }
    return;
  }

  // Cancel any existing timers for this agent (rapid re-injury)
  const existingHealer = pendingTimers.get(agentId);
  if (existingHealer) clearTimeout(existingHealer);
  const existingWake = autoWakeTimers.get(agentId);
  if (existingWake) clearTimeout(existingWake);

  // Classify error and pick the matching grace period. Transient errors
  // (rate_limit, network) get a longer grace because they often resolve on
  // their own. Non-transient errors are unlikely to self-resolve, so the
  // healer should engage almost immediately.
  const errorClass = classifyError(errorMessage);
  const isTransient = errorClass === 'rate_limit' || errorClass === 'network';
  const gracePeriodMs = isTransient ? GRACE_PERIOD_MS_TRANSIENT : GRACE_PERIOD_MS_NON_TRANSIENT;

  logger.info('Agent injured — scheduling auto-wake + healer notification', {
    agentId,
    errorClass,
    isTransient,
    autoWakeDelayMs: AUTO_WAKE_DELAY_MS,
    gracePeriodMs,
    attempt: attempts + 1,
    maxAttempts: MAX_RECOVERY_ATTEMPTS,
  });

  // Step 1 — engine-level auto-wake. Fires first. Just re-runs the agent's
  // loop without involving the Healer (no LLM cost). If transient errors
  // cleared or in-loop recovery handles the failure, the agent recovers
  // here and onAgentRecovered cancels the Healer timer below.
  const wakeTimer = setTimeout(async () => {
    autoWakeTimers.delete(agentId);
    try {
      const db = getDb();
      const stillInjured = db.prepare("SELECT status FROM agents WHERE id = ?").get(agentId) as { status: string } | undefined;
      if (!stillInjured || (stillInjured.status !== 'error' && stillInjured.status !== 'paused')) {
        logger.debug('Auto-wake skipped — agent already recovered', { agentId });
        return;
      }
      // Don't auto-wake paused agents — that's the error-loop signal.
      if (stillInjured.status === 'paused') {
        logger.debug('Auto-wake skipped — agent is paused (error loop)', { agentId });
        return;
      }
      const { getAgentRuntime } = await import('../agent/runtime.js');
      logger.info('Auto-wake firing — engine re-running injured agent before Healer is involved', { agentId });
      getAgentRuntime().handleMessage(agentId, '').catch(err => {
        logger.warn('Auto-wake handleMessage threw', {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      logger.warn('Auto-wake step failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, AUTO_WAKE_DELAY_MS);
  autoWakeTimers.set(agentId, wakeTimer);

  // Step 2 — Healer notification. Fires after the grace period if the
  // agent is still injured. With the auto-wake above, this only fires
  // when the agent is genuinely stuck.
  const timer = setTimeout(() => {
    pendingTimers.delete(agentId);
    setAttempts(agentId, attempts + 1);
    notifyHealerOfInjury(agentId, errorMessage);
  }, gracePeriodMs);

  pendingTimers.set(agentId, timer);
}

/**
 * Called when an agent recovers (transitions from error/paused to idle/working).
 * Cancels the grace period timer if still pending, and notifies the Healer
 * that the agent recovered.
 */
export function onAgentRecovered(agentId: string): void {
  // Clear recovery attempt counter — the agent is healthy again.
  // If it errors again later, the counter starts fresh. Persisted to DB
  // so a future restart sees a clean state.
  setAttempts(agentId, 0);

  // Cancel the engine auto-wake timer if it's still pending — agent recovered
  // before we needed to poke them.
  const wakeTimer = autoWakeTimers.get(agentId);
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    autoWakeTimers.delete(agentId);
  }

  // Phase 8 F1 fix: emit an info-severity AGENT_RECOVERED broadcast so the
  // dashboard can auto-dismiss the lingering injury error toast. Most
  // provider 4xx errors are transient (auto-recovered within 5s) — without
  // this signal the user sees a red banner from a problem that already
  // resolved.
  try {
    const db = getDb();
    const agentRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    const name = agentRow?.name ?? agentId;
    broadcast({
      type: 'chat:error',
      agentId,
      error: `${name} recovered and is back to work.`,
      code: 'AGENT_RECOVERED',
      severity: 'info',
      retryable: false,
    });
  } catch { /* best effort */ }

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

async function notifyHealerOfInjury(agentId: string, errorMessage: string): Promise<void> {
  try {
    const db = getDb();

    // Verify the agent is still injured (might have recovered between timer start and fire)
    const agent = db.prepare('SELECT id, name, status, classification, last_error FROM agents WHERE id = ?')
      .get(agentId) as { id: string; name: string; status: string; classification: string; last_error: string | null } | undefined;
    if (!agent || (agent.status !== 'error' && agent.status !== 'paused')) {
      logger.debug('Agent recovered before healer notification fired — skipping', { agentId });
      return;
    }

    // Notify the primary agent in parallel with the Healer. Pre-2026-04-30
    // the primary was alerted at the moment of injury, before auto-wake
    // and grace period had a chance to clear transient errors — so a
    // momentary 429 would fire a misleading "they will not recover on
    // their own" message even though the agent self-resolved seconds
    // later. Doing it here means the primary only hears about agents that
    // genuinely need help.
    try {
      const { getAgentRuntime } = await import('../agent/runtime.js');
      const pausedByLoop = agent.status === 'paused';
      await getAgentRuntime().notifyPrimaryOfInjury(agentId, agent.last_error ?? errorMessage, pausedByLoop);
    } catch (err) {
      logger.warn('Primary-agent injury notification failed', {
        agentId, error: err instanceof Error ? err.message : String(err),
      });
    }

    const healerRow = db.prepare("SELECT value FROM config WHERE key = 'healer_agent_id'")
      .get() as { value: string } | undefined;
    const healerId = healerRow?.value ?? 'healer';

    // Verify the healer exists and is not terminated. Pre-2026-04-29 this
    // returned silently, leaving an injured agent stuck with no surface
    // signal. Now we alert via iMessage AND broadcast to the dashboard so
    // the user actually finds out.
    const healer = db.prepare("SELECT id, status FROM agents WHERE id = ? AND status != 'terminated'")
      .get(healerId) as { id: string; status: string } | undefined;
    if (!healer) {
      logger.warn('Healer agent not available — cannot auto-recover injured agent', { agentId, healerId });
      const techMsg = `${agent.name} is injured but the Healer agent is missing or terminated, so auto-recovery cannot run. Restore the Healer in Settings → Sensei, or manually unstick this agent. Last error: ${errorMessage.slice(0, 200)}`;
      const userMsg = `${agent.name} is stuck and the Healer agent is missing. Restore the Healer in Settings → Sensei, or send a message to unstick the agent manually.`;
      try { sendAlert(techMsg, 'warning'); } catch { /* best effort */ }
      broadcastInjuryEvent(agentId, 'error', userMsg, 'HEALER_MISSING');
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
    parts.push(`[INJURY ALERT] ${agent.name} (${agent.classification}, ID: ${agentId}) is injured and has not recovered on its own within the grace period.`);
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
    parts.push(`1. If the error is transient (network, rate limit): send_to_agent(agent="${agentId}", intent="QUESTION", payload="...") to poke them.`);
    parts.push(`2. If the error is context corruption: reset_session(agent_id="${agentId}") to clear their context.`);
    parts.push('3. If the error is a config issue: send an iMessage alert to the user via imessage_send.');

    const content = parts.join('\n');

    // Deliver via A2A transport — ASSIGN intent wakes the healer to act
    const { deliverA2AMessage, makeThreadId } = await import('../agent/a2a-transport.js');
    const result = await deliverA2AMessage({
      intent: 'ASSIGN',
      threadId: makeThreadId(`injury-${agentId}`),
      requiresResponse: true,
      payload: content,
      toAgent: healerId,
      fromAgent: 'system', // System-generated, not from another agent
    });

    if (result.delivered) {
      logger.info('Healer notified of injured agent', {
        healerId,
        injuredAgentId: agentId,
        injuredName: agent.name,
        errorClass,
        stalledTaskCount: stalledTasks.length,
      });
      // Surface to the dashboard so the user can see the healer kicked in.
      // Without this, the healer's actions happen invisibly — the user is
      // left wondering whether anything is happening at all.
      broadcastInjuryEvent(
        agentId,
        'info',
        // User-facing: brief and reassuring. Tech detail (errorClass +
        // errorSnippet) was previously surfaced here but it's clutter for
        // users — it's already in logs and on the agent's detail page.
        `${agent.name} hit an error. Auto-healer is investigating — give it a moment.`,
        'HEALER_DISPATCHED',
      );
    } else {
      // Delivery failed (semantic dedup, hop limit, etc.) — surface so the
      // user knows the healer wasn't reached and can act manually.
      logger.warn('Healer notification delivery failed', {
        healerId, injuredAgentId: agentId, reason: result.reason,
      });
      // Phase 8 F1 fix: SEMANTIC_DUPLICATE means the Healer was already informed
      // about this exact issue. That's the dedup working as designed, not a
      // failure. Show as info ("already aware"), not error. Other reasons
      // (hop limit, healer down, etc.) stay as warning since the user may
      // need to intervene.
      const isDedup = result.reason === 'SEMANTIC_DUPLICATE';
      broadcastInjuryEvent(
        agentId,
        isDedup ? 'info' : 'warning',
        isDedup
          ? `${agent.name} hit the same error again — auto-healer was already notified. Skipping a duplicate message.`
          : `${agent.name} is stuck and auto-healer couldn't be reached. Send a message or reset the session from the agent's detail page to unstick it.`,
        'HEALER_DELIVERY_FAILED',
      );
    }
  } catch (err) {
    logger.error('Failed to notify healer of injury', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function notifyHealerOfRecovery(agentId: string): Promise<void> {
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

    const content = `${agent.name} (ID: ${agentId}) has recovered from its injured state and is back online. No further action needed.`;

    // Deliver via A2A transport — FYI intent does NOT wake the healer.
    // The recovery notice sits as read-only context, no tokens spent.
    const { deliverA2AMessage, makeThreadId } = await import('../agent/a2a-transport.js');
    await deliverA2AMessage({
      intent: 'FYI',
      threadId: makeThreadId(`injury-${agentId}`), // Same thread as the injury alert
      requiresResponse: false,
      payload: content,
      toAgent: healerId,
      fromAgent: 'system',
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

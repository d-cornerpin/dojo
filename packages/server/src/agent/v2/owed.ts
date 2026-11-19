// Who is owed what by an agent, and when the engine next wakes it. One timer for every agent and every due reply.

import { getDb } from '../../db/connection.js';
import { afterCommit } from '../../db/unit.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../../gateway/ws.js';
import { recordDeliveryAttempt } from '../../memory/message-store.js';
import { workingExpr } from '../../work/terminal-states.js';
import { activeRuns, isRunUnwinding } from '../shared-state.js';
import { nextReplyDueAt, deliverDueReplies } from './channel-sender.js';
import { getWaitingHumanConversations, getPendingEngineEvent, getNextEngineEventRetryAt } from './counterparty.js';

const logger = createLogger('owed');
const FLOOR_MS = 1_000;
const CEILING_MS = 3_600_000;
const STAGGER_MS = 300;
const WAKE_BUDGET_WINDOW_MS = 10 * 60 * 1000;
const WAKE_BUDGET_MAX = 30;
const wakeupTimes = new Map<string, number[]>();
const wakeBudgetTripped = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

export type Owed = { kind: 'ask' | 'task'; id: string } | { kind: 'row'; agentId: string; rowid: number };

/** THE ONE WRITER of "serve this again at". null clears. The clock is armed after the caller's unit commits. */
export function serveLater(subject: Owed, at: number | null, why: string, opts: { onlyIfParked?: true } = {}): void {
  const db = getDb();
  if (subject.kind === 'row') {
    if (at !== null) recordDeliveryAttempt({ agentId: subject.agentId, rowid: subject.rowid, notBefore: at });
  } else if (opts.onlyIfParked) {
    db.prepare(`UPDATE work SET next_attempt_at = MIN(next_attempt_at, ?), updated_at = ?
      WHERE id = ? AND next_attempt_at IS NOT NULL AND hold_kind IS NULL AND ${workingExpr('work')}`).run(at, Date.now(), subject.id);
  } else {
    db.prepare('UPDATE work SET next_attempt_at = ?, updated_at = ? WHERE id = ?').run(at, Date.now(), subject.id);
  }
  logger.info('owed: serve again at', { subject, at, why });
  afterCommit(armOwedClock);
}

/** The storm guard on the engine's own wakes (never a real inbound): at most 30 in 10 minutes per agent. */
export function underWakeBudget(agentId: string): boolean {
  const now = Date.now();
  const arr = (wakeupTimes.get(agentId) ?? []).filter((t) => t > now - WAKE_BUDGET_WINDOW_MS);
  wakeupTimes.set(agentId, arr);
  if (arr.length >= WAKE_BUDGET_MAX) {
    if (!wakeBudgetTripped.has(agentId)) {
      wakeBudgetTripped.add(agentId);
      logger.error('Wake budget tripped: too many self-wakeups in the window; the engine wakes this agent again when it clears (a new inbound still wakes it)', {
        agentId, wakeupsInWindow: arr.length, windowMinutes: WAKE_BUDGET_WINDOW_MS / 60000,
      }, agentId);
      try { broadcast({ type: 'agent:status', agentId, status: 'idle' }); } catch { /* best effort */ }
    }
    return false;
  }
  arr.push(now);
  wakeBudgetTripped.delete(agentId);
  return true;
}

function wakeBudgetClearsAt(agentId: string): number | null {
  return wakeBudgetTripped.has(agentId) ? ((wakeupTimes.get(agentId) ?? [])[0] ?? Date.now()) + WAKE_BUDGET_WINDOW_MS : null;
}

/** Is anything owed now, and the earliest future due time: one read of the waiting person and engine-event readers. */
export function dueOf(agentId: string, now = Date.now()): { now: boolean; next: number | null } {
  const convs = getWaitingHumanConversations(agentId, { includeNotDue: true });
  const event = getPendingEngineEvent(agentId, { pure: true });
  const future = [...convs.map((c) => c.dueAt).filter((t) => t > now), ...[getNextEngineEventRetryAt(agentId)].filter((t): t is number => t !== null)];
  return { now: event !== null || convs.some((c) => c.dueAt <= now), next: future.length > 0 ? Math.min(...future) : null };
}

/** Agents the clock may wake: live, not running, and holding something that could be owed. */
function clockAgents(): string[] {
  return (getDb().prepare(`
    SELECT a.id FROM agents a WHERE a.status NOT IN ('terminated', 'paused', 'error') AND (
         EXISTS (SELECT 1 FROM work w WHERE w.agent_id = a.id AND w.kind = 'ask' AND w.state = 'open'
                   AND w.opened_at >= (unixepoch(COALESCE(a.session_started_at, '1970-01-01')) * 1000))
      OR EXISTS (SELECT 1 FROM work t WHERE t.agent_id = a.id AND t.kind <> 'ask' AND t.next_attempt_at IS NOT NULL AND ${workingExpr('t')})
      OR EXISTS (SELECT 1 FROM messages m WHERE m.agent_id = a.id AND m.role = 'user' AND m.swept_at IS NULL
                   AND m.created_at >= (unixepoch('now', '-24 hours') * 1000)
                   AND (m.a2a_intent IN ('QUESTION', 'ASSIGN', 'BLOCK')
                        OR (m.served_by_turn IS NULL AND (m.lane = 'events' OR m.a2a_intent IN ('DELIVERABLE', 'ANSWER', 'COMPLETE', 'FAIL'))))))`)
    .all() as Array<{ id: string }>)
    .map((r) => r.id).filter((id) => !activeRuns.has(id));
}

/** THE ONE TIMER: the earliest of a due reply, an agent owed now, an agent's next due time, a wake budget clearing. */
export function armOwedClock(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const now = Date.now();
  let next: number | null = null;
  let floor = 0;
  const consider = (t: number | null, f: number): void => { if (t !== null && (next === null || t < next)) { next = t; floor = f; } };
  try { consider(nextReplyDueAt(), 0); } catch (err) { logger.warn('owed clock: the reply queue could not be read', { error: String(err) }); }
  let agents: string[] = [];
  try { agents = clockAgents(); } catch (err) { logger.warn('owed clock: the candidate agents could not be read', { error: String(err) }); }
  for (const id of agents) {
    try {
      const clears = wakeBudgetClearsAt(id);
      if (clears !== null && clears > now) { consider(clears, FLOOR_MS); continue; }
      const d = dueOf(id, now);
      consider(d.now ? now : d.next, FLOOR_MS);
    } catch (err) {
      logger.warn('owed clock: one agent could not be read; skipped', { agentId: id, error: String(err) }, id);
    }
  }
  if (next === null) return;
  timer = setTimeout(() => { void fire(); }, Math.min(Math.max(next - now, floor), CEILING_MS));
  timer.unref?.();
}

async function fire(): Promise<void> {
  timer = null;
  try {
    await deliverDueReplies(Date.now());
    const { getAgentRuntime } = await import('../runtime.js');
    let n = 0;
    for (const id of clockAgents()) {
      try {
        if (!dueOf(id).now || !underWakeBudget(id)) continue;
        const t = setTimeout(() => {
          if (isRunUnwinding(id)) return;   // a run live or in its exit tail: its drain's own wake comes next
          logger.info('owed clock: waking an agent that is owed something', { agentId: id });
          void getAgentRuntime().handleMessage(id, '').catch((err: unknown) =>
            logger.error('owed clock: the wake failed', { agentId: id, error: String(err) }, id));
        }, STAGGER_MS * n++);
        t.unref?.();
      } catch (err) {
        logger.warn('owed clock: one agent could not be woken; skipped', { agentId: id, error: String(err) }, id);
      }
    }
  } catch (err) {
    logger.error('owed clock: a fire failed', { error: String(err) });
  } finally {
    armOwedClock();
  }
}

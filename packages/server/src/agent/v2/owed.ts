// Who is owed what by an agent, and when the engine next wakes it. One timer for every agent and every due reply.

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../../gateway/ws.js';
import { workingExpr } from '../../work/terminal-states.js';
import { askIdForMessage } from '../../work/store.js';
import { parkedContinuationFor } from '../../work/task-freshness.js';
import { activeRuns, isRunUnwinding } from '../shared-state.js';
import { nextReplyDueAt, deliverDueReplies } from './channel-sender.js';
import {
  getWaitingHumanConversations, getPendingEngineEvent, getNextEngineEventRetryAt, findUnservedTerminalWake, askRootIsOwners,
} from './counterparty.js';

const logger = createLogger('owed');
const FLOOR_MS = 1_000;
const CEILING_MS = 3_600_000;
const STAGGER_MS = 300;
const WAKE_BUDGET_WINDOW_MS = 10 * 60 * 1000;
const WAKE_BUDGET_MAX = 30;
const wakeupTimes = new Map<string, number[]>();
const wakeBudgetTripped = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

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

type PendingEngineEvent = NonNullable<ReturnType<typeof getPendingEngineEvent>>;
export type OwedKind = 'person' | 'agentResult' | 'clock' | 'agentRequest' | 'job';
export interface OwedItem {
  kind: OwedKind; rank: 1 | 2 | 3 | 4 | 5 | 6; dueAt: number; age: number; ref: string; served?: boolean; event?: PendingEngineEvent;
}

/** An event rooted in a person's request ranks with it: 3 for the owner's, 4 for a contact's; any other event is 6. */
function rankOfEvent(agentId: string, ev: PendingEngineEvent): 3 | 4 | 6 {
  if (ev.rootKind !== 'ask' || !ev.rootId) return 6;
  return askRootIsOwners(agentId, ev.rootId) ? 3 : 4;
}

/** Everything this agent owes, due or not, ranked: the owner, approved people, events rooted in their requests,
 *  helper results, then the clock; a never-served person before a handed-back one, then the oldest. */
function owedItems(agentId: string, opts: { pure?: true } = {}): OwedItem[] {
  const items: OwedItem[] = getWaitingHumanConversations(agentId, { includeNotDue: true }).map((c) => (
    { kind: 'person', rank: c.owner ? 1 : 2, dueAt: c.dueAt, age: c.oldestWaitingRowid, ref: c.workId, served: c.served }));
  const wake = findUnservedTerminalWake(agentId);
  if (wake) items.push({ kind: 'agentResult', rank: 5, dueAt: 0, age: wake.rowid, ref: String(wake.rowid) });
  const ev = getPendingEngineEvent(agentId, opts);
  if (ev) items.push({ kind: 'clock', rank: rankOfEvent(agentId, ev), dueAt: 0, age: ev.rowid, ref: ev.id, event: ev });
  const evNext = getNextEngineEventRetryAt(agentId);
  if (!ev && evNext !== null) items.push({ kind: 'clock', rank: 6, dueAt: evNext, age: Number.MAX_SAFE_INTEGER, ref: 'next-event' });
  return items.sort((a, b) => a.rank - b.rank || Number(a.served ?? false) - Number(b.served ?? false) || a.age - b.age);
}

/** What this agent serves next, first item first: everything owed that is due now. */
export const nextOwed = (agentId: string, now = Date.now(), opts: { pure?: true } = {}): OwedItem[] =>
  owedItems(agentId, opts).filter((i) => i.dueAt <= now);

/** How many people are due an answer now, for the storm law; -1 when it cannot be read (stand down). */
export function personsWaiting(agentId: string): number {
  try {
    return nextOwed(agentId, Date.now(), { pure: true }).filter((i) => i.kind === 'person').length;
  } catch (err) {
    logger.warn('storm law: the waiting people could not be read; standing self-wakes down', { agentId, error: String(err) }, agentId);
    return -1;
  }
}

/** Is anything owed now, and the earliest future due time: one build of the items, read without writing.
 *  While a parked job's continuation is queued, the conversation it started from is left to it. */
export function dueOf(agentId: string, now = Date.now()): { now: boolean; next: number | null } {
  const parked = parkedContinuationFor(agentId);
  const items = owedItems(agentId, { pure: true }).filter((i) => i.kind !== 'person' || parked === null || i.ref !== askIdForMessage(parked));
  const future = items.map((i) => i.dueAt).filter((t) => t > now);
  return { now: items.some((i) => i.dueAt <= now), next: future.length > 0 ? Math.min(...future) : null };
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
          if (isRunUnwinding(id)) return;   // a run live or in its exit tail: its own end arms the clock again
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

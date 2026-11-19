// Who is owed what by an agent, and when the engine next wakes it. One timer for every agent and every due reply.

import { A2A_THREAD_SHORT_LENGTH } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../../gateway/ws.js';
import { repliedOnThread } from '../../memory/message-store.js';
import { workingExpr } from '../../work/terminal-states.js';
import { originOfTasks, type JobOrigin } from '../../work/job-origin.js';
import { activeRuns, isRunUnwinding } from '../shared-state.js';
import { nextReplyDueAt, deliverDueReplies } from './channel-sender.js';
import {
  getWaitingHumanConversations, getPendingEngineEvent, getNextEngineEventRetryAt, findUnservedTerminalWake, askRoot,
  TERMINAL_WAKE_WINDOW_MS,
} from './counterparty.js';

const logger = createLogger('owed');
const FLOOR_MS = 1_000;
const CEILING_MS = 3_600_000;
const STAGGER_MS = 300;
const WAKE_BUDGET_WINDOW_MS = 10 * 60 * 1000;
const WAKE_BUDGET_MAX = 30;
const wakeupTimes = new Map<string, number[]>();
const wakeBudgetTripped = new Set<string>();
const wakeScheduled = new Set<string>();   // a staggered wake set and not yet started
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

export interface AgentRequest {
  messageId: string; rowid: number; threadId: string; threadShort: string; intent: string; fromId: string; fromName: string;
  createdAt: number; attempts: number; dueAt: number;
}

/** Unreplied requests from other agents, oldest first, with when each may be served (a provider's reset). A request
 *  never served is always owed (the transport opens an ASSIGN's task before it writes the message). Once served, an
 *  open task on its thread owns it: parked, the job item serves it; held by the owner, nobody does; working, the
 *  PM's ladder watches it. */
export function agentRequests(agentId: string, now = Date.now()): AgentRequest[] {
  const rows = getDb().prepare(`
    SELECT m.seq AS rowid, m.id AS messageId, m.a2a_thread_id AS threadId, m.a2a_intent AS intent,
           m.source_agent_id AS fromId, COALESCE(s.name, m.source_agent_id) AS fromName, m.created_at AS createdAt,
           m.delivery_attempts AS attempts, COALESCE(m.next_attempt_at, 0) AS dueAt
      FROM messages m JOIN agents a ON a.id = m.agent_id LEFT JOIN agents s ON s.id = m.source_agent_id
     WHERE m.agent_id = @agentId AND m.role = 'user' AND m.lane <> 'events'
       AND m.a2a_intent IN ('QUESTION', 'ASSIGN', 'BLOCK') AND m.a2a_thread_id IS NOT NULL AND m.source_agent_id IS NOT NULL
       AND m.swept_at IS NULL
       AND m.created_at >= (unixepoch(COALESCE(a.session_started_at, '1970-01-01')) * 1000) AND m.created_at >= @now - 86400000
       AND (CASE WHEN m.served_by_turn IS NULL THEN m.created_at >= @now - 86400000
                 ELSE MAX(COALESCE((SELECT unixepoch(t.started_at) * 1000 FROM turns t
                                     WHERE t.agent_id = m.agent_id AND t.turn_number = m.served_by_turn), m.created_at),
                          COALESCE(m.next_attempt_at, 0)) >= @now - @servedWindow END)
       AND NOT EXISTS (SELECT 1 FROM work t WHERE t.agent_id = m.agent_id AND t.a2a_thread_id = m.a2a_thread_id
                         AND ${workingExpr('t')}
                         AND (t.next_attempt_at IS NOT NULL OR t.hold_kind IS NOT NULL OR m.served_by_turn IS NOT NULL))
     ORDER BY m.seq ASC LIMIT 20`).all({ agentId, now, servedWindow: TERMINAL_WAKE_WINDOW_MS }) as Array<Omit<AgentRequest, 'threadShort'>>;
  return rows.filter((r) => !repliedOnThread(agentId, r.fromId, r.threadId, r.createdAt))
    .map((r) => ({ ...r, threadShort: r.threadId.slice(0, A2A_THREAD_SHORT_LENGTH) }));
}

/** The agent's parked jobs: working tasks with a due time, not held. */
function parkedJobs(agentId: string): Array<{ id: string; dueAt: number }> {
  return getDb().prepare(`SELECT w.id, w.next_attempt_at AS dueAt FROM work w WHERE w.agent_id = ? AND w.kind <> 'ask'
    AND w.next_attempt_at IS NOT NULL AND w.hold_kind IS NULL AND ${workingExpr('w')}`).all(agentId) as Array<{ id: string; dueAt: number }>;
}

type PendingEngineEvent = NonNullable<ReturnType<typeof getPendingEngineEvent>>;
export type OwedKind = 'person' | 'agentResult' | 'clock' | 'agentRequest' | 'job';
export interface OwedItem {
  kind: OwedKind; rank: 1 | 2 | 3 | 4 | 5 | 6; dueAt: number; age: number; ref: string; served?: boolean;
  event?: PendingEngineEvent; request?: AgentRequest;
  /** A parked job: where its task started, and that request's ask when it is a person's. */
  job?: { origin: JobOrigin | null; ask: ReturnType<typeof askRoot> };
}

/** An event rooted in a person's request ranks with it: 3 for the owner's, 4 for a contact's; any other event is 6. */
function rankOfEvent(agentId: string, ev: PendingEngineEvent): 3 | 4 | 6 {
  if (ev.rootKind !== 'ask' || !ev.rootId) return 6;
  return askRoot(agentId, ev.rootId)?.owner ? 3 : 4;
}

/** Everything this agent owes, due or not, ranked: the owner, approved people, events and parked jobs rooted in their
 *  requests, helper results and other agents' requests and their jobs, then the clock; a never-served person before a handed-back one, then
 *  the oldest. */
function owedItems(agentId: string, opts: { pure?: true } = {}): OwedItem[] {
  const items: OwedItem[] = getWaitingHumanConversations(agentId, { includeNotDue: true }).map((c) => (
    { kind: 'person', rank: c.owner ? 1 : 2, dueAt: c.dueAt, age: c.oldestWaitingRowid, ref: c.workId, served: c.served }));
  const wake = findUnservedTerminalWake(agentId);
  if (wake) items.push({ kind: 'agentResult', rank: 5, dueAt: 0, age: wake.rowid, ref: String(wake.rowid) });
  const jobs = parkedJobs(agentId).map((t) => ({ ...t, origin: originOfTasks(agentId, [t.id]) }));
  // Another agent's request whose job is parked is served by the job's own turn.
  const jobThreads = new Set(jobs.map((j) => (j.origin?.kind === 'a2a' ? j.origin.threadId : null)));
  for (const r of agentRequests(agentId)) {
    if (!jobThreads.has(r.threadId)) items.push({ kind: 'agentRequest', rank: 5, dueAt: r.dueAt, age: r.rowid, ref: r.messageId, request: r });
  }
  const ev = getPendingEngineEvent(agentId, opts);
  if (ev) items.push({ kind: 'clock', rank: rankOfEvent(agentId, ev), dueAt: 0, age: ev.rowid, ref: ev.id, event: ev });
  for (const t of jobs) {
    const { origin } = t;
    const ask = origin?.kind === 'ask' ? askRoot(agentId, origin.messageId) : null;
    if (ask?.state === 'open') continue;   // the person item serves it, with the job in view
    const rank = ask ? (ask.owner ? 3 : 4) : origin?.kind === 'a2a' ? 5 : 6;
    items.push({ kind: 'job', rank, dueAt: t.dueAt, age: t.dueAt, ref: t.id, job: { origin, ask } });
  }
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

/** Is anything owed now, and the earliest future due time: one build of the items, read without writing. */
export function dueOf(agentId: string, now = Date.now()): { now: boolean; next: number | null } {
  const items = owedItems(agentId, { pure: true });
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
        // A run still unwinding is retried by the next fire, uncharged.
        if (isRunUnwinding(id) || wakeScheduled.has(id) || !dueOf(id).now || !underWakeBudget(id)) continue;
        wakeScheduled.add(id);
        const t = setTimeout(() => {
          wakeScheduled.delete(id);
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

// Who is owed what by an agent, and when the engine next wakes it. One timer for every agent and every due reply.

import { A2A_THREAD_SHORT_LENGTH, FINAL_REPLY_SQL, FINAL_REPLY_INTENTS } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../../gateway/ws.js';
import { repliedOnThread } from '../../memory/message-store.js';
import { workingExpr } from '../../work/terminal-states.js';
import { originOfTasks, type JobOrigin } from '../../work/job-origin.js';
import { activeRuns, isRunUnwinding } from '../shared-state.js';
import { turnContext } from '../turn-context.js';
import { parkedJobs } from '../live-work.js';
import { askIdForMessage, openPieceOnSql } from '../../work/store.js';
import { linkedTaskOf, jobHeldAt } from '../../work/ask-settlement.js';
import { nextReplyDueAt, deliverDueReplies } from './channel-sender.js';
import {
  getWaitingHumanConversations, getPendingEngineEvent, getNextEngineEventRetryAt, findUnservedTerminalWake, askRoot,
  TERMINAL_WAKE_WINDOW_MS, RESULT_FOR_ENDED_REQUEST,
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
  createdAt: number; attempts: number; dueAt: number; kept: number;
}

/** Requests from other agents with no final reply (on `thread` when given), oldest first, with when each may be served. */
export function agentRequests(agentId: string, now = Date.now(), thread: string | null = null): AgentRequest[] {
  const rows = getDb().prepare(`
    SELECT m.seq AS rowid, m.id AS messageId, m.a2a_thread_id AS threadId, m.a2a_intent AS intent,
           m.source_agent_id AS fromId, COALESCE(s.name, m.source_agent_id) AS fromName, m.created_at AS createdAt,
           m.delivery_attempts AS attempts, COALESCE(m.next_attempt_at, 0) AS dueAt, ${openPieceOnSql('m.a2a_thread_id')} AS kept
      FROM messages m JOIN agents a ON a.id = m.agent_id LEFT JOIN agents s ON s.id = m.source_agent_id
     WHERE m.agent_id = @agentId AND m.role = 'user' AND m.lane <> 'events'
       AND m.a2a_intent IN ('QUESTION', 'ASSIGN', 'BLOCK') AND m.a2a_thread_id IS NOT NULL AND m.source_agent_id IS NOT NULL
       AND (m.swept_at IS NULL OR kept) AND NOT ${RESULT_FOR_ENDED_REQUEST('m')}
       AND m.created_at >= (unixepoch(COALESCE(a.session_started_at, '1970-01-01')) * 1000) AND (@thread IS NULL OR m.a2a_thread_id = @thread)
       AND (CASE WHEN m.served_by_turn IS NULL THEN kept OR m.created_at >= @now - 86400000
                 WHEN kept THEN EXISTS (SELECT 1 FROM turns t WHERE t.agent_id = m.agent_id AND t.turn_number = m.served_by_turn AND (t.exit_reason IS NULL
                   OR t.exit_reason IN ('preempt', 'abort', 'terminated', 'provider_error', 'stream_idle', 'unknown') OR EXISTS (SELECT 1 FROM messages n WHERE n.a2a_thread_id = m.a2a_thread_id
                     AND (n.agent_id = m.agent_id OR (n.agent_id = m.source_agent_id AND n.a2a_intent NOT IN ('QUESTION', 'BLOCK') AND NOT EXISTS (SELECT 1 FROM messages e WHERE e.agent_id = m.source_agent_id
                       AND e.a2a_thread_id = m.a2a_thread_id AND e.source_agent_id = m.agent_id AND e.created_at < unixepoch(t.started_at) * 1000))) AND n.role = 'user' AND n.id <> m.id AND n.created_at >= unixepoch(t.started_at) * 1000)))
                 ELSE MAX(COALESCE((SELECT unixepoch(t.started_at) * 1000 FROM turns t
                                     WHERE t.agent_id = m.agent_id AND t.turn_number = m.served_by_turn), m.created_at),
                          COALESCE(m.next_attempt_at, 0)) >= @now - @servedWindow END)
       AND NOT EXISTS (SELECT 1 FROM work t WHERE t.agent_id = m.agent_id AND t.a2a_thread_id = m.a2a_thread_id
                         AND ${workingExpr('t')}
                         AND (t.next_attempt_at IS NOT NULL OR t.hold_kind IS NOT NULL OR m.served_by_turn IS NOT NULL))
     ORDER BY m.seq ASC LIMIT 20`).all({ agentId, now, thread, servedWindow: TERMINAL_WAKE_WINDOW_MS }) as Array<Omit<AgentRequest, 'threadShort'>>;
  return rows.filter((r) => !repliedOnThread(agentId, r.fromId, r.threadId, r.createdAt, FINAL_REPLY_INTENTS))
    .map((r) => ({ ...r, threadShort: r.threadId.slice(0, A2A_THREAD_SHORT_LENGTH) }));
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
function owedItems(agentId: string, opts: { pure?: true; thread?: string | null } = {}): OwedItem[] {
  const items: OwedItem[] = getWaitingHumanConversations(agentId, { includeNotDue: true }).map((c) => (
    { kind: 'person', rank: c.owner ? 1 : 2, dueAt: c.dueAt, age: c.oldestWaitingRowid, ref: c.workId, served: c.served }));
  const wake = findUnservedTerminalWake(agentId);
  if (wake) items.push({ kind: 'agentResult', rank: 5, dueAt: 0, age: wake.rowid, ref: String(wake.rowid) });
  const jobs = parkedJobs(agentId).map((t) => ({ ...t, origin: originOfTasks(agentId, [t.id]) }));
  // Another agent's request whose job is parked is served by the job's own turn.
  const jobThreads = new Set(jobs.map((j) => (j.origin?.kind === 'a2a' ? j.origin.threadId : null)));
  for (const r of agentRequests(agentId, Date.now(), opts.thread)) {
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

export interface OwedWork { taskId?: string | null; threadId?: string | null }
const isFor = (i: OwedItem, w: OwedWork): boolean => (!!w.taskId && (i.event?.taskId === w.taskId || (i.kind === 'job' && i.ref === w.taskId)))
  || (!!w.threadId && i.request?.threadId === w.threadId);
/** Is anything owed now (with `work`, only its task's events and parked job or its thread's request), and the next due time. */
export function dueOf(agentId: string, now = Date.now(), work?: OwedWork): { now: boolean; next: number | null } {
  const items = owedItems(agentId, { pure: true, thread: work?.threadId }).filter((i) => !work || isFor(i, work));
  const future = items.map((i) => i.dueAt).filter((t) => t > now);
  return { now: items.some((i) => i.dueAt <= now), next: future.length > 0 ? Math.min(...future) : null };
}

type StoppedRequest = Pick<AgentRequest, 'rowid' | 'messageId' | 'threadId' | 'fromId' | 'createdAt'>;
export interface StoppedRequests {
  liveRun: boolean; asks: string[]; runTasks: string[]; requests: StoppedRequest[]; jobs: string[];
}
const REQUEST_ROW = `SELECT seq AS rowid, id AS messageId, a2a_thread_id AS threadId, source_agent_id AS fromId,
    created_at AS createdAt
  FROM messages WHERE agent_id = ? AND role = 'user' AND a2a_intent IN ('QUESTION', 'ASSIGN', 'BLOCK') AND swept_at IS NULL`;

/** Which request a Stop ends: the live turn's; else every parked job's and the latest turn's while still started
 *  (an ask claimed, held, or open with a due; another agent's request unanswered or its job parked); and their
 *  job tasks. */
export function stoppedRequestsOf(agentId: string): StoppedRequests {
  const db = getDb();
  const one = (sql: string, ...args: unknown[]): { id: string } | undefined =>
    db.prepare(sql).get(...args) as { id: string } | undefined;
  const requestRow = (clause: string, arg: unknown): StoppedRequest | undefined =>
    db.prepare(`${REQUEST_ROW} AND ${clause} ORDER BY seq DESC LIMIT 1`).get(agentId, arg) as StoppedRequest | undefined;
  const threadTasks = (thread: string): Array<{ id: string; due: number | null }> => db.prepare(
    `SELECT t.id, t.next_attempt_at AS due FROM work t WHERE t.agent_id = ? AND t.a2a_thread_id = ? AND ${workingExpr('t')}`,
  ).all(agentId, thread) as Array<{ id: string; due: number | null }>;
  const bag = turnContext(agentId);
  const live = bag?.turnNumber !== undefined ? bag : undefined;
  const latest = live ? undefined : db.prepare(
    'SELECT turn_number AS n, root_kind AS kind, root_id AS id FROM turns WHERE agent_id = ? ORDER BY turn_number DESC LIMIT 1',
  ).get(agentId) as { n: number; kind: string | null; id: string | null } | undefined;
  const root = live ? live.root : latest?.kind && latest.id ? { kind: latest.kind, id: latest.id } : null;

  // The request behind the root: an ask, or another agent's request (re-read, so a swept one is not ended twice).
  let request = live?.servedRequest ? requestRow('seq = ?', live.servedRequest.rowid)
    : !live && !root && latest ? requestRow('served_by_turn = ?', latest.n) : undefined;
  const ask = root?.kind === 'ask' ? { id: askIdForMessage(root.id) }
    : root?.kind === 'engine' ? one(`SELECT CASE WHEN root_kind = 'ask' THEN 'ask:' || root_id
        WHEN task_id LIKE 'ask:%' THEN task_id END AS id FROM messages WHERE id = ?`, root.id)
    : root?.kind === 'a2a' ? one(`SELECT parent_id AS id FROM work WHERE agent_id = ? AND root_kind = 'a2a_thread'
        AND root_id = ? AND parent_id IS NOT NULL ORDER BY opened_at DESC LIMIT 1`, agentId, root.id)
    : undefined;
  if (root?.kind === 'a2a' && !ask) request ??= requestRow('a2a_thread_id = ?', root.id);
  const run = root?.kind === 'occurrence'
    ? one("SELECT parent_id AS id FROM work WHERE id = ? AND parent_id IS NOT NULL AND state = 'open'", root.id)
    : undefined;

  // With no run, every parked job is what is running: its request ends too, whichever turn was latest.
  const parked = live ? [] : parkedJobs(agentId).map((j) => ({ id: j.id, origin: originOfTasks(agentId, [j.id]) }));
  const parkedAsks = parked.map((j) => (j.origin?.kind === 'ask' ? askIdForMessage(j.origin.messageId) : null));
  const asks = [...new Set([ask?.id, ...parkedAsks])]
    .filter((id): id is string => !!id && !!one(`SELECT id FROM work WHERE id = ?
      AND (state IN ('claimed', 'blocked') OR (state = 'open' AND next_attempt_at IS NOT NULL))`, id));
  const candidates = [request,
    ...parked.map((j) => (j.origin?.kind === 'a2a' ? requestRow('a2a_thread_id = ?', j.origin.threadId) : undefined))];
  const requests = [...new Map(candidates
    .filter((r): r is StoppedRequest => !!r && (!repliedOnThread(agentId, r.fromId, r.threadId, r.createdAt)
      || threadTasks(r.threadId).some((t) => t.due !== null)))
    .map((r) => [r.rowid, r] as const)).values()];

  // The job tasks: the live turn's job, the run's schedule, the parked ones, the task linked to an ask or named by
  // its job hold, and the working tasks on a request's thread.
  const jobs = new Set([live?.servedJob, live?.jobParked, run?.id, ...parked.map((j) => j.id),
    ...asks.flatMap((a) => [linkedTaskOf(agentId, a.slice('ask:'.length)), jobHeldAt(a)?.task]),
    ...requests.flatMap((r) => threadTasks(r.threadId).map((t) => t.id))].filter((t): t is string => !!t));
  return { liveRun: !!live, asks, runTasks: run ? [run.id] : [], requests, jobs: [...jobs] };
}

/** Agents the clock may wake: live, not running, and holding something that could be owed. */
function clockAgents(): string[] {
  return (getDb().prepare(`
    SELECT a.id FROM agents a WHERE a.status NOT IN ('terminated', 'paused', 'error') AND (
         EXISTS (SELECT 1 FROM work w WHERE w.agent_id = a.id AND w.kind = 'ask' AND w.state = 'open'
                   AND w.opened_at >= (unixepoch(COALESCE(a.session_started_at, '1970-01-01')) * 1000))
      OR EXISTS (SELECT 1 FROM work t WHERE t.agent_id = a.id AND t.kind <> 'ask' AND t.next_attempt_at IS NOT NULL AND ${workingExpr('t')})
      OR EXISTS (SELECT 1 FROM messages m WHERE m.agent_id = a.id AND m.role = 'user' AND m.swept_at IS NULL
                   AND (m.created_at >= (unixepoch('now', '-24 hours') * 1000) OR ${openPieceOnSql('m.a2a_thread_id')})
                   AND (m.a2a_intent IN ('QUESTION', 'ASSIGN', 'BLOCK')
                        OR (m.served_by_turn IS NULL AND (m.lane = 'events' OR m.a2a_intent IN (${FINAL_REPLY_SQL}))))))`)
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

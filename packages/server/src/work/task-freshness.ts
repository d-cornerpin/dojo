// When a task last moved: one expression, read by the PM's ladder and the close-out gate. Only activity that
// structurally names THAT task refreshes it. Plain assignee notes, PM pokes and engine bookkeeping are not
// movement; a status, an edit, a delivery or the turn's `activity` stamp is.

import { getDb } from '../db/connection.js';
import { taskScope } from './tracker-view.js';
import { turnContext } from '../agent/turn-context.js';
import type { JobOrigin } from './job-origin.js';
import { workingExpr } from './terminal-states.js';

/** Epoch ms the task aliased `a` last moved. `claim_turn` is not movement (`work/task-turns.ts`); a ledger
 *  item its calls touched (`work/ledger-store.ts`) is, so a job working through a set never looks idle. */
export const taskMovedAtSql = (a: string): string => `MAX(${a}.updated_at,
  COALESCE((SELECT MAX(l.last_at) FROM work_ledger l WHERE l.work_id = ${a}.id), 0), COALESCE((SELECT MAX(e.created_at)
  FROM work_events e WHERE e.work_id = ${a}.id AND ((e.kind IN ('transition', 'activity', 'opened') AND e.actor <> 'migration-901')
  OR (e.actor IN (${a}.agent_id, 'agent:' || ${a}.agent_id)
      AND NOT (e.kind = 'audit' AND json_extract(e.payload, '$.entry_kind') = 'observation')))), 0))`;

export const LADDER_ANCHOR_SQL = `COALESCE((SELECT unixepoch(applied_at) * 1000 FROM _migrations WHERE name LIKE '901%'), 0)`;

/** SQL: when the row under alias `a` began to stall: last move, latest hold lift, or the ladder anchor. */
export const stallSinceSql = (a: string): string => `MAX(${taskMovedAtSql(a)}, ${LADDER_ANCHOR_SQL}, COALESCE((SELECT MAX(c.created_at)
  FROM work_events c WHERE c.work_id = ${a}.id AND c.kind = 'audit' AND json_extract(c.payload, '$.entry_kind') = 'hold_cleared'), 0))`;

/** The job in flight. Its task ids travel on the park's own continuation wake, so it can be neither stolen
 *  nor orphaned: only a run launched from that wake carries it (`beginJobRun`), and it ends with that run
 *  (`endJobRun`), when its tasks close, its wake drops, or the agent stops (`endJobCarry`). In memory on
 *  purpose: a restart ends the job's turn. No clock: a call may run for hours. */
const jobWork = new Map<string, { ids: string[]; asks: string[]; origin: JobOrigin | null; drainWake: boolean; timerWakes: number; running: boolean }>();

const carryOf = (agentId: string) => {
  let c = jobWork.get(agentId);
  if (!c) { c = { ids: [], asks: [], origin: null, drainWake: false, timerWakes: 0, running: false }; jobWork.set(agentId, c); }
  return c;
};

/** A park names the job it hands on, never replacing a standing job with less. `asks` are the owner messages
 *  the parking turn served, re-shown only to its continuation (`memory/served-ask.ts`). */
export function carryJobWork(agentId: string, ids: string[], asks: string[] = [], origin: JobOrigin | null = null): void {
  if (ids.length === 0 && asks.length === 0 && !origin && !jobWork.has(agentId)) return;
  const c = carryOf(agentId);
  c.ids = [...new Set([...c.ids, ...ids])];
  c.asks = [...new Set([...c.asks, ...asks])];
  c.origin = c.origin ?? origin;   // the first park's origin stands for the whole chain
}

export function jobCarriedOrigin(agentId: string): JobOrigin | null {
  return jobWork.get(agentId)?.origin ?? null;
}

export function registerDrainWake(agentId: string): void {
  const c = jobWork.get(agentId);
  if (c) c.drainWake = true;
}

export function registerTimerWake(agentId: string): void {
  const c = jobWork.get(agentId);
  if (c) c.timerWakes += 1;
}

/** A park queues exactly one continuation. Its timer wake carries a token: if the drain starts the real
 *  continuation first, that run spends the token and the timer, whenever it fires, does nothing. */
export interface TimerWake { spent: boolean }
const armedTimerWakes = new Map<string, TimerWake[]>();

export function armTimerWake(agentId: string): TimerWake {
  registerTimerWake(agentId);
  const wake: TimerWake = { spent: false };
  armedTimerWakes.set(agentId, [...(armedTimerWakes.get(agentId) ?? []), wake]);
  return wake;
}

export function timerWakeIsSpent(agentId: string, wake: TimerWake): boolean {
  const rest = (armedTimerWakes.get(agentId) ?? []).filter((w) => w !== wake);
  if (rest.length > 0) armedTimerWakes.set(agentId, rest); else armedTimerWakes.delete(agentId);
  return wake.spent;
}

/** A queued-wakeup run is starting, before any turn context exists. If it serves one of the parked job's own
 *  asks (`servedIds`, read only while a timer wake is owed) it is the continuation: it spends a token and
 *  carries the job. */
export function beginContinuationRun(agentId: string, servedIds: () => string[]): boolean {
  const c = jobWork.get(agentId);
  const wake = (armedTimerWakes.get(agentId) ?? []).find((w) => !w.spent);
  if (!c || !wake || c.asks.length === 0) return false;
  try { if (!servedIds().some((id) => c.asks.includes(id))) return false; } catch { return false; }   // an unreadable probe spends nothing
  wake.spent = true;
  if (c.timerWakes > 0) c.timerWakes -= 1;
  c.running = true;
  return true;
}

export function beginJobRun(agentId: string, from: 'timer' | 'drain'): boolean {
  const c = jobWork.get(agentId);
  if (!c) return false;
  if (from === 'timer' && c.timerWakes > 0) c.timerWakes -= 1;
  else if (from === 'drain' && c.drainWake) c.drainWake = false;
  else return false;
  c.running = true;
  return true;
}

export function deferTimerWake(agentId: string): void {
  const c = jobWork.get(agentId);
  if (c && c.timerWakes > 0) { c.timerWakes -= 1; c.drainWake = true; }
}

/** The carrying run ended: the job lives on only while a continuation is queued. `wakeQueued` (a wake of its
 *  own on the shared set, none registered) makes that wake the continuation. */
export function endJobRun(agentId: string, wakeQueued = false): void {
  const c = jobWork.get(agentId);
  if (!c?.running) return;
  c.running = false;
  if (wakeQueued && !c.drainWake && c.timerWakes === 0) c.drainWake = true;
}

export function dropDrainJobWake(agentId: string): void {
  const c = jobWork.get(agentId);
  if (c) c.drainWake = false;
}

/** The job's chain is over (owner stop, or the agent left the running states): its parked timer wakes end
 *  with it, so a wake waiting on a named event cannot fire into a Stop pressed meanwhile. */
export function endJobCarry(agentId: string): void {
  jobWork.delete(agentId);
  for (const wake of armedTimerWakes.get(agentId) ?? []) wake.spent = true;
}

export function jobCarriedIds(agentId: string): string[] {
  return settleJob(agentId).tasks;
}

export function jobCarriedAsks(agentId: string): string[] {
  return settleJob(agentId).asks;
}

/** What is still open of the job's tasks and asks; the job is over when neither is. */
function settleJob(agentId: string): { tasks: string[]; asks: string[] } {
  const c = jobWork.get(agentId);
  if (!c) return { tasks: [], asks: [] };
  const inFlight = c.running || c.drainWake || c.timerWakes > 0;
  const db = getDb();
  const tasks = !inFlight ? [] : (db.prepare(
    `SELECT w.id AS id FROM work w WHERE w.id IN (${c.ids.map(() => '?').join(', ')})
       AND ${workingExpr('w', true)}`).all(...c.ids) as Array<{ id: string }>).map((r) => r.id);
  const asks = !inFlight || c.asks.length === 0 ? [] : (db.prepare(
    `SELECT w.root_id AS id FROM work w WHERE w.kind = 'ask' AND w.state = 'claimed'
       AND w.root_id IN (${c.asks.map(() => '?').join(', ')})`).all(...c.asks) as Array<{ id: string }>).map((r) => r.id);
  if (tasks.length === 0 && asks.length === 0 && !(inFlight && c.origin)) jobWork.delete(agentId);   // a job carried by its origin alone lives while its chain does
  else { c.ids = tasks; c.asks = asks; }
  return { tasks, asks };
}

/** The person's message a parked job started from, while its continuation is queued and has not started. */
export function parkedContinuationFor(agentId: string): string | null {
  const c = jobWork.get(agentId);
  return c && (c.drainWake || c.timerWakes > 0) && c.origin?.kind === 'ask' ? c.origin.messageId : null;
}

export function runCarriesJob(agentId: string): boolean {
  return jobWork.get(agentId)?.running === true;
}

/** Was this task served to this turn by a tracker notice (re-drive, retask, assignment)? Being woken by one
 *  is not progress: only what the agent then does on the task moves it. */
export function servedByNotice(agentId: string, turnNumber: number, taskId: string | null | undefined): boolean {
  try {
    return !!taskId && !!getDb().prepare(`SELECT 1 FROM messages WHERE agent_id = ? AND served_by_turn = ?
      AND lane = 'events' AND origin_intent = 'tracker' AND task_id = ? LIMIT 1`).get(agentId, turnNumber, taskId);
  } catch { return false; /* unreadable: the served task is tied as before */ }
}

export function turnWorkIds(agentId: string): string[] {
  const ctx = turnContext(agentId);
  if (!ctx || ctx.turnNumber === undefined) return [];
  const inherited = runCarriesJob(agentId) ? jobCarriedIds(agentId) : [];   // only the run launched from the park's own wake
  const named = [...inherited, ...(ctx.servedWork?.taskId ? [ctx.servedWork.taskId] : [])];   // the served task IS the job, whatever woke the turn
  const ask = ctx.root?.kind === 'ask' ? ctx.root.sourceMessageId : null;
  const thread = ctx.root?.kind === 'a2a' ? ctx.root.id : null;
  const list = named.length > 0 ? named.map(() => '?').join(', ') : 'NULL';
  const rows = getDb().prepare(`SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND (
      w.id IN (${list}) OR w.source_message_id = ? OR w.a2a_thread_id = ? OR w.origin_turn = ?
      OR w.parent_id IN (SELECT p.id FROM work p WHERE p.id IN (${list}) OR p.source_message_id = ?))`)
    .all(agentId, ...named, ask, thread, ctx.turnNumber, ...named, ask) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}


// ════════════════════════════════════════════════════════════════════════════════════════
// WHEN A TASK LAST MOVED — ONE EXPRESSION, READ BY THE PM'S LADDER AND THE CLOSE-OUT GATE
// (t143 round 2, orchestrator ruling: a task's freshness may only be refreshed by activity that
// structurally names THAT task).
//
// `work.updated_at` is written only by changes to that row (a status, a claim, an edit, a
// schedule; and, since round 2, the engine checkpoint for the job's OWN tasks — see
// `engine-checkpoint-note.ts`). What it never saw is a "still working" note: `work_note` appends
// an event and touches no column. So the task's movement is the newer of its row's clock and its
// own events: its transitions, its opening and claim, the turn-finalize `activity` stamp (written
// only for turns whose trigger names the task, round 2), and what its assignee wrote on it, EXCEPT its
// plain notes (t151: a "still working" note is a record, an answer to a check-in, not the task moving;
// real work shows as a status, an edit, a delivery or the turn's `activity` stamp).
// A PM poke, the PM's own notes and engine bookkeeping are not the task moving.
//
// And WHICH work a turn names (`turnWorkIds`), which the engine checkpoint and the turn-finalize
// stamp use instead of "every claim of this agent" / "every ticket of this conversation".
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { taskScope } from './tracker-view.js';
import { turnContext } from '../agent/turn-context.js';

/** Epoch ms the task aliased `a` last moved. */
export const taskMovedAtSql = (a: string): string => `MAX(${a}.updated_at, COALESCE((SELECT MAX(e.created_at)
  FROM work_events e WHERE e.work_id = ${a}.id AND (e.kind IN ('transition', 'activity', 'opened', 'claim_turn')
  OR (e.actor IN (${a}.agent_id, 'agent:' || ${a}.agent_id)
      AND NOT (e.kind = 'audit' AND json_extract(e.payload, '$.entry_kind') = 'observation')))), 0))`;

/** THE JOB IN FLIGHT. Its task ids travel ON the park's own continuation wake (t143 round 6), so
 *  it can be neither stolen nor orphaned:
 *    - a park (`carryJobWork`) names the ids and queues exactly one continuation wake — on the
 *      shared wake set that the runtime's drain serves (`drainWake`), or on the tool-loop park's own
 *      timer (`timerWakes`). Both are registered by the park's helpers (`engine-checkpoint-note.ts`);
 *    - only a run LAUNCHED FROM THAT WAKE carries the job (`beginJobRun`): the timer's run, or the
 *      drain's run while a drain wake is registered. Any other run (an owner message, an A2A, an
 *      engine event, the scheduler) neither carries it nor ends it — it touches none of this;
 *    - the carrying run ends it only by ending (`endJobRun`), and a further park inside it re-hands
 *      the job to the next continuation it queues;
 *    - the job is also over when its tasks close, when the queued wake is dropped (`dropDrainJobWake`),
 *      when the owner stops the agent, or when the agent leaves the running states (`endJobCarry`,
 *      called by the one status writer).
 *  In memory on purpose: a restart ends the job's turn. There is no clock: a call may run for hours. */
const jobWork = new Map<string, { ids: string[]; asks: string[]; drainWake: boolean; timerWakes: number; running: boolean }>();

const carryOf = (agentId: string) => {
  let c = jobWork.get(agentId);
  if (!c) { c = { ids: [], asks: [], drainWake: false, timerWakes: 0, running: false }; jobWork.set(agentId, c); }
  return c;
};

/** A park names the job it is handing on: never replaces a standing job with less. `asks` (t145) are the
 *  owner messages the parking turn SERVED — the same record carries them, so a job with no task still
 *  has its words re-shown to its continuation (`memory/served-ask.ts`), and ONLY to that continuation. */
export function carryJobWork(agentId: string, ids: string[], asks: string[] = []): void {
  if (ids.length === 0 && asks.length === 0 && !jobWork.has(agentId)) return;
  const c = carryOf(agentId);
  c.ids = [...new Set([...c.ids, ...ids])];
  c.asks = [...new Set([...c.asks, ...asks])];
}

/** The park queued its continuation on the shared wake set (the runtime's drain serves it). */
export function registerDrainWake(agentId: string): void {
  const c = jobWork.get(agentId);
  if (c) c.drainWake = true;
}

/** The park armed its continuation on the tool-loop timer. */
export function registerTimerWake(agentId: string): void {
  const c = jobWork.get(agentId);
  if (c) c.timerWakes += 1;
}

/** t158 E — A PARK QUEUES EXACTLY ONE CONTINUATION, KEPT BY BOOKKEEPING AND NOT BY TIMING. The tool-loop
 *  park's timer wake carries a token. When the ask-settlement re-open lets the drain start the real
 *  continuation first (it serves one of the job's own asks), THAT run is the continuation: its start
 *  spends the token, and the timer, whenever it fires and whatever the agent is doing, finds its token
 *  spent and does nothing. A park with no ask (no drain) is never spent, so its timer is the only wake. */
export interface TimerWake { spent: boolean }
const armedTimerWakes = new Map<string, TimerWake[]>();

/** The park armed its continuation on the tool-loop timer: count it, and hand the timer its token. */
export function armTimerWake(agentId: string): TimerWake {
  registerTimerWake(agentId);
  const wake: TimerWake = { spent: false };
  armedTimerWakes.set(agentId, [...(armedTimerWakes.get(agentId) ?? []), wake]);
  return wake;
}

/** The timer fired: forget its token; true when the token was already spent (nothing to run). */
export function timerWakeIsSpent(agentId: string, wake: TimerWake): boolean {
  const rest = (armedTimerWakes.get(agentId) ?? []).filter((w) => w !== wake);
  if (rest.length > 0) armedTimerWakes.set(agentId, rest); else armedTimerWakes.delete(agentId);
  return wake.spent;
}

/** A queued-wakeup run is STARTING, before any turn context exists. If it will serve one of the parked
 *  job's own asks (`servedIds`, read lazily, only while a park's timer wake is owed), it IS the park's
 *  continuation: spend one timer token and carry the job as a timer-started run does. */
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

/** A run is starting FROM a continuation wake: `'timer'` (the park's own timer fired) or `'drain'`
 *  (the runtime's queued-wakeup drain, which serves a registered drain wake). Returns whether this
 *  run now carries the job. */
export function beginJobRun(agentId: string, from: 'timer' | 'drain'): boolean {
  const c = jobWork.get(agentId);
  if (!c) return false;
  if (from === 'timer' && c.timerWakes > 0) c.timerWakes -= 1;
  else if (from === 'drain' && c.drainWake) c.drainWake = false;
  else return false;
  c.running = true;
  return true;
}

/** The park's timer fired while the agent was busy: its wake is now queued on the shared set. */
export function deferTimerWake(agentId: string): void {
  const c = jobWork.get(agentId);
  if (c && c.timerWakes > 0) { c.timerWakes -= 1; c.drainWake = true; }
}

/** The run that carried the job has ended. A further park inside it registered a new wake, so the
 *  job lives on exactly when a continuation is still queued. `wakeQueued`: the run ended with a wake of
 *  its own on the shared set (a recovery re-queue, a self-wake, an arrival merged with it) and none
 *  registered: that wake becomes the job's continuation, with the same ids (t143 round 7). */
export function endJobRun(agentId: string, wakeQueued = false): void {
  const c = jobWork.get(agentId);
  if (!c?.running) return;
  c.running = false;
  if (wakeQueued && !c.drainWake && c.timerWakes === 0) c.drainWake = true;
}

/** A carrying run is scheduling a retry of itself on a timer (the 429 silent retry): the retry is the
 *  job's continuation. Returns whether it was registered (the caller then starts it `{ job: true }`). */
export function registerRetryWake(agentId: string): boolean {
  const c = jobWork.get(agentId);
  if (!c?.running) return false;
  c.timerWakes += 1;
  return true;
}

/** The queued continuation was skipped or dropped (a stop state, a stop fence, a terminated agent). */
export function dropDrainJobWake(agentId: string): void {
  const c = jobWork.get(agentId);
  if (c) c.drainWake = false;
}

/** The job's chain is over: the owner stopped the agent, or it left the running states. */
export function endJobCarry(agentId: string): void {
  jobWork.delete(agentId);
}

/** The tasks this agent's job is carrying right now: those still open, while a run carries the job
 *  or a continuation wake is queued for it. The one answer to "is this task the job in flight?". */
export function jobCarriedIds(agentId: string): string[] {
  return settleJob(agentId).tasks;
}

/** The owner messages (t145) this agent's job is carrying: those whose ask is still claimed, under the same
 *  rule as the tasks (a run carries the job or a continuation wake is queued). A finished ask drops out. */
export function jobCarriedAsks(agentId: string): string[] {
  return settleJob(agentId).asks;
}

/** One settle for both: what is still open of the job's tasks and of its asks; the job is over when neither is. */
function settleJob(agentId: string): { tasks: string[]; asks: string[] } {
  const c = jobWork.get(agentId);
  if (!c) return { tasks: [], asks: [] };
  const inFlight = c.running || c.drainWake || c.timerWakes > 0;
  const db = getDb();
  const tasks = !inFlight ? [] : (db.prepare(
    `SELECT w.id AS id FROM work w WHERE w.id IN (${c.ids.map(() => '?').join(', ')})
       AND w.state IN ('claimed', 'on_deck', 'blocked')`).all(...c.ids) as Array<{ id: string }>).map((r) => r.id);
  const asks = !inFlight || c.asks.length === 0 ? [] : (db.prepare(
    `SELECT w.root_id AS id FROM work w WHERE w.kind = 'ask' AND w.state = 'claimed'
       AND w.root_id IN (${c.asks.map(() => '?').join(', ')})`).all(...c.asks) as Array<{ id: string }>).map((r) => r.id);
  if (tasks.length === 0 && asks.length === 0) jobWork.delete(agentId);
  else { c.ids = tasks; c.asks = asks; }
  return { tasks, asks };
}

/** Is the CURRENT run the one carrying the job (launched from the park's continuation wake)? */
export function runCarriesJob(agentId: string): boolean {
  return jobWork.get(agentId)?.running === true;
}

/** Was this task served to this turn by a tracker NOTICE (a PM re-drive, a retask, an assignment)?
 *  Being woken by one is not progress on the task (t143 round 4): only what the agent then does on
 *  it (its tool calls, notes, status changes, a delivery about it) moves it. */
export function servedByNotice(agentId: string, turnNumber: number, taskId: string | null | undefined): boolean {
  try {
    return !!taskId && !!getDb().prepare(`SELECT 1 FROM messages WHERE agent_id = ? AND served_by_turn = ?
      AND lane = 'events' AND origin_intent = 'tracker' AND task_id = ? LIMIT 1`).get(agentId, turnNumber, taskId);
  } catch { return false; /* unreadable: the served task is tied as before */ }
}

/** The tasks the CURRENT turn of this agent structurally serves (see the header above). */
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


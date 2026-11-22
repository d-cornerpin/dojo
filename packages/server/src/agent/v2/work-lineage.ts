// Is the work a message is about still open? One reader for the serve boundary (counterparty.ts) and the
// approval decision (approval-decision.ts); an ask is the `work` row `ask:<messageId>`, spent once terminal.
import { getDb } from '../../db/connection.js';
import { askIdForMessage, isTerminal, type WorkState } from '../../work/store.js';
import { occurrenceRunStatus } from '../../work/occurrence-runs.js';
import { taskScope, STATE_TO_STATUS_SQL } from '../../work/tracker-view.js';
import { isTerminalTaskStatus } from '../tool-helpers.js';
import type { TurnRoot } from '../turn-context.js';

export interface Spent { reason: string; state: string }

export function spentRun(runId: string): Spent | null {
  const status = occurrenceRunStatus(runId);
  if (!status) return { reason: 'run_missing', state: 'run row gone' };
  return status === 'running' ? null : { reason: 'run_closed', state: `run ${status}` };
}

export function spentTask(taskId: string): Spent | null {
  const task = getDb().prepare(
    `SELECT ${STATE_TO_STATUS_SQL('w.state')} AS status, w.is_paused AS is_paused FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
  ).get(taskId) as { status: string; is_paused: number } | undefined;
  if (!task) return { reason: 'task_missing', state: 'task row gone' };
  if (isTerminalTaskStatus(task.status)) return { reason: 'task_terminal', state: `task ${task.status}` };
  // A paused schedule is spent, a hold is not; handed-in awaits its decision (a prompt would redo it).
  if (task.is_paused === 1) return { reason: 'task_paused', state: 'task paused' };
  if (task.status === 'handed_in') return { reason: 'task_handed_in', state: 'task handed in' };
  return null;
}

/** An owner's ask is the `work` row `ask:<messageId>`; no row means the ask no longer resolves. */
export function spentAsk(messageId: string): Spent | null {
  const row = getDb().prepare('SELECT state FROM work WHERE id = ?').get(askIdForMessage(messageId)) as { state: WorkState } | undefined;
  if (!row) return { reason: 'ask_missing', state: 'ask row gone' };
  return isTerminal(row.state) ? { reason: 'ask_closed', state: `ask ${row.state}` } : null;
}

/** A queued `a2a_request` wake rooted in an ask is spent only when its whole lineage is finished (the
 * approval decision's verdict), so an ask closed while its task is open stays served. Other events: null. */
export function spentWakeAsk(ev: { origin_intent: string | null; root_kind: string | null; root_id: string | null; task_id: string | null }): Spent | null {
  if (ev.origin_intent !== 'a2a_request' || ev.root_kind !== 'ask' || !ev.root_id) return null;
  return lineageVerdict({ rootKind: ev.root_kind, rootId: ev.root_id, taskId: ev.task_id }).finished ? spentAsk(ev.root_id) : null;
}

export interface WorkLineage { rootKind: string | null; rootId: string | null; taskId: string | null }

export interface LineageVerdict {
  /** The ledger could answer for at least one named referent. False means no evidence either way. */
  judged: boolean;
  finished: boolean;
  rootSpent: boolean;
  taskSpent: boolean;
}

/** Ask and occurrence roots and task ids can be judged; engine and a2a roots are only origins. FINISHED
 * means every judgeable referent is spent; callers treat `judged: false` (nothing to judge) as open. */
export function lineageVerdict(l: WorkLineage): LineageVerdict {
  const rootJudged = !!l.rootId && (l.rootKind === 'ask' || l.rootKind === 'occurrence');
  const root = !rootJudged ? null : l.rootKind === 'ask' ? spentAsk(l.rootId!) : spentRun(l.rootId!);
  const taskJudged = !!l.taskId;
  const task = taskJudged ? spentTask(l.taskId!) : null;
  const judged = rootJudged || taskJudged;
  const rootSpent = rootJudged && root !== null;
  const taskSpent = taskJudged && task !== null;
  const finished = judged && (!rootJudged || rootSpent) && (!taskJudged || taskSpent);
  return { judged, finished, rootSpent, taskSpent };
}

/** Turn root for an engine event: its run, the carried work of an `a2a_request` wake, else the event. */
export function engineEventRoot(ev: {
  id: string; runId: string | null; originIntent: string | null; rootKind: string | null; rootId: string | null;
}): TurnRoot {
  if (ev.runId) return { kind: 'occurrence', id: ev.runId, sourceMessageId: null };
  if (ev.originIntent === 'a2a_request' && ev.rootId && (ev.rootKind === 'ask' || ev.rootKind === 'a2a' || ev.rootKind === 'engine')) {
    if (ev.rootKind !== 'ask') return { kind: ev.rootKind, id: ev.rootId, sourceMessageId: null };
    const ticket = getDb().prepare('SELECT conversation_id FROM work WHERE id = ?').get(askIdForMessage(ev.rootId)) as { conversation_id: string | null } | undefined;
    return { kind: 'ask', id: ev.rootId, sourceMessageId: ev.rootId, conversationId: ticket?.conversation_id ?? null };
  }
  return { kind: 'engine', id: ev.id, sourceMessageId: null };
}

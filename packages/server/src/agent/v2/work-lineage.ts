// ════════════════════════════════════════════════════════════════════════════════
// Is the work a message is ABOUT still open?  (t232)
//
// One reader for a question two doors were asking differently:
//   * the SERVE BOUNDARY (`counterparty.retireSpentEngineEvents`) asks it of a queued engine event's
//     task and run before the event can become a turn;
//   * the APPROVAL DECISION (`agent/approval-decision.ts`) asks it of the held call's lineage before
//     it wakes the requester, because a decision for finished work is not a job.
// The task and run answers moved here from the first door, byte for byte (same reasons, same states),
// and the ask answer is new: an ask is the `work` row `ask:<messageId>`, spent once it is terminal.
//
// Also here: the one place a woken turn's ROOT is derived from the event that woke it.
// ════════════════════════════════════════════════════════════════════════════════
import { getDb } from '../../db/connection.js';
import { askIdForMessage, isTerminal, type WorkState } from '../../work/store.js';
import { occurrenceRunStatus } from '../../work/occurrence-runs.js';
import { taskScope, STATE_TO_STATUS_SQL } from '../../work/tracker-view.js';
import { isTerminalTaskStatus } from '../tool-helpers.js';
import type { TurnRoot } from '../turn-context.js';

/** Why a referent no longer calls for a turn, and the state that says so. */
export interface Spent { reason: string; state: string }

export function spentRun(runId: string): Spent | null {
  const status = occurrenceRunStatus(runId);   // T10F: an occurrence id now
  if (!status) return { reason: 'run_missing', state: 'run row gone' };
  return status === 'running' ? null : { reason: 'run_closed', state: `run ${status}` };
}

export function spentTask(taskId: string): Spent | null {
  const task = getDb().prepare(
    `SELECT ${STATE_TO_STATUS_SQL('w.state')} AS status, w.is_paused AS is_paused FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
  ).get(taskId) as { status: string; is_paused: number } | undefined;
  if (!task) return { reason: 'task_missing', state: 'task row gone' };
  if (isTerminalTaskStatus(task.status)) return { reason: 'task_terminal', state: `task ${task.status}` };
  if (task.status === 'paused' && task.is_paused === 1) return { reason: 'task_paused', state: 'task paused' };
  return null;
}

/** An owner's ask: the ticket `ask:<messageId>`. A message with no ticket is an ask that no longer resolves. */
export function spentAsk(messageId: string): Spent | null {
  const row = getDb().prepare('SELECT state FROM work WHERE id = ?').get(askIdForMessage(messageId)) as { state: WorkState } | undefined;
  if (!row) return { reason: 'ask_missing', state: 'ask row gone' };
  return isTerminal(row.state) ? { reason: 'ask_closed', state: `ask ${row.state}` } : null;
}

export interface WorkLineage { rootKind: string | null; rootId: string | null; taskId: string | null }

export interface LineageVerdict {
  /** The ledger could answer for at least one named referent. False means no evidence either way. */
  judged: boolean;
  /** Every referent the ledger could answer for is spent (and at least one was). */
  finished: boolean;
  rootSpent: boolean;
  taskSpent: boolean;
}

/**
 * The state of the work a lineage names. A root of kind `ask` or `occurrence` and a task id are things the
 * ledger can answer for; an `engine` or `a2a` root is only an origin and says nothing about whether the job
 * is done. The work is FINISHED only when every referent that can be judged is spent — an ask closed while
 * its task is still open is open work. No judgeable referent (an old row, a call made outside any turn) is
 * `judged: false`, and callers treat that as open: nothing says the work is finished.
 */
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

/**
 * The root of the turn an engine event starts. An occurrence run is its own root (the scheduler's shape,
 * unchanged). An action-required A2A wake that CARRIES the lineage of the work it belongs to (`a2a_request`
 * with root columns — the approval decision's wake) is rooted in that work; every other event, including the
 * ones whose root columns only label a referent, is rooted in the event itself, as before.
 */
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

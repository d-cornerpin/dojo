// What happens at the two moments of board work, each a short ordered list of calls.
//   At the hand-in (the work is delivered): a run's schedule advances, the asker who never got the work
//   on its thread is relayed it, prompts queued for the work retire, and the decider is woken.
//   At the decision (the work is accepted, or not): dependents unblock, the project is derived from its
//   tasks, a finished schedule stops, and a send-back reaches the worker of record.
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { ringValidationDoorbell } from '../validation-drive.js';
import { retireEngineEventsForTask } from '../../agent/v2/counterparty.js';
import { claimTrackerNoticeForTask } from '../../memory/message-store.js';
import { checkDependencies } from '../../tracker/dependencies.js';
import { sendAgentMessage } from '../../agent/agent-bus.js';
import { getPMAgentId, getPrimaryAgentId } from '../../config/platform.js';
import { writeAssignee } from '../row-authority.js';
import { recordMove } from '../move-record.js';
import { isTerminal, type WorkState } from '../store.js';
import { latestHandIn, workerOf, OWNER_ID } from './record.js';
import { settleProject } from './project-state.js';

const logger = createLogger('work-effects');

/** The hand-in-time effects, in order. */
export function onHandedIn(workId: string, handInEventId: number): void {
  const h = latestHandIn(workId, handInEventId);
  if (!h) return;
  if (h.scope === 'run') {
    void import('../../scheduler/runner.js')
      .then(({ onTaskRunComplete }) => onTaskRunComplete(workId, h.outcome === 'finished' ? 'complete' : 'failed', h.note))
      .catch((err: unknown) => logger.warn('run hand-in: the schedule did not advance', { workId, error: String(err) }));
  }
  relayAssignHandbackIfMissing(workId, h.note);
  retireQueuedPrompts(workerOf(workId), workId);
  ringValidationDoorbell({ workId, shape: 'close-request' });
}

/** Every unserved prompt for this work (its assignment notice, triggers, pokes) retires, so handed-in work
 *  is never driven again. Rows written before prompts carried a task id are matched on the notice text. */
function retireQueuedPrompts(workerId: string, workId: string): void {
  try {
    retireEngineEventsForTask(workId, 'task_handed_in');
    claimTrackerNoticeForTask({ agentId: workerId, contentLike: `%ID: ${workId}%` });
  } catch (err) {
    logger.warn('hand-in: queued prompts for the work did not retire', { workId, error: String(err) });
  }
}

/** The decision-time effects, in order. `decisionId` is the `decided` event. */
export function onDecided(workId: string, decisionId: number): void {
  const db = getDb();
  const d = db.prepare("SELECT actor, payload FROM work_events WHERE id = ? AND work_id = ? AND kind = 'decided'").get(decisionId, workId) as
    { actor: string; payload: string } | undefined;
  const row = db.prepare('SELECT parent_id, title FROM work WHERE id = ?').get(workId) as { parent_id: string | null; title: string | null } | undefined;
  if (!d || !row) return;
  const { verdict, reason, to } = JSON.parse(d.payload) as { verdict: string; reason: string; to: WorkState };
  if (verdict === 'send_back') { sendBackHint(workId, row.title, d.actor, reason); return; }
  if (!isTerminal(to)) return;
  if (to === 'done') checkDependencies(workId);
  if (row.parent_id) settleProject(row.parent_id);
  void import('../../scheduler/runner.js')
    .then(({ terminateLiveScheduleOnFallen }) => terminateLiveScheduleOnFallen(workId, `the work was decided ${to}`, 'schedule stopped at its decision'))
    .catch((err: unknown) => logger.warn('decision: the schedule could not be stopped', { workId, error: String(err) }));
}

/** A terminated agent's work goes back to the agent that spawned it, else to the primary. */
export function workerOfRecord(agentId: string): string {
  const a = getDb().prepare('SELECT status, parent_agent FROM agents WHERE id = ?').get(agentId) as { status: string; parent_agent: string | null } | undefined;
  if (!a || a.status !== 'terminated') return agentId;
  return a.parent_agent ?? getPrimaryAgentId();
}

/** One hint to the worker of record, which works the row from here on. */
function sendBackHint(workId: string, title: string | null, deciderId: string, reason: string): void {
  const worker = workerOf(workId);
  const to = workerOfRecord(worker);
  if (to !== worker && writeAssignee(workId, { agentId: to }) > 0) {
    recordMove({ taskId: workId, actor: 'engine', from: worker, to: { agentId: to }, cause: 'assignee_gone', door: 'send-back' });
  }
  sendAgentMessage(deciderId === OWNER_ID ? getPMAgentId() : deciderId, to, 'status',
    `[Engine hint: "${title ?? workId}" [${workId}] was sent back${to !== worker ? ` (its worker ${worker} has ended, so it is yours now)` : ''}: ${reason}. `
    + 'Delivered work stays as it is; do only what the reason asks, then hand it in again with proof.]', { taskId: workId, event: 'sent_back' });
}

/** The asker of an assigned task hears the work on its thread when the worker never said anything there. */
function relayAssignHandbackIfMissing(workId: string, note: string): void {
  const row = getDb().prepare('SELECT requester_id, agent_id, a2a_thread_id, opened_at, title FROM work WHERE id = ?').get(workId) as
    { requester_id: string | null; agent_id: string; a2a_thread_id: string | null; opened_at: number; title: string | null } | undefined;
  if (!row?.a2a_thread_id || !row.requester_id || row.requester_id === row.agent_id) return;
  const thread = row.a2a_thread_id, asker = row.requester_id;
  const heard = (): boolean => !!getDb().prepare(
    'SELECT 1 FROM messages WHERE agent_id = ? AND source_agent_id = ? AND a2a_thread_id = ? AND created_at >= ? LIMIT 1',
  ).get(asker, row.agent_id, thread, row.opened_at);
  if (heard()) return;
  // A grace period first: the worker often sends the work back in the same batch as its hand-in.
  setTimeout(() => {
    if (heard()) return;
    void import('../../agent/a2a-transport.js').then(async ({ deliverA2AMessage }) => {
      const sent = await deliverA2AMessage({
        intent: 'COMPLETE', threadId: thread, requiresResponse: false, toAgent: asker, fromAgent: row.agent_id,
        payload: `${note}\n\n[Engine relay: the assignee handed in "${row.title ?? workId}" (${workId.slice(0, 8)}) without replying on this thread; the text above is its hand-in note.]`,
      });
      if (!sent.delivered) logger.warn('hand-in relay to the asker was not delivered', { workId, reason: sent.reason });
    }).catch((err: unknown) => logger.warn('hand-in relay to the asker failed', { workId, error: String(err) }));
  }, 20_000).unref?.();
}

// What happens at the two moments of board work, each a short ordered list of calls.
//   At the hand-in (the work is delivered): a run's schedule advances, the asker who never got the work
//   on its thread is relayed it, prompts queued for the work retire, and the decider is woken.
//   At the decision (the work is accepted, or not): dependents unblock, the project is derived from its
//   tasks, a finished schedule stops, and a send-back reaches the worker of record.
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { retireEngineEventsForTask } from '../../agent/v2/counterparty.js';
import { claimTrackerNoticeForTask, repliedOnThread } from '../../memory/message-store.js';
import { taskScope, STATE_TO_STATUS_SQL, heldByOwnerSql, stateToStatus } from '../tracker-view.js';
import { setTrackerStatus } from '../tracker-store.js';
import { sendAgentMessage } from '../../agent/agent-bus.js';
import { getPMAgentId, getPrimaryAgentId } from '../../config/platform.js';
import { workerOfRecord, rehome } from '../row-authority.js';
import { isTerminal, noteUnsettled, ownerHoldStands, type WorkState } from '../store.js';
import { latestHandIn, workerOf, OWNER_ID } from './record.js';
import { settleProject } from './project-state.js';

const logger = createLogger('work-effects');
/** The PM module, loaded once and shared, so a burst of hand-ins never races its own import. */
let pmAgent: Promise<typeof import('../../tracker/pm-agent.js')> | null = null;

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
  void (pmAgent ??= import('../../tracker/pm-agent.js')).then(({ armDebouncedReview }) => armDebouncedReview(workId, 'hand-in'))
    .catch((err: unknown) => logger.warn('hand-in: the decider could not be woken', { workId, error: String(err) }));
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

/** One hint to the worker of record, which works the row from here on: the owner's send-back as an engine hint in his
 *  name, an agent decider's as its own message. */
function sendBackHint(workId: string, title: string | null, deciderId: string, reason: string): void {
  const worker = workerOf(workId);
  const to = workerOfRecord(worker);
  rehome(workId, worker, to, 'send-back');
  const hint = `[Engine hint: "${title ?? workId}" [${workId}] was sent back${deciderId === OWNER_ID ? ' by the owner' : ''}${to !== worker ? ` (its worker ${worker} has ended, so it is yours now)` : ''}: ${reason}. `
    + 'Delivered work stays as it is; do only what the reason asks, then hand it in again with proof.]';
  if (deciderId !== OWNER_ID) sendAgentMessage(deciderId, to, 'status', hint, { taskId: workId, event: 'sent_back' });
  else void import('../../agent/agent-notice.js').then(({ redriveWithoutReply }) => redriveWithoutReply({ toAgentId: to, fromAgentId: null, content: hint, taskId: workId }));
}

/** The asker of an assigned task hears the work on its thread when the worker never said anything there. */
function relayAssignHandbackIfMissing(workId: string, note: string): void {
  const row = getDb().prepare('SELECT requester_id, agent_id, a2a_thread_id, opened_at, title FROM work WHERE id = ?').get(workId) as
    { requester_id: string | null; agent_id: string; a2a_thread_id: string | null; opened_at: number; title: string | null } | undefined;
  if (!row?.a2a_thread_id || !row.requester_id || row.requester_id === row.agent_id) return;
  const thread = row.a2a_thread_id, asker = row.requester_id;
  const heard = (): boolean => repliedOnThread(row.agent_id, asker, thread, row.opened_at);
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

// ── Dependents unblock when the work they wait on is done ──

export function checkDependencies(completedTaskId: string): void {
  const db = getDb();

  // Find tasks that depend on the completed task
  const dependentTasks = db.prepare(`
    SELECT w.id AS id, w.title AS title, ${STATE_TO_STATUS_SQL('w.state')} AS status,
           w.agent_id AS assigned_to, w.depends_on AS depends_on,
           w.scheduled_start AS scheduled_start, w.next_run_at AS next_run_at
    FROM work w
    WHERE ${taskScope('w')} AND w.state = 'open'
      AND w.depends_on LIKE ?
  `).all(`%${completedTaskId}%`) as Array<{
    id: string;
    title: string;
    status: string;
    assigned_to: string | null;
    depends_on: string;
    scheduled_start: number | null;
    next_run_at: number | null;
  }>;

  for (const row of dependentTasks) {
    let dependsOn: string[];
    try {
      dependsOn = JSON.parse(row.depends_on) as string[];
    } catch {
      continue;
    }

    // Check if this task actually depends on the completed task
    if (!dependsOn.includes(completedTaskId)) continue;

    // Check if ALL dependencies are now complete
    const allDepsComplete = dependsOn.every(depId => {
      const depTask = db.prepare(`SELECT ${STATE_TO_STATUS_SQL('state')} AS status FROM work WHERE id = ?`).get(depId) as { status: string } | undefined;
      return depTask?.status === 'complete';
    });

    if (allDepsComplete && !ownerHoldStands(row.id, false)) {
      // A dependency validating makes the task ELIGIBLE; it does not start it ahead of its own schedule.
      // A task with a start still in the future waits on deck and the scheduler fires it then (it was only
      // skipping it for the unmet dependency). Tasks without a future schedule
      // land in 'in_progress' so they stay visible; 'on_deck' is reserved for scheduled-for-later.
      const nowMs = Date.now();
      const startsLater = (row.scheduled_start ?? 0) > nowMs || (row.next_run_at ?? 0) > nowMs;
      if (startsLater) {
        if (row.status !== 'on_deck') {
          noteUnsettled(setTrackerStatus(row.id, 'on_deck', {
            by: 'pm', actorId: getPMAgentId(),
            reason: `every dependency of this task is complete (last: ${completedTaskId.slice(0, 8)}); it waits for its own scheduled start`,
          }), 'pm: dependencies cleared, task waits for its scheduled start', { taskId: row.id });
        }
      } else {
        noteUnsettled(setTrackerStatus(row.id, 'in_progress', {
          by: 'pm', actorId: getPMAgentId(),
          reason: `every dependency of this task is complete (last: ${completedTaskId.slice(0, 8)})`,
        }), 'pm: dependencies cleared, task unblocked', { taskId: row.id });
      }

      logger.info('Task unblocked by dependency completion', {
        taskId: row.id,
        taskTitle: row.title,
        completedDep: completedTaskId,
      });

      // Notify primary agent or the assigned agent
      const recipient = row.assigned_to ?? getPrimaryAgentId();
      const task = db.prepare('SELECT priority, description FROM work WHERE id = ?').get(row.id) as { priority: string | null; description: string | null };
      const message = `Task "${row.title}" (${row.id}) is now unblocked. All dependencies are complete.`
        + (startsLater ? ` It starts at its own scheduled time (${new Date(row.scheduled_start ?? row.next_run_at ?? nowMs).toISOString()}), not before.` : '') + '\n\n' +
        `Priority: ${task.priority ?? 'normal'}\n` +
        (task.description ? `Description: ${task.description}\n` : '') +
        `Previously blocked on: ${dependsOn.join(', ')}`;
      sendAgentMessage(getPMAgentId(), recipient, 'status', message, {
        taskId: row.id,
        event: 'unblocked',
        completedDependency: completedTaskId,
      });
    }
  }
}

/** Steps whose hand-in the door refused: not tried again until restart. */
const refusedHandIns = new Set<string>();

/** Open steps whose earlier step was cancelled, failed or is gone are handed in as can't be done, once each:
 *  a handed-in step is no longer open, so the next sweep passes it by. At most 20 a sweep. */
export async function handInStepsAfterADeadStep(): Promise<number> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT w.id AS id, w.depends_on AS depends_on FROM work w
    WHERE ${taskScope('w')} AND w.state = 'open' AND NOT ${heldByOwnerSql('w')}
      AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(w.depends_on) AND json_type(w.depends_on) = 'array' THEN w.depends_on ELSE '[]' END) d
                  LEFT JOIN work x ON x.id = d.value WHERE x.id IS NULL OR x.state IN ('failed', 'abandoned'))
      AND w.id NOT IN (SELECT value FROM json_each(?))
    LIMIT 20
  `).all(JSON.stringify([...refusedHandIns])) as Array<{ id: string; depends_on: string }>;
  if (rows.length === 0) return 0;
  const { engineHandIn } = await import('./hand-in.js');
  let handed = 0;
  for (const row of rows) {
    const deps = JSON.parse(row.depends_on) as string[];
    const found = deps.map((id) => db.prepare('SELECT state, title FROM work WHERE id = ?').get(id) as { state: string; title: string | null } | undefined);
    const dead = found.findIndex((r) => !r || r.state === 'failed' || r.state === 'abandoned');
    if (dead < 0) continue;
    const r = found[dead];
    const step = r ? `"${r.title ?? 'untitled'}" [${deps[dead]!.slice(0, 8)}] is ${stateToStatus(r.state)}` : `[${deps[dead]!.slice(0, 8)}] no longer exists`;
    const res = engineHandIn(row.id, `the step it waits on, ${step}, so this one can never start`, { scope: 'schedule', outcome: 'cant_be_done' });
    if (res.kind === 'handed_in') handed += 1;
    else refusedHandIns.add(row.id);
  }
  return handed;
}

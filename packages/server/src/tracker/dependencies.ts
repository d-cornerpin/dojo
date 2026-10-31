import { getDb } from '../db/connection.js';
import { taskScope, STATE_TO_STATUS_SQL } from '../work/tracker-view.js';
import { setTrackerStatus } from '../work/tracker-store.js';
import { noteUnsettled } from '../work/store.js';
import { createLogger } from '../logger.js';
import { sendAgentMessage } from '../agent/agent-bus.js';
import { getTask } from './schema.js';
import { getPrimaryAgentId, getPMAgentId } from '../config/platform.js';

const logger = createLogger('pm-agent');

export function checkDependencies(completedTaskId: string): void {
  const db = getDb();

  // Find tasks that depend on the completed task
  const dependentTasks = db.prepare(`
    SELECT w.id AS id, w.title AS title, ${STATE_TO_STATUS_SQL('w.state')} AS status,
           w.agent_id AS assigned_to, w.depends_on AS depends_on,
           w.scheduled_start AS scheduled_start, w.next_run_at AS next_run_at
    FROM work w
    WHERE ${taskScope('w')} AND w.state IN ('on_deck', 'blocked')
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

    if (allDepsComplete) {
      // A dependency validating makes the task ELIGIBLE; it does not start it ahead of its own schedule.
      // A task with a start still in the future waits on deck and the scheduler fires it then (it was only
      // skipping it for the unmet dependency). v2.8.x rule for the rest: tasks without a future schedule
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
      const task = getTask(row.id);

      if (task) {
        const message = `Task "${task.title}" (${task.id}) is now unblocked. All dependencies are complete.`
          + (startsLater ? ` It starts at its own scheduled time (${task.scheduledStart ?? 'later'}), not before.` : '') + '\n\n' +
          `Priority: ${task.priority}\n` +
          (task.description ? `Description: ${task.description}\n` : '') +
          `Previously blocked on: ${dependsOn.join(', ')}`;

        sendAgentMessage(getPMAgentId(), recipient, 'status', message, {
          taskId: task.id,
          event: 'unblocked',
          completedDependency: completedTaskId,
        });
      }
    }
  }
}

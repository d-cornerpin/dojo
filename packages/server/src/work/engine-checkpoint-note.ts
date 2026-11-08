// AN ENGINE CHECKPOINT (the turn-time budget, the tool-loop cap, a job that continues) parks a turn and
// queues its continuation. It carries the job's work to that continuation and notes the park on each of the
// job's open tasks; it never touches a task's movement, so a job that stops moving still reads as stalled.
import { getDb } from '../db/connection.js';
import { writeTaskLog } from '../tracker/task-log.js';
import { turnWorkIds, carryJobWork } from './task-freshness.js';
import { servedOwnerMessageIds } from '../memory/served-ask.js';
import { taskScope } from './tracker-view.js';

/** Why the checkpoint fired: one member per checkpoint site. */
export type EngineCheckpointReason = 'turn-budget' | 'tool-loop' | 'job-continues';

const REASON_TEXT: Record<EngineCheckpointReason, string> = {
  'turn-budget': 'the 15-minute turn-time budget parked this turn for a fresh continuation',
  'tool-loop': 'the 75-tool-call loop cap parked this turn for a fresh continuation',
  'job-continues': 'the turn ended mid-job while making progress; the engine parked it for a fresh continuation',
};

/** Call just before a checkpoint queues its continuation: the work the turn served (and `jobTaskIds`) is
 *  carried to it, and each of this agent's board tasks among them still open gets one note. Returns the number noted. */
export function noteEngineCheckpoint(agentId: string, reason: EngineCheckpointReason, jobTaskIds: string[] = []): number {
  const tied = [...new Set([...turnWorkIds(agentId), ...jobTaskIds])];
  carryJobWork(agentId, tied, servedOwnerMessageIds(agentId));
  if (tied.length === 0) return 0;
  const open = getDb().prepare(
    `SELECT w.id FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND w.id IN (${tied.map(() => '?').join(', ')}) AND w.state IN ('open', 'claimed', 'sent_back')`,
  ).all(agentId, ...tied) as Array<{ id: string }>;
  for (const { id } of open) {
    writeTaskLog({
      taskId: id, fromEntity: 'engine', entryKind: 'observation', reason: `engine checkpoint: ${reason}`,
      actionTaken: REASON_TEXT[reason], note: 'turn parked for a continuation; this task is still in flight, not abandoned.',
    });
  }
  return open.length;
}

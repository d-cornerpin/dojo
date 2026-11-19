// An engine checkpoint parks a turn for its job's next turn: it notes the park on each open task the turn worked. It never touches a task's movement, so a stalled job still reads as stalled.
import { getDb } from '../db/connection.js';
import { writeTaskLog } from '../tracker/task-log.js';
import { turnWorkIds } from './task-freshness.js';
import { taskScope } from './tracker-view.js';
import { workingExpr } from './terminal-states.js';

/** Why the checkpoint fired: one member per checkpoint site. */
export type EngineCheckpointReason = 'turn-budget' | 'job-continues';

const REASON_TEXT: Record<EngineCheckpointReason, string> = {
  'turn-budget': 'a window of 75 steps or 15 minutes passed without the job moving; the engine parked this turn for a fresh continuation',
  'job-continues': 'the turn ended mid-job while making progress; the engine parked it for a fresh continuation',
};

/** Call just before a checkpoint parks its job; returns how many open tasks got a note. */
export function noteEngineCheckpoint(agentId: string, reason: EngineCheckpointReason, jobTaskIds: string[] = []): number {
  const tied = [...new Set([...turnWorkIds(agentId), ...jobTaskIds])];
  if (tied.length === 0) return 0;
  const open = getDb().prepare(
    `SELECT w.id FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND w.id IN (${tied.map(() => '?').join(', ')}) AND ${workingExpr('w', true)}`,
  ).all(agentId, ...tied) as Array<{ id: string }>;
  for (const { id } of open) {
    writeTaskLog({
      taskId: id, fromEntity: 'engine', entryKind: 'observation', reason: `engine checkpoint: ${reason}`,
      actionTaken: REASON_TEXT[reason], note: 'turn parked for a continuation; this task is still in flight, not abandoned.',
    });
  }
  return open.length;
}

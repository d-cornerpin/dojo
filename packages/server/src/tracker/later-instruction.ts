// ════════════════════════════════════════════════════════════════════════════════════════
// THE NEWER-INSTRUCTION LINK (t145 group A). The only record of an owner's LATER words.
//
// The owner ruled the task list the one record of what is current (OR-TRACKER-1). A task is
// linked to the message that started it (`work.source_message_id`). When the owner then sends
// a LATER message in the same conversation and the turn that serves it UPDATES the open task,
// that message is part of the job's brief. The link is recorded here, at the tracker tool
// door, from two recorded facts and nothing else:
//
//   * the turn's root is an inbound human ask (`turnContext().root`), and
//   * that message is a user row in the SAME conversation as the task's own request, with a
//     higher `messages.seq`.
//
// Never inferred from the words of either message, and never from a turn merely coinciding with
// an update by an agent that serves something else (an engine, A2A or occurrence turn has a
// different root kind and links nothing). The record is an `audit` row on the task's own
// trail (`entry_kind = 'newer_instruction'`, `reason` = the later message's id), so it lives and
// dies with the task and needs no migration. Written once per (task, message).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { turnContext } from '../agent/turn-context.js';
import { writeTaskLog } from './task-log.js';

/** Call after a tracker write on `taskId` succeeded. Best-effort: a failure here never fails the write. */
export function linkLaterInstruction(agentId: string, taskId: string): void {
  try {
    const root = turnContext(agentId)?.root;
    if (!root || root.kind !== 'ask' || !root.sourceMessageId) return;
    const db = getDb();
    const task = db.prepare(
      `SELECT w.state AS state, o.seq AS seq, o.conversation_id AS conv
         FROM work w LEFT JOIN messages o ON o.id = w.source_message_id
        WHERE w.id = ?`,
    ).get(taskId) as { state: string; seq: number | null; conv: string | null } | undefined;
    if (!task || task.seq === null || task.conv === null) return;           // not linked to a request
    if (task.state === 'done' || task.state === 'failed' || task.state === 'abandoned') return;
    const later = db.prepare('SELECT seq, conversation_id AS conv, role FROM messages WHERE id = ?')
      .get(root.sourceMessageId) as { seq: number; conv: string | null; role: string } | undefined;
    if (!later || later.role !== 'user' || later.conv !== task.conv || later.seq <= task.seq) return;
    const known = db.prepare(
      `SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'audit'
          AND json_extract(payload, '$.entry_kind') = 'newer_instruction'
          AND json_extract(payload, '$.reason') = ? LIMIT 1`,
    ).get(taskId, root.sourceMessageId);
    if (known) return;
    writeTaskLog({
      taskId, fromEntity: 'engine', entryKind: 'newer_instruction', reason: root.sourceMessageId,
      actionTaken: 'a later message in this conversation was served while this task was updated',
    });
  } catch { /* the link is a record, never a gate */ }
}

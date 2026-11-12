// The newer-instruction link: the only record of an owner's LATER words on an open task, written after
// a successful tracker write when the turn's root is an inbound human ask and that message is a user row
// in the task request's conversation with a higher `messages.seq`. Never inferred from wording (engine,
// A2A and occurrence turns link nothing). Stored as an `audit` row (`entry_kind = 'newer_instruction'`).

import { getDb } from '../db/connection.js';
import { turnContext } from '../agent/turn-context.js';
import { writeTaskLog } from './task-log.js';

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
    if (!task || task.seq === null || task.conv === null) return;
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

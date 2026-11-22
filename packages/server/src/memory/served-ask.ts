// The messages a running turn's reply is addressed to (its trigger and the open requests after it in its conversation):
// the assembler re-emits any a fold took out of view (`memory/assembler.ts` `tailRender`). No running turn: `[]`.

import { getDb } from '../db/connection.js';
import { turnContext } from '../agent/turn-context.js';
import { originOfTasks } from '../work/job-origin.js';
import { getMessagesByIds } from './store.js';
import { repliedOnThread } from './message-store.js';
import type { Message } from '@dojo/shared';
import type { Database } from 'better-sqlite3';

export function servedOwnerMessageIds(agentId: string): string[] {
  try {
    const bag = turnContext(agentId);
    if (!bag) return [];
    const db = getDb();
    if (bag.root?.kind === 'ask' && bag.root.sourceMessageId) {
      const trigger = bag.root.sourceMessageId;
      const rows = db.prepare(
        `SELECT m.id AS id FROM messages m
          WHERE m.id = @trigger AND m.agent_id = @agentId AND m.role = 'user'
             OR (m.agent_id = @agentId AND m.role = 'user'
                 AND m.conversation_id = (SELECT conversation_id FROM messages WHERE id = @trigger)
                 AND m.seq > (SELECT seq FROM messages WHERE id = @trigger)
                 AND EXISTS (SELECT 1 FROM work w WHERE w.kind = 'ask' AND w.root_id = m.id AND w.state = 'open'))
          ORDER BY m.seq ASC`,
      ).all({ agentId, trigger }) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }
    // A trigger-less run (A2A, scheduler, engine event) serves nothing it did not pick up; a job turn started by a
    // person's request is rooted in it above.
    return [];
  } catch {
    return [];
  }
}

const spokenByTurn = new WeakMap<object, boolean>();

/** The running turn answers a request spoken in voice mode, so its reply is read aloud. Decided once per turn
 *  from the first owner message it serves: an ask, its continuation, or an engine wake rooted in the ask. */
export function turnAnswersSpokenRequest(agentId: string): boolean {
  const bag = turnContext(agentId);
  if (!bag) return false;
  let spoken = spokenByTurn.get(bag);
  if (spoken === undefined) {
    const first = servedOwnerMessageIds(agentId)[0];
    try {
      spoken = !!first && (getDb().prepare('SELECT channel FROM messages WHERE id = ?').get(first) as { channel: string | null } | undefined)?.channel === 'voice';
    } catch { spoken = false; }
    spokenByTurn.set(bag, spoken);
  }
  return spoken;
}

/** The reply-needed message a running A2A turn answers, until answered, else `[]`: the request the preflight
 *  picked for it; kept apart from the owner's words, which a park carries. */
export function servedAssignMessageIds(agentId: string): string[] {
  try {
    const bag = turnContext(agentId);
    if (bag?.kind !== 'a2a') return [];
    // A job turn serves the request its job started from, replied to or not: its root is that thread, found from
    // the job's task (`work/job-origin.ts`).
    if (bag.root?.kind === 'a2a' && bag.servedJob) {
      const origin = originOfTasks(agentId, [bag.servedJob]);
      if (origin?.kind === 'a2a' && origin.threadId === bag.root.id && origin.messageId) return [origin.messageId];
    }
    const r = bag.servedRequest;
    return r && !repliedOnThread(agentId, r.fromId, r.threadId, r.createdAt) ? [r.messageId] : [];
  } catch {
    return [];
  }
}

/** The id of this agent's message at `seq` (the "rowid" the inbound reads carry), or null. */
export function messageIdAtSeq(db: Database, agentId: string, seq: number): string | null {
  try {
    return (db.prepare('SELECT id FROM messages WHERE agent_id = ? AND seq = ?').get(agentId, seq) as { id: string } | undefined)?.id ?? null;
  } catch {
    return null;
  }
}

/** The row that woke the running turn, for a turn kind whose root is not itself a message; `[]` otherwise.
 *  An ask's trigger is already `servedOwnerMessageIds`' first answer. */
export function servedTriggerMessageIds(agentId: string): string[] {
  try {
    const bag = turnContext(agentId);
    return bag && bag.root?.kind !== 'ask' && bag.triggerMessageId ? [bag.triggerMessageId] : [];
  } catch {
    return [];
  }
}

/** Every message the running turn serves; the first is the one that started it. */
const servedIds = (agentId: string): string[] =>
  [...new Set([...servedOwnerMessageIds(agentId), ...servedAssignMessageIds(agentId), ...servedTriggerMessageIds(agentId)])];

/** The message the running turn answers, or null. */
export const answeredMessageId = (agentId: string): string | null => servedIds(agentId)[0] ?? null;

/** The served rows that are NOT among `inView` (compared by id), as stored rows, oldest first. */
export function servedRowsOutOfView(agentId: string, inView: readonly { id: string }[]): Message[] {
  const ids = servedIds(agentId);
  if (ids.length === 0) return [];
  const seen = new Set(inView.map((m) => m.id));
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length === 0) return [];
  try {
    return getMessagesByIds(missing).sort((a, b) => (a.rowid ?? 0) - (b.rowid ?? 0));
  } catch {
    return [];
  }
}

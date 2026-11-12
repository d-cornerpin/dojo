// The words the task list prints: the pool they are spent from, and the owner's later messages.
// Later messages are exactly the recorded newer-instruction links (`tracker/later-instruction.ts`),
// never chosen by reading the words.

import { getDb } from '../db/connection.js';
import { recordedInstant } from './message-stamp.js';
import { conversationLabel } from './party-label.js';

/** Characters of original words this rendering may spend, shared across its tasks in pass order. */
export interface WordsPool { remaining: number }

export interface TermCaps { title: number; label: number; note: number }

export interface ListedMessage {
  messageId: string | null;
  words: string | null;
  createdAt: number | string | null;
  label: string | null;
  /** The words are already in the live conversation the model is reading. */
  inView?: boolean;
}

export function capLabel(raw: string | null | undefined, fallback: string, caps: TermCaps): string {
  const label = raw ?? fallback;
  return label.length > caps.label ? `${label.slice(0, caps.label)}...` : label;
}

/** "<party> on <channel>", without repeating a channel the party label already carries. */
export function originLabel(party: string | null, channel: string | null): string | null {
  if (party && channel && !party.includes(`(${channel})`)) return `${party} on ${channel}`;
  return party ?? (channel ? `the ${channel} channel` : null);
}

/** Print `text` verbatim up to what the pool has left, then the end marker or the cut line. */
export function spend(text: string, pool: WordsPool, endMarker: string, cutLine: (more: number) => string): string {
  const shown = text.slice(0, Math.max(0, pool.remaining));
  pool.remaining -= shown.length;
  return shown.length === text.length
    ? `${shown}\n${endMarker}`
    : `${shown}${shown.length > 0 ? '\n' : ''}${cutLine(text.length - shown.length)}`;
}

/** The later messages recorded against a task, oldest first. A row no longer stored keeps its id. */
export function readLaterMessages(taskId: string): ListedMessage[] {
  try {
    const rows = getDb().prepare(
      `SELECT json_extract(e.payload, '$.reason') AS id, m.id AS found, m.content AS content,
              m.created_at AS created_at, m.conversation_id AS conversation_id,
              COALESCE(c.channel, m.channel) AS channel
         FROM work_events e
         LEFT JOIN messages m ON m.id = json_extract(e.payload, '$.reason')
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE e.work_id = ? AND e.kind = 'audit'
          AND json_extract(e.payload, '$.entry_kind') = 'newer_instruction'
        ORDER BY COALESCE(m.seq, 9007199254740991), e.id`,
    ).all(taskId) as Array<{
      id: string | null; found: string | null; content: string | null; created_at: number | string | null;
      conversation_id: string | null; channel: string | null;
    }>;
    return rows.filter((r) => r.id).map((r) => r.found
      ? { messageId: r.id, words: r.content ?? '', createdAt: r.created_at,
          label: originLabel(conversationLabel(r.conversation_id), r.channel) }
      : { messageId: r.id, words: null, createdAt: null, label: null });
  } catch { return []; }
}

/**
 * The later-message section of a current task's line. The label claims only what the link records:
 * the message was sent while the task was open and the turn answering it touched the task.
 * Messages are paid newest to oldest (before the original request's pass) and printed oldest first;
 * when the pool is gone the older ones collapse into one counted line that names the newest.
 */
export function laterSection(laters: readonly ListedMessage[], pool: WordsPool, caps: TermCaps): string {
  const printed: string[] = new Array(laters.length).fill('');
  let collapsed = 0;
  for (let i = laters.length - 1; i >= 0; i--) {
    const m = laters[i];
    if (pool.remaining <= 0) { collapsed = i + 1; break; }
    if (m.words === null) {
      printed[i] = `\n  [later message ${m.messageId}, which the owner sent while this task was open, is no longer stored]`;
      pool.remaining -= printed[i].length;
      continue;
    }
    const from = `from ${capLabel(m.label, 'a conversation with no recorded label', caps)}, ${recordedInstant(m.createdAt)}`;
    const when = 'sent while this task was open (the turn that answered it touched this task)';
    if (m.inView) {
      printed[i] = `\n  Later message ${from}, ${when}: it is in the conversation above, `
        + `message ${m.messageId}; read it there, it is not repeated here.`;
      pool.remaining -= printed[i].length;
      continue;
    }
    const head = `\n  Later message ${from}, ${when}, word for word:\n`;
    pool.remaining -= head.length;
    printed[i] = head + spend(m.words, pool, '  [end of later message]',
      (more) => `  [later message continues: ${more} more characters; history_get(id="${m.messageId}") returns it in full]`);
  }
  if (collapsed === 0) return printed.join('');
  const id = laters[collapsed - 1].messageId;
  return `\n  [${collapsed} older later message${collapsed === 1 ? '' : 's'} sent while this task was open, `
    + `answered by turns that touched it; the newest of them is message ${id}; history_get(id="${id}") returns it]`
    + printed.join('');
}

// ════════════════════════════════════════════════════════════════════════════════════════
// THE WORDS THE TASK LIST PRINTS: the pool they are spent from, and the owner's LATER messages.
//
// Split out of `work-board-lane.ts` (t145 group A) so the list's word-spending primitives and the
// later-message section live together and the lane file does not grow.
//
// LATER MESSAGES (the structural newer-instruction link, `tracker/later-instruction.ts`): a
// message the owner sent after the request that opened a task, which a turn serving it used to
// update that task. They print after the original words, in the order they were sent, spending
// the same room-driven pool — and, like the original words, a message already in the live
// conversation above is POINTED TO, not printed twice (t139 round 6). Nothing is ever chosen by
// reading the words: the set is exactly the recorded links.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { recordedInstant } from './message-stamp.js';
import { conversationLabel } from './party-label.js';

/** The characters of original words this rendering may spend, shared across its tasks in pass
 *  order. `fitTaskList` sets it from the room the assembly left the list. Mutable: each line spends it. */
export interface WordsPool { remaining: number }

/** The widths of the three short terms the block does not author. */
export interface TermCaps { title: number; label: number; note: number }

/** A message the list can print or point to: the request, or a later message. */
export interface ListedMessage {
  messageId: string | null;
  words: string | null;
  createdAt: number | string | null;
  label: string | null;
  /** The words are already in the live conversation the model is reading (t139 round 6). */
  inView?: boolean;
}

export function capLabel(raw: string | null | undefined, fallback: string, caps: TermCaps): string {
  const label = raw ?? fallback;
  return label.length > caps.label ? `${label.slice(0, caps.label)}...` : label;
}

/** "<party> on <channel>", without saying the channel twice when the party label already
 *  carries it (`conversationLabel` renders a contact as "Name (channel)"). */
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
 * The later-message section of a current task's line. WHAT THE LABEL CLAIMS is only what the link
 * records (`tracker/later-instruction.ts`): the message was sent while the task was open, and the
 * turn that answered it touched the task. It never says the message "updated" anything.
 *
 * UNDER ROOM PRESSURE THE NEWEST WORDS GET THE ROOM FIRST: messages are paid newest to oldest
 * (and `renderTaskLines` runs this pass BEFORE the original request's), then printed in the order
 * they were sent. Each message spends the pool for its whole rendering (framing included), so the
 * section is bounded by the room, never by a count. When the pool is gone the OLDER messages left
 * collapse into ONE line, printed first, that says how many and names the newest of them (label,
 * never a silent cut).
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

// ════════════════════════════════════════════════════════════════════════════════════════
// THE TASK'S OWN NOTES, READ BACK (t169).
//
// `work_note` writes the task's audit trail; the notes FIELD that `work_update get` used to render is
// never filled by it. An agent that kept its findings in `work_note` and lost them from view had no
// call that returned them (run 9, S1: it re-read 154 pages to rebuild what it had already written
// down, and the PM ruled it circling). `get` now ends with every note on the task, oldest first, each
// with the time it was recorded and who wrote it.
//
// THE SIZE IS THE MODEL'S VIEW, NOT A NUMBER PICKED HERE. A tool result is shown to the model from its
// head up to `TOOL_RESULT_VIEW_CHARS`, so a page is sized to leave room for its own footer, and the
// footer ("continue at offset N") sits at the END of the result, always in view: the shape `file_read`
// pages by. `offset` is the number of the first note to show (0-based). A single note longer than the
// whole page is cut with a line that says how much of it is shown.
//
// Cache: tool-RESULT text. It is in no prompt prefix and moves no cached byte.
// ════════════════════════════════════════════════════════════════════════════════════════

import { TOOL_RESULT_VIEW_CHARS } from '../memory/tool-result-view.js';
import { listTaskNotes, type TaskLogEntry } from './task-log.js';

/** Notes with words in them, oldest first. */
function writtenNotes(taskId: string): TaskLogEntry[] {
  return listTaskNotes(taskId).filter((e) => (e.note ?? '').trim().length > 0);
}

const noun = (n: number): string => (n === 1 ? 'note' : 'notes');

/** One note, for the agent that is reading: when, who, then its words. */
function renderNoteEntry(e: TaskLogEntry, readerId: string): string {
  const who = e.fromEntity === `agent:${readerId}` ? 'you' : e.fromEntity === 'pm' ? 'PM' : e.fromEntity;
  return `[${e.createdAt} UTC] [${who}] ${e.note ?? ''}`;
}

/** The notes page starting at `offset`, given how much of the result the rest of the page already uses. */
function renderPage(taskId: string, readerId: string, offset: number, bodyChars: number): string | null {
  const notes = writtenNotes(taskId);
  const total = notes.length;
  if (total === 0) return null;
  if (offset >= total) {
    return `\nNotes written on this task: ${total} ${noun(total)}; offset ${offset} is past the last one. ` +
      `work_update(action="get", id="${taskId}") reads them from the first.`;
  }
  const head = `\nNotes written on this task (${total}, oldest first, each with the time it was recorded):`;
  const footerFor = (end: number): string => {
    const remaining = total - end;
    return `\n\n[Notes ${offset}-${end - 1} of ${total}. ${remaining} more ${noun(remaining)} remain.\n` +
      ` To continue: work_update(action="get", id="${taskId}", offset=${end}).]`;
  };
  // The footer is worst-cased up front (a page that stops at the last-but-one note) and reserved.
  const budget = TOOL_RESULT_VIEW_CHARS - bodyChars - head.length - footerFor(total - 1).length;
  const shown: string[] = [];
  let used = 0;
  let end = offset;
  for (let i = offset; i < total; i++) {
    let line = renderNoteEntry(notes[i], readerId);
    if (used + line.length + 1 > budget) {
      if (shown.length > 0) break;
      const keep = Math.max(0, budget - 1);
      line = `${line.slice(0, keep)} … [note cut: ${keep} of ${line.length} chars shown]`;
    }
    shown.push(line);
    used += line.length + 1;
    end = i + 1;
  }
  return head + '\n' + shown.join('\n') + (end < total ? footerFor(end) : '');
}

/**
 * `work_update get` on a task: the task's body, then its notes. A first page (offset 0, or none) is the
 * body plus as many notes as the view holds; a later page is the notes alone, the body having been on the
 * first.
 */
export function taskReadWithNotes(
  taskId: string, readerId: string, body: string, offset: unknown,
): string {
  const at = typeof offset === 'number' && offset > 0 ? Math.floor(offset) : 0;
  if (at > 0) {
    return `[OK] task_id=${taskId} | notes, continued\n${renderPage(taskId, readerId, at, 0) ?? '\nThis task has no notes.'}`;
  }
  const notes = renderPage(taskId, readerId, 0, body.length);
  return notes ? `${body}\n${notes}` : body;
}

/**
 * The attempt ledger shows only the newest few notes. When the task holds more than it showed, this is
 * the line that says so and names the call that reads every one; empty when all of them are shown.
 */
export function moreNotesLine(taskId: string, shown: number): string {
  const more = writtenNotes(taskId).length - shown;
  if (more <= 0) return '';
  return `  (${more} more note${more === 1 ? '' : 's'} on this task ${more === 1 ? 'is' : 'are'} not shown here: `
    + `work_update(action="get", id="${taskId}") reads every note, oldest first.)\n`;
}

// A task's own notes, read back: `work_update get` ends with every note on the task, oldest first, each with
// its time and author (`work_note` writes the audit trail; the notes FIELD is never filled by it).
// The page is sized by the model's view, not a number picked here: a tool result is shown from its head up to
// `TOOL_RESULT_VIEW_CHARS`, so a page leaves room for its footer, which sits at the END of the result and is
// always in view (the shape `file_read` pages by). `offset` is the 0-based number of the first note shown; a
// note longer than the page is cut with a line saying how much of it is shown. Tool-RESULT text: in no prompt prefix.

import { TOOL_RESULT_VIEW_CHARS } from '../memory/tool-result-view.js';
import { listTaskNotes, type TaskLogEntry } from './task-log.js';

function writtenNotes(taskId: string): TaskLogEntry[] {
  return listTaskNotes(taskId).filter((e) => (e.note ?? '').trim().length > 0);
}

const noun = (n: number): string => (n === 1 ? 'note' : 'notes');

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

/** `work_update get` on a task: its body, then its notes; a later page (offset > 0) is the notes alone. */
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

/** The line telling the attempt ledger's reader there are more notes, and which call reads them all. */
export function moreNotesLine(taskId: string, shown: number): string {
  const more = writtenNotes(taskId).length - shown;
  if (more <= 0) return '';
  return `  (${more} more note${more === 1 ? '' : 's'} on this task ${more === 1 ? 'is' : 'are'} not shown here: `
    + `work_update(action="get", id="${taskId}") reads every note, oldest first.)\n`;
}

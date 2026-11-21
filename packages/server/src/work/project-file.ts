// The file of a piece of work on the board: its project's plan, the owner's words and the notes on the project,
// the earlier reviews on its tasks, and the project manager's questions about them with their answers. One file
// per project, inside one room; what does not fit is the oldest, and the file says so.
import { extractPayloadFromA2AMessage } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { estimateTokens } from '../memory/budget.js';
import { readLaterMessages } from '../memory/task-list-words.js';
import { listTaskNotes } from '../tracker/task-log.js';
import { resolveAgentDisplayName } from '../agent/tool-helpers.js';
import { readAuditTrail } from './audit-trail.js';
import { pmQuestions } from './done/who-decides.js';
import { planOfProject } from './plan-store.js';
import { msToUtcText, tsToMs } from './tracker-view.js';

const OWNER_WORDS_EXCERPT_CHARS = 400;   // a display excerpt; history_get returns the whole message
const EXCHANGE_EXCERPT_CHARS = 500;      // a question or an answer in the file, cut here
const FRAME_TOKENS = 64;                 // the section headings and the left-out lines

/** The owner's later words the engine recorded against this task or project: what a decision-type close is
 *  judged on. */
export function ownerWordsLines(workId: string, what = 'task'): string {
  const laters = readLaterMessages(workId);
  if (laters.length === 0) return `\n  Owner words recorded on this ${what}: none`;
  const shown = laters.map((m) => {
    const id = (m.messageId ?? '').slice(0, 8);
    if (m.words === null) return `    message ${id}: no longer stored`;
    const flat = m.words.replace(/\s+/g, ' ').trim();
    const cut = flat.length > OWNER_WORDS_EXCERPT_CHARS
      ? `${flat.slice(0, OWNER_WORDS_EXCERPT_CHARS)}… (history_get(id="${m.messageId}") returns it whole)`
      : flat;
    return `    message ${id}: "${cut}"`;
  });
  const why = 'sent while it was open; the turn that answered them touched it';
  return `\n  Owner words recorded on this ${what} (${why}):\n${shown.join('\n')}`;
}

/** The project a task belongs to, or the work itself when it is a project; null for a task with none. */
export function projectOf(workId: string): { id: string; title: string | null } | null {
  const row = getDb().prepare(`
    SELECT p.id, p.title
      FROM work w
      JOIN work p ON p.id = CASE WHEN w.kind = 'project' THEN w.id ELSE w.parent_id END
     WHERE w.id = ?
  `).get(workId) as { id: string; title: string | null } | undefined;
  return row ?? null;
}

/** One line of the file, with its time. */
interface Dated { at: number; text: string }

function noteLines(projectId: string): Dated[] {
  return listTaskNotes(projectId).map((n) => ({
    at: tsToMs(n.createdAt) ?? 0,
    text: `\n    ${n.createdAt}: ${n.note}`,
  }));
}

const DECIDED_AS: Record<string, string> = { approve: 'approved', cancel: 'cancelled', owner_done: 'closed by the owner' };

/** Every decision and instruction given on these tasks, from their audit trails. */
function reviewLines(tasks: Array<{ id: string; title: string | null }>): Dated[] {
  const trail = (id: string) => readAuditTrail(id, { limit: Number.MAX_SAFE_INTEGER, kinds: ['decided', 'directive'] });
  return tasks.flatMap((t) => trail(t.id).map((r) => {
    const what = r.entry_kind === 'directive' ? 'retasked' : DECIDED_AS[r.action_taken ?? ''] ?? 'sent back';
    const reason = (r.reason ?? '').split('\n')[0];
    return { at: tsToMs(r.created_at) ?? 0, text: `\n    ${r.created_at} "${t.title ?? t.id}" ${what}: ${reason}` };
  }));
}

/** The PM's questions about these tasks with their answers. */
function exchangeLines(taskIds: string[]): Dated[] {
  return taskIds.flatMap((taskId) => pmQuestions(taskId).map((q) => {
    const asked = `\n    ${msToUtcText(q.at)} you asked ${q.typed} about [${taskId}]: "${q.text.slice(0, EXCHANGE_EXCERPT_CHARS)}"`;
    const said = q.answers.map((a) => {
      const words = (extractPayloadFromA2AMessage(a.content) ?? a.content).slice(0, EXCHANGE_EXCERPT_CHARS);
      return `\n      ${msToUtcText(a.at)} ${resolveAgentDisplayName(a.from) ?? a.from} answered: ${words}`;
    }).join('');
    const none = q.until > Date.now()
      ? `\n      waiting for an answer until ${msToUtcText(q.until)}`
      : '\n      no answer';
    return { at: q.answers[q.answers.length - 1]?.at ?? q.at, text: asked + (said || none) };
  }));
}

/** The newest of `lines` that fit in `room`, back in time order; and how many older ones did not. With `atLeastOne`
 *  the newest line is kept even when it alone is over `room`. */
function newestThatFit(lines: Dated[], room: number, atLeastOne = false): { kept: string[]; left: number; omitted: number } {
  const newest = [...lines].sort((a, b) => b.at - a.at);
  const kept: string[] = [];
  let left = room;
  for (const line of newest) {
    if (estimateTokens(line.text) > left && !(atLeastOne && kept.length === 0)) break;
    kept.push(line.text);
    left -= estimateTokens(line.text);
  }
  return { kept: kept.reverse(), left, omitted: newest.length - kept.length };
}

function omittedLine(n: number, what: string, where: string): string {
  return n > 0 ? `\n    ${n} older ${what} left out (${where})` : '';
}

/** The file of `workId`'s project, or of the task alone when it has none, inside `room` tokens: the project line and
 *  the owner's words always; then the newest reviews and questions (the newest exchange always) and the newest notes,
 *  each guaranteed half of what is left, and what one does not use goes to the other. Empty when there is none. */
export function workFile(workId: string, room: number): string {
  const project = projectOf(workId);
  const taskRows = project ? getDb().prepare('SELECT id, title FROM work WHERE parent_id = ?').all(project.id) : [];
  const tasks = taskRows as Array<{ id: string; title: string | null }>;
  const approach = project ? planOfProject(project.id)?.approach ?? '(no plan)' : '';
  const head = project
    ? `\n  Project "${project.title ?? project.id}" [${project.id}]: ${approach}${ownerWordsLines(project.id, 'project')}`
    : '';
  const space = room - FRAME_TOKENS - estimateTokens(head);
  const half = Math.floor(space / 2);
  const noteList = project ? noteLines(project.id) : [];
  const spare = newestThatFit(noteList, half).left;
  const timed = newestThatFit([...reviewLines(tasks), ...exchangeLines(project ? tasks.map((t) => t.id) : [workId])], space - half + spare, true);
  const notes = newestThatFit(noteList, half - spare + Math.max(0, timed.left));   // an over-long newest exchange takes no note room
  if (!project && timed.kept.length === 0) return '';
  const noteText = project
    ? `\n  The project's notes:${notes.kept.join('') || ' none'}`
      + omittedLine(notes.omitted, 'notes', `work_update(action="get", id="${project.id}")`)
    : '';
  return `${head}${noteText}\n  Earlier reviews and your questions:${timed.kept.join('') || ' none'}`
    + omittedLine(timed.omitted, 'lines', 'history_search finds them');
}

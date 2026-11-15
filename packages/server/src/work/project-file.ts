// The file of a piece of work on the board: its project's plan, the owner's words and the notes on the project,
// the earlier reviews on its tasks, and the project manager's questions about them with their answers. One file
// per project, inside one room; what does not fit is the oldest, and the file says so.
import { extractPayloadFromA2AMessage } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { estimateTokens } from '../memory/budget.js';
import { readLaterMessages } from '../memory/task-list-words.js';
import { listTaskNotes } from '../tracker/task-log.js';
import { AUDIT_KIND } from './audit-trail.js';
import { pmQuestions } from './done/who-decides.js';
import { planOfProject } from './plan-store.js';
import { msToUtcText, tsToMs } from './tracker-view.js';

const OWNER_WORDS_EXCERPT_CHARS = 400;   // a display excerpt; history_get returns the whole message
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

/** One line of the file with its time, and the shorter form it takes when it does not fit whole. */
interface Dated { at: number; text: string; short: string }

function noteLines(projectId: string): Dated[] {
  return listTaskNotes(projectId).map((n) => {
    const text = `\n    ${n.createdAt}: ${n.note}`;
    return { at: tsToMs(n.createdAt) ?? 0, text, short: text };
  });
}

/** Every decision and instruction given on the project's tasks. */
function reviewLines(projectId: string): Dated[] {
  const rows = getDb().prepare(`
    SELECT w.title, e.kind, e.created_at AS at,
           json_extract(e.payload, '$.verdict') AS verdict,
           COALESCE(json_extract(e.payload, '$.reason'), '') AS reason
      FROM work_events e
      JOIN work w ON w.id = e.work_id
     WHERE w.parent_id = ?
       AND (e.kind = 'decided' OR (e.kind = '${AUDIT_KIND}' AND json_extract(e.payload, '$.entry_kind') = 'directive'))
  `).all(projectId) as Array<{ title: string | null; kind: string; at: number; verdict: string | null; reason: string }>;
  return rows.map((r) => {
    const what = r.kind === 'decided' ? (r.verdict === 'approve' ? 'approved' : 'sent back') : 'retasked';
    const text = `\n    ${msToUtcText(r.at)} "${r.title ?? ''}" ${what}: ${r.reason.split('\n')[0]}`;
    return { at: r.at, text, short: text };
  });
}

/** The PM's questions about these tasks with their answers; the short form keeps each answer's first line. */
function exchangeLines(taskIds: string[]): Dated[] {
  const nameOf = (id: string): string =>
    (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;
  return taskIds.flatMap((taskId) => pmQuestions(taskId).map((q) => {
    const asked = `\n    ${msToUtcText(q.at)} you asked ${q.typed} about [${taskId}]: "${q.text.slice(0, 500)}"`;
    const said = (cut: boolean): string => q.answers.map((a) => {
      const words = extractPayloadFromA2AMessage(a.content) ?? a.content;
      const first = words.split('\n')[0];
      const shown = cut && first !== words ? `${first}... (history_get(id="${a.id}") returns it whole)` : words;
      return `\n      ${msToUtcText(a.at)} ${nameOf(a.from)} answered: ${shown}`;
    }).join('');
    const none = q.until > Date.now()
      ? `\n      waiting for an answer until ${msToUtcText(q.until)}`
      : '\n      no answer';
    const at = q.answers[q.answers.length - 1]?.at ?? q.at;
    return { at, text: asked + (said(false) || none), short: asked + (said(true) || none) };
  }));
}

/** The newest of `lines` that fit in `room`, whole or short, back in time order; and how many older ones did not. */
function newestThatFit(lines: Dated[], room: number): { kept: string[]; left: number; omitted: number } {
  const newest = [...lines].sort((a, b) => b.at - a.at);
  const kept: string[] = [];
  let left = room;
  for (const line of newest) {
    const text = estimateTokens(line.text) <= left ? line.text : line.short;
    if (estimateTokens(text) > left) break;
    kept.push(text);
    left -= estimateTokens(text);
  }
  return { kept: kept.reverse(), left, omitted: newest.length - kept.length };
}

function omittedLine(n: number, what: string, where: string): string {
  return n > 0 ? `\n    ${n} older ${what} left out (${where})` : '';
}

/** The file of `workId`'s project, or of the task alone when it has none, inside `room` tokens: the project line and
 *  the owner's words always; then the newest notes; then the newest reviews and questions. Empty when there is none. */
export function workFile(workId: string, room: number): string {
  const project = projectOf(workId);
  const taskRows = project ? getDb().prepare('SELECT id FROM work WHERE parent_id = ?').all(project.id) : [];
  const tasks = project ? (taskRows as Array<{ id: string }>).map((r) => r.id) : [workId];
  const approach = project ? planOfProject(project.id)?.approach ?? '(no plan)' : '';
  const head = project
    ? `\n  Project "${project.title ?? project.id}" [${project.id}]: ${approach}${ownerWordsLines(project.id, 'project')}`
    : '';
  const notes = newestThatFit(project ? noteLines(project.id) : [], room - FRAME_TOKENS - estimateTokens(head));
  const reviews = project ? reviewLines(project.id) : [];
  const timed = newestThatFit([...reviews, ...exchangeLines(tasks)], notes.left);
  if (!project && timed.kept.length === 0) return '';
  const noteText = project
    ? `\n  The project's notes:${notes.kept.join('') || ' none'}`
      + omittedLine(notes.omitted, 'notes', `work_update(action="get", id="${project.id}")`)
    : '';
  return `${head}${noteText}\n  Earlier reviews and your questions:${timed.kept.join('') || ' none'}`
    + omittedLine(timed.omitted, 'lines', 'history_search finds them');
}

// Demoted notes render dimmed, hidden, or as a full reply; the rules live in lib so vitest drives them.

// Markers come from @dojo/shared (census: one client copy); a drifted copy shows raw note text.
import { parseWorkingNote } from '@dojo/shared';

export type WorkingNoteArm = 'plain' | 'internal';

export type NoteVerdict = 'answer' | 'dimmed' | 'wordyOnly';

/** What `Chat.tsx` does with the row: asked once at each note arm, so the two cannot drift. */
export type NoteRender = 'hide' | 'note' | 'answer';

export interface NoteRow {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly displayKind?: string | null;
  /** `messages.conversation_id`, as stored: on the run's anchor row, non-empty means a person opened it. */
  readonly conversationId?: string | null;
}

function armOf(content: string): { text: string; arm: WorkingNoteArm } | null {
  const m = parseWorkingNote(content);
  return m === null ? null : { text: m.text, arm: m.internal ? 'internal' : 'plain' };
}

/** A note row: the prefixed `role='system'` demotion, or a re-classified assistant row by kind. */
export function noteOn(row: NoteRow): { text: string; arm: WorkingNoteArm } | null {
  if (row.role === 'system') return armOf(row.content);
  if (row.role === 'assistant' && row.displayKind === 'working-note') {
    const prefixed = armOf(row.content);
    return prefixed ?? { text: row.content, arm: 'plain' };
  }
  return null;
}

function textOf(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b): b is { type: string; text?: string } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text')
        .map((b) => b.text ?? '')
        .join('\n\n')
        .trim();
    }
  } catch { /* not JSON, plain text */ }
  return content.trim();
}

/** What the agent visibly SAID: a note is not an answer, and neither is a tool-only row. */
export function visibleAgentText(row: NoteRow): string {
  if (row.role !== 'assistant') return '';
  if (noteOn(row) !== null) return '';
  return textOf(row.content);
}

/** The person's own unit around `index`: between their previous message and their next. */
export function conversationalRun(
  rows: readonly NoteRow[], index: number,
): { start: number; end: number } {
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i]?.role === 'user') { start = i + 1; break; }
  }
  let end = rows.length;
  for (let i = index + 1; i < rows.length; i++) {
    if (rows[i]?.role === 'user') { end = i; break; }
  }
  return { start, end };
}

/** Did a person open this run? The nearest user row decides; none, or an empty conversationId, NO. */
export function askedByAPerson(rows: readonly NoteRow[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const row = rows[i];
    if (row === undefined || row.role !== 'user') continue;
    return typeof row.conversationId === 'string' && row.conversationId.trim() !== '';
  }
  return false;
}

/** The verdict for the note at `index`, or null when it is not a note. A duplicate of the
 *  visible answer goes quiet first; a lone note after a person's ask is the reply. */
export function workingNoteVerdict(rows: readonly NoteRow[], index: number): NoteVerdict | null {
  const note = noteOn(rows[index] as NoteRow);
  if (note === null) return null;
  const { start, end } = conversationalRun(rows, index);

  const answers: string[] = [];
  for (let i = start; i < end; i++) {
    if (i === index) continue;
    const said = visibleAgentText(rows[i] as NoteRow);
    if (said !== '') answers.push(said);
  }

  // Exact trimmed match with a visible answer only: a merely similar note is another sentence.
  const body = note.text.trim();
  if (body !== '' && answers.some((a) => a === body)) return 'wordyOnly';

  // A person opened the run and nothing else was shown: the note is the reply, in either arm.
  if (answers.length === 0 && askedByAPerson(rows, index)) return 'answer';

  // A routed-channel note: hidden only beside a visible reply; alone it renders dimmed.
  if (note.arm === 'internal') return answers.length > 0 ? 'wordyOnly' : 'dimmed';

  return 'dimmed';
}

export function renderWorkingNote(
  rows: readonly NoteRow[], index: number, wordyMode: boolean,
): NoteRender {
  const verdict = workingNoteVerdict(rows, index);
  if (verdict === null || (verdict === 'wordyOnly' && !wordyMode)) return 'hide';
  // Wordy mode only ever adds rows, so it never re-dims a row the regular view shows as a reply.
  return verdict === 'answer' ? 'answer' : 'note';
}

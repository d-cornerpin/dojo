// The one place that turns a task's wire status into the owner's words and its board column.
// `fallen` and `cancelled` share the Closed column; each card says which one it is.

import type { Task } from '@dojo/shared';

export type TaskStatus = Task['status'];

export const STATUS_WORDS: Record<TaskStatus, string> = {
  on_deck: 'Open',
  in_progress: 'Working',
  handed_in: 'Handed in',
  sent_back: 'Sent back',
  complete: 'Done',
  fallen: "Couldn't be done",
  cancelled: 'Cancelled',
};

export const HOLD_WORDS: Record<NonNullable<Task['hold']>, string> = { paused: 'Paused', blocked: 'Blocked' };

/** The board columns, in display order; `cancelled` has no column, it renders in Closed. */
export const KANBAN_COLUMN_KEYS = [
  'on_deck', 'in_progress', 'handed_in', 'sent_back', 'complete', 'fallen',
] as const;

export type KanbanColumnKey = (typeof KANBAN_COLUMN_KEYS)[number];

export const COLUMN_WORDS: Record<KanbanColumnKey, string> = { ...STATUS_WORDS, fallen: 'Closed' };

const COLUMN_OF: Record<TaskStatus, KanbanColumnKey> = {
  on_deck: 'on_deck', in_progress: 'in_progress', handed_in: 'handed_in', sent_back: 'sent_back',
  complete: 'complete', fallen: 'fallen', cancelled: 'fallen',
};

export function columnKeyForStatus(status: TaskStatus | string): KanbanColumnKey | null {
  return Object.hasOwn(COLUMN_OF, status) ? COLUMN_OF[status as TaskStatus] : null;
}

export function terminalOutcomeLabel(status: TaskStatus | string): string | null {
  return status === 'fallen' || status === 'cancelled' ? STATUS_WORDS[status] : null;
}

/** A task-log entry kind in the owner's words; a kind not listed reads as its own words. */
const ENTRY_WORDS: Record<string, string> = {
  transition: 'Moved', observation: 'Note', reject: 'Refused', override: 'Overridden', evidence: 'Proof',
  directive: 'Instruction', auto_sweep: 'Tidied by the Dojo', user_verdict_request: 'Asked you to decide',
  user_verdict_applied: 'Your decision', legacy_note: 'Earlier note', newer_instruction: 'Newer instruction',
  claim_upheld: 'Accepted by the project manager', claim_rejected: 'Turned down by the project manager',
  delivery_held: 'Held back', handed_in: 'Handed in', decided: 'Decided', proof_opened: 'Proof opened',
};
export const entryWords = (kind: string): string => ENTRY_WORDS[kind] ?? kind.replace(/_/g, ' ');

/** A status or hold as the log stores it, in the board's words. */
export const statusWords = (s: string): string =>
  (STATUS_WORDS as Record<string, string>)[s] ?? (HOLD_WORDS as Record<string, string>)[s] ?? s.replace(/_/g, ' ');

/** Who wrote a log entry: 'user', 'pm', 'engine', 'scheduler', 'legacy', or 'agent:<id>' (named by `nameOf`). */
export function whoWords(from: string, nameOf: (agentId: string) => string | undefined): string {
  const who: Record<string, string> = { user: 'You', pm: 'Project manager', engine: 'The Dojo', scheduler: 'The schedule', legacy: 'Earlier record' };
  if (who[from]) return who[from];
  return nameOf(from.startsWith('agent:') ? from.slice('agent:'.length) : from) ?? 'An agent';
}

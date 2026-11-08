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

/** The columns the board renders, in order. */
export const KANBAN_COLUMN_KEYS = [
  'on_deck', 'in_progress', 'handed_in', 'sent_back', 'complete', 'fallen',
] as const;

export type KanbanColumnKey = (typeof KANBAN_COLUMN_KEYS)[number];

export const COLUMN_WORDS: Record<KanbanColumnKey, string> = { ...STATUS_WORDS, fallen: 'Closed' };

const COLUMN_OF: Record<TaskStatus, KanbanColumnKey> = {
  on_deck: 'on_deck', in_progress: 'in_progress', handed_in: 'handed_in', sent_back: 'sent_back',
  complete: 'complete', fallen: 'fallen', cancelled: 'fallen',
};

/** Which column a task renders in; the Record type keeps it total over the status union. */
export function columnKeyForStatus(status: TaskStatus | string): KanbanColumnKey | null {
  return COLUMN_OF[status as TaskStatus] ?? null;
}

/** The word on a Closed card, or null where the column header already says it. */
export function terminalOutcomeLabel(status: TaskStatus | string): string | null {
  return status === 'fallen' || status === 'cancelled' ? STATUS_WORDS[status] : null;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// THE BOARD'S STATUS RULE — one owner, so a status can never fall through it silently.
//
// UX-REPAIR ROUND 3 T18. `tracker/schema.ts:381-386` (commit `632cadd`, 2026-05-20) recorded
// the ONE real reason the tracker folded a user's "cancelled" into "fallen":
//
//   > the board only renders the six legacy task statuses … storing a literal "cancelled" on
//   > a task would make it disappear from the board.
//
// That was true, and it was a rendering constraint rather than a semantic judgement. The
// mechanism behind it was `KanbanBoard`'s `tasks.filter(t => t.status === col.key)`: a status
// with no column of its own matched nothing and rendered nowhere.
//
// So the constraint is ANSWERED here rather than obeyed by mislabelling the row. `fallen` and
// `cancelled` are two OUTCOMES that share ONE terminal column — a task that did not make it,
// for two different reasons, each said in its own word on the card. No seventh column, no
// vanishing row, and no status that resolves to nothing: `columnKeyForStatus` is total over
// the union and the suite asserts it.
//
// Kept deliberately free of React so the server-side suite can run it —
// `packages/server/src/tracker/__tests__/cancelled-is-a-real-word.test.ts` §4 is the board's
// no-vanishing test, and it is the only executable proof that the constraint above still
// holds. The precedent is `lib/dates.ts` + `__tests__/dashboard-dates.test.ts`.
// ════════════════════════════════════════════════════════════════════════════════════════

import type { Task } from '@dojo/shared';

export type TaskStatus = Task['status'];

/** The columns the kanban renders, in order. `cancelled` is NOT one — it shares the terminal
 *  column with `fallen`, which is why the board gained a word rather than a column. */
export const KANBAN_COLUMN_KEYS = [
  'on_deck', 'in_progress', 'paused', 'complete', 'blocked', 'fallen',
] as const;

export type KanbanColumnKey = (typeof KANBAN_COLUMN_KEYS)[number];

/** The two outcomes that share the terminal column, in render order. */
export const TERMINAL_COLUMN_STATUSES = ['fallen', 'cancelled'] as const;

/**
 * Which column a task renders in. TOTAL over `Task['status']` — a status that returns null
 * here is a row that vanishes from the board, which is the failure this module exists to
 * prevent, so the suite asserts totality rather than trusting the union.
 */
export function columnKeyForStatus(status: TaskStatus | string): KanbanColumnKey | null {
  if (status === 'cancelled') return 'fallen';
  return (KANBAN_COLUMN_KEYS as readonly string[]).includes(status)
    ? (status as KanbanColumnKey)
    : null;
}

/**
 * The word shown ON the card for a terminal-column row, or null for every status whose column
 * header already says it. "Failed" is what the task detail page has always called `fallen`
 * (`pages/Tracker.tsx`), so the two surfaces agree; "Cancelled" is the user's own word,
 * arriving intact for the first time.
 */
export function terminalOutcomeLabel(status: TaskStatus | string): string | null {
  if (status === 'fallen') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  return null;
}

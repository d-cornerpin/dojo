// The ONE reading of a task status word: the status door and the work verbs' door (`agent/tools/cat/tracker.ts`)
// share it, so a measured task's close is re-read however "complete" is spelled.
export const CANONICAL_TASK_STATUSES = ['on_deck', 'in_progress', 'paused', 'complete', 'blocked', 'fallen', 'cancelled'];

const STATUS_SYNONYMS: Record<string, string> = {
  done: 'complete', finished: 'complete', completed: 'complete', complete: 'complete',
  in_progress: 'in_progress', inprogress: 'in_progress', working: 'in_progress',
  active: 'in_progress', doing: 'in_progress', started: 'in_progress', wip: 'in_progress',
  on_deck: 'on_deck', ondeck: 'on_deck', todo: 'on_deck', to_do: 'on_deck',
  queued: 'on_deck', backlog: 'on_deck', pending: 'on_deck',
  paused: 'paused', pause: 'paused', on_hold: 'paused', hold: 'paused', waiting: 'paused', parked: 'paused',
  blocked: 'blocked', block: 'blocked', stuck: 'blocked', stalled: 'blocked',
  fallen: 'fallen', failed: 'fallen', fail: 'fallen',
  cancelled: 'cancelled', canceled: 'cancelled', cancel: 'cancelled',
  abandoned: 'cancelled', dropped: 'cancelled', wontfix: 'cancelled',
};

export function normalizeTaskStatus(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CANONICAL_TASK_STATUSES.includes(key) ? key : STATUS_SYNONYMS[key] ?? null;
}

/** Statuses that end work. A status change never sets one: the hand-in decision does (`work/done/`). */
export const TERMINAL_STATUS_WORDS: ReadonlySet<string> = new Set(['complete', 'fallen', 'cancelled']);

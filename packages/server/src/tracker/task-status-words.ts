// The ONE reading of a task status word (moved out of `trackerUpdateStatus`, v3.5 fix round 1).
//
// A weak model says "done" / "in progress" / "on hold". The status door maps the clear synonyms to
// the canonical seven and refuses anything else, and the work verbs' door (`agent/tools/cat/
// tracker.ts`) asks the SAME function whether a call is a close, so a measured task's close re-reads
// its measure however "complete" is spelled. Two copies of this list are how the door and the
// handler came to disagree.
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

/** The canonical status a word means, or null when it is not a recognized task status. */
export function normalizeTaskStatus(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CANONICAL_TASK_STATUSES.includes(key) ? key : STATUS_SYNONYMS[key] ?? null;
}

/** The statuses that end work. None is set by a status change: finished or can't-be-done work is handed in,
 *  and the decision sets the end state (`work/done/`). */
export const TERMINAL_STATUS_WORDS: ReadonlySet<string> = new Set(['complete', 'fallen', 'cancelled']);

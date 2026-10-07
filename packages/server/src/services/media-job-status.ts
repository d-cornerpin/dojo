// ════════════════════════════════════════════════════════════════════════════════════════
// t122 — THE MEDIA JOB STATUS VOCABULARY, IN ONE PLACE, READ FROM THE TERMINAL END.
//
// Two tables model background media work and their non-terminal words DIFFER:
//
//   `generation_jobs` (image / audio / music, migration 063)
//        queued -> running -> succeeded | failed | cancelled
//   `video_jobs` (migration 062)
//        queued -> polling -> succeeded | failed | cancelled
//
// Census at this head, every writer of either table: `services/generation-jobs.ts`,
// `services/video-generation.ts`, `services/video-job-poller.ts`, and the two cancel doors in
// `gateway/routes/config.ts`. No writer produces any other word. The non-terminal sets are
// `{queued, running}` and `{queued, polling}`; the TERMINAL set is identical in both.
//
// ── WHY THIS IS A CONSTANT AND NOT FIVE INLINE IN-LISTS ──
// Every reader that asked "is this job still open" asked it as `status IN ('queued','running')`
// or `IN ('queued','polling')` — the open end, enumerated. That shape is what let t122 happen:
// a reader written against the open end is blind to any word it was not told about, so a status
// added to either table tomorrow would be open-but-uncounted in `live-work.ts` and
// unsweepable by the boot reconciliation — invisible in exactly the direction that costs the
// owner a permanent phantom stop button, and invisible to the thing that would have fixed it.
//
// Asked from the TERMINAL end — `status NOT IN ('succeeded','failed','cancelled')` — an unknown
// word means "something is open", which is the direction that gets noticed and swept rather
// than silently believed. The terminal set is also the half that is genuinely closed: a row
// cannot leave it, so a predicate keyed on it cannot go stale the way the open end did.
//
// The cancel doors and the CAS transitions deliberately keep their narrow `IN` lists: those are
// GUARDS on a specific legal transition ("only a queued row may become running"), not questions
// about whether work is open, and widening them would let a terminal row be re-opened.
// ════════════════════════════════════════════════════════════════════════════════════════

/** A media job row can never leave one of these. Identical for both tables. */
export const TERMINAL_JOB_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

/**
 * The same list as a SQL fragment, for `status NOT IN (…)`.
 *
 * Built from the array rather than written twice so the two can never disagree; the words are
 * literals of this file's own making, so there is no parameter to bind and nothing a row can
 * put into it.
 */
export const TERMINAL_JOB_STATUS_SQL = TERMINAL_JOB_STATUSES.map((s) => `'${s}'`).join(',');

/** Written into a reconciled row's `error`. Explicit about the fact AND the cause. */
export const ABANDONED_AT_BOOT = 'abandoned at boot: no owning process';

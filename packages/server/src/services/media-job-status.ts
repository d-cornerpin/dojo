// Media job statuses, read from the terminal end: `generation_jobs` and `video_jobs` share one terminal set.
// "Still open" is `status NOT IN (terminal)`, so a new status word counts as open and gets swept. The cancel
// doors and compare-and-set transitions keep narrow `IN` lists: they must not re-open a terminal row.

/** A media job row can never leave one of these. Identical for both tables. */
export const TERMINAL_JOB_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

/** The same list as a SQL fragment, built from the array so the two cannot disagree; no row data can enter it. */
export const TERMINAL_JOB_STATUS_SQL = TERMINAL_JOB_STATUSES.map((s) => `'${s}'`).join(',');

/** Written into a reconciled row's `error`. Names both the fact and the cause. */
export const ABANDONED_AT_BOOT = 'abandoned at boot: no owning process';

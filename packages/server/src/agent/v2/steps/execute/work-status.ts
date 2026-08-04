// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — FA-T2's "does this status argument ADVANCE the task",
// moved out of `loop.ts` module level with the floor that asks it. Its only use
// was inside the `execute` span.
// ════════════════════════════════════════

// v3.1.11 (FN-9) + FA-T2: tracker mutation tools partitioned by whether a call
// proves the worker is TENDING open multi-step work.
//
// DISARMING (open / advance-to-active): creating a project or task, adding
// notes, editing a task/project, or advancing a step. A call to one of these
// means the agent is actively opening or pushing its work forward, so it
// disarms the multi-step enforcement floor (state.trackerWriteThisTurn).
//
// NON-DISARMING (close / abandon / handoff), and so DELIBERATELY absent:
// work_update:close_project, work_update:reassign, work_schedule:resolve_missed,
// and work_update:status when its status ARGUMENT is a terminal / non-active value
// (complete / fallen / paused / blocked). These REMOVE or hand off the thing the
// PM watches, so they must NOT disarm, otherwise new multi-step work started
// LATER in the same turn rides in behind an earlier close and escapes both the
// nudge and the floor (FA-T2). For those the floor falls through to the
// hasRecentlyTendedTask DB check, which reflects whether an OPEN task actually
// still exists after the mutation.
//
// READS (work_update:get / work_update:list) are absent from both sets: a bare
// status peek never disarms enforcement (FN-9 invariant). PM / validation-lane
// governance operations (every work_validate action, both work_close_request
// asks, work_schedule:pause / :resume) are also absent: those are
// override/governance actions, not a worker opening or advancing its own task.
// The two obligation ops (work_open:commitment, work_close_request:commitment)
// are absent for a different reason — a promise is not multi-step work, and
// `work_open(kind="commitment")` never disarmed this floor before the collapse either.
// FA-T2: a status change disarms the floor ONLY when its status argument
// ADVANCES the task to an active state. These are the canonical active statuses
// plus the weak-model synonyms the status normalizer accepts for them (kept in
// sync with STATUS_SYNONYMS in tracker/tools.ts). A transition to
// complete / fallen / paused / blocked, an update with no status (a bare
// reassign/repriority), or an unrecognized value is NOT advancing and does not
// disarm, it falls through to the hasRecentlyTendedTask DB check. That is safe
// by construction: mis-reading an advancing synonym as non-advancing only defers
// to the DB, which then sees the freshly-tended open task and suppresses anyway;
// only wrongly reading a CLOSING status as advancing would be a real disarm hole,
// and this set never contains a terminal value.
const ADVANCING_STATUS_ARGS = new Set([
  'in_progress', 'inprogress', 'working', 'active', 'doing', 'started', 'wip',
  'on_deck', 'ondeck', 'todo', 'to_do', 'queued', 'backlog', 'pending',
]);
export function isAdvancingStatusArg(rawStatus: unknown): boolean {
  if (typeof rawStatus !== 'string') return false;
  const key = rawStatus.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ADVANCING_STATUS_ARGS.has(key);
}

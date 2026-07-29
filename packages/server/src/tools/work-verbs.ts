// ════════════════════════════════════════
// PHASE-2 T8V — the six work verbs, and the ONE place a tool call is
// turned back into the operation it performs.
// ════════════════════════════════════════
//
// WHY THIS MODULE EXISTS. Before the collapse, twenty-four public tool names
// each named exactly one operation, so ~20 engine behaviours could decide what
// a call MEANT by matching its NAME: the multi-step floor, the hoarding brake,
// the close-out gate, the PM overseer allow-list, the bookkeeping nudge, the
// concurrency planner. Six verbs with a discriminator argument break every one
// of those matches — and break them SILENTLY, because `tools/aliases.ts`
// canonicalises the old names at loop ingestion, so a classifier still watching
// for `tracker_create_task` simply stops firing the moment the model calls
// `work_open`.
//
// The fix is not "match six names instead of twenty-four". A name-only match
// cannot express the distinctions those behaviours actually encode — the PM may
// close a project but may NOT flip a worker's status, and after the collapse
// both are `work_update`. So the sites rekey to the STRUCTURAL FACT the name
// was proxying: the OPERATION, derived from (name, args) here and nowhere else.
// One matcher for one marker.
//
// The op id is deliberately `<verb>:<discriminator>` — the same shape the
// dispatch cases use — so a set of ops reads like the old set of names and a
// reviewer can check the translation line by line.

/** The six public verbs. Nothing else is a work verb. */
export const WORK_VERBS = [
  'work_open',
  'work_update',
  'work_note',
  'work_close_request',
  'work_validate',
  'work_schedule',
] as const;

export type WorkVerb = (typeof WORK_VERBS)[number];

const WORK_VERB_SET: ReadonlySet<string> = new Set<string>(WORK_VERBS);

/** True for any of the six public verbs. */
export function isWorkVerb(name: string | undefined | null): boolean {
  return typeof name === 'string' && WORK_VERB_SET.has(name);
}

/**
 * Every operation the six verbs can perform, one id per operation that used to
 * be its own tool. The comment on each names the retired verb it absorbed, so
 * the mapping is auditable without leaving the file.
 */
export const WORK_OPS = [
  'work_open:project',                 // tracker_create_project
  'work_open:task',                    // tracker_create_task
  'work_open:reminder',                // reminder_create
  'work_open:commitment',              // commitment_open
  'work_update:status',                // tracker_update_status
  'work_update:edit',                  // tracker_edit_task + tracker_edit_project
  'work_update:reassign',              // tracker_reassign_task
  'work_update:complete_step',         // tracker_complete_step
  'work_update:close_project',         // tracker_close_project
  'work_update:list',                  // tracker_list_active
  'work_update:get',                   // tracker_get_status
  'work_note',                         // tracker_add_notes
  'work_close_request:override',       // tracker_request_override
  'work_close_request:user_verdict',   // tracker_request_user_verdict
  'work_close_request:commitment',     // commitment_resolve
  'work_validate:validate',            // tracker_validate
  'work_validate:retask',              // tracker_retask
  'work_validate:override',            // tracker_override
  'work_validate:apply_user_verdict',  // tracker_apply_user_verdict
  'work_validate:apply_user_validation', // tracker_apply_user_validation
  'work_schedule:pause',               // tracker_pause_schedule
  'work_schedule:resume',              // tracker_resume_schedule
  'work_schedule:resolve_missed',      // tracker_resolve_missed_runs
] as const;

export type WorkOp = (typeof WORK_OPS)[number];

const WORK_OP_SET: ReadonlySet<string> = new Set<string>(WORK_OPS);

/** True when a string is one of the 23 operation ids. */
export function isWorkOp(op: string): op is WorkOp {
  return WORK_OP_SET.has(op);
}

type Args = Record<string, unknown> | undefined | null;

function str(args: Args, key: string): string | null {
  const v = args?.[key];
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
}

function has(args: Args, key: string): boolean {
  return args != null && args[key] !== undefined && args[key] !== null && args[key] !== '';
}

/** The fields `work_update` treats as an EDIT when no action is given. */
const EDITABLE_FIELDS = [
  'title', 'description', 'goal', 'depends_on', 'step_number', 'phase',
  'scheduled_start', 'repeat_interval', 'repeat_unit', 'repeat_end_type',
  'repeat_end_value', 'repeat_days_of_week', 'anchor_time', 'priority', 'notes',
];

/**
 * ABSORB-DON'T-REFUSE (#77) LIVES HERE. Weak models omit the discriminator, so
 * every verb infers it from the shape of the call before it refuses anything.
 * The inference is deterministic and total: an explicit discriminator always
 * wins, and each fallback ladder ends in the operation that is safest to
 * perform by accident (a READ for work_update; a validate for work_validate).
 *
 * Returns null when the name is not a work verb — callers use that to fall back
 * to plain name matching for the rest of the tool surface.
 */
export function workOperation(name: string | undefined | null, args?: Args): WorkOp | null {
  if (!isWorkVerb(name)) return null;

  switch (name) {
    case 'work_note':
      return 'work_note';

    case 'work_open': {
      const kind = str(args, 'kind');
      if (kind === 'project') return 'work_open:project';
      if (kind === 'task') return 'work_open:task';
      if (kind === 'reminder') return 'work_open:reminder';
      if (kind === 'commitment' || kind === 'promise') return 'work_open:commitment';
      // No kind: read the shape. `what` is the reminder's own field; `tasks` /
      // `level` only exist on a project; a bare `description` with no title is a
      // promise; anything with a title is a task.
      if (has(args, 'what') || has(args, 'when')) return 'work_open:reminder';
      if (has(args, 'tasks') || has(args, 'level')) return 'work_open:project';
      if (!has(args, 'title') && has(args, 'description')) return 'work_open:commitment';
      return 'work_open:task';
    }

    case 'work_update': {
      const action = str(args, 'action');
      if (action === 'status') return 'work_update:status';
      if (action === 'edit') return 'work_update:edit';
      if (action === 'reassign') return 'work_update:reassign';
      if (action === 'complete_step' || action === 'step') return 'work_update:complete_step';
      if (action === 'close_project' || action === 'close') return 'work_update:close_project';
      if (action === 'list') return 'work_update:list';
      if (action === 'get') return 'work_update:get';
      // No action: the argument shape decides, most-specific first.
      if (has(args, 'status')) return 'work_update:status';
      if (has(args, 'assigned_to') || has(args, 'assigned_to_group')) return 'work_update:reassign';
      // A project id with no task id and a `reason` is a close; with edit
      // fields it is a project edit (the §7.2 absorb rule).
      if (has(args, 'project_id') && !has(args, 'task_id')) {
        if (has(args, 'reason')) return 'work_update:close_project';
        if (EDITABLE_FIELDS.some((f) => has(args, f))) return 'work_update:edit';
        return 'work_update:get';
      }
      if (EDITABLE_FIELDS.some((f) => has(args, f))) return 'work_update:edit';
      if (has(args, 'task_id') || has(args, 'id')) return 'work_update:get';
      return 'work_update:list';
    }

    case 'work_close_request': {
      const action = str(args, 'action');
      if (action === 'override') return 'work_close_request:override';
      if (action === 'user_verdict' || action === 'verdict') return 'work_close_request:user_verdict';
      if (action === 'commitment' || action === 'promise') return 'work_close_request:commitment';
      if (has(args, 'disposition')) return 'work_close_request:commitment';
      if (has(args, 'status_requested') || has(args, 'pm_rejection_summary')) {
        return 'work_close_request:user_verdict';
      }
      if (has(args, 'requested_status') || has(args, 'justification')) {
        return 'work_close_request:override';
      }
      // A `cmt:` id is unambiguous even with no other field.
      const id = str(args, 'id');
      if (id?.startsWith('cmt:')) return 'work_close_request:commitment';
      return 'work_close_request:override';
    }

    case 'work_validate': {
      const action = str(args, 'action');
      if (action === 'validate') return 'work_validate:validate';
      if (action === 'retask') return 'work_validate:retask';
      if (action === 'override') return 'work_validate:override';
      if (action === 'apply_user_verdict') return 'work_validate:apply_user_verdict';
      if (action === 'apply_user_validation') return 'work_validate:apply_user_validation';
      if (has(args, 'directive')) return 'work_validate:retask';
      if (has(args, 'override_request_id') || has(args, 'approve')) return 'work_validate:override';
      if (has(args, 'validated')) return 'work_validate:apply_user_validation';
      if (has(args, 'user_quote')) return 'work_validate:apply_user_verdict';
      return 'work_validate:validate';
    }

    case 'work_schedule': {
      const action = str(args, 'action');
      if (action === 'resume') return 'work_schedule:resume';
      if (action === 'resolve_missed' || action === 'resolve_missed_runs') {
        return 'work_schedule:resolve_missed';
      }
      if (action === 'pause') return 'work_schedule:pause';
      // `resolution` is the missed-run choice; its presence names the operation
      // even when the model forgot `action` (the discriminator collision the
      // §7.2 mapping had to break: `tracker_resolve_missed_runs` already took a
      // parameter called `action`, whose value could be "pause").
      if (has(args, 'resolution')) return 'work_schedule:resolve_missed';
      return 'work_schedule:pause';
    }
  }
  return null;
}

/**
 * The key a behavioural set should be matched on: the OPERATION for a work
 * verb, the plain tool name for everything else. Every rekeyed set in the
 * engine is a set of these, so a set can mix `work_update:status` with
 * `vault_remember` exactly as the old name sets did.
 */
export function toolOpKey(name: string | undefined | null, args?: Args): string {
  return workOperation(name, args) ?? (name ?? '');
}

// ── Family predicates: the facts the old NAME PREFIXES were proxying ──

/**
 * The TRACKER family — what `name.startsWith('tracker_')` used to select.
 *
 * `work_open:reminder` and the two commitment ops are DELIBERATELY excluded:
 * `reminder_create`, `commitment_open` and `commitment_resolve` never carried
 * the `tracker_` prefix, so they never counted as tracker calls at the
 * multi-step floor and never got the hoarding load-count exemption. Folding
 * them in here would change two live counters by widening a prefix, which is
 * the kind of accident this module exists to prevent.
 */
export function isTrackerFamilyOp(op: string | null): boolean {
  if (op === null) return false;
  if (op === 'work_open:reminder') return false;
  if (op === 'work_open:commitment') return false;
  if (op === 'work_close_request:commitment') return false;
  return isWorkOp(op);
}

/** Convenience: (name, args) → tracker-family membership. */
export function isTrackerFamilyCall(name: string | undefined | null, args?: Args): boolean {
  return isTrackerFamilyOp(workOperation(name, args));
}

/** The two obligation (promise) operations, formerly `commitment_*`. */
export function isCommitmentOp(op: string | null): boolean {
  return op === 'work_open:commitment' || op === 'work_close_request:commitment';
}

/**
 * READ operations. Only these two are safe to run in parallel and only these
 * two never disarm the multi-step floor (the FN-9 invariant).
 */
export function isWorkReadOp(op: string | null): boolean {
  return op === 'work_update:list' || op === 'work_update:get';
}

// ════════════════════════════════════════
// The behavioural operation sets
// ════════════════════════════════════════
//
// Each set below is the EXACT membership of a retired NAME set that the engine
// used to match on. They live here rather than at their gates for two reasons:
// one matcher per marker (the same rule that put `workOperation` here), and so
// that `__tests__/work-verbs.test.ts` can hold each set against the retired
// names it replaced without importing `agent/v2/loop.ts`, which has a
// module-init circular import and hangs when imported standalone.
//
// A missing member here is EXACTLY the silent disable this task exists to
// prevent: the gate keeps running, the alias table keeps canonicalising, and the
// behaviour simply stops firing. The test names the behaviour that went dark.

/**
 * Closing / transitioning a task.
 * Was `{tracker_update_status, tracker_complete_step, tracker_close_project}` —
 * the set five separate loop gates matched on (transitioned-this-turn, the
 * promise floor's transition test, the thrash-gate clear, the status-mutation
 * signal, and the end-of-turn close detector).
 */
export const CLOSING_WORK_OPS: ReadonlySet<string> = new Set([
  'work_update:status',
  'work_update:complete_step',
  'work_update:close_project',
]);

/**
 * Forward progress for the thrash counter.
 * Was `{tracker_update_status, tracker_complete_step, tracker_add_notes}`.
 * `work_update:close_project` is deliberately absent, exactly as
 * `tracker_close_project` was: closing a project is not evidence the agent is
 * still working the thing it is looping on.
 */
export const PROGRESS_WORK_OPS: ReadonlySet<string> = new Set([
  'work_update:status',
  'work_update:complete_step',
  'work_note',
]);

/**
 * Satisfies the pre-turn close-out gate once the agent engages.
 * Was `{tracker_update_status, tracker_complete_step, tracker_add_notes,
 * tracker_close_project}` — note this is a strictly SMALLER set than the gate's
 * allowlist below, because a read may pass the gate without disengaging it.
 */
export const SATISFYING_WORK_OPS: ReadonlySet<string> = new Set([
  'work_update:status',
  'work_update:complete_step',
  'work_note',
  'work_update:close_project',
]);

/**
 * The pre-turn close-out gate's ALLOWLIST: what an agent with dangling
 * in_progress tasks may still call. `load_tool_docs` is in it (not a work op)
 * because the agent may need a close-out tool's schema before it can call it.
 * The two obligation ops are deliberately absent: closing a promise is not
 * engaging with a dangling task.
 */
export const CLOSE_OUT_WORK_OPS: ReadonlySet<string> = new Set([
  'work_update:status',
  'work_update:complete_step',
  'work_note',
  'work_update:close_project',   // bulk-resolve a whole stranded project
  'work_update:get',             // read-only allowed (investigate before resolving)
  'work_update:list',            // ditto
  'work_update:edit',            // editing the task counts as engagement
  'work_schedule:pause',
  'work_schedule:resume',
  'work_schedule:resolve_missed',
  'load_tool_docs',
]);

/**
 * Operations that DISARM the multi-step enforcement floor, i.e. that prove the
 * worker is opening or advancing its own work (FN-9 / FA-T2).
 * Was `{tracker_create_project, tracker_create_task, tracker_add_notes,
 * tracker_edit_task, tracker_edit_project, tracker_complete_step}`; the two edit
 * verbs are one op now. A status change disarms only when its status ARGUMENT
 * advances the task, which is a second test at the gate, not a member here.
 */
export const DISARMING_WORK_OPS: ReadonlySet<string> = new Set([
  'work_open:project',
  'work_open:task',
  'work_note',
  'work_update:edit',
  'work_update:complete_step',
]);

/**
 * The two close operations that carry a task_id, so the engine can tell a
 * USER-REQUESTED close from incidental bookkeeping.
 * Was `{tracker_update_status, tracker_complete_step}`.
 */
export const CLOSE_OPS_WITH_TASK_ID: ReadonlySet<string> = new Set([
  'work_update:status',
  'work_update:complete_step',
]);

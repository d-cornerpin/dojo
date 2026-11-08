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
import { normalizeTaskStatus, TERMINAL_STATUS_WORDS } from '../tracker/task-status-words.js';

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
  'work_update:hand_in',               // tracker_complete_step + tracker_close_project + the closing statuses
  'work_update:edit',                  // tracker_edit_task + tracker_edit_project
  'work_update:reassign',              // tracker_reassign_task
  'work_update:list',                  // tracker_list_active
  'work_update:get',                   // tracker_get_status
  // UX-REPAIR ROUND 13 T60. The ONE operation on this list that absorbed no retired verb:
  // it never existed. Round-13 S4 asked the board what had happened that day, got the
  // list door's "what is open right now", and answered "quiet day" over 57 rows opened
  // and closed. `__tests__/work-verbs.test.ts` names it as the post-collapse addition so
  // the "every operation traces to a retired verb" proof stays honest instead of blanket.
  'work_update:activity',              // (new — no retired verb; T60)
  'work_note',                         // tracker_add_notes
  'work_close_request:commitment',     // commitment_resolve
  'work_validate:decide',              // tracker_validate + tracker_override + the two user-verdict verbs
  'work_validate:open_proof',          // (new: the decider's open of a proof item)
  'work_validate:retask',              // tracker_retask
  'work_schedule:pause',               // tracker_pause_schedule
  'work_schedule:resume',              // tracker_resume_schedule
  'work_schedule:resolve_missed',      // tracker_resolve_missed_runs
] as const;

export type WorkOp = (typeof WORK_OPS)[number];

const WORK_OP_SET: ReadonlySet<string> = new Set<string>(WORK_OPS);

/** True when a string is one of the 24 operation ids. */
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
      // `level` / `plan` only exist on a project; a bare `description` with no title is a
      // promise; anything with a title is a task.
      if (has(args, 'what') || has(args, 'when')) return 'work_open:reminder';
      if (has(args, 'tasks') || has(args, 'level') || has(args, 'plan')) return 'work_open:project';
      if (!has(args, 'title') && has(args, 'description')) return 'work_open:commitment';
      return 'work_open:task';
    }

    case 'work_update': {
      const action = str(args, 'action');
      // Finishing is a hand-in, never a status: a weak model's old habit (a closing status, a step
      // close, a project close) reaches the hand-in door and its proof check.
      if (action === 'hand_in' || action === 'complete_step' || action === 'step' || action === 'close_project' || action === 'close') return 'work_update:hand_in';
      if ((action === 'status' || action === null) && TERMINAL_STATUS_WORDS.has(normalizeTaskStatus(args?.status) ?? '')) return 'work_update:hand_in';
      if (action === 'status') return 'work_update:status';
      if (action === 'edit') return 'work_update:edit';
      if (action === 'reassign') return 'work_update:reassign';
      if (action === 'list') return 'work_update:list';
      if (action === 'get') return 'work_update:get';
      // T60. Ahead of the shape ladder for the same reason every explicit discriminator is:
      // an action the caller NAMED always wins. Without this arm the ladder's terminal
      // `return 'work_update:list'` claims it, and the model that asked what CHANGED is
      // silently handed what is OPEN — the S4 substitution, made by the router.
      if (action === 'activity') return 'work_update:activity';
      // No action: the argument shape decides, most-specific first.
      // T65: `hours` is the activity door's own declared property and no other operation reads
      // it, so its presence names the operation — the same absorb-don't-refuse reading the
      // ladder makes of `status`, `assigned_to` and the rest. Without this arm a model that
      // passes a window and forgets the discriminator falls to the terminal `list` and is
      // handed what is OPEN, which is the exact substitution T60's own router arm exists to
      // stop, arriving one field over.
      if (has(args, 'hours')) return 'work_update:activity';
      // ⚠ `status` BEFORE `assigned_to`, and the order stays: an explicit discriminator always
      // wins (#77), and rerouting the pair would hand the STATUS half to a door that does not
      // perform one. t193 closed the side door at the other end instead: the status door now
      // REFUSES a call carrying `assigned_to` (moving work is `:reassign`'s, under the
      // row-authority gate's cause rule), so the pair can no longer move a task.
      if (has(args, 'status')) return 'work_update:status';
      if (has(args, 'assigned_to') || has(args, 'assigned_to_group')) return 'work_update:reassign';
      // A project id with no task id and a `reason` is a close; with edit
      // fields it is a project edit (the §7.2 absorb rule).
      if (has(args, 'proof') || has(args, 'outcome')) return 'work_update:hand_in';
      if (has(args, 'project_id') && !has(args, 'task_id')) {
        if (EDITABLE_FIELDS.some((f) => has(args, f))) return 'work_update:edit';
        return 'work_update:get';
      }
      if (EDITABLE_FIELDS.some((f) => has(args, f))) return 'work_update:edit';
      if (has(args, 'task_id') || has(args, 'id')) return 'work_update:get';
      return 'work_update:list';
    }

    case 'work_close_request':
      return 'work_close_request:commitment';

    case 'work_validate': {
      const action = str(args, 'action');
      if (action === 'retask' || has(args, 'directive')) return 'work_validate:retask';
      if (action === 'open_proof' || (action !== 'decide' && has(args, 'item'))) return 'work_validate:open_proof';
      return 'work_validate:decide';
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
 * READ operations. Only these are safe to run in parallel and only these never
 * disarm the multi-step floor (the FN-9 invariant).
 *
 * T60 added the third, and it belongs here for the FN-9 reason and not by family
 * resemblance: `work_update:activity` opens nothing, advances nothing and writes
 * nothing (its own test counts `work`, `work_events` and `deliveries` before and
 * after). An agent that reads its day has not started work, so treating the read as
 * progress would let a board-read disarm the floor that exists to make it do some.
 */
export function isWorkReadOp(op: string | null): boolean {
  return op === 'work_update:list' || op === 'work_update:get' || op === 'work_update:activity';
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
  'work_update:hand_in',
]);

/** Forward progress on open work: what resets the thrash counter, and what the compile gate lets through
 *  besides the reply. Closing a project is not in it: that is not working the thing being looped on. */
export const PROGRESS_WORK_OPS: ReadonlySet<string> = new Set([
  'work_update:status',
  'work_update:hand_in',
  'work_note',
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
  'work_update:hand_in',
]);

/**
 * THE OPENING OPERATIONS — "a work row came into existence on this turn".
 *
 * PHASE-2 T8c item 3 (DECIDED D4). The >=6 engine floor used to be gated on
 * `trackerWriteThisTurn`, i.e. on the DISARMING set above, which is a broader question:
 * noting, editing and advancing a step all count as tending. D4's requirement is narrower and
 * is about existence — *a model that ignores the nudge still ends the turn with a work row* —
 * so the floor asks the narrow question with its own set rather than borrowing the wide one.
 * This is a strict subset of DISARMING_WORK_OPS by construction, asserted in
 * `tools/__tests__/work-verbs.test.ts`.
 */
export const OPENING_WORK_OPS: ReadonlySet<string> = new Set([
  'work_open:project',
  'work_open:task',
]);

/**
 * The two close operations that carry a task_id, so the engine can tell a
 * USER-REQUESTED close from incidental bookkeeping.
 * Was `{tracker_update_status, tracker_complete_step}`.
 */
export const CLOSE_OPS_WITH_TASK_ID: ReadonlySet<string> = new Set([
  'work_update:status',
  'work_update:hand_in',
]);


// ════════════════════════════════════════
// v3.5 field fix 3, test-2 rank 3: WHAT EACH OPERATION READS.
//
// Each work verb declares the UNION of its operations' arguments (one schema per verb), and each
// operation's handler (`agent/tools/cat/tracker.ts`) reads its own subset. The per-tool unknown-
// argument check therefore passed `measure` on `complete_step` (declared, for `edit`), and the handler
// dropped it without a word: the agent believed it had set a measure. This map is the same check, per
// operation: a DECLARED argument the chosen operation does not read refuses the whole call before
// anything runs (`unknownArgsAgainstSchema` → `unreadArgsRefusal`), and the refusal names, from this
// same map, the operations that do read it. `an-argument-the-action-does-not-read-is-refused.test.ts`
// holds it to the handlers (every direct read is listed) and to the schemas (every listed name is
// declared, and every declared name is read by some operation), so it cannot drift.
// The discriminators (`action`, `kind`) are read by every operation of their verb.
// ════════════════════════════════════════

export const WORK_OP_READS: Readonly<Record<WorkOp, readonly string[]>> = {
  'work_open:project': ['kind', 'title', 'description', 'level', 'tasks', 'plan', 'allow_duplicate'],
  'work_open:task': ['kind', 'title', 'description', 'project_id', 'assigned_to', 'assigned_to_group', 'priority', 'step_number',
    'depends_on', 'phase', 'goal', 'measure', 'scheduled_start', 'repeat_interval', 'repeat_unit', 'repeat_days_of_week',
    'repeat_end_type', 'repeat_end_value', 'anchor_time', 'local_time', 'local_timezone', 'allow_duplicate'],
  'work_open:reminder': ['kind', 'what', 'when', 'anchor_time', 'local_time', 'local_timezone', 'repeat_interval', 'repeat_unit',
    'repeat_days_of_week', 'repeat_end_type', 'repeat_end_value'],
  'work_open:commitment': ['kind', 'description'],
  'work_update:status': ['action', 'task_id', 'status', 'notes', 'resume_at', 'priority', 'reason'],
  'work_update:hand_in': ['action', 'task_id', 'project_id', 'outcome', 'proof', 'note', 'status', 'notes', 'reason'],
  'work_update:edit': ['action', 'task_id', 'project_id', ...EDITABLE_FIELDS,   // the edit door's own field list, the one the shape ladder reads
    'local_time', 'local_timezone', 'revert_to_original', 'measure'],
  'work_update:reassign': ['action', 'task_id', 'assigned_to', 'assigned_to_group', 'cause', 'user_quote'],
  'work_update:list': ['action', 'filter', 'verbose'],
  'work_update:get': ['action', 'id', 'task_id', 'project_id', 'offset'],
  'work_update:activity': ['action', 'hours', 'verbose'],
  'work_note': ['task_id', 'notes'],
  'work_close_request:commitment': ['action', 'id', 'disposition', 'note'],
  'work_validate:decide': ['action', 'task_id', 'verdict', 'reason', 'user_quote'],
  'work_validate:open_proof': ['action', 'task_id', 'item'],
  'work_validate:retask': ['action', 'task_id', 'directive', 'target_status'],
  'work_schedule:pause': ['action', 'task_id'],
  'work_schedule:resume': ['action', 'task_id'],
  'work_schedule:resolve_missed': ['action', 'task_id', 'resolution'],
};

/** NAVIGATION arguments an operation ACCEPTS without reading (never refused, never claimed as read): the
 *  ids a model naturally carries from a sibling call, and the list door's `verbose`. The activity door
 *  reports the whole board's window, so a task id on it changes nothing and costs nothing. */
export const WORK_OP_ACCEPTS: Readonly<Partial<Record<WorkOp, readonly string[]>>> = {
  'work_update:activity': ['task_id', 'project_id'],
  'work_update:get': ['verbose'],
};

/** How an operation is spelled to the model: `work_update(action="edit")`, `work_open(kind="task")`. */
export function workOpCallName(op: WorkOp): string {
  const [verb, sub] = op.split(':');
  if (!sub) return verb;
  return verb === 'work_open' ? `${verb}(kind="${sub}")` : `${verb}(action="${sub}")`;
}

/** The DECLARED arguments of `args` that the operation the call resolves to does not read (in the call's
 *  own order). Empty for a call that is not a work verb. `declared` is the verb's schema property set. */
export function unreadWorkArgs(name: string, args: Args, declared: ReadonlySet<string>): { op: WorkOp | null; unread: string[] } {
  const op = workOperation(name, args);
  if (!op || !args) return { op, unread: [] };
  const reads = new Set([...WORK_OP_READS[op], ...(WORK_OP_ACCEPTS[op] ?? [])]);
  const unread = Object.keys(args).filter((k) => !k.startsWith('__') && declared.has(k) && has(args, k) && !reads.has(k));
  return { op, unread };
}

/** The other work operations that read `arg`, as the model calls them (any work verb: `measure` is set
 *  by `work_open` as well as by `work_update(action="edit")`). Discriminators are not doors, so they are
 *  never named for each other. */
export function workOpsThatRead(op: WorkOp, arg: string): string[] {
  return WORK_OPS.filter((o) => o !== op && WORK_OP_READS[o].includes(arg)).map(workOpCallName);
}

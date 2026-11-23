// The six work verbs, and the one place a tool call becomes the operation it performs: engine gates key on
// the op id `<verb>:<discriminator>` derived from (name, args) here, never on a tool name.

import { normalizeTaskStatus, TERMINAL_STATUS_WORDS } from '../tracker/task-status-words.js';

export const WORK_VERBS = [
  'work_open',
  'work_update',
  'work_note',
  'work_close_request',
  'work_validate',
  'work_schedule',
] as const;

const WORK_VERB_SET: ReadonlySet<string> = new Set<string>(WORK_VERBS);

export function isWorkVerb(name: string | undefined | null): boolean {
  return typeof name === 'string' && WORK_VERB_SET.has(name);
}

/** Every operation the six verbs can perform, one id per discriminator value. */
export const WORK_OPS = [
  'work_open:project',
  'work_open:task',
  'work_open:reminder',
  'work_open:commitment',
  'work_update:status',
  'work_update:hand_in',
  'work_update:edit',
  'work_update:reassign',
  'work_update:list',
  'work_update:get',
  'work_update:activity',
  'work_note',
  'work_close_request:commitment',
  'work_validate:decide',
  'work_validate:open_proof',
  'work_validate:retask',
  'work_schedule:pause',
  'work_schedule:resume',
] as const;

export type WorkOp = (typeof WORK_OPS)[number];

const WORK_OP_SET: ReadonlySet<string> = new Set<string>(WORK_OPS);

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

// Weak models omit the discriminator, so each verb infers it from the call's shape; an explicit one always wins.
// Fallbacks end in the safest operation (a read for work_update). Null for a name that is not a work verb.
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
      // No kind: `what`/`when` is a reminder, `tasks`/`level`/`plan` a project, a bare description a promise.
      if (has(args, 'what') || has(args, 'when')) return 'work_open:reminder';
      if (has(args, 'tasks') || has(args, 'level') || has(args, 'plan')) return 'work_open:project';
      if (!has(args, 'title') && has(args, 'description')) return 'work_open:commitment';
      return 'work_open:task';
    }

    case 'work_update': {
      const action = str(args, 'action');
      // Finishing is a hand-in, never a status: every closing form reaches the hand-in door's proof check.
      if (action === 'hand_in' || action === 'complete_step' || action === 'step' || action === 'close_project' || action === 'close') return 'work_update:hand_in';
      if ((action === 'status' || action === null) && TERMINAL_STATUS_WORDS.has(normalizeTaskStatus(args?.status) ?? '')) return 'work_update:hand_in';
      if (action === 'status') return 'work_update:status';
      if (action === 'edit') return 'work_update:edit';
      if (action === 'reassign') return 'work_update:reassign';
      if (action === 'list') return 'work_update:list';
      if (action === 'get') return 'work_update:get';
      // A named action beats the shape ladder (its terminal `list` would answer what is OPEN instead).
      if (action === 'activity') return 'work_update:activity';
      // No action: shape decides, most-specific first; `hours` belongs only to the activity door.
      if (has(args, 'hours')) return 'work_update:activity';
      // `status` stays before `assigned_to`: rerouting the pair would hand the status half to a door that
      // performs none (the status door refuses `assigned_to`).
      if (has(args, 'status')) return 'work_update:status';
      if (has(args, 'assigned_to') || has(args, 'assigned_to_group')) return 'work_update:reassign';
      // `proof`/`outcome` is a hand-in; a project id with no task id is an edit (with edit fields) or a read.
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
      return 'work_schedule:pause';
    }
  }
  return null;
}

/** The key a behavioural set matches on: the operation for a work verb, else the plain tool name. */
export function toolOpKey(name: string | undefined | null, args?: Args): string {
  return workOperation(name, args) ?? (name ?? '');
}


// The tracker family. Reminder and commitment ops are excluded: they never counted at the multi-step floor
// or got the hoarding load-count exemption, and including them would move those counters.
export function isTrackerFamilyOp(op: string | null): boolean {
  if (op === null) return false;
  if (op === 'work_open:reminder') return false;
  if (op === 'work_open:commitment') return false;
  if (op === 'work_close_request:commitment') return false;
  return isWorkOp(op);
}

export function isTrackerFamilyCall(name: string | undefined | null, args?: Args): boolean {
  return isTrackerFamilyOp(workOperation(name, args));
}

export function isCommitmentOp(op: string | null): boolean {
  return op === 'work_open:commitment' || op === 'work_close_request:commitment';
}

/** Read operations write nothing, so they never disarm the multi-step floor (`activity` included). */
export function isWorkReadOp(op: string | null): boolean {
  return op === 'work_update:list' || op === 'work_update:get' || op === 'work_update:activity';
}

// Engine gate sets, kept beside `workOperation` (one matcher per marker). `__tests__/work-verbs.test.ts`
// checks them here because importing `agent/v2/loop.ts` standalone hangs on a circular import.
// A missing member silently disables its gate.

/** Closing or transitioning a task: matched by the loop's close and transition checks. */
export const CLOSING_WORK_OPS: ReadonlySet<string> = new Set([
  'work_update:status',
  'work_update:hand_in',
]);

// Operations that write the worker's own work (opening or advancing it). A status change counts only if its
// status ARGUMENT advances the task, a second test at the gate.
export const DISARMING_WORK_OPS: ReadonlySet<string> = new Set([
  'work_open:project',
  'work_open:task',
  'work_note',
  'work_update:edit',
  'work_update:hand_in',
]);

/** The close operations that carry a task_id, to tell a user-requested close from bookkeeping. */
export const CLOSE_OPS_WITH_TASK_ID: ReadonlySet<string> = new Set([
  'work_update:status',
  'work_update:hand_in',
]);


// What each operation reads. A verb declares the union of its operations' arguments, so a declared argument
// the chosen operation ignores is refused before anything runs (`unreadArgsRefusal`), naming the operations
// that read it. `action` and `kind` are read by every operation. Handlers: `agent/tools/cat/tracker.ts`.
// Held to the schemas by `agent/tools/__tests__/an-argument-the-action-does-not-read-is-refused.test.ts`.

export const WORK_OP_READS: Readonly<Record<WorkOp, readonly string[]>> = {
  'work_open:project': ['kind', 'title', 'description', 'level', 'tasks', 'plan', 'allow_duplicate'],
  'work_open:task': ['kind', 'title', 'description', 'project_id', 'assigned_to', 'assigned_to_group', 'priority', 'step_number',
    'depends_on', 'phase', 'goal', 'measure', 'scheduled_start', 'repeat_interval', 'repeat_unit', 'repeat_days_of_week',
    'repeat_end_type', 'repeat_end_value', 'anchor_time', 'local_time', 'local_timezone', 'allow_duplicate'],
  'work_open:reminder': ['kind', 'what', 'when', 'anchor_time', 'local_time', 'local_timezone', 'repeat_interval', 'repeat_unit',
    'repeat_days_of_week', 'repeat_end_type', 'repeat_end_value'],
  'work_open:commitment': ['kind', 'description'],
  'work_update:status': ['action', 'task_id', 'status', 'notes', 'resume_at', 'priority', 'reason', 'user_quote'],
  'work_update:hand_in': ['action', 'task_id', 'project_id', 'outcome', 'proof', 'note', 'status', 'notes', 'reason'],
  'work_update:edit': ['action', 'task_id', 'project_id', ...EDITABLE_FIELDS,
    'local_time', 'local_timezone', 'revert_to_original', 'measure'],
  'work_update:reassign': ['action', 'task_id', 'assigned_to', 'assigned_to_group', 'cause', 'user_quote'],
  'work_update:list': ['action', 'filter', 'verbose'],
  'work_update:get': ['action', 'id', 'task_id', 'project_id', 'offset'],
  'work_update:activity': ['action', 'hours', 'verbose'],
  'work_note': ['task_id', 'notes'],
  'work_close_request:commitment': ['action', 'id', 'disposition', 'note'],
  'work_validate:decide': ['action', 'task_id', 'verdict', 'reason', 'user_quote'],
  'work_validate:open_proof': ['action', 'task_id', 'item'],
  'work_validate:retask': ['action', 'task_id', 'directive', 'target_status', 'user_quote'],
  'work_schedule:pause': ['action', 'task_id', 'resume_at'],
  'work_schedule:resume': ['action', 'task_id'],
};

/** Navigation arguments accepted without being read (never refused): sibling-call ids, `verbose`. */
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

/** The declared arguments of the call that its resolved operation does not read (in call order). */
export function unreadWorkArgs(name: string, args: Args, declared: ReadonlySet<string>): { op: WorkOp | null; unread: string[] } {
  const op = workOperation(name, args);
  if (!op || !args) return { op, unread: [] };
  const reads = new Set([...WORK_OP_READS[op], ...(WORK_OP_ACCEPTS[op] ?? [])]);
  const unread = Object.keys(args).filter((k) => !k.startsWith('__') && declared.has(k) && has(args, k) && !reads.has(k));
  return { op, unread };
}

/** The other work operations that read `arg`, as the model calls them. */
export function workOpsThatRead(op: WorkOp, arg: string): string[] {
  return WORK_OPS.filter((o) => o !== op && WORK_OP_READS[o].includes(arg)).map(workOpCallName);
}

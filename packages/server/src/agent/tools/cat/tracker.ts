// ════════════════════════════════════════════════════════════════════════════
// THE PROJECT TRACKER'S WORK VERBS (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// Twenty-three dispatch keys, and they are the reason this table is keyed on the
// DISPATCH KEY rather than the tool name. PHASE-2 T8V collapsed 24 public tool
// names into six `work_*` verbs, so `work_update` alone reaches SEVEN different
// bodies (`:status`, `:edit`, `:get`, `:list`, `:complete_step`,
// `:close_project`, `:reassign`) and `work_validate` five. A by-name map could
// not express that; `workOperation(name, args) ?? name` is what the switch keyed
// on and it is what this module's keys are.
//
// ── THE NINETEEN PER-OPERATION `checkRequired` SITES ARE ALL HERE, INTACT ──
// T3C folded 57 per-TOOL required-field arrays into one boundary at
// `executeTool` and DELIBERATELY PRESERVED nineteen per-OPERATION checks,
// because the work verbs' `input_schema.required` is `[]` — the wire carries a
// UNION of every operation's fields and requiredness is per operation, in code.
// A schema-compiled validator validates NOTHING for them, so deleting them
// would have deleted validation outright (RULING P5-R8's own reasoning). All
// nineteen moved with their handlers, unedited; `grep -c "checkRequired(" ` on
// this file is 19 and that is the same unit T3C measured.
//
// RELOCATION, NOT REWRITE. Every body is byte-faithful, including
// `work_open:task`'s scheduling normalisation, `work_close_request:commitment`'s
// delivery-record read, and every user-facing refusal string.
//
// `normalizeRepeatDaysOfWeek` + `REPEAT_DAY_NAME_MAP` moved WITH these handlers:
// re-derived at this HEAD, their only three call sites are `work_open:task`,
// `work_open:reminder` and `work_update:edit`, all of them here.
//
// ── FIVE LAZY LOADS DIED ──
// The five `../tracker/tools.js` loads (four destructures + one namespace) are
// not on §T0-PINS P8's sanctioned list, and `tracker/tools.ts` imports nothing
// from the toolbox, so not one broke a cycle. Converted; the unit suite is the
// arbiter under RULING P5-R9 and it stayed green.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../../db/connection.js';
import { turnContext } from '../../turn-context.js';
import { checkRequired, friendlyDbError } from '../../tool-helpers.js';
import { terminalDeliveryForTurn } from '../../v2/answered-edge.js';
import { taskScope } from '../../../work/tracker-view.js';
import { patchWork } from '../../../work/tracker-store.js';
import { openCommitment, resolveCommitment, dismissCommitment, findObligationByTypedId } from '../../../work/store.js';
import { recordRemediation } from '../../../work/poke-ladder.js';
import { resolveTaskId, formatResolveError } from '../../../tracker/schema.js';
import { WORK_EDITABLE_TASK_FIELDS } from '../../work-verb-schema.js';
import * as trackerMod from '../../../tracker/tools.js';
import {
  trackerCreateProject, trackerCreateTask, reminderCreate, trackerUpdateStatus,
  trackerAddNotes, trackerEditTask, trackerEditProject, trackerGetStatus,
  trackerListActive, trackerCompleteStep, trackerCloseProject,
  trackerPauseSchedule, trackerResumeSchedule,
  trackerRetask, trackerRequestOverride, trackerOverride, trackerRequestUserVerdict,
  trackerApplyUserVerdict, trackerApplyUserValidation, trackerResolveMissedRuns,
} from '../../../tracker/tools.js';
import type { ToolHandlerMap } from '../handler.js';

// v2.5.3, shared by work_open(kind="task") and work_update(action="edit"). Accepts an
// array of names ("mon", "wednesday"), an array of ints (0-6), or a CSV
// string and returns the canonical CSV-of-ints stored in the DB ("1,3").
// Returns null when the input is null (caller wants to clear), undefined
// when the field wasn't supplied, or a string when normalization succeeded.
// Returns the literal string '__INVALID__' if every entry was unparseable
//, callers translate that to a user-facing error.
const REPEAT_DAY_NAME_MAP: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};
function normalizeRepeatDaysOfWeek(rawDays: unknown): string | null | undefined {
  if (rawDays === undefined) return undefined;
  if (rawDays === null) return null;
  const raw: unknown[] = Array.isArray(rawDays)
    ? rawDays
    : typeof rawDays === 'string'
      ? rawDays.split(',')
      : [];
  if (Array.isArray(rawDays) && rawDays.length === 0) return null; // explicit clear
  const nums = new Set<number>();
  for (const item of raw) {
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 6) {
      nums.add(item);
    } else if (typeof item === 'string') {
      const trimmed = item.trim().toLowerCase();
      if (trimmed === '') continue;
      const asNum = parseInt(trimmed, 10);
      if (Number.isInteger(asNum) && asNum >= 0 && asNum <= 6) {
        nums.add(asNum);
      } else if (REPEAT_DAY_NAME_MAP[trimmed] !== undefined) {
        nums.add(REPEAT_DAY_NAME_MAP[trimmed]);
      }
    }
  }
  if (nums.size === 0) return '__INVALID__';
  return [...nums].sort((a, b) => a - b).join(',');
}

export const trackerHandlers: ToolHandlerMap = {
  async "work_open:project"({ agentId, args }) {
    let content = '';
    let isError = false;
    const projErr = checkRequired([
      { name: 'title', value: args.title, type: 'string' },
    ]);
    if (projErr) { content = projErr; isError = true; return { content, isError }; }
    const taskInputs = (args.tasks as Array<Record<string, unknown>> | undefined)?.map(t => ({
      title: t.title as string,
      description: t.description as string | undefined,
      assignedTo: (t.assigned_to ?? t.assignedTo) as string | undefined,
      priority: t.priority as 'high' | 'normal' | 'low' | undefined,
      stepNumber: (t.step_number ?? t.stepNumber) as number | undefined,
      dependsOn: (t.depends_on ?? t.dependsOn) as string[] | undefined,
      phase: t.phase as number | undefined,
    }));
    try {
      content = trackerCreateProject(agentId, {
        title: args.title as string,
        description: args.description as string | undefined,
        level: args.level as number,
        tasks: taskInputs,
        allow_duplicate: args.allow_duplicate as boolean | undefined,
      });
    } catch (err) {
      content = friendlyDbError(err, 'work_open(kind="project")');
    }
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_open:task"({ agentId, args }) {
    let content = '';
    let isError = false;
    const taskErr = checkRequired([
      { name: 'title', value: args.title, type: 'string' },
    ]);
    if (taskErr) { content = taskErr; isError = true; return { content, isError }; }

    // v2.5.2, normalize repeat_days_of_week from agent-friendly
    // formats (array of names, array of ints, or CSV string) into
    // the canonical CSV-of-ints stored in the DB. v2.5.3, shared
    // with work_update(action="edit") via normalizeRepeatDaysOfWeek().
    const normalizedDays = normalizeRepeatDaysOfWeek(args.repeat_days_of_week);
    if (normalizedDays === '__INVALID__') {
      content = 'Error: repeat_days_of_week contained no valid days. Accepted: sun/mon/tue/wed/thu/fri/sat or 0-6.';
      isError = true;
      return { content, isError };
    }
    const repeatDaysOfWeek: string | undefined = normalizedDays ?? undefined;
    if (args.repeat_unit === 'specific_days' && !repeatDaysOfWeek) {
      content = 'Error: repeat_unit="specific_days" requires repeat_days_of_week (e.g. ["mon","wed"]).';
      isError = true;
      return { content, isError };
    }

    // Recurring-schedule integrity gate. Pre-fix the engine would
    // accept partial schedules and write them straight to the row,
    // producing silent failures:
    //   - repeat_interval without repeat_unit → calculateNextRun
    //     treats the task as one-shot (fires once, then nothing).
    //   - repeat_unit without repeat_interval → same outcome.
    //   - repeat_unit set to a value not in the enum → next_run_at
    //     stays at scheduled_start, fires once, then dies.
    //   - any repeat_* without scheduled_start → the entire
    //     scheduling block in trackerCreateTask is skipped (no
    //     next_run_at written) and hasFutureSchedule still suppresses
    //     the assignment notification. Task created, never fires,
    //     assignee never told.
    // All three shapes match the symptom from the field report:
    // "agent set up a recurring task and it never fired."
    const VALID_REPEAT_UNITS = new Set([
      'minutes', 'hours', 'days', 'weeks', 'months', 'years', 'weekdays', 'specific_days',
    ]);
    const hasInterval = args.repeat_interval !== undefined && args.repeat_interval !== null;
    const hasUnit = args.repeat_unit !== undefined && args.repeat_unit !== null && args.repeat_unit !== '';
    // Order matters here. Catch invalid unit FIRST, otherwise an
    // agent passing repeat_unit="weekly" (the common wrong spelling)
    // hits the "missing interval" branch first and gets a misleading
    // hint telling it to add interval=1 to "every weekly". Validate
    // the unit value before checking pairing.
    if (hasUnit && !VALID_REPEAT_UNITS.has(args.repeat_unit as string)) {
      content =
        `Error: repeat_unit="${args.repeat_unit}" is not a valid unit. ` +
        `Valid values: minutes, hours, days, weeks, months, years, weekdays, specific_days. ` +
        `Common mistakes: "weekly" → repeat_interval=1, repeat_unit="weeks"; ` +
        `"daily" → repeat_interval=1, repeat_unit="days"; ` +
        `"every Mon/Wed/Fri" → repeat_unit="specific_days", repeat_days_of_week=["mon","wed","fri"].`;
      isError = true;
      return { content, isError };
    }
    if (hasInterval && !hasUnit) {
      content =
        `Error: repeat_interval was set without repeat_unit. The task would fire once and then never again. ` +
        `Add repeat_unit (one of: minutes, hours, days, weeks, months, years, weekdays, specific_days). ` +
        `Example for a daily task: repeat_interval=1, repeat_unit="days".`;
      isError = true;
      return { content, isError };
    }
    if (hasUnit && !hasInterval && args.repeat_unit !== 'specific_days') {
      // specific_days legitimately ignores interval (handled below by
      // the defaulting at trackerCreateTask). Every other unit needs
      // an explicit number.
      content =
        `Error: repeat_unit="${args.repeat_unit}" was set without repeat_interval. ` +
        `Add repeat_interval (e.g. repeat_interval=1 for "every ${(args.repeat_unit as string).replace(/s$/, '')}"). ` +
        `Or, if you want a fixed set of weekdays, use repeat_unit="specific_days" with repeat_days_of_week=["mon","wed",...].`;
      isError = true;
      return { content, isError };
    }
    if ((hasInterval || hasUnit) && !args.scheduled_start) {
      content =
        `Error: a recurring task needs a scheduled_start, the time of the FIRST run. ` +
        `Without it the scheduler has no anchor, no next_run_at gets written, and the task will never fire. ` +
        `Call get_current_time, ask the user when the first run should happen (or pick the next sensible slot, e.g. "tomorrow at 6 AM"), and re-call this tool with scheduled_start set to the resolved ISO 8601 timestamp.`;
      isError = true;
      return { content, isError };
    }

    try {
      content = trackerCreateTask(agentId, {
        projectId: args.project_id as string | undefined,
        title: args.title as string,
        description: args.description as string | undefined,
        assignedTo: args.assigned_to as string | undefined,
        priority: args.priority as string | undefined,
        stepNumber: args.step_number as number | undefined,
        dependsOn: args.depends_on as string[] | undefined,
        phase: args.phase as number | undefined,
        // Schedule parameters
        scheduled_start: args.scheduled_start as string | undefined,
        // v2.5.2, interval is meaningless for specific_days but the
        // engine and DB row should still carry 1 so downstream callers
        // (UI form, formatter) can detect a recurring schedule.
        repeat_interval: (args.repeat_interval as number | undefined)
          ?? (args.repeat_unit === 'specific_days' ? 1 : undefined),
        repeat_unit: args.repeat_unit as string | undefined,
        repeat_end_type: args.repeat_end_type as string | undefined,
        repeat_end_value: args.repeat_end_value as string | undefined,
        repeat_days_of_week: repeatDaysOfWeek,
        // PHASE-6 T0A: declared on work_open, read by trackerCreateTask, dropped here —
        // so a fixed wall-clock cadence was unreachable at creation and every schedule
        // drifted by its own run duration. Held by tracker-door-census.test.ts.
        anchor_time: args.anchor_time as string | undefined,
        // PHASE-6 T0C-W (seed 1): the wall-clock pair. `trackerCreateTask` has converted
        // these into `scheduled_start` since RC-18 so the model never does UTC math; the
        // door dropped both, leaving the conversion HTTP-only while this tool's own
        // success echo told the model to use it.
        local_time: args.local_time as string | undefined,
        local_timezone: args.local_timezone as string | undefined,
        // Group assignment
        assigned_to_group: args.assigned_to_group as string | undefined,
        // Override for the near-duplicate guard
        allow_duplicate: args.allow_duplicate as boolean | undefined,
        // Goal pass-through (B.1)
        goal: args.goal as string | undefined,
      });
    } catch (err) {
      content = friendlyDbError(err, 'work_open(kind="task")');
    }
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_open:reminder"({ agentId, args }) {
    let content = '';
    let isError = false;
    const remErr = checkRequired([
      { name: 'what', value: args.what, type: 'string' },
    ]);
    if (remErr) { content = remErr; isError = true; return { content, isError }; }

    // Mirror the task path's day-of-week normalization for the
    // recurring reminder case so callers can pass ["mon","wed"] and
    // get the canonical CSV-of-ints the scheduler expects.
    const normalizedDays = normalizeRepeatDaysOfWeek(args.repeat_days_of_week);
    if (normalizedDays === '__INVALID__') {
      content = 'Error: repeat_days_of_week contained no valid days. Accepted: sun/mon/tue/wed/thu/fri/sat or 0-6.';
      isError = true;
      return { content, isError };
    }
    const repeatDaysOfWeek: string | undefined = normalizedDays ?? undefined;
    if (args.repeat_unit === 'specific_days' && !repeatDaysOfWeek) {
      content = 'Error: repeat_unit="specific_days" requires repeat_days_of_week (e.g. ["mon","wed"]).';
      isError = true;
      return { content, isError };
    }

    // Same recurring-schedule integrity gate as kind="task".
    // Reminders go through the same scheduler, so a partial config
    // produces the same silent never-fires failure mode here.
    const VALID_REMINDER_REPEAT_UNITS = new Set([
      'minutes', 'hours', 'days', 'weeks', 'months', 'years', 'weekdays', 'specific_days',
    ]);
    const remHasInterval = args.repeat_interval !== undefined && args.repeat_interval !== null;
    const remHasUnit = args.repeat_unit !== undefined && args.repeat_unit !== null && args.repeat_unit !== '';
    // Same ordering rule as kind="task": catch invalid unit
    // first so a misspelled value ("weekly") produces a corrective
    // hint instead of a misleading "missing interval" message.
    if (remHasUnit && !VALID_REMINDER_REPEAT_UNITS.has(args.repeat_unit as string)) {
      content =
        `Error: repeat_unit="${args.repeat_unit}" is not a valid unit. ` +
        `Valid values: minutes, hours, days, weeks, months, years, weekdays, specific_days. ` +
        `Common mistakes: "weekly" → repeat_interval=1, repeat_unit="weeks"; ` +
        `"daily" → repeat_interval=1, repeat_unit="days".`;
      isError = true;
      return { content, isError };
    }
    if (remHasInterval && !remHasUnit) {
      content =
        `Error: repeat_interval was set without repeat_unit. The reminder would fire once and then never again. ` +
        `Add repeat_unit (one of: minutes, hours, days, weeks, months, years, weekdays, specific_days). ` +
        `Example for a daily reminder: repeat_interval=1, repeat_unit="days".`;
      isError = true;
      return { content, isError };
    }
    if (remHasUnit && !remHasInterval && args.repeat_unit !== 'specific_days') {
      content =
        `Error: repeat_unit="${args.repeat_unit}" was set without repeat_interval. ` +
        `Add repeat_interval (e.g. repeat_interval=1 for "every ${(args.repeat_unit as string).replace(/s$/, '')}"). ` +
        `Or, for a fixed set of weekdays, use repeat_unit="specific_days" with repeat_days_of_week=["mon","wed",...].`;
      isError = true;
      return { content, isError };
    }
    if ((remHasInterval || remHasUnit) && !args.when) {
      content =
        `Error: a recurring reminder needs \`when\`, the time of the FIRST fire. ` +
        `Without it the scheduler has no anchor. Ask the user when the first reminder should fire and re-call with \`when\` set to the resolved ISO 8601 timestamp.`;
      isError = true;
      return { content, isError };
    }

    try {
      content = reminderCreate(agentId, {
        what: args.what,
        when: args.when,
        repeat_interval: (args.repeat_interval as number | undefined)
          ?? (args.repeat_unit === 'specific_days' ? 1 : undefined),
        repeat_unit: args.repeat_unit,
        repeat_end_type: args.repeat_end_type,
        repeat_end_value: args.repeat_end_value,
        repeat_days_of_week: repeatDaysOfWeek,
        anchor_time: args.anchor_time,
        // PHASE-6 T0C-W (seed 1): `reminderCreate` accepts a wall clock as an alternative
        // to `when` and hands it to trackerCreateTask; the door dropped it, so the
        // ASK_USER text that offered it named a field the model could not reach.
        local_time: args.local_time,
        local_timezone: args.local_timezone,
      });
    } catch (err) {
      content = friendlyDbError(err, 'work_open(kind="reminder")');
    }
    // ASK_USER is an instruction to the agent, not an error.
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_update:status"({ agentId, args }) {
    let content = '';
    let isError = false;
    const updErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
      { name: 'status', value: args.status, type: 'string' },
    ]);
    if (updErr) { content = updErr; isError = true; return { content, isError }; }
    const updateArgs: Record<string, unknown> = {
      taskId: args.task_id as string,
      status: args.status as string,
    };
    if (args.notes) updateArgs.notes = args.notes;
    if (args.resume_at) updateArgs.resume_at = args.resume_at;
    if (args.complete_all_runs) updateArgs.complete_all_runs = args.complete_all_runs;
    // Phase B.1: result + evidence forwarded for the complete hard gate.
    if (args.result !== undefined) updateArgs.result = args.result;
    if (args.evidence !== undefined) updateArgs.evidence = args.evidence;
    // assigned_to / priority forwards (these were missing before, even
    // though trackerUpdateStatus accepts them)
    if (args.assigned_to !== undefined) updateArgs.assignedTo = args.assigned_to;
    if (args.priority !== undefined) updateArgs.priority = args.priority;
    content = trackerUpdateStatus(agentId, updateArgs);
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_note"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = trackerAddNotes(agentId, {
      taskId: args.task_id as string,
      notes: args.notes as string,
    });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_update:edit"({ agentId, args }) {
    let content = '';
    let isError = false;
    // PHASE-2 T8V: one `edit` discriminator covers both nouns. A project_id
    // with no task_id edits the PROJECT (the §7.2 absorb-don't-refuse rule);
    // this is the merged body of the retired project-edit verb, unchanged.
    if (typeof args.project_id === 'string' && args.project_id.trim() && !args.task_id) {
      content = trackerEditProject(agentId, {
        project_id: args.project_id as string,
        title: args.title as string | undefined,
        description: args.description as string | null | undefined,
      });
      isError = content.startsWith('Error');
      return { content, isError };
    }
    const editErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
    ]);
    if (editErr) { content = editErr; isError = true; return { content, isError }; }
    // Forward every field the schema lists. trackerEditTask reads either
    // snake_case or camelCase, so passing snake_case through works.
    // PHASE-6 T0A: the list is `WORK_EDITABLE_TASK_FIELDS`, the same declaration the
    // refusal's `Editable:` line renders from — see its header for the defect that
    // cost. A hand-written copy here is what dropped `anchor_time`.
    const editArgs: Record<string, unknown> = {
      taskId: args.task_id as string,
    };
    for (const k of WORK_EDITABLE_TASK_FIELDS) {
      if (args[k] !== undefined) editArgs[k] = args[k];
    }
    // PHASE-6 T0C-W — three seeds that are NOT editable fields, so they must stay OUT of
    // `WORK_EDITABLE_TASK_FIELDS` (which renders the `Editable:` refusal byte-for-byte,
    // pinned at 417 chars by T0A). `local_time`/`local_timezone` are an alternative
    // SPELLING of `scheduled_start` — `trackerEditTask` converts them before it reads any
    // editable field, so one of them satisfies the "at least one editable field" check by
    // itself, which is precisely the refusal a wall-clock-only edit used to get.
    // `revert_to_original` is an ACKNOWLEDGEMENT: the guard is unchanged and still refuses
    // without it; what changed is that its named escape hatch is reachable through here.
    for (const k of ['local_time', 'local_timezone', 'revert_to_original'] as const) {
      if (args[k] !== undefined) editArgs[k] = args[k];
    }
    // v2.5.3, normalize and forward repeat_days_of_week so agents can
    // change the day-of-week list on an existing recurring task without
    // having to delete and recreate it. Mirrors the create-side
    // validation: specific_days requires at least one valid day.
    if (args.repeat_days_of_week !== undefined) {
      const normalizedDays = normalizeRepeatDaysOfWeek(args.repeat_days_of_week);
      if (normalizedDays === '__INVALID__') {
        content = 'Error: repeat_days_of_week contained no valid days. Accepted: sun/mon/tue/wed/thu/fri/sat or 0-6, or [] to clear.';
        isError = true;
        return { content, isError };
      }
      editArgs.repeat_days_of_week = normalizedDays; // string | null
    }
    // If the agent is switching to specific_days, make sure the list is
    // present (either supplied this call, or already on the row).
    if (args.repeat_unit === 'specific_days') {
      if (editArgs.repeat_days_of_week === undefined || editArgs.repeat_days_of_week === null) {
        // Permit it only if days were also supplied (already handled
        // above) or if the row already carries days.
        try {
          const row = getDb().prepare('SELECT repeat_days_of_week FROM work WHERE id = ?').get(args.task_id) as { repeat_days_of_week: string | null } | undefined;
          const existingDays = row?.repeat_days_of_week ?? null;
          if (!editArgs.repeat_days_of_week && !existingDays) {
            content = 'Error: switching repeat_unit to "specific_days" requires repeat_days_of_week (e.g. ["mon","wed"]).';
            isError = true;
            return { content, isError };
          }
        } catch { /* fall through; tracker layer will surface row issues */ }
      }
      // Mirror create: specific_days needs interval=1 so downstream
      // formatters detect a recurring schedule.
      if (editArgs.repeat_interval === undefined) {
        editArgs.repeat_interval = 1;
      }
    }
    content = trackerEditTask(agentId, editArgs);
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_update:get"({ agentId, args }) {
    let content = '';
    let isError = false;
    // F6 (harness finding): sibling tools take task_id / project_id, so weak
    // models naturally pass those here too. Accept them as aliases for id
    // instead of warning-and-ignoring (which left the call id-less).
    if (typeof args.id !== 'string') {
      const alias = args.task_id ?? args.project_id;
      if (typeof alias === 'string') args.id = alias;
    }
    const getErr = checkRequired([
      { name: 'id', value: args.id, type: 'string' },
    ]);
    if (getErr) { content = getErr; isError = true; return { content, isError }; }
    // The tool takes a single 'id' param, try as task first, then project
    const lookupId = args.id as string;
    content = trackerGetStatus(agentId, { taskId: lookupId, projectId: lookupId });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_update:list"({ agentId, args }) {
    let content = '';
    let isError = false;
    const listFilter = args.filter as string | undefined;
    const verbose = args.verbose as boolean | undefined;
    if (listFilter === 'mine') {
      content = trackerListActive(agentId, { scope: 'tasks', assignedTo: agentId, verbose });
    } else if (listFilter === 'blocked') {
      content = trackerListActive(agentId, { scope: 'tasks', status: 'blocked', verbose });
    } else if (listFilter === 'overdue') {
      // PHASE-6 T0C-W: the fourth declared enum value finally has a branch. It used to
      // fall to the `else` and return the UNFILTERED list — the worst kind of unimplemented,
      // because the answer looked like an answer.
      content = trackerListActive(agentId, { scope: 'tasks', filter: 'overdue', verbose });
    } else {
      content = trackerListActive(agentId, { scope: 'all', verbose });
    }
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_open:commitment"({ agentId, args }) {
    let content = '';
    let isError = false;
    const coErr = checkRequired([{ name: 'description', value: args.description, type: 'string' }]);
    if (coErr) { content = coErr; isError = true; return { content, isError }; }
    const coTurn = turnContext(agentId)?.turnNumber ?? null;
    if (coTurn === null) {
      // Origin is required on the spine, and a commitment's origin is the turn that made
      // it. Refusing here is honest; minting a row with a fabricated turn is not.
      content = 'Error: work_open(kind="commitment") can only be called inside a turn.';
      isError = true;
      return { content, isError };
    }
    const coRoot = turnContext(agentId)?.root ?? null;
    const coId = openCommitment({
      agentId,
      description: args.description as string,
      conversationId: coRoot?.conversationId ?? null,
      turnNumber: coTurn,
      sourceMessageId: coRoot?.id ?? null,
    });
    if (!coId) {
      content = 'Error: pass the promise you made as `description`.';
      isError = true;
      return { content, isError };
    }
    content = `[OK] Recorded: ${(args.description as string).trim()} — id ${coId}. It stays open until you deliver it or drop it.`;
    return { content, isError };
  },

  async "work_close_request:commitment"({ agentId, args }) {
    let content = '';
    let isError = false;
    const crErr = checkRequired([
      { name: 'id', value: args.id, type: 'string' },
      { name: 'disposition', value: args.disposition, type: 'string' },
    ]);
    if (crErr) { content = crErr; isError = true; return { content, isError }; }
    const crRow = findObligationByTypedId(agentId, args.id as string);
    if (!crRow) {
      // The refusal is steerable, and it names the surface the id comes from — the
      // recorded baseline red is a model writing to an id from a previous session.
      content = `Error: no open work matches "${String(args.id)}". Use an id exactly as shown in [brackets] in the OPEN WORK block; it may already be closed.`;
      isError = true;
      return { content, isError };
    }
    // ── SWEEP-A TB1: THE ASK BRANCH IS NARROWED OUT (`DESIGN-2BUGS/DESIGN.md` §1b, row 4) ──
    // This tool is the agent's PROMISE LEDGER: commitments IT makes, closed by IT. It reaches
    // asks because asks and commitments deliberately share one obligation frame, and on
    // 2026-08-05 it was measured closing an owner's ask straight out of the OPEN WORK block
    // (probe B3: `open -> done`, "commitment kept", pointing at another ask's delivery). An
    // owner's ask is not the model's to close — the record that answers it closes it.
    // The refusal is steerable and names what actually decides, because a model that cannot
    // tell why it was refused invents a second way to try.
    if (crRow.kind === 'ask') {
      content = `Not closed: "${crRow.title ?? crRow.id}" is something the owner asked YOU for, not a `
        + 'promise you made. It closes itself the moment an answer is delivered for it — the '
        + 'delivery record is what marks it done, at send time and again when the turn ends. '
        + 'Answer it and it will tick off on its own; there is nothing to call here.';
      isError = true;
      return { content, isError };
    }
    const crNote = (args.note as string | undefined)?.trim() || null;
    if (String(args.disposition) === 'dropped') {
      const dr = dismissCommitment(crRow.id, {
        agentId, reason: crNote ?? 'no longer owed',
      });
      if (dr.kind === 'applied') content = `[OK] Dropped: ${crRow.title ?? crRow.id}.`;
      else { content = `Error: could not drop ${crRow.id} (${dr.kind}).`; isError = true; }
      return { content, isError };
    }
    // 'kept' — and a promise is kept by DELIVERING it. The delivery is resolved from this
    // turn's own transport receipts rather than taken from the model, so there is no
    // argument it can pass that would make an undelivered promise look kept.
    const crTurn = turnContext(agentId)?.turnNumber ?? null;
    const crDelivery = terminalDeliveryForTurn(agentId, crTurn, crRow.conversationId);
    const rr = resolveCommitment(crRow.id, {
      agentId, resultDeliveryId: crDelivery, note: crNote,
    });
    if (rr.kind === 'applied') {
      content = `[OK] Closed: ${crRow.title ?? crRow.id}.`;
    } else if (rr.kind === 'refused' && rr.reason === 'done-requires-delivery') {
      content = `Not closed: nothing was delivered for "${crRow.title ?? crRow.id}" on this turn, so it is still owed. Send it first, then call this again — or use disposition "dropped" if it is no longer owed.`;
      isError = true;
    } else {
      content = `Error: could not close ${crRow.id} (${rr.kind}).`;
      isError = true;
    }
    return { content, isError };
  },

  async "work_update:complete_step"({ agentId, args }) {
    let content = '';
    let isError = false;
    // task_id is intentionally NOT hard-required here: a single-task agent
    // (the floor model working its one assigned step) routinely omits it.
    // trackerCompleteStep resolves the obvious task when exactly one is in
    // progress for this agent, and rejects-with-guidance otherwise, so we
    // pass whatever the model sent (possibly undefined) straight through.
    content = trackerCompleteStep(agentId, {
      taskId: (args.task_id ?? args.taskId) as string | undefined,
      notes: args.notes as string | undefined,
    });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_validate:validate"({ agentId, args }) {
    let content = '';
    let isError = false;
    const vkind = args.kind as 'pause' | 'complete' | 'blocked' | undefined;
    if (!vkind || !['pause', 'complete', 'blocked'].includes(vkind)) {
      content = 'Error: work_validate(action="validate") requires kind to be one of: pause, complete, blocked.';
      isError = true;
      return { content, isError };
    }
    const tvErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
      { name: 'valid', value: args.valid, type: 'boolean' },
    ]);
    if (tvErr) { content = tvErr; isError = true; return { content, isError }; }
    const vp = {
      task_id: args.task_id as string,
      valid: args.valid as boolean,
      reject_reason: args.reject_reason as string | undefined,
      target_status: args.target_status as string | undefined,
    };
    if (vkind === 'pause') content = await trackerMod.trackerValidatePause(agentId, vp);
    else if (vkind === 'complete') content = await trackerMod.trackerValidateComplete(agentId, vp);
    else content = await trackerMod.trackerValidateBlocked(agentId, vp);
    return { content, isError };
  },

  async "work_validate:retask"({ agentId, args }) {
    let content = '';
    let isError = false;
    const trErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
      { name: 'directive', value: args.directive, type: 'string' },
    ]);
    if (trErr) { content = trErr; isError = true; return { content, isError }; }
    content = await trackerRetask(agentId, {
      task_id: args.task_id as string,
      directive: args.directive as string,
      target_status: args.target_status as string | undefined,
      allow_regenerate: args.allow_regenerate as boolean | undefined,
    });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_close_request:override"({ agentId, args }) {
    let content = '';
    let isError = false;
    const troErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
      { name: 'requested_status', value: args.requested_status, type: 'string' },
      { name: 'justification', value: args.justification, type: 'string' },
    ]);
    if (troErr) { content = troErr; isError = true; return { content, isError }; }
    content = trackerRequestOverride(agentId, {
      task_id: args.task_id as string,
      requested_status: args.requested_status as string,
      justification: args.justification as string,
    });
    return { content, isError };
  },

  async "work_validate:override"({ agentId, args }) {
    let content = '';
    let isError = false;
    const toErr = checkRequired([
      { name: 'override_request_id', value: args.override_request_id, type: 'string' },
      { name: 'approve', value: args.approve, type: 'boolean' },
      { name: 'reason', value: args.reason, type: 'string' },
    ]);
    if (toErr) { content = toErr; isError = true; return { content, isError }; }
    content = await trackerOverride(agentId, {
      override_request_id: args.override_request_id as string,
      approve: args.approve as boolean,
      reason: args.reason as string,
    });
    return { content, isError };
  },

  async "work_close_request:user_verdict"({ agentId, args }) {
    let content = '';
    let isError = false;
    const truvErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
      { name: 'status_requested', value: args.status_requested, type: 'string' },
      { name: 'agent_summary', value: args.agent_summary, type: 'string' },
      { name: 'pm_rejection_summary', value: args.pm_rejection_summary, type: 'string' },
    ]);
    if (truvErr) { content = truvErr; isError = true; return { content, isError }; }
    content = await trackerRequestUserVerdict(agentId, {
      task_id: args.task_id as string,
      status_requested: args.status_requested as string,
      agent_summary: args.agent_summary as string,
      pm_rejection_summary: args.pm_rejection_summary as string,
    });
    return { content, isError };
  },

  async "work_validate:apply_user_verdict"({ agentId, args }) {
    let content = '';
    let isError = false;
    const tauvErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
      { name: 'status', value: args.status, type: 'string' },
      { name: 'user_quote', value: args.user_quote, type: 'string' },
    ]);
    if (tauvErr) { content = tauvErr; isError = true; return { content, isError }; }
    content = await trackerApplyUserVerdict(agentId, {
      task_id: args.task_id as string,
      status: args.status as string,
      user_quote: args.user_quote as string,
    });
    return { content, isError };
  },

  async "work_validate:apply_user_validation"({ agentId, args }) {
    let content = '';
    let isError = false;
    const tauvErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
      { name: 'validated', value: args.validated, type: 'boolean' },
      { name: 'user_quote', value: args.user_quote, type: 'string' },
    ]);
    if (tauvErr) { content = tauvErr; isError = true; return { content, isError }; }
    content = await trackerApplyUserValidation(agentId, {
      task_id: args.task_id as string,
      validated: args.validated as boolean,
      user_quote: args.user_quote as string,
      feedback: args.feedback as string | undefined,
    });
    return { content, isError };
  },

  async "work_update:close_project"({ agentId, args }) {
    let content = '';
    let isError = false;
    const tcpErr = checkRequired([
      { name: 'project_id', value: args.project_id, type: 'string' },
      { name: 'reason', value: args.reason, type: 'string' },
    ]);
    if (tcpErr) { content = tcpErr; isError = true; return { content, isError }; }
    content = trackerCloseProject(agentId, {
      project_id: args.project_id as string,
      status: args.status as string | undefined,
      reason: args.reason as string,
    });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_schedule:pause"({ agentId, args }) {
    let content = '';
    let isError = false;
    const tpsErr = checkRequired([{ name: 'task_id', value: args.task_id, type: 'string' }]);
    if (tpsErr) { content = tpsErr; isError = true; return { content, isError }; }
    content = trackerPauseSchedule(agentId, { taskId: args.task_id as string, mark_complete: args.mark_complete as boolean | undefined });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_schedule:resume"({ agentId, args }) {
    let content = '';
    let isError = false;
    const trsErr = checkRequired([{ name: 'task_id', value: args.task_id, type: 'string' }]);
    if (trsErr) { content = trsErr; isError = true; return { content, isError }; }
    content = trackerResumeSchedule(agentId, { taskId: args.task_id as string });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_schedule:resolve_missed"({ agentId, args }) {
    let content = '';
    let isError = false;
    // PHASE-2 T8V: the discriminator collision. The retired verb's own
    // parameter was called `action` and one of its values was "pause", which
    // is also a work_schedule action — so the missed-run choice moved to
    // `resolution` and is mapped back onto the handler's `action` here. A
    // model that still sends the old shape (`action:"run_now"|"skip"`) is
    // absorbed: workOperation only reads pause/resume/resolve_missed, so an
    // unrecognised value falls through to this case and is used as-is.
    const rawResolution = args.resolution ?? (
      args.action === 'run_now' || args.action === 'skip' ? args.action : undefined
    );
    const trmrErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
      { name: 'resolution', value: rawResolution, type: 'string' },
    ]);
    if (trmrErr) { content = trmrErr; isError = true; return { content, isError }; }
    content = trackerResolveMissedRuns(agentId, { ...args, action: rawResolution });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "work_update:reassign"({ agentId, args }) {
    let content = '';
    let isError = false;
    const rawReassignTaskId = args.task_id as string;
    if (!rawReassignTaskId) { content = 'Error: task_id is required'; isError = true; return { content, isError }; }

    // Resolve task id prefix to the full UUID so this tool accepts
    // the 8-char ids emitted by work_update(action="list"), same pattern as
    // every other work operation.
    const reassignResolved = resolveTaskId(rawReassignTaskId);
    if (!reassignResolved.ok) {
      content = formatResolveError('task', rawReassignTaskId, reassignResolved);
      isError = true;
      return { content, isError };
    }
    const reassignTaskId = reassignResolved.id;

    const reassignDb = getDb();
    const reassignTask = reassignDb.prepare(`SELECT w.id AS id, w.title AS title FROM work w WHERE ${taskScope('w')} AND w.id = ?`).get(reassignTaskId) as { id: string; title: string } | undefined;
    if (!reassignTask) { content = `Error: Task ${reassignTaskId} was deleted before reassignment could be applied.`; isError = true; return { content, isError }; }
    let newAgent = args.assigned_to as string | undefined;
    const newGroup = args.assigned_to_group as string | undefined;
    if (newAgent) {
      // Resolve name → UUID. Match by id OR name (case-insensitive) so
      // sensei ids like "primary" and capitalised names both work. Friendlier
      // error than the bare FK violation.
      if (!newAgent.match(/^[0-9a-f]{8}-[0-9a-f]{4}-/)) {
        const lookup = reassignDb.prepare(
          `SELECT id FROM agents
             WHERE (id = ? OR name = ? COLLATE NOCASE)
               AND status != 'terminated'
             ORDER BY created_at DESC LIMIT 1`
        ).get(newAgent, newAgent) as { id: string } | undefined;
        if (!lookup) {
          content = `Agent "${newAgent}" doesn't exist yet. Spawn them first with spawn_agent, then reassign. Or pass an existing agent's UUID directly.`;
          isError = true;
          return { content, isError };
        }
        newAgent = lookup.id;
      }
      // PHASE-6 T0D — the two sites in this file get a BRANCH rather than the
      // recorder, because a model is waiting on the answer: the row was resolved
      // and re-read above, so a refusal here means it was deleted in between, and
      // the old code went on to say "reassigned to X" about a row that is not
      // there. Telling a model a write landed when it did not is the stale-id
      // class doing its damage one layer up from the door.
      const moved = patchWork(reassignTaskId, { agent_id: newAgent, assignee_agent: newAgent, assigned_to_group: null });
      if (moved.kind !== 'applied') { content = `Error: ${moved.detail}`; isError = true; return { content, isError }; }
      // Resolve name for response
      const agentName = (reassignDb.prepare('SELECT name FROM agents WHERE id = ?').get(newAgent) as { name: string } | undefined)?.name ?? newAgent;
      content = `Task "${reassignTask.title}" reassigned to ${agentName}`;
    } else if (newGroup) {
      const moved = patchWork(reassignTaskId, { assignee_agent: null, assigned_to_group: newGroup });
      if (moved.kind !== 'applied') { content = `Error: ${moved.detail}`; isError = true; return { content, isError }; }
      const groupName = (reassignDb.prepare('SELECT name FROM agent_groups WHERE id = ?').get(newGroup) as { name: string } | undefined)?.name ?? newGroup;
      content = `Task "${reassignTask.title}" reassigned to group "${groupName}", PM will pick an agent at run time`;
    } else {
      content = 'Error: Provide either assigned_to (agent ID) or assigned_to_group (group ID)';
      isError = true;
    }
    // Reassign is a remediation: the task is moving to a new assignee (or
    // back to a group for the PM to pick), which starts a fresh escalation
    // cycle. Re-arm the ladder so it climbs from nudge(1) against the new
    // owner instead of staying stuck at the old assignee's rung. Marking at
    // a remediation event (never mid-cycle) keeps the cross-restart poke
    // dedup intact. Skip on the error path so a rejected reassign doesn't
    // re-arm a live escalation cycle.
    if (!isError) recordRemediation(reassignTaskId, agentId, 'reassigned to a new owner');
    return { content, isError };
  },

};

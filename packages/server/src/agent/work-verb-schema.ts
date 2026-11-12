// The 17 property schemas `work_open` and `work_update` share, declared once; emitted bytes must not change.
// Only `work_open` constrains `priority`: an enum on `work_update` would refuse values it accepts now.

/** The values `work_open` constrains `priority` to. */
import { MEASURE_TOOLS } from '../work/measure.js';   // the measure's tool list is the registry's own (no second copy)

export const WORK_PRIORITY_ENUM = ['high', 'normal', 'low'] as const;

/** The repeat units both verbs accept. Declared once; identical bytes in both. */
export const WORK_REPEAT_UNIT_ENUM = [
  'minutes', 'hours', 'days', 'weekdays', 'specific_days', 'weeks', 'months', 'years',
] as const;

/** How a recurrence ends. Declared once; identical bytes in both. */
export const WORK_REPEAT_END_TYPE_ENUM = ['never', 'after_count', 'on_date'] as const;

// Declared once: `tracker/tools.ts` renders the edit refusal from it and `agent/tools/cat/tracker.ts`
// forwards from it, so no field is advertised without being forwarded. Order is the refusal's order.
export const WORK_EDITABLE_TASK_FIELDS = [
  'title', 'description', 'goal', 'depends_on', 'step_number', 'phase',
  'scheduled_start', 'repeat_interval', 'repeat_unit',
  'repeat_end_type', 'repeat_end_value', 'repeat_days_of_week', 'anchor_time',
  'priority', 'notes',
] as const;

type PropSchema = Record<string, unknown>;

/** Every field of each shared schema except its description. Key order is load-bearing (`type`, then
 *  `enum`/`items`, then `description`) because the tools array heads the cached prefix. */
export const WORK_SHARED_PROPERTIES: Record<string, PropSchema> = {
  title: { type: 'string' },
  description: { type: 'string' },
  project_id: { type: 'string' },
  assigned_to: { type: 'string' },
  assigned_to_group: { type: 'string' },
  priority: { type: 'string' },
  step_number: { type: 'number' },
  depends_on: { type: 'array', items: { type: 'string' } },
  phase: { type: 'number' },
  goal: { type: 'string' },
  scheduled_start: { type: 'string' },
  repeat_interval: { type: 'number' },
  repeat_unit: { type: 'string', enum: WORK_REPEAT_UNIT_ENUM as unknown as string[] },
  repeat_days_of_week: { type: 'array', items: { type: 'string' } },
  repeat_end_type: { type: 'string', enum: WORK_REPEAT_END_TYPE_ENUM as unknown as string[] },
  repeat_end_value: { type: 'string' },
  anchor_time: { type: 'string' },
};

/** One shared property with this verb's description; `extra` goes before it to keep key order. */
export function workProp(name: keyof typeof WORK_SHARED_PROPERTIES | string, description: string, extra?: PropSchema): PropSchema {
  const shared = WORK_SHARED_PROPERTIES[name as string];
  if (!shared) throw new Error(`work verb property not declared: ${String(name)}`);
  return { ...shared, ...(extra ?? {}), description };
}

// Fields both verbs describe alike, said once: `work_open` emits `canonical`; `work_update`'s `onUpdate`
// holds only its action routing, edit-side clauses and a pointer, since each tool serialises its own schema.

export const WORK_FIELD_TEXT: Record<string, { canonical: string; onUpdate: string }> = {
  assigned_to_group: {
    canonical: 'Assign to a group instead of a specific agent. The PM picks an available agent at run time.',
    onUpdate: 'action="reassign": group ID to assign to (see work_open).',
  },
  scheduled_start: {
    canonical: 'When to run this task. Use ISO 8601 UTC format like "2026-03-20T22:35:00Z". Call get_current_time first to get the current time, then calculate your target time. If omitted, task runs immediately.',
    onUpdate: 'action="edit": new scheduled start (see work_open). Pass null or empty string to clear and run immediately.',
  },
  repeat_interval: {
    canonical: 'How often to repeat. e.g., 2 means every 2 of the repeat_unit. Requires repeat_unit.',
    onUpdate: 'action="edit": repeat interval value (see work_open).',
  },
  repeat_unit: {
    canonical: 'Unit for repeat interval. "weekdays" = Mon–Fri only (skips weekends). "specific_days" = an explicit set of weekdays you provide via repeat_days_of_week (e.g. "every Monday and Wednesday" or "every weekday except Friday"). For specific_days, repeat_interval is ignored, the task fires on each listed day every week.',
    onUpdate: 'action="edit": repeat unit (see work_open for what each unit means).',
  },
  repeat_days_of_week: {
    canonical: 'Required when repeat_unit="specific_days". List of weekday names: ["mon","wed"] for Mondays and Wednesdays, ["mon","tue","wed","thu"] for weekdays except Friday. Accepted names: sun/mon/tue/wed/thu/fri/sat (case-insensitive). Integers 0-6 (0=Sun..6=Sat) also accepted.',
    onUpdate: 'action="edit": the weekday list (same format as work_open). Pass [] to clear.',
  },
  repeat_end_value: {
    canonical: 'For after_count: the number of runs (e.g., "5"). For on_date: an ISO8601 date (e.g., "2026-04-01"). Required when repeat_end_type is not "never".',
    onUpdate: 'action="edit": value for repeat_end_type (see work_open).',
  },
  anchor_time: {
    canonical: 'For recurring work: ISO 8601 timestamp that anchors all future runs (only the time-of-day matters, date components reflect when the anchor was set). DEFAULTS to scheduled_start (or `when` for a reminder); pass explicitly only if you want a different wall-clock time. Use this when it should ALWAYS fire at a specific time-of-day regardless of how long each run takes, e.g. "every Monday at 06:00", not "every Monday whenever the previous run happened to finish." Without this, a 5-minute completion drifts the schedule by 5 minutes every cycle.',
    onUpdate: 'action="edit": the anchor timestamp (see work_open); use it to change WHEN a recurring task fires without recreating it, e.g. 06:00 instead of 06:05. Pass null or empty string to clear.',
  },
};

// One `measure` object for every verb that declares it; engine side in `agent/tools/cat/measure-door.ts`.

export const WORK_MEASURE_PROP: PropSchema = {
  type: 'object',
  description: 'For a task over a SET of items (mailbox messages, or files in a folder): the read the engine can re-run to list what is STILL to do, so progress is counted for you and the task cannot be closed with items left. {tool, args, unit}. Mail: tool="gmail_search" or "outlook_search" (your own mailbox), "user_gmail_search" or "user_outlook_search" (the user\'s), with args.query (optionally args.account) and unit="messages". Files: tool="file_list" with args.path (the folder) and args.pattern (the files still to do there, e.g. "*.pdf"; "**" reaches into subfolders) and unit="files". Write it so it SHRINKS as you work (e.g. "in:inbox -label:Sorted", or the folder the unfiled files sit in), never one that stays constant. The engine counts it when you set it, at the end of each turn that makes progress, and when you close; your task board shows the last count.',
  properties: {
    tool: { type: 'string', enum: [...MEASURE_TOOLS] },
    args: { type: 'object', properties: { query: { type: 'string' }, account: { type: 'string' }, path: { type: 'string' }, pattern: { type: 'string' } } },
    unit: { type: 'string' },
  },
  required: ['tool', 'args'],
};

/** A pointer description where work_open already carries the full text, so it is emitted once per tool. */
export const WORK_MEASURE_REF_PROP: PropSchema = { ...WORK_MEASURE_PROP, description: 'This item\'s own measure, as the top-level `measure` describes.' };


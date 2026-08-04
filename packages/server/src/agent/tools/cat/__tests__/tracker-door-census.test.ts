// ════════════════════════════════════════════════════════════════════════════
// THE TRACKER DOORS, CENSUSED AGAINST THEIR OWN DECLARATIONS.
// PHASE-6 T0A Step 2 — the walk is `agent/tools/__tests__/door-forward-census.ts`
// and T0C widens THAT, rather than building a sixth tool-surface mechanism.
//
// Four doors are censused here because they are the four this task's defect
// class lives in: the two `work_open` creators, the reminder creator, and the
// edit door. Each drives the REAL handler with a value for every parameter its
// tool declares and reads what `tracker/tools.ts` actually received.
//
// EVERY `notForwarded` ENTRY IS A SENTENCE SOMEBODY HAD TO WRITE. That is the
// mechanism: a new declared parameter cannot reach the wire without either
// being forwarded or being explained, and an explanation that stops being true
// fails the same clause. Nothing here forgives a drop.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The inner layer is REPLACED by a recorder: this suite asks what the door
// handed on, never what the tracker did with it. `anchor-time-seam.test.ts` is
// the other half — it drives the same doors into a real database and asserts
// the row.
const { captured, recorder } = vi.hoisted(() => {
  const store: Record<string, Record<string, unknown> | null> = {};
  return {
    captured: store,
    recorder: (key: string) => (_agentId: string, args: Record<string, unknown>): string => {
      store[key] = args;
      return '[OK] recorded';
    },
  };
});

vi.mock('../../../../tracker/tools.js', () => ({
  trackerCreateProject: recorder('work_open:project'),
  trackerCreateTask: recorder('work_open:task'),
  reminderCreate: recorder('work_open:reminder'),
  trackerEditTask: recorder('work_update:edit'),
  trackerEditProject: recorder('work_update:edit_project'),
  trackerUpdateStatus: recorder('work_update:status'),
  trackerAddNotes: recorder('work_note'),
  trackerGetStatus: recorder('work_update:get'),
  trackerListActive: recorder('work_update:list'),
  trackerCompleteStep: recorder('work_update:complete_step'),
  trackerCloseProject: recorder('work_update:close_project'),
  trackerPauseSchedule: recorder('work_schedule:pause'),
  trackerResumeSchedule: recorder('work_schedule:resume'),
  trackerRetask: recorder('work_update:reassign'),
  trackerRequestOverride: recorder('work_close_request:override'),
  trackerOverride: recorder('work_validate:override'),
  trackerRequestUserVerdict: recorder('work_close_request:user_verdict'),
  trackerApplyUserVerdict: recorder('work_validate:apply_user_verdict'),
  trackerApplyUserValidation: recorder('work_validate:apply_user_validation'),
  trackerResolveMissedRuns: recorder('work_schedule:resolve_missed'),
}));
vi.mock('../../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }) }),
}));

import { trackerHandlers } from '../tracker.js';
import { getAllToolDefinitions } from '../../definitions.js';
import {
  censusDoor, declaredParams, formatCensus, probeArgsFor, type DoorSpec,
} from '../../__tests__/door-forward-census.js';

const DEFS = new Map(getAllToolDefinitions().map((d) => [d.name, d]));

const SPECS: DoorSpec[] = [
  {
    door: 'work_open:task',
    tool: 'work_open',
    baseArgs: { kind: 'task', title: 'probe task', repeat_unit: 'days', repeat_interval: 1 },
    notForwarded: {
      kind: 'the dispatch discriminator itself — it selects THIS door, it is not a task field',
      what: 'Reminder only (its own description says so); work_open(kind="reminder") forwards it',
      when: 'Reminder only; work_open(kind="reminder") forwards it as the first-fire time',
      level: 'Project only — the project importance tier',
      tasks: 'Project only — the initial task list a project is opened with',
    },
  },
  {
    door: 'work_open:reminder',
    tool: 'work_open',
    baseArgs: { kind: 'reminder', what: 'stand up', when: '2026-08-05T13:00:00Z' },
    notForwarded: {
      kind: 'the dispatch discriminator itself',
      title: 'Task/Project only — a reminder is identified by `what`',
      description: 'Task/Project only',
      goal: 'Task only — a reminder has no definition of done to compare a result against',
      // NOTE: `local_time`/`local_timezone` are NOT listed here — the reminder door
      // forwards both (PHASE-6 T0C-W). A reason for them would be a stale reason and
      // this suite's own anti-rot clause would fail on it.
      project_id: 'Task only — reminders do not hang off a project',
      assigned_to: 'Task only — a reminder fires for the owner, not an assignee',
      assigned_to_group: 'Task only — group assignment is a tracker-task concept',
      priority: 'Task only — reminders are not prioritised against each other',
      step_number: 'Task only — step ordering is a project concept',
      depends_on: 'Task only — dependency edges are a project concept',
      phase: 'Task only — phases are a project concept',
      scheduled_start: 'Task only — the reminder equivalent is `when`',
      allow_duplicate: 'Task/Project only — the near-duplicate guard runs on titles, and a reminder has none',
      level: 'Project only',
      tasks: 'Project only',
    },
  },
  {
    door: 'work_open:project',
    tool: 'work_open',
    baseArgs: { kind: 'project', title: 'probe project' },
    notForwarded: {
      kind: 'the dispatch discriminator itself',
      what: 'Reminder only',
      when: 'Reminder only',
      goal: 'Task only — the goal is per task; a project is judged through its tasks',
      project_id: 'Task only — a project does not hang off a project',
      assigned_to: 'Task only — per-task assignment travels inside `tasks[]`',
      assigned_to_group: 'Task only',
      priority: 'Task only — per-task priority travels inside `tasks[]`',
      step_number: 'Task only — travels inside `tasks[]`',
      depends_on: 'Task only — travels inside `tasks[]`',
      phase: 'Task only — travels inside `tasks[]`',
      scheduled_start: 'Task only — a project has no schedule of its own',
      repeat_interval: 'Task only — recurrence belongs to a task',
      repeat_unit: 'Task only',
      repeat_days_of_week: 'Task only',
      repeat_end_type: 'Task only',
      repeat_end_value: 'Task only',
      anchor_time: 'Task only — a project carries no next_run_at to anchor',
      local_time: 'Task/Reminder only — it resolves into `scheduled_start`, and a project has no schedule of its own',
      local_timezone: 'Task/Reminder only — the zone `local_time` is resolved in; a project passes neither',
    },
  },
  {
    door: 'work_update:edit',
    tool: 'work_update',
    baseArgs: { action: 'edit', task_id: 'probe-task-id' },
    notForwarded: {
      action: 'the dispatch discriminator itself — it selects THIS door',
      id: 'action="get" alias for task_id/project_id; the edit door takes `task_id`',
      project_id: 'a project_id with no task_id ROUTES to the project editor (the §7.2 absorb rule) — a routing discriminator, not a task field',
      status: 'action="status" owns status transitions; they carry notification and rollup side-effects edit deliberately skips',
      result: 'action="status" (status="complete") — the close-out hard gate reads it',
      evidence: 'action="status" (status="complete") — the close-out hard gate reads it',
      resume_at: 'action="status" (status="paused") — the auto-resume clock',
      complete_all_runs: 'action="status" — it stops a recurring schedule, which is not a field edit',
      reason: 'action="close_project" — the audit sentence written onto every closed task',
      assigned_to: 'action="reassign" — reassignment notifies and re-scopes; edit deliberately skips that',
      assigned_to_group: 'action="reassign"',
      filter: 'action="list" — a query parameter, not a field on a row',
      verbose: 'action="list" — a rendering parameter, not a field on a row',
    },
  },
];

beforeEach(() => {
  for (const k of Object.keys(captured)) delete captured[k];
});

describe('tracker door census — the declared surface and the forwarded surface are one list', () => {
  for (const spec of SPECS) {
    it(`${spec.door} forwards every parameter ${spec.tool} declares, or says why not`, async () => {
      const def = DEFS.get(spec.tool);
      expect(def, `${spec.tool} is not a live tool definition`).toBeDefined();
      const declared = declaredParams(def!);
      const handler = trackerHandlers[spec.door];
      expect(handler, `${spec.door} is not a live dispatch key`).toBeDefined();

      const res = await handler!({ agentId: 'a1', args: probeArgsFor(def!, spec) } as never);
      expect(res.isError, `${spec.door} refused the probe: ${res.content}`).toBe(false);

      const inner = captured[spec.door];
      expect(inner, `${spec.door} never reached its inner function`).toBeTruthy();

      const census = censusDoor(spec, declared, Object.keys(inner!));
      expect(census.dropped, formatCensus(census)).toEqual([]);
      expect(census.staleReasons, formatCensus(census)).toEqual([]);
    });
  }

  it('the census is not vacuous: every door forwarded a non-trivial share of its declared surface', () => {
    // A probe that silently stopped reaching the inner function would make every
    // clause above pass with an empty comparison. This is the denominator.
    expect(SPECS.length).toBe(4);
    for (const spec of SPECS) {
      const declared = declaredParams(DEFS.get(spec.tool)!);
      expect(declared.length, `${spec.tool} declares nothing — the walk is measuring air`).toBeGreaterThan(10);
      expect(
        Object.keys(spec.notForwarded).length,
        `${spec.door} excludes its entire declared surface — that is not a census`,
      ).toBeLessThan(declared.length);
    }
  });
});

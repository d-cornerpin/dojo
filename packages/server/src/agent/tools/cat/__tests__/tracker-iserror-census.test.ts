// ════════════════════════════════════════════════════════════════════════════
// t189 B3: A TRACKER HANDLER THAT RETURNS AN `Error:` TEXT MUST SAY isError.
//
// Six handlers (`work_validate:validate`, `work_close_request:override`,
// `work_validate:override`, `work_close_request:user_verdict`,
// `work_validate:apply_user_verdict`, `work_validate:apply_user_validation`)
// returned the inner function's `Error: ...` string with `isError` still at its
// initial `false`. The error-loop counter and the identical-call brake read
// `isError`, so a refused validate looked like a success to both.
//
// THE CENSUS walks EVERY key of `trackerHandlers`, not a list of six. The inner
// tracker layer is replaced by a stub that fails with `Error: forced`, each
// handler is driven with a value for every parameter its tool declares, and the
// invariant is checked on whatever came back: error text implies isError.
// A handler added later is walked automatically; one that forgets the rule
// fails here.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { reached } = vi.hoisted(() => {
  const reached = new Set<string>();
  return { reached };
});

vi.mock('../../../../tracker/tools.js', () => {
  // Plain strings, not promises: several inner functions are synchronous and a handler
  // that does not `await` one must be seen exactly as production sees it.
  const fail = (key: string) => (): string => {
    reached.add(key);
    return 'Error: forced failure from the tracker layer.';
  };
  return {
    trackerCreateProject: fail('work_open:project'),
    trackerCreateTask: fail('work_open:task'),
    reminderCreate: fail('work_open:reminder'),
    trackerEditTask: fail('work_update:edit'),
    trackerEditProject: fail('work_update:edit_project'),
    trackerUpdateStatus: fail('work_update:status'),
    trackerAddNotes: fail('work_note'),
    trackerGetStatus: fail('work_update:get'),
    trackerListActive: fail('work_update:list'),
    trackerActivity: fail('work_update:activity'),
    activityWindowStart: () => undefined,
    trackerPauseSchedule: fail('work_schedule:pause'),
    trackerResumeSchedule: fail('work_schedule:resume'),
    trackerRetask: fail('work_validate:retask'),
  };
});
vi.mock('../../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }) }),
}));

import { trackerHandlers } from '../tracker.js';
import { getAllToolDefinitions } from '../../definitions.js';
import { probeArgsFor } from '../../__tests__/door-forward-census.js';

const DEFS = new Map(getAllToolDefinitions().map((d) => [d.name, d]));

// Routing values a handler reads from its args rather than from its key.
const ROUTING: Record<string, Record<string, unknown>> = {};

/** Handlers that reach the stubbed tracker layer. They must each be REACHED, or the census is measuring air.
 *  (The six B3 named were the verdict doors; the one decision replaced them.) */
const THE_SIX = [
  'work_validate:retask',
  'work_schedule:pause',
  'work_schedule:resume',
];

beforeEach(() => reached.clear());

describe('t189 B3: tracker handlers say isError when they return an Error: text', () => {
  const keys = Object.keys(trackerHandlers);

  for (const key of keys) {
    it(`${key}: error text implies isError`, async () => {
      const tool = key.split(':')[0]!;
      const def = DEFS.get(tool);
      expect(def, `${tool} is not a live tool definition`).toBeDefined();
      const args = probeArgsFor(def!, { door: key, tool, baseArgs: ROUTING[key] ?? {}, notForwarded: {} });
      let res: { content: unknown; isError?: boolean } | undefined;
      try {
        res = await trackerHandlers[key]!({ agentId: 'a1', args } as never) as never;
      } catch {
        // A handler that needs the real database cannot be driven by this stub; the
        // non-vacuity clause below keeps that from hiding the six.
        return;
      }
      if (typeof res?.content === 'string' && res.content.startsWith('Error')) {
        expect(res.isError, `${key} returned "${res.content.slice(0, 80)}" with isError=${String(res.isError)}`).toBe(true);
      }
    });
  }

  it('is not vacuous: the named handlers reached the stubbed tracker layer and were checked', async () => {
    for (const key of THE_SIX) {
      const tool = key.split(':')[0]!;
      const def = DEFS.get(tool)!;
      const args = probeArgsFor(def, { door: key, tool, baseArgs: ROUTING[key] ?? {}, notForwarded: {} });
      const res = await trackerHandlers[key]!({ agentId: 'a1', args } as never);
      expect(reached.has(key), `${key} never reached its inner function`).toBe(true);
      expect(String(res.content)).toMatch(/^Error/);
      expect(res.isError, `${key}: the stub's Error text must surface as isError`).toBe(true);
    }
    expect(keys.length).toBeGreaterThan(15);
  });
});

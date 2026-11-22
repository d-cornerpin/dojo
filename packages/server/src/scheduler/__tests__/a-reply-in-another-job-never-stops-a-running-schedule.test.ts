// A schedule's run is open (its job parked between stretches) when the same agent's turn for another run, a one-time
// reminder, ends with a reply: only that turn's own run is touched. The schedule's run stays open, and once it is handed
// in the next tick fires the run after it. A turn that ends its own repeating run with a reply closes that run as not
// done, and its schedule goes on.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/missed-runs-box.js');
const { openTurnContext, endTurnContext } = await import('../../agent/turn-context.js');
const { initState, advance } = await import('../../agent/v2/state.js');
const { runGoingIdle } = await import('../../agent/v2/steps/post-call-classify/going-idle.js');
const { onTaskRunComplete, cleanupStaleRuns } = await import('../runner.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

const runs = (id: string) => box.db().prepare("SELECT id, sequence, state FROM work WHERE kind = 'occurrence' AND parent_id = ? ORDER BY sequence").all(id) as Array<{ id: string; sequence: number; state: string }>;
const opened = async (args: Record<string, unknown>): Promise<string> => {
  const made = await box.call('work_open', args);
  expect(made.isError, made.content).toBeFalsy();
  return /task_id=([\w-]+)/.exec(made.content)![1]!;
};

/** A run's turn writes its one line and ends, through the real going-idle step. */
async function runTurnReplies(runId: string): Promise<void> {
  const bag = openTurnContext(box.MAIN);
  Object.assign(bag, { turnNumber: 7, root: { kind: 'occurrence', id: runId, sourceMessageId: null } });
  const state = advance(initState({ agentId: box.MAIN, turnNumber: 7, lastUserMessageContent: null } as unknown as Parameters<typeof initState>[0]), { loopCount: 1 });
  const ctx = {
    agentId: box.MAIN, db: box.db(), turnNumber: 7, agent: { id: box.MAIN, name: 'main' }, turnCtx: bag, triggerRow: null, isA2ATurn: false,
    mostRecentInbound: { origin_intent: 'scheduler' }, lastUserMessageContent: '[SOURCE: SCHEDULER] Time to stretch', result: { content: 'Time to stretch.', toolCalls: [] },
  };
  await runGoingIdle(state, ctx as never, { persistedContent: 'Time to stretch.' } as never);
  endTurnContext(box.MAIN);
}

describe('a reply in another job never stops a running schedule', () => {
  it('the schedule\'s open run stays open, and after its hand-in the next tick fires run 2', async () => {
    box.at('2026-03-02T12:00:00Z');
    const moving = await opened({ kind: 'task', goal: 'the inbox is empty', title: 'Move three files per run', scheduled_start: '2026-03-02T12:05:00Z', repeat_interval: 5, repeat_unit: 'minutes' });
    const stretch = await opened({ kind: 'reminder', what: 'stretch', when: '2026-03-02T12:06:00Z' });
    box.at('2026-03-02T12:05:30Z');
    await box.checkScheduledTasks();
    box.at('2026-03-02T12:06:30Z');
    await box.checkScheduledTasks();
    await runTurnReplies(runs(stretch)[0].id);

    // The schedule's next slot passes while its run is still being worked, and the reaper's orphan sweep runs.
    box.at('2026-03-02T12:12:00Z');
    await box.checkScheduledTasks();
    cleanupStaleRuns();
    expect(runs(moving)).toMatchObject([{ sequence: 1, state: 'open' }]);
    expect(await onTaskRunComplete(moving, 'complete', 'moved three files')).toBe(true);
    box.at('2026-03-02T12:15:30Z');
    await box.checkScheduledTasks();
    expect(runs(moving).map((r) => r.sequence)).toEqual([1, 2]);
  });

  it('the turn\'s own repeating run that ends with a reply is closed as not done, and the next run fires', async () => {
    box.at('2026-03-03T12:00:00Z');
    const clearing = await opened({ kind: 'task', goal: 'the desk is clear', title: 'Clear the desk', scheduled_start: '2026-03-03T12:05:00Z', repeat_interval: 5, repeat_unit: 'minutes' });
    box.at('2026-03-03T12:05:30Z');
    await box.checkScheduledTasks();
    await runTurnReplies(runs(clearing)[0].id);
    expect(runs(clearing)).toMatchObject([{ sequence: 1, state: 'failed' }]);
    box.at('2026-03-03T12:10:30Z');
    await box.checkScheduledTasks();
    expect(runs(clearing).map((r) => r.sequence)).toEqual([1, 2]);
  });
});

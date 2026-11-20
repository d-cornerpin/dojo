// A reminder whose turn says nothing, even after the required call, is closed undelivered by the stale-run sweep
// and the owner gets the run-undelivered card exactly once.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const callModel = vi.hoisted(() => vi.fn(async (_p: { forceReply?: boolean }) => (
  { content: '', toolCalls: [], inputTokens: 10, outputTokens: 0, stopReason: 'end_turn' })));
vi.mock('../../agent/model.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), callModel, getContextWindow: () => 200_000,
}));
const box = await import('./helpers/missed-runs-box.js');
const { cleanupStaleRuns } = await import('../runner.js');

// The fake clock starts at the real minute: rows SQLite stamps itself carry its own clock, which must not run ahead.
const T0 = Math.floor(Date.now() / 60_000) * 60_000;
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const cards = (): number => (box.db().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE kind = 'floor_ghosted' AND json_extract(payload, '$.floor') = 'run-undelivered'",
).get() as { n: number }).n;

beforeAll(() => {
  box.openBox();
  box.db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'Test', 'anthropic', 'api_key')").run();
  box.db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m', 'p', 'Test Model', 'test-1', '["tools"]', 200000, 1)`).run();
  box.db().prepare("UPDATE agents SET model_id = 'm' WHERE id = ?").run(box.MAIN);
});
afterAll(() => box.closeBox());

describe('a reminder left unsaid', () => {
  it('gets the required call, then one run-undelivered card when the run is swept', async () => {
    box.at(at(0));
    const made = await box.call('work_open', { kind: 'reminder', what: 'Take the bins out', when: at(5) });
    expect(made.isError, made.content).toBeFalsy();
    box.at(at(5.5));
    await box.checkScheduledTasks();
    const turnEnded = () => box.db().prepare('SELECT 1 FROM turns WHERE ended_at IS NOT NULL').get();
    await vi.waitFor(() => expect(turnEnded()).toBeTruthy(), { timeout: 10_000 });
    expect(callModel.mock.calls.at(-1)![0].forceReply).toBe(true);
    expect(cards()).toBe(0);

    box.at(at(40));
    cleanupStaleRuns();
    await vi.waitFor(() => expect(cards()).toBe(1));
    cleanupStaleRuns();
    await new Promise((r) => setTimeout(r, 50));
    expect(cards()).toBe(1);
  });
});

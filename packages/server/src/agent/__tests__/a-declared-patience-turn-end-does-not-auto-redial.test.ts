// T81c (NO-DOOMED-DIALS, Leg B) — census row 22: "Queued-wakeup restart timer ... a plain,
// unconditional cold restart — no prompt-size check, no memory of WHY the prior attempt didn't
// finish." Combined with an unlimited preempt (row 21) this was "the fastest concretely-provable
// cold-redial loop in the tree: abort -> 500ms -> new cold call -> (if re-preempted) abort again."
//
// This suite drives `getAgentRuntime().handleMessage` directly against a REAL migrated
// in-memory DB (no mock of `agents`/`last_error` semantics) with `v2/loop.js`'s `runV2Turn`
// stubbed to a no-op spy — the turn machinery itself is not what this task changes, only
// whether the 500ms queued-wakeup restart honours WHY the prior turn ended.
//
// The scenario seeded below is not contrived: `agent-status.ts`'s `resetWorkingAgentsToIdleAtBoot`
// (the crash-recovery boot sweep) flips a `working` row straight to `idle` with a raw statement
// that never touches `last_error` — a server that crashes moments after a declared-patience
// injury, before the agent's next turn could clear the diagnostic on a clean exit, boots with
// status='idle' (nothing status-based blocks it) and a stale `last_error` that still names the
// un-finishable request. That is exactly the gap a status-only check cannot see.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

const broadcastSpy = vi.fn();
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: unknown) => broadcastSpy(e) }));

const runV2TurnSpy = vi.fn(async () => undefined);
vi.mock('../v2/loop.js', () => ({ runV2Turn: (...args: unknown[]) => runV2TurnSpy(...args) }));

const AGENT = 'boot-crash-fixture-agent';

// A realistic (TEST FIXTURE, not a code constant) shape of what `model.ts`'s
// `declaredPatienceClause` actually appends to `STREAM_FIRST_CHUNK_TIMEOUT_ERROR`.
const PATIENCE_LAST_ERROR =
  'model first-chunk timeout: no data from provider for too long (elapsed 214009ms); ' +
  '~76543 estimated prompt tokens against a declared 214000ms first-chunk patience';

const PRE_DIAL_REFUSAL_LAST_ERROR =
  "refused before any network dial: ~9999 estimated prompt tokens exceeds the ~100-token " +
  "ceiling this provider's declared 10 tok/s prefill throughput can cover inside its declared " +
  "40000ms first-chunk patience.";

function seed(status: string, lastError: string | null): void {
  mockDb.current!.prepare(
    "INSERT INTO agents (id, name, status, last_error, model_id) VALUES (?, 'Fixture', ?, ?, NULL)",
  ).run(AGENT, status, lastError);
}

beforeEach(async () => {
  vi.resetModules();
  runV2TurnSpy.mockClear();
  broadcastSpy.mockClear();
  const db = new Database(':memory:');
  mockDb.current = db;
  const { runMigrations } = await import('../../db/migrations.js');
  runMigrations();
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('a declared-patience turn end does not auto-redial via the queued wakeup', () => {
  it('RED: status=idle with a stale declared-patience last_error (post-boot-sweep) still declines the redial', async () => {
    seed('idle', PATIENCE_LAST_ERROR);
    const { pendingWakeups } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    vi.useFakeTimers();
    pendingWakeups.add(AGENT); // "a message arrived while busy" was already queued before the crash

    await getAgentRuntime().handleMessage(AGENT, 'hello');
    expect(runV2TurnSpy).toHaveBeenCalledTimes(1); // this turn itself (a no-op mock)

    await vi.advanceTimersByTimeAsync(600); // past the 500ms queued-wakeup delay

    expect(runV2TurnSpy, 'the queued wakeup must not cold-redial the same request').toHaveBeenCalledTimes(1);
    pendingWakeups.delete(AGENT);
  });

  it('the wake is left queued, not dropped — a later clean turn can still serve it', async () => {
    seed('idle', PATIENCE_LAST_ERROR);
    const { pendingWakeups } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    vi.useFakeTimers();
    pendingWakeups.add(AGENT);

    await getAgentRuntime().handleMessage(AGENT, 'hello');
    await vi.advanceTimersByTimeAsync(600);

    expect(pendingWakeups.has(AGENT), 'declining must re-queue the wake, never silently drop it').toBe(true);
    pendingWakeups.delete(AGENT);
  });

  it('does not duplicate a human-facing note — T81a\'s own injury path already sent one', async () => {
    seed('idle', PATIENCE_LAST_ERROR);
    const { pendingWakeups } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    vi.useFakeTimers();
    pendingWakeups.add(AGENT);
    await getAgentRuntime().handleMessage(AGENT, 'hello');
    broadcastSpy.mockClear(); // only care about broadcasts from the DECLINE itself, past this point
    await vi.advanceTimersByTimeAsync(600);

    const chatMessageBroadcasts = broadcastSpy.mock.calls
      .map((c) => c[0] as { type?: string })
      .filter((e) => e?.type === 'chat:message' || e?.type === 'chat:error');
    expect(chatMessageBroadcasts).toEqual([]);
    pendingWakeups.delete(AGENT);
  });

  it('the SAME decline applies to a T81b pre-dial refusal message', async () => {
    seed('idle', PRE_DIAL_REFUSAL_LAST_ERROR);
    const { pendingWakeups } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    vi.useFakeTimers();
    pendingWakeups.add(AGENT);
    await getAgentRuntime().handleMessage(AGENT, 'hello');
    await vi.advanceTimersByTimeAsync(600);

    expect(runV2TurnSpy).toHaveBeenCalledTimes(1);
    pendingWakeups.delete(AGENT);
  });

  it('CONTROL: a generic transient last_error (no declared-patience phrase) still auto-redials normally', async () => {
    seed('idle', 'fetch failed: ECONNRESET');
    const { pendingWakeups } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    vi.useFakeTimers();
    pendingWakeups.add(AGENT);
    await getAgentRuntime().handleMessage(AGENT, 'hello');
    expect(runV2TurnSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600);

    expect(runV2TurnSpy, 'ordinary queued wakeups must be unaffected by this task').toHaveBeenCalledTimes(2);
    pendingWakeups.delete(AGENT);
  });

  it('CONTROL: no last_error at all still auto-redials normally', async () => {
    seed('idle', null);
    const { pendingWakeups } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    vi.useFakeTimers();
    pendingWakeups.add(AGENT);
    await getAgentRuntime().handleMessage(AGENT, 'hello');
    await vi.advanceTimersByTimeAsync(600);

    expect(runV2TurnSpy).toHaveBeenCalledTimes(2);
    pendingWakeups.delete(AGENT);
  });
});

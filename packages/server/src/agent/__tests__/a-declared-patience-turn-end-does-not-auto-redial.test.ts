// T81c (NO-DOOMED-DIALS, Leg B) — census row 22: "Queued-wakeup restart timer ... a plain,
// unconditional cold restart — no prompt-size check, no memory of WHY the prior attempt didn't
// finish." Combined with an unlimited preempt (row 21) this was "the fastest concretely-provable
// cold-redial loop in the tree: abort -> 500ms -> new cold call -> (if re-preempted) abort again."
//
// FIX ROUND 1 — CRITICAL finding closed here: the first cut read `agents.last_error` (a plain
// STRING) to decide whether to decline the redial, unscoped to WHICH turn produced it. Because
// `last_error` survives a `working` transition by design (FA-A2), an OLD declared-patience
// injury's message could still be sitting there when a LATER, wholly unrelated turn's
// legitimate recovery arm (context-overflow, the pre-dial compaction retry, output-truncation,
// Tier-B — none of which touch `last_error`) queued its own self-wake, and the stale text
// silently declined a real retry: a hang at `status='working'` until the 75-minute reaper.
//
// The replacement signal is `declaredPatienceHonestFailTurn` (`shared-state.ts`), a turn-scoped
// marker set ONLY by `v2/recovery.ts`'s `recordInjury` for `DECLARED_PATIENCE_EXCEEDED_CODE` —
// see `agent/v2/__tests__/integration.test.ts`'s "T81c FIX ROUND 1" block for the SETTER side,
// driven through the real recovery cascade. This file drives the CONSUMER side: `runtime.ts`'s
// queued-wakeup gate, `turnJustEndedOnDeclaredPatience`, which declines ONLY when the marker
// names the agent's CURRENT latest turn (`v2/turn-record.ts`'s `currentTurnNumber`) and consumes
// it as part of that match. The marker's value is set directly here (not through a mocked
// `runV2Turn`) because this file's subject is the CONSUMER's own identity check in isolation —
// exactly the shape the setter side already proved honest in the file named above — while
// `agents.last_error` is deliberately seeded with STALE, contradictory text in every scenario to
// prove it is now completely irrelevant to the decision.

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

const AGENT = 'marker-fixture-agent';

// Deliberately the OLD phrase the first cut used to key on — every scenario below seeds this so
// a regression back to reading `last_error` would show up as a wrongly-declined CONTROL case.
const STALE_LAST_ERROR =
  'model first-chunk timeout: no data from provider for too long (elapsed 214009ms); ' +
  '~76543 estimated prompt tokens against a declared 214000ms first-chunk patience';

function seedAgent(status: string): void {
  mockDb.current!.prepare(
    "INSERT INTO agents (id, name, status, last_error, model_id) VALUES (?, 'Fixture', ?, ?, NULL)",
  ).run(AGENT, status, STALE_LAST_ERROR);
}

/** `currentTurnNumber`'s own source — see `v2/turn-record.ts`. Allocates turn rows directly so
 *  the fixture matches exactly what `startTurn` would have produced, without running a turn. */
function seedTurn(turnNumber: number): void {
  mockDb.current!.prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, answered, effectful_calls, started_at)
     VALUES (?, ?, 'user', 'none', 0, 0, datetime('now'))`,
  ).run(AGENT, turnNumber);
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
  it('RED: the marker naming the agent\'s current latest turn declines the redial', async () => {
    seedAgent('working'); // status alone would NOT block this — the marker must be what does
    seedTurn(1);
    const { pendingWakeups, declaredPatienceHonestFailTurn } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    declaredPatienceHonestFailTurn.set(AGENT, 1); // names turn 1 — the agent's current latest
    vi.useFakeTimers();
    pendingWakeups.add(AGENT); // "a message arrived while busy" was already queued

    await getAgentRuntime().handleMessage(AGENT, 'hello');
    expect(runV2TurnSpy).toHaveBeenCalledTimes(1); // this turn itself (a no-op mock)

    await vi.advanceTimersByTimeAsync(600); // past the 500ms queued-wakeup delay

    expect(runV2TurnSpy, 'the queued wakeup must not cold-redial the same request').toHaveBeenCalledTimes(1);
    pendingWakeups.delete(AGENT);
    declaredPatienceHonestFailTurn.delete(AGENT);
  });

  it('the wake is left queued, not dropped — a later clean turn can still serve it', async () => {
    seedAgent('working');
    seedTurn(1);
    const { pendingWakeups, declaredPatienceHonestFailTurn } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    declaredPatienceHonestFailTurn.set(AGENT, 1);
    vi.useFakeTimers();
    pendingWakeups.add(AGENT);

    await getAgentRuntime().handleMessage(AGENT, 'hello');
    await vi.advanceTimersByTimeAsync(600);

    expect(pendingWakeups.has(AGENT), 'declining must re-queue the wake, never silently drop it').toBe(true);
    pendingWakeups.delete(AGENT);
    declaredPatienceHonestFailTurn.delete(AGENT);
  });

  it('the marker is CONSUMED (deleted) once it declines — it does not fire on a second, independent check', async () => {
    seedAgent('working');
    seedTurn(1);
    const { pendingWakeups, declaredPatienceHonestFailTurn } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    declaredPatienceHonestFailTurn.set(AGENT, 1);
    vi.useFakeTimers();
    pendingWakeups.add(AGENT);
    await getAgentRuntime().handleMessage(AGENT, 'hello');
    await vi.advanceTimersByTimeAsync(600);

    expect(declaredPatienceHonestFailTurn.has(AGENT), 'a consumed marker must not linger').toBe(false);
    pendingWakeups.delete(AGENT);
  });

  it('does not duplicate a human-facing note — T81a\'s own injury path already sent one', async () => {
    seedAgent('working');
    seedTurn(1);
    const { pendingWakeups, declaredPatienceHonestFailTurn } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    declaredPatienceHonestFailTurn.set(AGENT, 1);
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
    declaredPatienceHonestFailTurn.delete(AGENT);
  });

  it('CRITICAL FIX: a STALE marker naming an EARLIER turn (a newer turn has since run) does NOT decline — the four recovery arms restart normally', async () => {
    // This is the exact defect the review round reproduced: turn 1 ended in a declared-patience
    // honest fail (marker set to 1), the agent moved on, and turn 2 already ran (whatever it
    // did — a context-overflow retry, say) before this queued wakeup ever got a chance to fire.
    // `agents.last_error` (seeded, stale, and WRONG for this decision) still says declared-
    // patience — the OLD code would have wrongly declined. The marker names turn 1; the agent's
    // CURRENT latest is turn 2; they do not match.
    seedAgent('working');
    seedTurn(1);
    seedTurn(2); // a newer turn has already run since the marker was set
    const { pendingWakeups, declaredPatienceHonestFailTurn } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    declaredPatienceHonestFailTurn.set(AGENT, 1); // stale — names the OLD turn, not the current one
    vi.useFakeTimers();
    pendingWakeups.add(AGENT);
    await getAgentRuntime().handleMessage(AGENT, 'hello');
    await vi.advanceTimersByTimeAsync(600);

    expect(runV2TurnSpy, 'a stale marker must never block a legitimate later retry').toHaveBeenCalledTimes(2);
    pendingWakeups.delete(AGENT);
    declaredPatienceHonestFailTurn.delete(AGENT);
  });

  it('CONTROL: no marker at all (the shape every one of the four recovery arms leaves) still auto-redials normally, even with a stale doomed last_error', async () => {
    seedAgent('working');
    seedTurn(1);
    const { pendingWakeups, declaredPatienceHonestFailTurn } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    expect(declaredPatienceHonestFailTurn.has(AGENT)).toBe(false); // no marker — the four arms never set one
    vi.useFakeTimers();
    pendingWakeups.add(AGENT);
    await getAgentRuntime().handleMessage(AGENT, 'hello');
    await vi.advanceTimersByTimeAsync(600);

    expect(runV2TurnSpy, 'ordinary queued wakeups must be unaffected by this task').toHaveBeenCalledTimes(2);
    pendingWakeups.delete(AGENT);
  });

  it('CONTROL: a revived agent (status back to working, stale last_error, marker never set) restarts normally', async () => {
    // "Revived after injury" — a fresh human message resumed the agent (status='working'),
    // `last_error` was never cleared (by design, FA-A2), and no marker exists because this
    // agent's most recent failure was never re-injured. The queued wakeup must behave exactly
    // as it would for a perfectly healthy agent.
    seedAgent('working');
    seedTurn(5); // several turns deep — an established, ongoing session
    const { pendingWakeups, declaredPatienceHonestFailTurn } = await import('../shared-state.js');
    const { getAgentRuntime } = await import('../runtime.js');

    expect(declaredPatienceHonestFailTurn.has(AGENT)).toBe(false);
    vi.useFakeTimers();
    pendingWakeups.add(AGENT);
    await getAgentRuntime().handleMessage(AGENT, 'hello');
    await vi.advanceTimersByTimeAsync(600);

    expect(runV2TurnSpy).toHaveBeenCalledTimes(2);
    pendingWakeups.delete(AGENT);
  });
});

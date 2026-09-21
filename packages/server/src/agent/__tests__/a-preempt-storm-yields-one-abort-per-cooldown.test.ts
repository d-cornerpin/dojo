// T81c (NO-DOOMED-DIALS, Leg B) — census row 21: "Preempt (urgent message) ... has ZERO
// governor: no count cap, no cool-down ... If anything (a flaky VAD, a reconnect loop) calls it
// repeatedly, nothing in the codebase stops a sub-second-cadence livelock."
//
// The GPU livelock incident's fast loop: abort -> 500ms queued-wakeup restart -> a fresh
// in-flight call -> re-abort -> ... with no counter and no backoff. This suite drives
// `preemptAgentForUrgentMessage` directly (the one function every urgent-preempt caller shares
// — today, voice barge-in) and pins the OBSERVABLE fix: within a per-agent cool-down window, a
// second preempt request is coalesced (the in-flight abort already serves it) rather than
// firing a second `AbortController.abort()`. The FIRST press in any window still works.
//
// Every timing number here is a TEST FIXTURE for THIS suite's own clock — it never assumes or
// re-derives the real cool-down constant, only that some positive window exists.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
// The engine's own turn machinery is irrelevant to this function — mocked out so importing
// `runtime.js` never pulls in the model-call chain (and never risks a real dial or a real DB
// touch through it).
vi.mock('../v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

beforeEach(() => {
  vi.resetModules();
  const db = new Database(':memory:');
  mockDb.current = db;
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

const AGENT = 'voice-fixture-agent';

describe('a preempt storm yields at most one abort per cool-down window', () => {
  it('RED: five preempts inside one cool-down window abort only ONCE', async () => {
    const { activeAbortControllers, preemptedAgents, registerAbortable } = await import('../shared-state.js');
    const { preemptAgentForUrgentMessage } = await import('../runtime.js');

    let aborts = 0;
    const rearm = (): void => {
      const c = new AbortController();
      c.signal.addEventListener('abort', () => { aborts++; });
      registerAbortable(AGENT, c);
    };
    rearm();

    // Five urgent-preempt requests in rapid succession — a flaky VAD, a reconnect loop, or
    // several distinct barge-in presses inside one window.
    for (let i = 0; i < 5; i++) {
      preemptAgentForUrgentMessage(AGENT);
      // Simulate the queued-wakeup restart re-arming a fresh in-flight call between presses,
      // exactly as the fast Leg-B loop does — without a cool-down, EVERY one of these would
      // abort a genuinely fresh controller.
      rearm();
    }

    expect(aborts, 'a preempt storm must not abort more than once inside the cool-down window').toBe(1);
    activeAbortControllers.delete(AGENT);
    preemptedAgents.delete(AGENT);
  });

  it('the FIRST press in a window always works, even with nothing yet in the cool-down map', async () => {
    const { activeAbortControllers, preemptedAgents, registerAbortable } = await import('../shared-state.js');
    const { preemptAgentForUrgentMessage } = await import('../runtime.js');

    const controller = new AbortController();
    registerAbortable(AGENT, controller);

    const result = preemptAgentForUrgentMessage(AGENT);

    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    preemptedAgents.delete(AGENT);
  });

  it('a preempt AFTER the cool-down window elapses aborts again — this is a window, not a permanent latch', async () => {
    vi.useFakeTimers();
    const { activeAbortControllers, preemptedAgents, registerAbortable } = await import('../shared-state.js');
    const { preemptAgentForUrgentMessage } = await import('../runtime.js');

    const first = new AbortController();
    registerAbortable(AGENT, first);
    expect(preemptAgentForUrgentMessage(AGENT)).toBe(true);

    // Well past any reasonable cool-down window (minutes).
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const second = new AbortController();
    registerAbortable(AGENT, second);
    expect(preemptAgentForUrgentMessage(AGENT)).toBe(true);
    expect(second.signal.aborted).toBe(true);
    preemptedAgents.delete(AGENT);
  });

  it('CONTROL: a coalesced preempt does not touch a controller belonging to a DIFFERENT agent', async () => {
    const { activeAbortControllers, preemptedAgents, registerAbortable } = await import('../shared-state.js');
    const { preemptAgentForUrgentMessage } = await import('../runtime.js');

    const mine = new AbortController();
    const someoneElse = new AbortController();
    registerAbortable(AGENT, mine);
    registerAbortable('someone-else', someoneElse);

    preemptAgentForUrgentMessage(AGENT);
    registerAbortable(AGENT, new AbortController()); // fresh in-flight call re-armed
    preemptAgentForUrgentMessage(AGENT); // coalesced — within the cool-down

    expect(someoneElse.signal.aborted, 'a per-agent cool-down must never cross agents').toBe(false);
    expect(preemptAgentForUrgentMessage('someone-else')).toBe(true);
    expect(someoneElse.signal.aborted).toBe(true);

    activeAbortControllers.delete(AGENT);
    activeAbortControllers.delete('someone-else');
    preemptedAgents.delete(AGENT);
    preemptedAgents.delete('someone-else');
  });

  it('CONTROL: with no in-flight call to abort, the function still returns false (unchanged today\'s behaviour)', async () => {
    const { activeAbortControllers, registerAbortable } = await import('../shared-state.js');
    const { preemptAgentForUrgentMessage } = await import('../runtime.js');
    activeAbortControllers.delete(AGENT);
    expect(preemptAgentForUrgentMessage(AGENT)).toBe(false);
  });
});

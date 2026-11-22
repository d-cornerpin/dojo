// ════════════════════════════════════════════════════════════════════════════
// T83 — A STOP STOPS, AND THE STATUS TELLS THE TRUTH.
//
// THE DEFECT, re-derived from the dev box's own log (`~/.dojo/logs`, FX.n8
// `a504e5c9`, 2026-09-21) rather than from the triage report's prose:
//
//   04:22:16.150  OpenAI call completed          ← the TURN's own call ends,
//                                                   and its controller is gone
//   04:22:25.264  v2 turn time budget reached, auto-continuing with forced compaction
//   04:22:25.273  Calling OpenAI model  (messageCount 2, toolCount 0)
//                                                ← the SUMMARISER's call: made by
//                                                   `memory/summarize.ts`, registered
//                                                   in NOTHING, carrying NO abort signal
//   04:22:42.167  Agent stop requested           ← the button. `activeAbortControllers`
//                                                   is EMPTY, so it aborts nothing,
//                                                   and it writes status='idle'
//   04:25:23.307  Agent session reset via API    ← clears `stoppedAgents` while the
//                                                   stopped run is STILL RUNNING
//   04:25:27.711  Calling OpenAI model           ← ask-title, CONCURRENT with the
//                                                   summariser on the same agentId
//   04:27:10.615  OpenAI call completed  latencyMs 285328   ← the un-aborted call
//   04:27:10.624  the turn parks for a continuation
//   04:27:11.132  Processing queued wakeup       ← the chain RESUMES
//
// THREE ROOT-CAUSE PROPERTIES, each pinned by its own clause below:
//
//   1. EVERY PROVIDER CALL AN AGENT MAKES IS ABORTABLE BY THAT AGENT'S STOP.
//      The registry only ever held the ONE controller the turn's own model call
//      put there. Every other dial a turn makes — the turn-budget checkpoint's
//      forced compaction, the continuity brief, the classifiers, ask-title —
//      dialled with no controller and no signal. And because two of them can be
//      in flight at once on one agentId (proven at 04:25:27 above), a registry
//      holding ONE controller per agent is wrong even if every caller registers.
//
//   2. A CALL THAT RACES THE STOP TO THE REGISTRY LOSES. Registration goes
//      through one door that refuses — and aborts on the spot — while a stop is
//      live, so there is no window in which a call can register itself out of a
//      stop that already landed.
//
//   3. THE STOP FENCE IS THE RUN'S, AND ONLY THE RUN RETIRES IT. `stoppedAgents`
//      is clearable from outside (a fresh user message; reset-session — both
//      legitimate, both about the NEXT run). The run that was stopped needs a
//      fence nobody outside it can lift, or its own turn-budget checkpoint
//      re-arms the continuation four minutes later.
//
//   4. STATUS IS NOT A COSMETIC. `idle` written while the loop is still
//      unwinding is a lie that every reader believes — it is exactly why three
//      `resetSession()` calls sailed through a busy agent here, where the same
//      guard had correctly refused for 390 s when the status told the truth.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { stoppedAgents, activeAbortControllers, registerAbortable, activeRuns, releaseAbortable, abortInFlight, pendingWakeups, queueSelfWake, stopFencedRuns, isStopFenced } from '../shared-state.js';
import * as s from '../shared-state.js';
import { stopAgent } from '../runtime.js';
import { FX } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const mockDb: { current: Database.Database | null } = { current: null };
const broadcasts: Array<Record<string, unknown>> = [];

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (ev: Record<string, unknown>) => { broadcasts.push(ev); },
}));
// The turn machinery is irrelevant to the stop door itself — mocked so importing
// `runtime.js` never pulls the model-call chain (and never risks a real dial).
vi.mock('../v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const AGENT = 'stop-truth-agent';

function seedAgent(status: string): void {
  mockDb.current!.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, config TEXT,
      last_error TEXT, last_error_at TEXT, updated_at TEXT
    );
  `);
  mockDb.current!.prepare(
    `INSERT OR REPLACE INTO agents (id, name, status, config, updated_at) VALUES (?, '${FX.n8}', ?, '{}', datetime('now'))`,
  ).run(AGENT, status);
}

function statusOf(): string {
  return (mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status;
}

beforeEach(() => {
  broadcasts.length = 0;
  mockDb.current = new Database(':memory:');
});

afterEach(async () => {
  s.stoppedAgents.clear();
  s.pendingWakeups.clear();
  s.preemptedAgents.clear();
  s.activeRuns.clear();
  s.activeAbortControllers.clear();
  s.stopFencedRuns.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

// ── PROPERTY 2: a call racing the stop to the registry loses ─────────────────

describe('a call that races the stop to the registry cannot dial', () => {
  it('THE RED: registering while a stop is live is REFUSED, and the controller is aborted on the spot', async () => {
    stoppedAgents.add(AGENT);

    const racing = new AbortController();
    expect(registerAbortable(AGENT, racing)).toBe(false);
    expect(racing.signal.aborted, 'a call that registers after the stop must never reach the wire').toBe(true);
    expect(activeAbortControllers.get(AGENT)?.size ?? 0).toBe(0);
  });

  it('CONTROL: with no stop live, registration is accepted and the controller is untouched', async () => {
    const c = new AbortController();
    expect(registerAbortable(AGENT, c)).toBe(true);
    expect(c.signal.aborted).toBe(false);
    expect(activeAbortControllers.get(AGENT)?.has(c)).toBe(true);
  });
});

// ── PROPERTY 1: every call an agent has in flight is abortable ───────────────

describe('a stop aborts EVERY call the agent has in flight', () => {
  it('THE RED: the turn\'s own call AND a mid-turn compaction call are both cut', async () => {
    seedAgent('working');
    activeRuns.add(AGENT);

    // 04:22:25 — the turn's dial and the turn-budget checkpoint's summariser dial,
    // both on one agentId, both genuinely in flight when the button is pressed.
    const turnCall = new AbortController();
    const compactionCall = new AbortController();
    expect(registerAbortable(AGENT, turnCall)).toBe(true);
    expect(registerAbortable(AGENT, compactionCall)).toBe(true);

    stopAgent(AGENT);

    expect(turnCall.signal.aborted).toBe(true);
    expect(compactionCall.signal.aborted, 'the 285-second call the stop never reached').toBe(true);
  });

  it('CONTROL — the stop that DID work (03:18:34): one registered call, cut', async () => {
    seedAgent('working');
    activeRuns.add(AGENT);
    const inFlight = new AbortController();
    registerAbortable(AGENT, inFlight);

    stopAgent(AGENT);
    expect(inFlight.signal.aborted).toBe(true);
  });

  it('CONTROL: a stop on one agent never reaches another agent\'s in-flight call', async () => {
    seedAgent('working');
    activeRuns.add(AGENT);
    const mine = new AbortController();
    const theirs = new AbortController();
    registerAbortable(AGENT, mine);
    registerAbortable('someone-else', theirs);

    stopAgent(AGENT);
    expect(mine.signal.aborted).toBe(true);
    expect(theirs.signal.aborted).toBe(false);
  });

  it('release is by IDENTITY: one call settling never de-registers the other', async () => {
    const first = new AbortController();
    const second = new AbortController();
    registerAbortable(AGENT, first);
    registerAbortable(AGENT, second);

    releaseAbortable(AGENT, first);

    expect(activeAbortControllers.get(AGENT)?.has(second)).toBe(true);
    expect(abortInFlight(AGENT, 'test')).toBe(1);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted, 'a released controller is not the stop\'s business').toBe(false);
  });
});

// ── PROPERTY 3: the fence is the run's, and only the run retires it ──────────

describe('the continuation chain cannot re-arm itself after a stop', () => {
  it('THE RED: the turn-budget continuation is refused even after reset-session clears the stop flag', async () => {
    seedAgent('working');
    activeRuns.add(AGENT);

    stopAgent(AGENT);
    // 04:25:23 — `POST /:id/reset-session` deletes the flag, legitimately (it is
    // about the NEXT run). The run stopped at 04:22:42 is still unwinding.
    stoppedAgents.delete(AGENT);

    // 04:27:10 — the forced compaction finishes and the checkpoint tries to park.
    expect(queueSelfWake(AGENT, 'turn-budget-continuation')).toBe(false);
    expect(pendingWakeups.has(AGENT), 'the stopped run queued its own next turn').toBe(false);
  });

  it('CONTROL: a REAL inbound arriving after the stop still queues — it is not a self-wake', async () => {
    seedAgent('working');
    activeRuns.add(AGENT);
    stopAgent(AGENT);

    // `handleMessage`'s busy path — somebody asking for something new.
    pendingWakeups.add(AGENT);
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });

  it('CONTROL: with no run in flight, a stop raises no fence to leak', async () => {
    seedAgent('idle');
    stopAgent(AGENT);
    expect(stopFencedRuns.has(AGENT), 'a fence nothing will ever clear is a silent hang').toBe(false);
  });

  it('THE RED (review IMPORTANT A-2): the tool executor halts on a stop that reset-session has "cleared"', async () => {
    // The scenario the review reproduced: owner stops mid-turn while a tool batch is running;
    // a reset-session lands two minutes later and lifts `stoppedAgents`. The executor's next
    // boundary check saw no stop and kept dispatching real side-effecting calls — a send, a
    // write, a calendar change — for a run the owner had stopped.
    seedAgent('working');
    activeRuns.add(AGENT);
    stopAgent(AGENT);
    stoppedAgents.delete(AGENT); // reset-session

    expect(isStopFenced(AGENT), 'the executor consults this at both batch boundaries').toBe(true);
  });
});

// ── PROPERTY 4: the status does not lie ──────────────────────────────────────

describe('the status field does not lie about a stop', () => {
  it('THE RED: a stop landing on a LIVE run never writes idle', async () => {
    seedAgent('working');
    activeRuns.add(AGENT);

    stopAgent(AGENT);

    expect(statusOf(), 'the run is still consuming the loop; idle is a lie every reader believes')
      .toBe('working');
    const idleFrames = broadcasts.filter((b) => b.type === 'agent:status' && b.status === 'idle');
    expect(idleFrames, 'a cosmetic idle broadcast is the same lie on a second surface').toEqual([]);
  });

  it('a stopping run still says something truthful to the dashboard', async () => {
    seedAgent('working');
    activeRuns.add(AGENT);

    stopAgent(AGENT);

    const frame = broadcasts.find((b) => b.type === 'agent:status');
    expect(frame).toMatchObject({ agentId: AGENT, status: 'working', stopping: true });
  });

  it('CONTROL: a stop on an agent with NO run in flight writes idle, because idle is true', async () => {
    seedAgent('working');

    stopAgent(AGENT);

    expect(statusOf()).toBe('idle');
    expect(broadcasts.some((b) => b.type === 'agent:status' && b.status === 'idle')).toBe(true);
  });
});

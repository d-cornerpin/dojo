// ════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T37 — THE STOP BUTTON STOPS THE AGENT AGAIN.
//
// THE DEFECT, as measured on the dev box (orchestrator's repro 2026-08-11
// 07:12:30Z, re-run by W16 at 07:24:30Z — the same shape both times):
//
//   07:24:30.475  Agent stop requested                    ← the button
//   07:24:30.484  v2 agent stopped by user                ← the turn DID halt
//   07:24:30.507  ask re-opened: its turn finalized without delivering an answer
//   07:24:31.571  Processing queued wakeup                ← the stopped run
//   07:24:38.718  Executing tool  work_open                  restarted itself
//
// The stop worked. What undid it was the stopped run's OWN end-of-run drain:
// `handleMessage`'s `finally` asks "is a human still waiting?", the answer is
// yes precisely BECAUSE the stop left the ask unanswered, and it queues a
// wakeup that fires a brand-new turn 500 ms later on the same request.
//
// WHEN IT BROKE: `b2027b0` (2026-06-25, "structured message attribution +
// concurrent turn serialization") added the human-conversation drain to that
// `finally`. Before it, the `finally`'s only re-trigger was
// `if (pendingWakeups.has(agentId))` — and `stopAgent` clears `pendingWakeups`,
// so a stop stayed stopped. Three more self-wake sites have been added to the
// same `finally` since (A2A re-trigger, compile drive, unserved-wake drain),
// none of them stop-aware either.
//
// TWO ROOT-CAUSE PROPERTIES, both pinned below:
//   1. THE FLAG MUST OUTLIVE THE CHECKPOINT THAT HONOURED IT. It used to be
//      deleted by whichever of the three checkpoints saw it first, so by the
//      time the drains ran there was nothing left to see. The run's own
//      `finally` is now the ONE owner of the clear.
//   2. A SELF-WAKE HAS ONE DOOR. Every "wake myself again" site goes through
//      `queueSelfWake`, which refuses while a stop is live. A REAL inbound
//      queued by `handleMessage`'s busy path keeps its direct `add` — the user
//      asking for something new is not the agent resurrecting itself.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  stoppedAgents, pendingWakeups, preemptedAgents, activeAbortControllers,
  queueSelfWake,
} from '../shared-state.js';
import { runPreCallGates } from '../v2/steps/pre-call-gates/index.js';

const AGENT = 'stop-button-agent';

beforeEach(() => {
  stoppedAgents.clear();
  pendingWakeups.clear();
  preemptedAgents.clear();
  activeAbortControllers.clear();
});

// ── PROPERTY 2: one door for self-wakes ──────────────────────────────────────

describe('a stopped run cannot wake itself', () => {
  it('THE RED: a self-wake is REFUSED while the user\'s stop is live', () => {
    stoppedAgents.add(AGENT);
    expect(queueSelfWake(AGENT, 'human-conversation-drain')).toBe(false);
    expect(pendingWakeups.has(AGENT)).toBe(false);
  });

  it('CONTROL: the same self-wake is queued when no stop is live — byte-identical to today', () => {
    expect(queueSelfWake(AGENT, 'human-conversation-drain')).toBe(true);
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });

  it('CONTROL: a stop on ONE agent never touches another agent\'s drain', () => {
    stoppedAgents.add(AGENT);
    expect(queueSelfWake('someone-else', 'unserved-wake-drain')).toBe(true);
    expect(pendingWakeups.has('someone-else')).toBe(true);
    expect(pendingWakeups.has(AGENT)).toBe(false);
  });

  it('a REAL inbound arriving during a stopped run still queues — it is not a self-wake', () => {
    // `handleMessage`'s busy path adds directly, on purpose: a message that
    // arrived while the agent was busy is somebody asking for something, and
    // the stop is about the work the agent was already doing.
    stoppedAgents.add(AGENT);
    pendingWakeups.add(AGENT);
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });
});

// ── PROPERTY 1: the flag outlives the checkpoint that honoured it ────────────

describe('the stop flag outlives the checkpoint that honoured it', () => {

  it('the pre-call gate exits on the stop and LEAVES the flag standing for the drains', async () => {
    const setAgentStatus = vi.fn();
    stoppedAgents.add(AGENT);
    const out = await runPreCallGates(
      { phase: 'preCallGates' } as never,
      { agentId: AGENT, setAgentStatus } as never,
    );
    expect(out).toMatchObject({ directive: 'exit', reason: 'stopped-by-user' });
    // ⚠ RE-DERIVED, NOT LOWERED (T83 fix round, review IMPORTANT A-3). This asserted that the
    // gate WRITES idle. It must not: the turn has not finalized, teardown has not run, and
    // `runtime.ts` still holds the agent in `activeRuns` through a long awaited tail — so idle
    // here is the same untruth `stopAgent` stopped telling, seconds wide instead of minutes,
    // and the same busy-guards believe it. `teardown/index.ts`'s `settleStatus` is the one
    // owner now, and it runs on every exit path including this one.
    expect(setAgentStatus, 'idle before teardown is the audited lie').not.toHaveBeenCalled();
    // THE RED: at HEAD this gate deleted the flag, so `handleMessage`'s drains
    // — which run after the loop breaks — could not tell a stopped run from a
    // finished one and queued the next turn.
    expect(stoppedAgents.has(AGENT)).toBe(true);
  });
});

afterEach(() => {
  stoppedAgents.clear();
  pendingWakeups.clear();
  preemptedAgents.clear();
});

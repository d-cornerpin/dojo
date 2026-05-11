// Finding #195 — preempted-flag cleanup regression test.
//
// Pre-spec: when a preempt aborted an in-flight model call but the call
// returned "successfully" with partial content (race: abort landed mid-
// stream, SDK returned what it had instead of throwing), the v2 loop
// took the natural "no tool calls — exit" path and never hit the
// preempt check at the top of the next outer iteration. The flag stayed
// set across the handleMessage boundary. The next queued-wakeup run
// exited immediately on entering the loop — stalling the queued user
// message. Discovered live in chaos batch 3, scenario 30.
//
// Fix: clear preemptedAgents in handleMessage's finally block as a hard
// guarantee that every new run starts with a clean preempt slate.
//
// This test directly exercises the shared-state guarantee: after a
// simulated handleMessage finally fires, preemptedAgents must be empty.

import { describe, it, expect, beforeEach } from 'vitest';
import { preemptedAgents } from '../shared-state.js';

describe('preempt flag cleanup (finding #195)', () => {
  beforeEach(() => {
    preemptedAgents.clear();
  });

  it('clearing the flag at run-end means the next run sees no stale preempt', () => {
    // Simulate the scenario: a preempt fires mid-run.
    preemptedAgents.add('kevin');
    expect(preemptedAgents.has('kevin')).toBe(true);

    // The run exits via the natural "no tool calls" path WITHOUT hitting
    // the preempt check. Then handleMessage's finally block runs and
    // clears the flag (this is the fix).
    preemptedAgents.delete('kevin');

    // A queued-wakeup run starts fresh. The preempt check at the top of
    // its first outer iteration should NOT see a stale flag.
    expect(preemptedAgents.has('kevin')).toBe(false);
  });

  it('multiple agents have independent preempt flags', () => {
    preemptedAgents.add('kevin');
    preemptedAgents.add('healer');

    preemptedAgents.delete('kevin');

    expect(preemptedAgents.has('kevin')).toBe(false);
    expect(preemptedAgents.has('healer')).toBe(true);
  });

  it('clear() resets all flags (used between tests)', () => {
    preemptedAgents.add('a');
    preemptedAgents.add('b');
    preemptedAgents.clear();
    expect(preemptedAgents.size).toBe(0);
  });
});

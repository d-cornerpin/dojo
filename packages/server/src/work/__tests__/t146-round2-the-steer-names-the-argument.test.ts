// ════════════════════════════════════════════════════════════════════════════════════════
// t146 ROUND 2 (ruling 1) — the escalation steer tells the agent, in one plain sentence, to
// pass `task_id` when it texts or emails the owner about this task, so the tell is recorded and
// the ladder does not raise the task with him again. The steer is an EVENTS-lane notice whose
// body is sliced to the lane's 400-char gist (`memory/assembler.ts:renderEventsLane`), so the
// whole instruction must still arrive whole; the cap is not raised (O15 refused).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { ownerVerdictNudgeText } from '../validation-drive.js';

const TASK = '77cba094-e823-4c22-88d4-bea9645b3191';
const nudge = (agentName = 'HarnessBot', ownerName = 'Marcus'): string => ownerVerdictNudgeText({
  taskId: TASK, title: 'Synthesize the Squarespace and WordPress research into one rundown',
  status: 'in_progress', agentName, ownerName, boundMin: 5,
});

describe('round 2: the steer names the argument', () => {
  it.fails('it tells the agent to pass task_id with this task\'s short id when it texts or emails the owner', () => {
    expect(nudge()).toMatch(/If you text or email him, pass task_id 77cba094\./);
  });

  it('the whole steer still fits the 400-char events gist, with room for longer names than the old copy had', () => {
    expect(nudge().length).toBeLessThanOrEqual(400);
    // The pre-round-2 copy was 380 chars with these names (20 spare); this keeps at least that.
    expect(nudge().length).toBeLessThanOrEqual(380);
  });
});

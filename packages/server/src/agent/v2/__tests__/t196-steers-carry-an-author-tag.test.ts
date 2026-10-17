// t196 (A4) - EVERY ENGINE STEER CARRIES ITS AUTHOR TAG.
// Two truth-guard steers ("you told the user you saved that", "you told the user that went out")
// reached the model with no "[System" / "[Engine" head, so they read as the user's own words. The tag is
// now held at the ONE seam every steer crosses (`enqueueSteer`), and the two texts carry it at the source.
import { describe, it, expect } from 'vitest';
import { emptySteerQueue, enqueueSteer, nextSteer, STEER_PRECEDENCE, type SteerQueue } from '../steer-queue.js';
import { TRUTH_GUARDS } from '../steps/post-call-classify/reply-floors.js';
import { refusedDeliverySteer } from '../refused-delivery.js';

const TAGGED = /^\[(System|Engine)\b/;
const EMPTY: SteerQueue = emptySteerQueue();

describe('t196 (A4) - the two steers that were untagged', () => {
  it('failed-save-claim carries the author head', () => {
    const guard = TRUTH_GUARDS.find((g) => g.floor === 'failed-save-claim')!;
    const state = { steerQueue: EMPTY, toolResults: [{ name: 'vault_remember', isError: true }, { name: 'vault_remember', isError: true }] } as never;
    const verdict = guard.decide(state, { agentId: 'a' } as never, 'Saved that for you.');
    expect(verdict, 'the guard fires on all-rejected saves').not.toBeNull();
    expect(verdict!.content).toMatch(TAGGED);
    expect(verdict!.content).toContain('You told the user you saved that');
  });

  it('false-delivery-claim carries the author head', () => {
    const text = refusedDeliverySteer({ quoted: 'no such recipient' } as never);
    expect(text).toMatch(TAGGED);
    expect(text).toContain('You told the user that went out');
  });
});

describe('t196 (A4) - the seam: nothing untagged reaches the queue', () => {
  it('an untagged steer is tagged on the way in, whatever floor wrote it', () => {
    for (const spec of STEER_PRECEDENCE) {
      const q = enqueueSteer(EMPTY, { floor: spec.id, content: 'Stop and answer the user.', atLoop: 1 });
      expect(nextSteer(q)!.content, spec.id).toMatch(TAGGED);
      expect(nextSteer(q)!.content, spec.id).toContain('Stop and answer the user.');
    }
  });

  it('an already-tagged steer is left byte-identical', () => {
    for (const content of ['[System: do the thing.]', '[Engine: do the thing.]', '[System] do the thing']) {
      const q = enqueueSteer(EMPTY, { floor: 'spinning', content, atLoop: 1 });
      expect(nextSteer(q)!.content).toBe(content);
    }
  });
});

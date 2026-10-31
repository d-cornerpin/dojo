// ════════════════════════════════════════════════════════════════════════════
// A REFUSED TECHNIQUE WRITE MUST SAY isError.
//
// The engine's failure counter, the repeated-call brake and the "reply Saved"
// nudge all read `isError`. The six technique WRITE handlers graded the result
// with `startsWith('Error')` (plus `'Only'` on save/publish/update), but the
// write functions in `techniques/tools.ts` refuse in shapes that start with
// neither:
//   - `Refused: save_technique is reserved for the trainer agent (X).` and the
//     sensei/disabled-trainer variants, plus `Refused: technique file-reference
//     validation found N issue(s):`
//   - `Technique "x" not found. Use list_techniques …`
//   - `Technique "x" is not in draft state (current: y).`
// So a refused save or a typo'd name read as SUCCESS: no failure counted, and
// the engine could tell the agent to just say "Saved". `vault_remember` got its
// bounce-shape regex; these six never did.
//
// The inner techniques layer is stubbed (the handlers load it through
// `await import`), so each handler is driven with every refusal shape and with
// a plain success line, and the invariant "refusal implies isError, success
// does not" is checked on whatever came back.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { stub } = vi.hoisted(() => ({ stub: { text: '' } }));

vi.mock('../../../../techniques/tools.js', () => ({
  // Plain strings, not promises: every inner write function is synchronous and
  // a handler that does not `await` one must be seen exactly as production does.
  executeSaveTechnique: () => stub.text,
  executePublishTechnique: () => stub.text,
  executeUpdateTechnique: () => stub.text,
  executeSubmitForReview: () => stub.text,
  executeTechniqueSetPlaceholder: () => stub.text,
  executeTechniqueFinalize: () => stub.text,
}));
vi.mock('../../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined }) }),
}));

import { techniqueHandlers } from '../techniques.js';

const SIX = [
  'save_technique',
  'publish_technique',
  'update_technique',
  'submit_technique_for_review',
  'technique_set_placeholder',
  'technique_finalize',
] as const;

/** Refusals the write functions really return — none starts with "Error" or "Only" except the last. */
const REFUSALS = [
  'Refused: save_technique is reserved for the trainer agent (X).',
  'Technique "nope" not found. Use list_techniques to see what\'s available.',
  'Error: name is required.',
];

const SUCCESS = 'Technique "t" saved successfully.';

beforeEach(() => { stub.text = ''; });

describe('a refused technique write says isError', () => {
  for (const key of SIX) {
    for (const refusal of REFUSALS) {
      it(`${key}: "${refusal.slice(0, 48)}…" is graded an error`, async () => {
        stub.text = refusal;
        const res = await techniqueHandlers[key]!({ agentId: 'a1', args: {} } as never);
        expect(res.content).toBe(refusal);
        expect(res.isError, `${key} returned "${refusal.slice(0, 80)}" with isError=${String(res.isError)}`).toBe(true);
      });
    }
    it(`${key}: a successful write is not an error`, async () => {
      stub.text = SUCCESS;
      const res = await techniqueHandlers[key]!({ agentId: 'a1', args: {} } as never);
      expect(res.isError).toBe(false);
    });
  }

  it('submit_technique_for_review: not-in-draft refusal is graded an error', async () => {
    stub.text = 'Technique "t" is not in draft state (current: review).';
    const res = await techniqueHandlers.submit_technique_for_review!({ agentId: 'a1', args: {} } as never);
    expect(res.isError).toBe(true);
  });
});

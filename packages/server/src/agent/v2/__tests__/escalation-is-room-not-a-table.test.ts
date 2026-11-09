// ════════════════════════════════════════════════════════════════════════════════════════
// t195 (D2) — THE ESCALATION DECISION: DOUBLE THE LAST BUDGET, BOUNDED BY ROOM, ONCE.
//
// Replaces the fixed 8K/16K/32K/64K chain (a table nobody could size against a model: the
// first rung, 8K, was BELOW the 16,384 the model had just been cut at). The next level is
// twice the budget the cut call was sent with, never above the room that call reported it
// could be given, and extra room is given ONCE per cut. No hard cap lives in the engine.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { outputTruncationClassifier } from '../classifiers/output.js';
import * as stateModule from '../state.js';
import { advance, validate, initState } from '../state.js';

const cut = { stopReason: 'length', contentLength: 0 };

describe('t195 — outputTruncationClassifier escalates by room', () => {
  it('doubles the budget the cut call was sent with', () => {
    const r = outputTruncationClassifier({ ...cut, currentBudget: 16_384, ceiling: 384_000 });
    expect(r).toMatchObject({ truncated: true, escalateTo: 32_768 });
  });

  it('is bounded by the room the cut call reported', () => {
    const r = outputTruncationClassifier({ ...cut, currentBudget: 300_000, ceiling: 384_000 });
    expect(r).toMatchObject({ truncated: true, escalateTo: 384_000 });
  });

  it('has nowhere to go when the cut call already had all the room there is', () => {
    const r = outputTruncationClassifier({ ...cut, currentBudget: 384_000, ceiling: 384_000 });
    expect(r).toMatchObject({ truncated: true, escalateTo: null });
  });

  it('gives extra room ONCE: a cut that was itself the escalated retry is not escalated again', () => {
    const r = outputTruncationClassifier({ ...cut, currentBudget: 32_768, ceiling: 384_000, alreadyEscalated: true });
    expect(r).toMatchObject({ truncated: true, escalateTo: null });
  });

  it('does not guess when the transport reported no room', () => {
    expect(outputTruncationClassifier({ ...cut, currentBudget: 0 })).toMatchObject({ truncated: true, escalateTo: null });
    expect(outputTruncationClassifier({ ...cut, currentBudget: 16_384 })).toMatchObject({ truncated: true, escalateTo: null });
  });

  it('a normal stop is not a truncation', () => {
    expect(outputTruncationClassifier({ stopReason: 'end_turn', contentLength: 5, currentBudget: 16_384, ceiling: 384_000 }))
      .toEqual({ truncated: false });
  });
});

describe('t195 — the fixed chain and its 64,000 wall are gone', () => {
  it('state.ts exports no escalation table', () => {
    expect((stateModule as Record<string, unknown>).nextOutputEscalation).toBeUndefined();
  });

  it('state validation no longer refuses an escalated budget above 64,000', () => {
    const s = advance(initState('test-agent', 'test-model'), { outputTokensEscalated: 384_000 });
    expect(() => validate(s)).not.toThrow();
  });
});

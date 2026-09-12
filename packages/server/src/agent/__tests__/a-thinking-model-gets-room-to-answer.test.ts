// ════════════════════════════════════════════════════════════════════════════════════════
// T72b claim 1 — A THINKING MODEL IS NOT SENT OUT WITH ROOM FOR NO ANSWER.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── THE CLAIM (owner's DS4-server agent) ────────────────────────────────────────────────
// "gen=1024 finish=length" on requests to his manual provider — the reasoning burns the
// whole output budget and no answer is ever written.
//
// ── VERIFIED: THERE IS NO `1024` DEFAULT, AND WE SEND 1024 ANYWAY ───────────────────────
// `max_tokens` on the wire is `min(modelInfo.maxOutputTokens, availableForOutput)`. The
// model's own cap defaults to 16384 for anything unrecognised (`getMaxOutputTokens`), never
// 1024. But `availableForOutput` was
//
//     Math.max(1024, Math.min(floor(contextWindow * 0.25), contextWindow - input - 1000))
//
// and that FLOOR is not a floor, it is the answer, in two situations a local box hits
// constantly:
//
//   1. `contextWindow <= 4096` -> `floor(cw * 0.25) <= 1024`, so the min collapses to the
//      floor no matter what `max_output_tokens` says;
//   2. the assembled prompt is within ~2 K tokens of the declared window — INCLUDING the
//      very common case where the declared window is simply wrong, because a manual
//      provider's /v1/models reports no `context_length` and our validate path writes a
//      guess. Then `cw - input - 1000` is negative and the floor is, again, the answer.
//
// So we ship `max_tokens: 1024` to a model with thinking enabled. It reasons for 1024
// tokens, the provider returns `finish_reason: 'length'`, and the content is empty. The
// engine already has a whole classifier rung for this population — 17 of 19,124 calls
// reaching their cap with nothing to show (`post-call-classify/empty-response.ts`) — so the
// failure was measured before it was understood.
//
// ── THE FIX, IN TWO PLACES, AND WHAT IT DELIBERATELY DOES NOT DO ────────────────────────
// (a) The floor is thinking-aware: a model that spends output tokens on reasoning before it
//     writes a visible word needs enough of them that an answer can still follow. 1024 is a
//     guaranteed empty answer for that shape.
// (b) It applies to the term WE DERIVE, never to a stored `max_output_tokens`. A number a
//     person put in a row is theirs; a number we computed from a context window we guessed
//     is ours to get right. The matching write-side fix is in the validate path, which used
//     to persist `min(floor(cw / 4), 16384)` — exactly 1024 for a 4096-window model.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  resolveOutputBudget,
  OUTPUT_FLOOR_TOKENS,
  THINKING_OUTPUT_FLOOR_TOKENS,
} from '../model.js';

const base = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  thinkingEnabled: false,
  capabilities: [] as string[],
};
const thinking = { ...base, thinkingEnabled: true, capabilities: ['thinking'] };

describe('T72b/1 — the derived output budget leaves room for an answer', () => {
  it('THE DEFECT: a tiny declared window sent a thinking model out with 1024', () => {
    // llama.cpp's default `n_ctx` is 4096, and a provider validate writes exactly that.
    const budget = resolveOutputBudget({ ...thinking, contextWindow: 4096 }, 500);
    // RED at HEAD: floor(4096 * 0.25) = 1024, and the Math.max floor was also 1024.
    expect(budget).toBeGreaterThanOrEqual(THINKING_OUTPUT_FLOOR_TOKENS);
  });

  it('THE DEFECT: a prompt past the declared window sent a thinking model out with 1024', () => {
    // The common manual-provider shape: /v1/models reports no context_length, our guess is
    // wrong, and the box happily accepts a prompt the declared window cannot hold.
    const budget = resolveOutputBudget({ ...thinking, contextWindow: 32_768 }, 35_000);
    expect(budget).toBeGreaterThanOrEqual(THINKING_OUTPUT_FLOOR_TOKENS);
  });

  it('a non-thinking model keeps the floor it has always had', () => {
    expect(resolveOutputBudget({ ...base, contextWindow: 4096 }, 500)).toBe(OUTPUT_FLOOR_TOKENS);
    expect(resolveOutputBudget({ ...base, contextWindow: 32_768 }, 35_000)).toBe(OUTPUT_FLOOR_TOKENS);
  });

  it('thinking must be BOTH supported and enabled to earn the larger floor', () => {
    const cw = { contextWindow: 4096 };
    // Declared capable, switched off by the owner on the Models page.
    expect(resolveOutputBudget({ ...base, ...cw, capabilities: ['thinking'] }, 500))
      .toBe(OUTPUT_FLOOR_TOKENS);
    // Switched on for a model that does not do it.
    expect(resolveOutputBudget({ ...base, ...cw, thinkingEnabled: true }, 500))
      .toBe(OUTPUT_FLOOR_TOKENS);
  });

  it('CONTROL — a healthy cloud model is untouched: 25% of window, capped by its own max', () => {
    // 128k window, small prompt: 25% is 32,000, the model's own cap is 16,384, and the cap
    // wins. This is the number every hosted call has been sending and it must not move.
    expect(resolveOutputBudget(base, 5_000)).toBe(16_384);
    expect(resolveOutputBudget(thinking, 5_000)).toBe(16_384);
  });

  it('CONTROL — the 25% rule still binds when it is the smaller number', () => {
    // 8k window, small prompt: 25% = 2,048, below the model's 16,384 cap.
    expect(resolveOutputBudget({ ...base, contextWindow: 8_192 }, 500)).toBe(2_048);
  });

  it('CONTROL — headroom still binds when the prompt is large but the window is honest', () => {
    // 128k window, 115k prompt: 25% would be 32,000 and the model's cap is 16,384, but only
    // 128,000 - 115,000 - 1,000 = 12,000 tokens are actually left. The smallest real number
    // wins, which is the whole point of the term.
    expect(resolveOutputBudget(base, 115_000)).toBe(12_000);
  });

  it('CONTROL — a STORED cap is never overridden, thinking or not', () => {
    // Someone deliberately capped this model at 800. That is their number, not ours: the
    // floor governs what we DERIVE from a context window, not what a person wrote down.
    expect(resolveOutputBudget({ ...thinking, maxOutputTokens: 800, contextWindow: 4096 }, 500))
      .toBe(800);
  });

  it('the two floors are the documented numbers', () => {
    expect(OUTPUT_FLOOR_TOKENS).toBe(1024);
    expect(THINKING_OUTPUT_FLOOR_TOKENS).toBe(4096);
  });
});

// ⚠ THE INCIDENT THIS FILE EXISTS FOR, in the numbers that were measured on a user's box:
// one ask-title dial = 198 input tokens, 4,156 output tokens (16,218 chars of "thinking"), 60 chars
// of usable title, 275 SECONDS, 5.4 GB of resident runtime, ~60 MB of free pages left, and a Mac
// that stopped responding for the keep-alive window with no agent doing anything.
//
// Every clause below is one of the three dials that produced that, plus the latency budget that
// bounds what a best-effort dial may cost. The fixture numbers ARE the box's numbers.
import { describe, it, expect } from 'vitest';
import {
  utilityDial, isUtilityPurpose, utilityOutputCap, utilityNumCtx, utilityNumCtxExceedsConfigured,
  MIN_UTILITY_NUM_CTX,
} from '../utility-dial.js';
import { ASK_TITLE_LATENCY_BUDGET_MS, ASK_TITLE_INPUT_CHARS, ASK_TITLE_MAX_CHARS } from '../../work/ask-title.js';

/** The box in the incident: a 4b model whose recommendation came out at 28,672 tokens. */
const RECOMMENDED_ON_THE_AFFECTED_BOX = 28_672;
/** What a title dial actually feeds the model: the instruction plus at most this much content. */
const TITLE_INPUT_CHARS = ASK_TITLE_INPUT_CHARS;

describe('a utility dial is declared, never inferred', () => {
  it('every engine artifact the audit found has a dial', () => {
    for (const purpose of [
      'ask_title', 'multistep_classify', 'memory_summarize', 'continuity_brief',
      'vision_caption', 'page_summary', 'voice_opener',
    ]) {
      expect(utilityDial(purpose), purpose).not.toBeNull();
    }
  });

  it('⚠ AN AGENT TURN IS NOT A UTILITY DIAL, and neither is anything unrecognised', () => {
    // This is the clause that stops the whole package from capping somebody's conversation at 64
    // tokens. `agent_turn` is what the served-turn path declares; the router tiers and a typo must
    // all land on "leave this call exactly as it is".
    for (const notUtility of [
      'agent_turn', 'completion', 'fast', 'balanced', 'deep', 'ask-title', 'ASK_TITLE',
      'askTitle', '', null, undefined, 'toString', 'constructor', '__proto__',
    ]) {
      expect(utilityDial(notUtility as string), String(notUtility)).toBeNull();
      expect(isUtilityPurpose(notUtility as string), String(notUtility)).toBe(false);
    }
  });
});

describe('the output cap is sized to the artifact', () => {
  it('a title gets tens of tokens, not thousands', () => {
    const dial = utilityDial('ask_title')!;
    // The measured call spent 4,156 output tokens on an 80-character artifact. The cap has to be in
    // the artifact's order of magnitude, so the clause is written against the ARTIFACT, not the
    // constant: 80 chars of title cannot need more than a hundred tokens.
    expect(dial.maxOutputTokens).toBeLessThan(128);
    expect(dial.maxOutputTokens).toBeGreaterThanOrEqual(Math.ceil(ASK_TITLE_MAX_CHARS / 4));
    expect(dial.maxOutputTokens).toBeLessThan(4_156 / 10);
  });

  it('a classification gets fewer still, and a summary gets room', () => {
    expect(utilityDial('multistep_classify')!.maxOutputTokens).toBeLessThan(128);
    // ⚠ THE OPPOSITE DIRECTION MATTERS TOO: truncating a compaction summary loses conversation
    // history permanently, so this one is deliberately generous.
    expect(utilityDial('memory_summarize')!.maxOutputTokens).toBeGreaterThan(2_000);
  });

  it("a caller's own target may ask for LESS than the ceiling and never for more", () => {
    const summarize = utilityDial('memory_summarize')!;
    // The summariser's prompt says "target approximately N tokens"; the request now enforces it.
    expect(utilityOutputCap(summarize, 400)).toBeLessThan(summarize.maxOutputTokens);
    expect(utilityOutputCap(summarize, 400)).toBeGreaterThanOrEqual(400);   // with slack to finish
    // …and nobody may raise their own ceiling, which is what makes the table a bound.
    expect(utilityOutputCap(summarize, 999_999)).toBe(summarize.maxOutputTokens);
    expect(utilityOutputCap(utilityDial('ask_title')!, 999_999)).toBe(64);
    // An absent or nonsense target falls back to the table rather than to zero.
    expect(utilityOutputCap(summarize, null)).toBe(summarize.maxOutputTokens);
    expect(utilityOutputCap(summarize, Number.NaN)).toBe(summarize.maxOutputTokens);
  });
});

describe('⚠ THE WINDOW IS SIZED TO THE CALL — on Ollama num_ctx is an ALLOCATION, not a limit', () => {
  it("a title's window is a fraction of the one that detonated the box", () => {
    const dial = utilityDial('ask_title')!;
    const sized = utilityNumCtx({
      inputChars: TITLE_INPUT_CHARS,
      outputTokens: dial.maxOutputTokens,
      configuredNumCtx: RECOMMENDED_ON_THE_AFFECTED_BOX,
    });
    // The real finding, in one assertion: 2,000 characters of input does not need 28,672 tokens of
    // KV cache. At ~90 KiB/token for that model, 28,672 tokens is ~2.5 GB of allocation.
    expect(sized).toBeLessThan(RECOMMENDED_ON_THE_AFFECTED_BOX / 4);
    // …and it still comfortably covers the input it was given.
    expect(sized).toBeGreaterThan(TITLE_INPUT_CHARS / 4);
  });

  it('never below the floor, however little the input', () => {
    const sized = utilityNumCtx({ inputChars: 12, outputTokens: 16, configuredNumCtx: 28_672 });
    expect(sized).toBe(MIN_UTILITY_NUM_CTX);
  });

  it('never above the box\'s configured window — that number is the memory budget speaking', () => {
    const sized = utilityNumCtx({ inputChars: 4_000, outputTokens: 256, configuredNumCtx: 2_048 });
    expect(sized).toBeLessThanOrEqual(4_096);
  });

  it('⚠ BUT NEVER BELOW WHAT THE INPUT NEEDS: a truncated prompt is a confident wrong answer', () => {
    // A 200,000-character input against a 2,048-token window. Clamping would silently feed the model
    // a fifth of its prompt; the honest move is to ask for what the input needs and say so.
    const input = { inputChars: 200_000, outputTokens: 512, configuredNumCtx: 2_048 };
    const sized = utilityNumCtx(input);
    expect(sized).toBeGreaterThan(2_048);
    expect(sized).toBeGreaterThan(200_000 / 4);
    expect(utilityNumCtxExceedsConfigured(input)).toBe(true);
    // …and the ordinary case does not report an exceedance.
    expect(utilityNumCtxExceedsConfigured({
      inputChars: TITLE_INPUT_CHARS, outputTokens: 64, configuredNumCtx: 28_672,
    })).toBe(false);
  });

  it('with no configured window at all, our own size is still used', () => {
    // Before t88 this was the dangerous case: no stored value meant no `num_ctx` at all, so Ollama
    // fell back to the Modelfile's own default — which on a modern small model is its full trained
    // context. "We do not know" must not mean "take everything".
    const sized = utilityNumCtx({ inputChars: TITLE_INPUT_CHARS, outputTokens: 64, configuredNumCtx: null });
    expect(sized).toBeGreaterThanOrEqual(MIN_UTILITY_NUM_CTX);
    expect(sized).toBeLessThan(8_192);
  });
});

describe('the latency budget on a best-effort dial', () => {
  it('the title dial has one, and it is in the right order of magnitude', () => {
    // 275 seconds is what it cost without one. The budget has to be far below that and comfortably
    // above the 5-20s a right-sized local dial now takes.
    expect(ASK_TITLE_LATENCY_BUDGET_MS).toBeLessThan(60_000);
    expect(ASK_TITLE_LATENCY_BUDGET_MS).toBeGreaterThanOrEqual(20_000);
    expect(ASK_TITLE_LATENCY_BUDGET_MS).toBeLessThan(275_000 / 5);
    // and the dial table agrees with the caller, so the two cannot drift apart
    expect(utilityDial('ask_title')!.latencyBudgetMs).toBe(ASK_TITLE_LATENCY_BUDGET_MS);
  });
});

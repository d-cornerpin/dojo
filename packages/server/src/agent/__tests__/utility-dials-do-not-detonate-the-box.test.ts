// ⚠ THE INCIDENT THIS FILE EXISTS FOR, in the numbers that were measured on a user's box:
// one ask-title dial = 198 input tokens, 4,156 output tokens (16,218 chars of "thinking"), 60 chars
// of usable title, 275 SECONDS, 5.4 GB of resident runtime, ~60 MB of free pages left, and a Mac
// that stopped responding for the keep-alive window with no agent doing anything.
//
// Every clause below is one of the three dials that produced that, plus the latency budget that
// bounds what a best-effort dial may cost. The fixture numbers ARE the box's numbers.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  utilityDial, isUtilityPurpose, utilityOutputCap, utilityNumCtx, utilityNumCtxExceedsConfigured,
  MIN_UTILITY_NUM_CTX, imageTokenAllowance, MIN_IMAGE_TOKENS, MAX_IMAGE_TOKENS,
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

  it('⚠ THE WINDOW GROWS WITH THE INPUT — a fixed floor is not "input-aware"', () => {
    // A mutant that ignored the input entirely and always returned the floor passed every other
    // clause in this file: a title's input is small enough that the floor already covers it. The
    // property that actually matters is MONOTONIC — more input, more window.
    // ⚠ ONLY ABOVE THE FLOOR, and my first version of this clause got that wrong: 500 and 4,000
    // characters BOTH land on the 2,048 floor, which is the floor doing its job, not a defect. The
    // strict comparison therefore starts where the floor stops binding.
    const windows = [12_000, 40_000, 120_000, 400_000].map((inputChars) => utilityNumCtx({
      inputChars, outputTokens: 256, configuredNumCtx: 1_048_576,
    }));
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i], `window ${i}`).toBeGreaterThan(windows[i - 1]);
    }
    expect(windows[0]).toBeGreaterThan(MIN_UTILITY_NUM_CTX);
    expect(windows[1]).toBeGreaterThan(40_000 / 4);
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

  it('⚠ M2: WITH NO CONFIGURED WINDOW, A LARGE INPUT STILL WINS — the unpinned sibling path', () => {
    // A mutant that made the window ignore its input entirely (`atLeastFloor = MIN_UTILITY_NUM_CTX`)
    // SURVIVED 942 clauses. Every clause drove the CONFIGURED path, where `blocks` survives in the
    // final `Math.max(Math.min(…), blocks)` and keeps the answer right under the mutation — and the one
    // unconfigured clause used an input small enough that the floor was the correct answer anyway.
    // This is the newest behaviour in the module ("we do not know" must not mean "take everything"),
    // so it gets a large input on the path that has no ceiling to fall back on.
    const sized = utilityNumCtx({ inputChars: 400_000, outputTokens: 512, configuredNumCtx: null });
    expect(sized).toBeGreaterThan(400_000 / 4);
    expect(sized).toBeGreaterThan(MIN_UTILITY_NUM_CTX * 10);
    // …and it is still a block multiple, like every other answer this function gives.
    expect(sized % 1_024).toBe(0);
  });

  it('⚠ M1: AN IMAGE IS PART OF THE INPUT, so a caption dial is not sized on its sentence alone', () => {
    // Three declaring sites are `vision_caption` on screenshots. A caption PROMPT is one sentence, so
    // sized on text alone the window lands on the floor while the picture costs thousands of tokens —
    // and a large screenshot then overflows it and truncates the prompt, which this module's own doc
    // says it refuses to do. The floor used to absorb a modest screenshot by luck, not by design.
    const promptOnly = utilityNumCtx({
      inputChars: 120, outputTokens: 256, configuredNumCtx: 28_672,
    });
    const withBigScreenshot = utilityNumCtx({
      inputChars: 120, outputTokens: 256, configuredNumCtx: 28_672,
      imageBase64Lengths: [2_000_000],            // ~1.5 MB of PNG, a retina screen grab
    });
    expect(promptOnly).toBe(MIN_UTILITY_NUM_CTX);
    expect(withBigScreenshot).toBeGreaterThan(promptOnly);
    expect(withBigScreenshot).toBeGreaterThan(MAX_IMAGE_TOKENS);
    // Two images cost more than one, because they do.
    expect(utilityNumCtx({
      inputChars: 120, outputTokens: 256, configuredNumCtx: 28_672,
      imageBase64Lengths: [500_000, 500_000],
    })).toBeGreaterThan(utilityNumCtx({
      inputChars: 120, outputTokens: 256, configuredNumCtx: 28_672,
      imageBase64Lengths: [500_000],
    }));
  });

  it('the image allowance is bounded in both directions', () => {
    // A thumbnail still costs a real encoder pass, and a gigantic upload must not demand a window no
    // box can hold — the cap is what keeps an absurd input from producing an absurd allocation.
    expect(imageTokenAllowance([1_000])).toBe(MIN_IMAGE_TOKENS);
    expect(imageTokenAllowance([50_000_000])).toBe(MAX_IMAGE_TOKENS);
    expect(imageTokenAllowance([])).toBe(0);
    expect(imageTokenAllowance([500_000])).toBeGreaterThan(MIN_IMAGE_TOKENS);
    expect(imageTokenAllowance([500_000])).toBeLessThan(MAX_IMAGE_TOKENS);
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

describe('the dial is wired at its call site, not merely available', () => {
  // ⚠ TWO MUTANTS LIVED THROUGH THIS FILE AND THE WIRE FILE BOTH: deleting `purpose: 'ask_title'`
  // from the title call, and deleting its `abortSignal`. Nothing failed, because the policy and the
  // transport were each covered and the ONE line joining them to this caller was not. A 30-second
  // budget cannot be proven by a 30-second test in a suite that runs on every commit, so the call site
  // is read instead — the same shape the engine's own censuses use for a wiring fact.
  const askTitleSource = readFileSync(new URL('../../work/ask-title.ts', import.meta.url), 'utf-8');

  it('⚠ H1: BOTH OF THE SUMMARISER\'S ROUNDS DECLARE — the retry is the worst one to lose', () => {
    // The review found the aggressive retry declaring neither `purpose` nor `utilityTargetTokens`, so
    // all three dials reverted to pre-t88 behaviour on the path that fires PRECISELY when the first
    // summary came back too large — the biggest bodies on the box, the incident's own shape. Counting
    // the declarations is what catches it: one `callModel` per `purpose`, both ways.
    const src = readFileSync(new URL('../../memory/summarize.ts', import.meta.url), 'utf-8');
    const calls = src.match(/callModel\(\{/g)?.length ?? 0;
    const purposes = src.match(/purpose: 'memory_summarize'/g)?.length ?? 0;
    const targets = src.match(/utilityTargetTokens:/g)?.length ?? 0;
    expect(calls).toBe(2);
    expect(purposes, 'every callModel in the summariser must declare its purpose').toBe(calls);
    expect(targets, 'and each must carry the target its own prompt promised the model').toBe(calls);
    // The retry's target is HALF the first pass's, which is the number its prompt states out loud.
    expect(src).toContain('utilityTargetTokens: Math.floor(targetTokens / 2)');
  });

  it('the title dial DECLARES its purpose', () => {
    expect(askTitleSource).toContain("purpose: 'ask_title'");
  });

  it('…and passes the budget as an abort signal, which is what the transports honour', () => {
    expect(askTitleSource).toContain('abortSignal: AbortSignal.timeout(ASK_TITLE_LATENCY_BUDGET_MS)');
    // `bestEffort` is what makes the abort a warn rather than an agent-level error; the three belong
    // together, so a reader who removes one sees this clause name the other two.
    expect(askTitleSource).toContain('bestEffort: true');
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

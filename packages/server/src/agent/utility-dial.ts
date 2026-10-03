// ════════════════════════════════════════════════════════════════════════════════════════
// UTILITY DIALS — what the ENGINE asks a model for ITSELF, and what it may spend doing it.
//
// ⚠ THIS EXISTS BECAUSE ONE TITLE CALL TOOK 275 SECONDS AND 5.4 GB OF RAM ON A USER'S BOX.
// Since every inbound user message opens an ask ticket, the ingest door fires a fire-and-forget
// model call to name it. On a box whose system model is a small local thinking model, one measured
// call spent 198 input tokens and FOUR THOUSAND ONE HUNDRED AND FIFTY-SIX output tokens — 16,218
// characters of "thinking" — to produce sixty characters of title. The same dial allocated the
// RAM-recommended context window (28,672 tokens) for an input of under two thousand characters,
// which loaded the runtime at 5.4 GB RSS, drove system wired memory from 1.3 GB to 6.4 GB, left
// ~60 MB of free pages and made the WHOLE MACHINE unresponsive — WindowServer, screen sharing, a
// browser — for the keep-alive window, with no agent doing anything at all.
//
// Three dials were wrong and each is wrong on its own:
//   1. THINKING WAS ON, inherited from the per-model toggle meant for an agent's own turns.
//   2. THERE WAS NO OUTPUT CAP — `num_predict` appeared NOWHERE in the engine, so the "Max output"
//      field in Settings was a knob that honoured nothing on the Ollama native path.
//   3. THE CONTEXT WINDOW WAS SIZED FOR THE MODEL, not for the call. A title has ~2,000 characters
//      of input; it was handed a 28K window, and on Ollama the window IS allocated KV memory.
//
// ── WHY A PURPOSE TABLE AND NOT A HEURISTIC ────────────────────────────────────────────────
// The tempting shortcut is `tools === false ⇒ it's a utility call`. That is wrong in this engine and
// the comment on `ModelCallParams.purpose` already says why: `runtime.ts`'s tools gate turns a REAL
// agent turn toolless when the model lacks the capability. A heuristic would have quietly capped a
// person's actual conversation at sixty-four output tokens. So a dial is a utility dial ONLY when its
// caller says so, by name, and anything that does not appear here is left exactly as it was —
// including every agent turn, every fallback retry of an agent turn, and every unknown purpose.
//
// ⚠ NOTHING HERE TOUCHES PROMPT ASSEMBLY. These are request OPTIONS (think, num_predict, num_ctx);
// the message array, its order and the system prompt are untouched, so the prefix cache is unaffected.
// ════════════════════════════════════════════════════════════════════════════════════════

import { estimateTokensFromChars } from '../memory/budget.js';

/** The engine's own artifacts. One name per thing the engine asks a model to produce for itself. */
export type UtilityPurpose =
  | 'ask_title'
  | 'multistep_classify'
  | 'memory_summarize'
  | 'continuity_brief'
  | 'vision_caption'
  | 'page_summary'
  | 'voice_opener';

export interface UtilityDial {
  readonly purpose: UtilityPurpose;
  /**
   * The hard output cap, in tokens, SIZED TO THE ARTIFACT — see each entry for the arithmetic.
   * This is not a performance tuning knob: it is the difference between a title that costs sixty
   * tokens and one that costs four thousand.
   */
  readonly maxOutputTokens: number;
  /**
   * Total latency budget for a BEST-EFFORT dial, after which the call is aborted and the caller's
   * documented fallback is used. `null` means the caller already owns a budget of its own (several
   * of these pass their own `AbortSignal.timeout`) or that the artifact is load-bearing and a
   * truncated answer would be worse than a slow one.
   */
  readonly latencyBudgetMs: number | null;
}

/**
 * ⚠ THE NUMBERS, AND THE ARITHMETIC FOR EACH ONE. A cap pulled from the air is a cap somebody will
 * quietly raise; every entry below says what the artifact is and how many tokens that needs.
 */
const DIALS: Readonly<Record<UtilityPurpose, UtilityDial>> = {
  // A ticket title is capped at 80 CHARACTERS by `ASK_TITLE_MAX_CHARS` and the acceptor rejects
  // anything longer. 80 chars is ~20-25 tokens; 64 leaves room for a model that opens with a short
  // preamble before the title (the acceptor strips those) without leaving room for an essay.
  // ⚠ 30s: this is the dial that took 275 seconds. Its caller is documented as fully handling
  // failure with the ticket's own id, so a slow answer is worth strictly less than a fast fallback.
  ask_title: { purpose: 'ask_title', maxOutputTokens: 64, latencyBudgetMs: 30_000 },

  // `{"multistep": true|false, "name": "3-5 word project name or null"}` — the whole artifact is
  // one small JSON object. 48 tokens covers it with the braces and a long project name.
  // The caller passes its own `AbortSignal.timeout`, so no budget is imposed here.
  multistep_classify: { purpose: 'multistep_classify', maxOutputTokens: 48, latencyBudgetMs: null },

  // A conversation summary, and the ONLY entry whose size the CALLER knows better than this table:
  // `getDepthPrompt(depth, targetTokens)` tells the model its target in words. The cap is applied
  // from that target at the call site (`utilityOutputCap`), and this value is the ceiling for a
  // caller that passes none. 4,096 is generous on purpose: truncating a compaction summary loses
  // conversation history permanently, which is the one failure here worse than being slow.
  memory_summarize: { purpose: 'memory_summarize', maxOutputTokens: 4_096, latencyBudgetMs: null },

  // The continuity brief is a few paragraphs handed to the next turn. 1,024 tokens is about 700
  // words — longer than any brief observed, short enough that a thinking model cannot monologue.
  continuity_brief: { purpose: 'continuity_brief', maxOutputTokens: 1_024, latencyBudgetMs: null },

  // A caption describing a screenshot or an image: one or two sentences for the agent to read.
  // 256 tokens is ~180 words, which is already more than a caption needs.
  vision_caption: { purpose: 'vision_caption', maxOutputTokens: 256, latencyBudgetMs: 30_000 },

  // A fetched web page distilled for the agent. A paragraph or two: 512 tokens.
  page_summary: { purpose: 'page_summary', maxOutputTokens: 512, latencyBudgetMs: 30_000 },

  // The spoken filler sentence while the real reply is still being written. It is SPOKEN, so it is
  // short by nature and long output is actively harmful — the opener must land before the real
  // answer. 96 tokens is about two sentences of speech. The caller owns a tight timeout already.
  voice_opener: { purpose: 'voice_opener', maxOutputTokens: 96, latencyBudgetMs: null },
};

/**
 * The dial for a declared purpose, or `null` when the purpose is not one of the engine's own
 * artifacts — which is the case for every agent turn and every value this table has never heard of.
 *
 * ⚠ UNKNOWN MEANS UNTOUCHED, and that direction is deliberate: a typo'd purpose must leave the call
 * exactly as it is today rather than silently capping somebody's conversation.
 */
export function utilityDial(purpose: string | null | undefined): UtilityDial | null {
  if (typeof purpose !== 'string' || purpose.length === 0) return null;
  return Object.prototype.hasOwnProperty.call(DIALS, purpose)
    ? DIALS[purpose as UtilityPurpose]
    : null;
}

/** True for a call the engine makes for itself, by its own declaration. */
export function isUtilityPurpose(purpose: string | null | undefined): boolean {
  return utilityDial(purpose) !== null;
}

/**
 * The output cap to send, in tokens. A caller that knows its artifact's size (the summariser knows
 * its `targetTokens`) may ask for less than the table's ceiling; nobody may ask for more, because
 * the ceiling is what makes the table a bound rather than a suggestion.
 */
export function utilityOutputCap(dial: UtilityDial, callerTargetTokens?: number | null): number {
  if (typeof callerTargetTokens !== 'number' || !Number.isFinite(callerTargetTokens)) {
    return dial.maxOutputTokens;
  }
  // A caller's target is prose guidance ("about N tokens"), so give it room to land on a sentence
  // boundary rather than clipping mid-word at exactly N.
  const withSlack = Math.ceil(callerTargetTokens * 1.5);
  return Math.max(64, Math.min(dial.maxOutputTokens, withSlack));
}

/** Context windows are requested in whole blocks; Ollama is happiest on 1,024-token boundaries. */
const NUM_CTX_BLOCK = 1_024;
/**
 * The floor for any window we ask for. Below this, small models behave erratically regardless of how
 * little input they were given — and this matches the auto-sizer's own `MIN_RECOMMENDED_NUM_CTX`.
 */
export const MIN_UTILITY_NUM_CTX = 2_048;
/**
 * Slack above input+output, for the chat template's own wrapper tokens and a tokenizer that counts
 * differently from our estimator. 256 is ~1KB of text — cheap insurance against a truncated prompt.
 */
const NUM_CTX_MARGIN_TOKENS = 256;

/**
 * ⚠ WHAT AN IMAGE COSTS THE WINDOW (t88 review M1). A caption prompt is a sentence, so a vision dial's
 * TEXT lands on the 2,048 floor while the picture beside it costs real context — and three of this
 * module's declaring sites are `vision_caption` on screenshots. The floor absorbed a modest screenshot
 * BY LUCK; a large one exceeded it and the prompt was silently truncated, which is the one outcome
 * this module's own doc says it refuses.
 *
 * Ollama's native shape carries images as base64 strings beside the text, and the encoder's real cost
 * is in PIXELS rather than bytes — but bytes track pixels closely enough to size a window, and the only
 * direction that matters here is "do not under-count". A 1080p screenshot is commonly ~0.5-2 MB of
 * base64 and costs an Ollama vision model roughly 600-5,800 tokens depending on tiling, so:
 *   base64 length / 200, floored at 1,024 and capped at 8,192 per image.
 * At 500 KB that is ~2,560 tokens; at 2 MB it saturates the cap. Deliberately generous — a window a
 * little larger than needed costs some KV cache, while one a little too small costs the answer.
 */
export const MIN_IMAGE_TOKENS = 1_024;
export const MAX_IMAGE_TOKENS = 8_192;
const IMAGE_BASE64_CHARS_PER_TOKEN = 200;

export function imageTokenAllowance(base64Lengths: readonly number[]): number {
  return base64Lengths.reduce((sum, len) => {
    const scaled = Math.ceil(Math.max(0, len) / IMAGE_BASE64_CHARS_PER_TOKEN);
    return sum + Math.min(MAX_IMAGE_TOKENS, Math.max(MIN_IMAGE_TOKENS, scaled));
  }, 0);
}

export interface UtilityNumCtxInput {
  /** Every character the model will be shown: the system prompt plus every message. */
  readonly inputChars: number;
  /**
   * The base64 length of each image the call carries. Empty for a text-only dial. Sized by
   * `imageTokenAllowance`, because an image the window does not account for truncates the prompt.
   */
  readonly imageBase64Lengths?: readonly number[];
  /** The output cap this same call will send. */
  readonly outputTokens: number;
  /**
   * The window the model is CONFIGURED for — the user's override, else the RAM-aware recommendation.
   * `null` when neither exists, in which case Ollama would otherwise fall back to the Modelfile's
   * own default, which on a modern small model can be the full trained context.
   */
  readonly configuredNumCtx: number | null;
}

/**
 * ⚠ THE WINDOW THE CALL ACTUALLY NEEDS — the highest-value line in this file, because on Ollama
 * `num_ctx` is not a limit, it is an ALLOCATION: the KV cache is sized to it at load time. A title
 * dial asking for 28,672 tokens asks for ~2.5 GB of KV cache to summarise 2,000 characters.
 *
 * `input + output + margin`, rounded up to a block, and then:
 *   · never below `MIN_UTILITY_NUM_CTX`, because tiny windows make small models erratic;
 *   · never above the configured window, because that is the box's memory budget speaking;
 *   · ⚠ BUT NEVER BELOW WHAT THE INPUT NEEDS EITHER. If a caller's input genuinely exceeds the
 *     configured window, the honest move is to ask for what the input needs and let the memory
 *     budget be exceeded by a call that would otherwise be silently truncated into nonsense. A
 *     truncated prompt does not fail loudly — it produces a confident wrong answer, which is the
 *     worse of the two outcomes. The caller is told by a warn at the call site.
 */
export function utilityNumCtx(input: UtilityNumCtxInput): number {
  const inputTokens = estimateTokensFromChars(Math.max(0, input.inputChars))
    + imageTokenAllowance(input.imageBase64Lengths ?? []);
  const needed = inputTokens + Math.max(0, input.outputTokens) + NUM_CTX_MARGIN_TOKENS;
  const blocks = Math.ceil(needed / NUM_CTX_BLOCK) * NUM_CTX_BLOCK;
  const atLeastFloor = Math.max(MIN_UTILITY_NUM_CTX, blocks);
  if (typeof input.configuredNumCtx !== 'number' || input.configuredNumCtx <= 0) {
    return atLeastFloor;
  }
  // The configured window caps us — unless the input genuinely does not fit in it.
  return Math.max(Math.min(atLeastFloor, input.configuredNumCtx), blocks);
}

/** True when the input could not fit the configured window, so the window was raised to fit it. */
export function utilityNumCtxExceedsConfigured(input: UtilityNumCtxInput): boolean {
  if (typeof input.configuredNumCtx !== 'number' || input.configuredNumCtx <= 0) return false;
  return utilityNumCtx(input) > input.configuredNumCtx;
}

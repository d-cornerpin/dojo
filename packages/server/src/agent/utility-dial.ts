// UTILITY DIALS: request options (think, num_predict, num_ctx) for the engine's own artifact calls.
// Prompt assembly is untouched, so the prefix cache is unaffected; caps are sized to each artifact.

import { effectiveDivisor } from '../memory/budget.js';

export type UtilityPurpose =
  | 'ask_title'
  | 'memory_summarize'
  | 'continuity_brief'
  | 'vision_caption'
  | 'page_summary';

export interface UtilityDial {
  readonly purpose: UtilityPurpose;
  readonly maxOutputTokens: number;
  /** Abort and fall back after this; null = the caller owns a timeout, or a slow answer beats a truncated one. */
  readonly latencyBudgetMs: number | null;
}

const DIALS: Readonly<Record<UtilityPurpose, UtilityDial>> = {
  // 30s: the caller falls back to the ask's own id, so slow is worth less than fast.
  ask_title: { purpose: 'ask_title', maxOutputTokens: 64, latencyBudgetMs: 30_000 },

  // 4,096 on purpose: truncating a compaction summary loses conversation history permanently.
  memory_summarize: { purpose: 'memory_summarize', maxOutputTokens: 4_096, latencyBudgetMs: null },

  continuity_brief: { purpose: 'continuity_brief', maxOutputTokens: 1_024, latencyBudgetMs: null },

  vision_caption: { purpose: 'vision_caption', maxOutputTokens: 256, latencyBudgetMs: 30_000 },

  page_summary: { purpose: 'page_summary', maxOutputTokens: 512, latencyBudgetMs: 30_000 },
};

// Unknown purpose returns null: the call stays EXACTLY as today, never silently capped, because
// tools===false is also true of a real agent turn on a toolless model (runtime.ts gate).
export function utilityDial(purpose: string | null | undefined): UtilityDial | null {
  if (typeof purpose !== 'string' || purpose.length === 0) return null;
  return Object.prototype.hasOwnProperty.call(DIALS, purpose)
    ? DIALS[purpose as UtilityPurpose]
    : null;
}

export function isUtilityPurpose(purpose: string | null | undefined): boolean {
  return utilityDial(purpose) !== null;
}

// A caller may ask for less than the table's ceiling, never more: the ceiling is what makes it a bound.
export function utilityOutputCap(dial: UtilityDial, callerTargetTokens?: number | null): number {
  if (typeof callerTargetTokens !== 'number' || !Number.isFinite(callerTargetTokens)) {
    return dial.maxOutputTokens;
  }
  const withSlack = Math.ceil(callerTargetTokens * 1.5);
  return Math.max(64, Math.min(dial.maxOutputTokens, withSlack));
}

export const NUM_CTX_BLOCK = 1_024;
// Tiny windows make small models erratic; matches the auto-sizer's MIN_RECOMMENDED_NUM_CTX.
export const MIN_UTILITY_NUM_CTX = 2_048;
export const NUM_CTX_MARGIN_TOKENS = 256;

// An image costs the window real context (pixels; bytes track them closely enough).
// Under-counting is the only wrong direction: a short window silently truncates the prompt.
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
  readonly inputChars: number;
  readonly imageBase64Lengths?: readonly number[];
  readonly outputTokens: number;
  readonly configuredNumCtx: number | null;
  readonly charsPerToken?: number | null;
}

// On Ollama num_ctx IS the allocation: the KV cache is sized to it at load time, so it is
// sized to the CALL, never below what the input needs: a truncated prompt gives a confident wrong answer.
export function utilityNumCtx(input: UtilityNumCtxInput): number {
  const inputTokens = Math.ceil(Math.max(0, input.inputChars) / effectiveDivisor(input.charsPerToken)) + imageTokenAllowance(input.imageBase64Lengths ?? []);
  const needed = inputTokens + Math.max(0, input.outputTokens) + NUM_CTX_MARGIN_TOKENS;
  const blocks = Math.ceil(needed / NUM_CTX_BLOCK) * NUM_CTX_BLOCK;
  const atLeastFloor = Math.max(MIN_UTILITY_NUM_CTX, blocks);
  if (typeof input.configuredNumCtx !== 'number' || input.configuredNumCtx <= 0) {
    return atLeastFloor;
  }
  return Math.max(Math.min(atLeastFloor, input.configuredNumCtx), blocks);
}

export function utilityNumCtxExceedsConfigured(input: UtilityNumCtxInput): boolean {
  if (typeof input.configuredNumCtx !== 'number' || input.configuredNumCtx <= 0) return false;
  return utilityNumCtx(input) > input.configuredNumCtx;
}

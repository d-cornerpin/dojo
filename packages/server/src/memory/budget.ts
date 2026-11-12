// The budget: one module owns the window, the compaction threshold, the reserve and the token estimator.
// It is a leaf: callers pass the window, not a model (a model lookup would make it cyclic with its consumers).
// `CHARS_PER_TOKEN` is 4, measured against provider-reported input tokens; re-derive before changing it.

// The one import: stream-patience.ts is a leaf too (no cycle); its ceiling cap is reused, never re-derived.
import { providerAwareBudgetTokens } from '../agent/stream-patience.js';


export const CHARS_PER_TOKEN = 4;

/** The one char-based token estimator (usage fallbacks and recall-budget accounting stay separate: other jobs). */
export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

// The request estimate (apart from the provider-agnostic `estimateTokens`) feeds the fit gate and
// `resolveOutputBudget`. Not tunable, never shrinks: divisors capped at 4, result floored at the `/4` answer.
// The ledger stores totalChars / tokens, never a flat 4, so chars = estimate x divisor stays exact.

export interface RequestChars {
  readonly proseChars: number;
  readonly schemaChars: number;
}

export interface MeasuredDivisors {
  readonly prose: number | null;
  readonly dense: number | null;
}

export interface RequestEstimate {
  readonly tokens: number;
  readonly effectiveCharsPerToken: number;
}

export function effectiveDivisor(measured: number | null | undefined): number {
  if (typeof measured !== 'number' || !Number.isFinite(measured) || measured <= 0) {
    return CHARS_PER_TOKEN;
  }
  return Math.min(CHARS_PER_TOKEN, measured);
}

/** Each population's chars over its measured divisor, floored at the constant's answer. Pure. */
export function estimateRequestTokens(chars: RequestChars, measured: MeasuredDivisors): RequestEstimate {
  const proseChars = Math.max(0, chars.proseChars);
  const schemaChars = Math.max(0, chars.schemaChars);
  const totalChars = proseChars + schemaChars;

  const split = Math.ceil(proseChars / effectiveDivisor(measured.prose))
    + Math.ceil(schemaChars / effectiveDivisor(measured.dense));

  const tokens = Math.max(split, estimateTokensFromChars(totalChars));

  return {
    tokens,
    effectiveCharsPerToken: tokens > 0 ? totalChars / tokens : CHARS_PER_TOKEN,
  };
}

export function estimateStoredTokens(text: string): number {
  return Math.max(1, estimateTokens(text));
}

// A stored row costs what the wire carries: tool-call assistant rows also replay `reasoning_content`, so it counts.

/** The replay rule: reasoning rides an assistant turn iff that turn carries a tool call. The replay site in
 *  `agent/model.ts` and this budget ask this same function, so the budget never bills bytes the serialiser drops. */
export function reasoningRidesThisTurn(content: unknown): boolean {
  const blocks = typeof content === 'string' ? tryParseBlocks(content) : content;
  return Array.isArray(blocks)
    && blocks.some((b) => (b as { type?: unknown } | null)?.type === 'tool_use');
}

function tryParseBlocks(content: string): unknown {
  if (content.length === 0 || content[0] !== '[') return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export interface StoredRowCostInput {
  role: string;
  content: string;
  tokenCount?: number | null;
  reasoningContent?: string | null;
  /** Reasoning retired at a compaction boundary no longer replays, so it costs nothing. */
  reasoningAgedOut?: boolean | null;
  attachmentTokens?: number;
}

export function replayedReasoningTokens(m: StoredRowCostInput): number {
  if (m.role !== 'assistant' || !m.reasoningContent || m.reasoningAgedOut) return 0;
  return reasoningRidesThisTurn(m.content) ? estimateTokens(m.reasoningContent) : 0;
}

/** Cost of carrying one stored row: the one expression the fresh-tail lane, `budgetFreshTail` and the compaction
 *  gate spend. `||` not `??`: a stored `token_count` of 0 is a missing measurement, not a free row. */
export function storedRowCost(m: StoredRowCostInput): number {
  return Math.max(1, m.tokenCount || estimateTokens(m.content)) + replayedReasoningTokens(m) + (m.attachmentTokens ?? 0);
}

// An image is costed from its pixels, not its base64 length (no provider bills that). The constants below are
// measured receipts, the worst arm of each; re-measure before touching one (`__tests__/image-token-rate.test.ts`).

export const IMAGE_TOKENS_PER_MEGAPIXEL = 1408;

export const IMAGE_TOKEN_FLOOR = 258;

/** The largest bill any image produced (qwen3.5-9b at 4096x4096 and up); providers downscale past it. */
export const IMAGE_TOKEN_CEILING = 16387;

export function estimateImageTokens(width: number, height: number): number {
  const megapixels = (Math.max(0, width) * Math.max(0, height)) / 1_000_000;
  const fromPixels = Math.ceil(megapixels * IMAGE_TOKENS_PER_MEGAPIXEL);
  return Math.min(IMAGE_TOKEN_CEILING, Math.max(IMAGE_TOKEN_FLOOR, fromPixels));
}

/** Pixel dimensions from an image's magic bytes; null when unreadable (a question for the caller). */
export function imagePixelDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString('ascii') === 'GIF') {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  // JPEG: scan segments for an SOFn marker (FF C0..CF, excluding C4, C8, CC which are DHT, JPG, DAC).
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      }
      const segLen = bytes.readUInt16BE(i + 2);
      if (segLen < 2) break;
      i += 2 + segLen;
    }
  }
  if (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const fourcc = bytes.subarray(12, 16).toString('ascii');
    if (fourcc === 'VP8X') {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
    if (fourcc === 'VP8L') {
      const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
      return {
        width: 1 + ((b1 | (b2 << 8)) & 0x3fff),
        height: 1 + (((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff),
      };
    }
    if (fourcc === 'VP8 ') {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}


/** Compaction threshold and assembler fill, chosen for fuller context and rarer compaction; not a tunable. */
export const CONTEXT_THRESHOLD = 0.96;

/** The output half of the reserve: covers over 99.9% of measured generations (p99.9 3,121 in 8,244 calls).
 *  It bounds history admitted, not the answer: max_tokens uses what the window has left. Never tune it. */
export const OUTPUT_RESERVE_TOKENS = 4096;

/** The reserve the assembler must not spend because the model layer will: the agent's tool payload (measured per
 *  agent per call) plus the output half, capped at what the model can emit. */
export function toolAndOutputReserve(measured: {
  toolPayloadTokens: number;
  maxOutputTokens?: number;
}): number {
  const tools = Math.max(0, Math.ceil(measured.toolPayloadTokens || 0));
  const cap = measured.maxOutputTokens;
  const output = Number.isFinite(cap) && (cap as number) > 0
    ? Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(cap as number))
    : OUTPUT_RESERVE_TOKENS;
  return tools + output;
}

export const SUMMARY_SHARE = 0.7;

/** Cached lanes are walked first and may spend at most this share of the content budget; the rest is
 *  the tail's floor. Equals `SUMMARY_SHARE`, a separate name so changing one never moves the other. */
export const CACHED_REGION_SHARE = 0.7;

/** The window's row rung: sizes the tail horizon's row ceiling and the trim block (`tail-horizon.ts`).
 *  Not the protected recent part, which is tokens (`ContextView.protectedFromSeq` in `assembler.ts`). */
export function getFreshTailCount(contextWindow: number): number {
  const cw = clampWindow(contextWindow);
  if (cw >= 200000) return 80;   // 200k+ (Sonnet, Opus), ~15-20 turns
  if (cw >= 128000) return 64;   // 128k (GPT-4o), ~12-15 turns
  if (cw >= 32000) return 40;    // 32k models, ~8-10 turns
  return 24;                     // Small models, ~5 turns
}


export interface ContextWindowPolicy {
  contextWindow: number;
  compactionThreshold: number;
  toolAndOutputReserve: number;
  /** What the assembler may spend on system prompt plus messages. Never negative. */
  assemblyBudgetTokens: number;
  freshTailCount: number;

}

function clampWindow(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow < 0) return 0;
  return contextWindow;
}

/** The window numbers, derived once, clamped at 0 (`assertSystemPromptFits` makes a zero budget loud).
 *  `measured` is required so no caller falls back to an underived constant. `providerCeilingTokens`
 *  (optional) also caps the window budget; null leaves the window expression exactly. */
export function contextWindowPolicy(
  contextWindow: number,
  measured: { toolPayloadTokens: number; maxOutputTokens?: number; providerCeilingTokens?: number | null },
): ContextWindowPolicy {
  const cw = clampWindow(contextWindow);
  const reserve = Math.max(0, toolAndOutputReserve(measured));
  // Two bounds, each with its own reserve: the window holds tools, output and assembly, so the whole reserve comes
  // off it; the prefill ceiling bounds what the box must prefill (tools yes, output no), so only tools come off it.
  const windowBudget = Math.max(0, Math.floor(CONTEXT_THRESHOLD * cw) - reserve);
  const { providerCeilingTokens } = measured;
  const inputReserve = Math.max(0, Math.ceil(measured.toolPayloadTokens || 0));
  const assemblyBudgetTokens = providerCeilingTokens != null
    ? Math.max(0, Math.min(windowBudget, providerAwareBudgetTokens(Number.POSITIVE_INFINITY, providerCeilingTokens) - inputReserve))
    : windowBudget;
  return {
    contextWindow: cw,
    compactionThreshold: CONTEXT_THRESHOLD,
    toolAndOutputReserve: reserve,
    assemblyBudgetTokens,
    freshTailCount: getFreshTailCount(cw),
  };
}

export class SystemPromptTooLargeError extends Error {
  constructor(
    readonly systemPromptTokens: number,
    readonly policy: ContextWindowPolicy,
  ) {
    super(
      `system prompt does not fit its own budget: ${systemPromptTokens} tokens against an ` +
      `assembly budget of ${policy.assemblyBudgetTokens} ` +
      `(window ${policy.contextWindow} × ${policy.compactionThreshold} − reserve ${policy.toolAndOutputReserve}). ` +
      `No message can be admitted, so nothing about this turn would be true. ` +
      `Fix one of the three: the model's window, the system prompt's size, or the reserve.`,
    );
    this.name = 'SystemPromptTooLargeError';
  }
}

/** Fail loud rather than assemble a lie: a negative budget would otherwise give a one-message context silently. */
export function assertSystemPromptFits(systemPromptTokens: number, policy: ContextWindowPolicy): void {
  if (systemPromptTokens > policy.assemblyBudgetTokens) {
    throw new SystemPromptTooLargeError(systemPromptTokens, policy);
  }
}

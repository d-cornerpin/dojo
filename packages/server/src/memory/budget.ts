// ════════════════════════════════════════════════════════════════════════════════════════
// THE BUDGET. One module owns the window, the thresholds, the reserve — and the estimator.
// PHASE-3 T2. Research 06 requirement A1/A2.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHAT STOOD HERE BEFORE, measured at `81fc6b7` (PHASE-3 §T0-C) ───────────────────────
// The same three numbers were declared in five modules, and two of the copies DISAGREED:
//
//   the threshold      memory/assembler.ts:26     0.75   the assembler's fill fraction
//                      memory/compaction.ts:209   0.96   the compaction gate
//                      agent/v2/classifiers/compaction.ts:38-41   0.90 / 0.96 / 0.99
//                      memory/compaction.ts:529   0.90 and 0.96 again, as bare literals
//   the reserve        memory/assembler.ts:670    15000  a LOCAL literal
//                      memory/compaction.ts:82    15000  the exported const
//   the assembly       memory/assembler.ts:671    floor(0.75·cw) − 15000
//   budget             memory/compaction.ts:123   floor(0.96·cw) − 15000
//
// That last pair is the one that matters: `estimateAssembledTokens` existed to cap the
// compaction gate's summary total "at the same budget the assembler applies", and it
// modelled that budget with its OWN threshold. Two functions, one noun, different answers.
//
// ── THE THRESHOLD IS DECIDED, NOT DERIVED ───────────────────────────────────────────────
// PHASE-3 T0b, owner, 2026-07-26, asked with the current value in hand: **0.96 — keep
// current behaviour.** Fuller context, dearer turns, rarer compaction, with the existing
// 0.90 WARN line. It is THE constant here and no task re-asks it.
//
// A real product change, stated out loud: the assembler used to stop filling at 0.75 while
// compaction only fired at 0.96, so it dropped history 21 points of window before anything
// would have compacted it. One threshold closes that gap, in the direction the owner chose.
//
// ── THE ESTIMATOR, AND WHY /4 ───────────────────────────────────────────────────────────
// §T0-C found SIX implementations plus a SQL dialect. Their divisors are a CLAIM ABOUT
// REALITY, so T2 measured reality rather than picking the most popular fork: 1,409 real
// context receipts joined to their own `cost_records` row (same agent, same instant),
// against the live tools payload measured at 70,006 chars for the primary agent —
//
//     Kevin, n=289 calls:  3.88 – 3.93 chars per token
//                          per-call p10 3.78 · median 3.92 · p90 3.99
//
//     /4    2% UNDER the measured cost   ← survivor
//     /3.5  12% over
//     /3    30% over
//
// A 30% over-estimate is not caution; it is the assembler dropping history the window did
// not require — the same defect Step 3b removes from the stored column. /4 is also already
// the dialect in `messages.token_count`, in `agent/v2/receipt.ts` and in the SQL, so the
// canonical value costs no rewrite of history it did not owe. The 2% shortfall is not
// hidden: Step 3 records the provider's own `input_tokens` beside this estimate on every
// call, so the error is measured and trending. Re-derive before changing it; never tune it.
//
// ── WHY THIS TAKES A WINDOW AND NOT A MODEL ─────────────────────────────────────────────
// The plan wrote `ContextWindowPolicy(model)`, but `getContextWindow(modelId)` lives in
// `agent/model.ts` → `memory/message-store.js` → `memory/store.js` → here, so taking a
// modelId would make the budget cyclic with its own consumers. Callers already hold the
// window and pass it; the policy is a pure function of it, and testable without a database.
// ════════════════════════════════════════════════════════════════════════════════════════

// ── The estimator ──

/** Characters per token. Measured, not inherited — see the header. */
export const CHARS_PER_TOKEN = 4;

/**
 * THE token estimator. One implementation, whole tree.
 *
 * Every other divisor in the repo was folded into this one at PHASE-3 T2:
 * `memory/store.ts` (/4), `agent/model.ts` Anthropic (/3.5) and OpenAI (/3),
 * `agent/v2/receipt.ts` (/4), `vault/maintenance.ts` (/3), `healer/healer-agent.ts` (/3).
 *
 * NOT folded in, deliberately, because they do a different job (§T0-C):
 *   `agent/model.ts:1682-1683` and `providers/anthropic-sdk.ts:365,:368` — usage
 *   FALLBACKS, used only when a provider reports no usage at all; and
 *   `agent/tools.ts:4992,:5030,:10465` — recall-budget accounting. A "one estimator"
 *   rule that ate those would make the phase look finished while breaking two features.
 */
export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

/**
 * The same estimate for a caller that already counted the characters and no longer holds
 * the text — `agent/v2/receipt.ts` measures a prompt it has already joined and released.
 * One implementation: `estimateTokens` is this function with a `.length` in front of it.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/**
 * The cost of carrying one STORED ROW, which is `estimateTokens` plus the floor the write
 * path has always applied (`memory/message-store.ts:227`): "never zero — a row that costs
 * nothing to carry does not exist". A name, not a second estimator: it calls the one above.
 */
export function estimateStoredTokens(text: string): number {
  return Math.max(1, estimateTokens(text));
}

// ── The replayed-reasoning half of a row's cost (T56 leg (a)) ────────────────────────────
//
// A STORED ROW COSTS WHAT THE WIRE WILL CARRY, and until T56 every arithmetic here counted
// its `content` and stopped. Assistant rows that carry a tool call ALSO ship their stored
// `reasoning_content` back to the provider (`agent/model.ts`'s replay site, dsh's own
// passback rule), and those tokens were spent by every request and billed to no budget:
//
//   • 7,575 replayable rows on the dev body carried 3,806,926 reasoning tokens against the
//     690,900 content tokens the assembler counted for the same rows — 5.5x.
//   • the worst single row (`d68a9576…`) was budgeted at 35 tokens and carried 14,310.
//   • across 37,872 sliding 40-row windows of that body: mean counted 6,025, mean UNCOUNTED
//     3,981, max uncounted 78,909. Eviction and the compaction gate were both deciding
//     against a number that was ~60% of the truth.
//
// This changes NO REQUEST BYTE. The same rows render the same way; only the count that
// decides how many of them fit is now the count of what is actually sent.

/**
 * THE REPLAY RULE, in one place. Reasoning rides an assistant turn if and only if that turn
 * carries a tool call — dsh's official passback rule (`llm-deepseek/src/serialize.ts:96-100`:
 * "reasoning_content must return on tool-call turns; it is ignored on plain turns"), adopted
 * at HL8 (C). The replay site in `agent/model.ts` and the token arithmetic here ask the SAME
 * question through this function, so the budget can never bill for bytes the serialiser drops
 * (or miss bytes it sends).
 *
 * Takes either a parsed block array or a stored row's JSON text; a plain-text row can never
 * carry a tool call, which is why the parse failure arm is `false` rather than an error.
 */
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

/** The fields a row's cost is computed from. Structural on purpose: the assembler holds a
 *  `Message`, the compaction gate holds the same rows, and neither has to hand this module
 *  a database type it would then have to import. */
export interface StoredRowCostInput {
  role: string;
  content: string;
  tokenCount?: number | null;
  reasoningContent?: string | null;
  /** T56 leg (b): a row whose reasoning was retired at a compaction boundary no longer
   *  replays it, so it no longer costs anything either. */
  reasoningAgedOut?: boolean | null;
}

/** What this row's `reasoning_content` will cost on the wire — 0 when nothing replays it. */
export function replayedReasoningTokens(m: StoredRowCostInput): number {
  if (m.role !== 'assistant' || !m.reasoningContent || m.reasoningAgedOut) return 0;
  return reasoningRidesThisTurn(m.content) ? estimateTokens(m.reasoningContent) : 0;
}

/**
 * COST OF CARRYING ONE STORED ROW. One owner for the expression the assembler's fresh-tail
 * lane, `budgetFreshTail` and the compaction gate all spend.
 *
 * The content half is `memory/assembler.ts`'s own `storedRowCost`, moved here unchanged and
 * with its history intact — PHASE-3 T3 found it written `msg.tokenCount ?? estimateTokens(…)`,
 * and `0 ?? x` is **0**, so a row whose stored `token_count` was 0 was FREE TO CARRY (§T0-D
 * measured 116 such rows before migration `150` re-computed every row to `MAX(1, …)`; any
 * writer bypassing `memory/message-store.ts` — the kit's own golden fixture is one — brings
 * it straight back). `||` not `??`, deliberately: a stored 0 is not a measurement, it is a
 * missing one. The compaction gate's copy used `??` and now shares this one.
 *
 * The reasoning half is T56 leg (a), above.
 */
export function storedRowCost(m: StoredRowCostInput): number {
  return Math.max(1, m.tokenCount || estimateTokens(m.content)) + replayedReasoningTokens(m);
}

// ── The image estimator (PHASE-6 T4-CAP) ────────────────────────────────────────────────
//
// AN IMAGE IS NOT TEXT AND MUST NOT BE BILLED AS TEXT. Everything above answers "what does
// this text cost", and until 2026-08-04 an image block was answered by the same function —
// `messageTokens` JSON-stringified the block, so an image cost the length of its base64
// over four. **No provider charges for base64 length.** The fallback vision captioner's own
// payload — one image and three sentences — therefore measured 185,178 tokens against
// budgets of 170,071–179,553 and C11 threw at the provider boundary before the request was
// ever sent; the agent then told its owner its vision pipeline had failed. Nine of those
// refusals are on the platform's own durable record (`~/.dojo/logs/assembly-validation.jsonl`,
// 2026-08-01 → 2026-08-03, `tokenTotal` 185,178 on every one), and the user-visible symptom
// is `behav-sig:360ba8e3` in `DOJO-ISSUES-LOG.md`.
//
// ── THE THREE NUMBERS BELOW ARE RECEIPTS. Re-measure before touching one. ────────────────
// Driven on the dev box 2026-08-04: **64 image calls + 20 text-only controls = 84 provider
// receipts**, five models over two providers (`google/gemini-2.5-flash-image`,
// `google/gemini-3.1-flash-image-preview`, `qwen/qwen3.5-9b`, `~moonshotai/kimi-latest` via
// OpenRouter; `gemma4:31b` via ollama-local). Each call replayed `captionOne`'s exact
// payload carrying ONE synthetic PNG of known dimensions; an image's own bill is that call's
// provider-reported `input_tokens` minus the text-only control's. The receipts are kept at
// `~/.dojo/receipts/t4cap-image-token-measurement/` and, per call, in `cost_records`, where
// `estimated_input_tokens` (ours) sits beside `input_tokens` (theirs).
//
//   BYTES DO NOT MOVE THE BILL, and that one fact IS the defect. Nine flat-vs-noise pairs at
//   IDENTICAL dimensions, byte ratios up to 346x: the largest provider token delta across
//   all nine was **3**. Our estimator moved by up to 65,463 on the same pairs.
//
//   PIXELS DO. Per-megapixel rates measured: gemini 2.5 / 3.1 flat 258 at every size ·
//   gemma4 ~450 · qwen ~980 · kimi ~1,300–1,408. Above each provider's own working
//   resolution the curve STOPS — kimi bills a flat 11,674 from 3,072² through 8,192² (67
//   megapixels), qwen a flat 16,387 from 4,096² up — because providers downscale.
//
// The law is the worst arm of that measurement, because the direction of error matters:
// an estimator that UNDER-bills lets the allocator admit an assembly the provider will
// refuse, which is the failure requirement C11 exists to prevent. Checked against all 64
// measurements — 0 under-billed, two of them exactly on the bound (kimi 512² sets the slope,
// qwen 4,096²+ sets the ceiling). `__tests__/image-token-rate.test.ts` pins the corpus.
//
// ⚠ ONE HONEST VARIANCE, recorded rather than smoothed away: OpenRouter routed the SAME
// model and the SAME image to backends with different image preprocessing, so `qwen3.5-9b`
// billed between 963 and 16,387 tokens for one 4,096² image across four drives. The law
// covers the expensive arm; a cheaper one costs the allocator nothing but headroom.

/** Tokens per megapixel — the STEEPEST rate measured (kimi-latest @ 512x512). */
export const IMAGE_TOKENS_PER_MEGAPIXEL = 1408;

/** No image was measured to cost less than this. Both Gemini models bill it flat, at every
 *  size from 64x64 to 1536x1536, so a thumbnail is not free anywhere. */
export const IMAGE_TOKEN_FLOOR = 258;

/** The largest bill any image produced (qwen3.5-9b at 4096x4096 and above). Past its own
 *  working resolution a provider downscales, so the curve stops climbing — and an estimator
 *  that kept climbing would refuse assemblies the provider would have answered. */
export const IMAGE_TOKEN_CEILING = 16387;

/**
 * What one image costs, from its pixels — the only dimension the receipts show a provider
 * charging for. Unknown dimensions are the caller's problem, not this function's: see
 * `IMAGE_TOKEN_CEILING` for what "I cannot size it" must cost.
 */
export function estimateImageTokens(width: number, height: number): number {
  const megapixels = (Math.max(0, width) * Math.max(0, height)) / 1_000_000;
  const fromPixels = Math.ceil(megapixels * IMAGE_TOKENS_PER_MEGAPIXEL);
  return Math.min(IMAGE_TOKEN_CEILING, Math.max(IMAGE_TOKEN_FLOOR, fromPixels));
}

/**
 * Pixel dimensions sniffed from an image's own magic bytes. Returns null for anything it
 * cannot read, which is a QUESTION for the caller and never an answer — see #15.
 *
 * ONE OWNER: this was `services/image-generation.ts`'s private `getImageDimensions`, where
 * the cost tracker used it for megapixel-priced models. It moved here rather than being
 * copied, because two functions answering "how big is this image" is how the six token
 * estimators happened. `image-generation.ts` imports this one.
 */
export function imagePixelDimensions(bytes: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature 89 50 4E 47 0D 0A 1A 0A, then IHDR with width at offset 16 and
  // height at offset 20, both big-endian uint32.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // GIF: 'GIF87a' / 'GIF89a', then width and height as little-endian uint16.
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString('ascii') === 'GIF') {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  // JPEG: starts FF D8. Scan segments for an SOFn marker (FF C0..CF, excluding C4/C8/CC
  // which are DHT/JPG/DAC). The 5 bytes after the marker are precision, height, width.
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
  // WebP: RIFF....WEBPVP8?
  if (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const fourcc = bytes.subarray(12, 16).toString('ascii');
    if (fourcc === 'VP8X') {
      // Extended: 4-byte flags @ offset 20, then 3-byte (width-1) LE, 3-byte (height-1) LE.
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
    if (fourcc === 'VP8L') {
      // Lossless: 1 byte signature 0x2F at offset 20, then 14-bit (width-1), 14-bit (height-1).
      const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
      return {
        width: 1 + ((b1 | (b2 << 8)) & 0x3fff),
        height: 1 + (((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff),
      };
    }
    if (fourcc === 'VP8 ') {
      // Lossy: dimensions at offset 26 (frame tag + start code already past).
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

// ── The thresholds ──

/**
 * THE compaction threshold. Owner ruling, PHASE-3 T0b, 2026-07-26: 0.96, keep current
 * behaviour. Fuller context, dearer turns, rarer compaction. No task re-asks this.
 */
export const CONTEXT_THRESHOLD = 0.96;

/** The WARN line that has always sat below it (Part V). Every WARN is an architecture bug. */
export const CONTEXT_WARN_THRESHOLD = 0.90;

/** Above this the turn is surrendered rather than sent (v2 Part V's `block` rung). */
export const CONTEXT_BLOCK_THRESHOLD = 0.99;

/**
 * THE OUTPUT HALF OF THE RESERVE. **DERIVED, and here is the derivation** (PHASE-3 T4).
 *
 * It is not a number this module chose. It WAS `agent/model.ts`'s own
 * `minOutputReserve = 4096` — the Anthropic transport's declared floor, the STRICTER of the
 * two the tree then enforced (the OpenAI path declared 1,024). Reserving less than the
 * transport itself demanded would have guaranteed the transport re-trimming whatever the
 * assembler admitted, which is the two-authorities defect this phase exists to close.
 *
 * PHASE-3 T4 STEP 2B (2026-08-01) CLOSED IT, AND THIS IS NOW THE ONLY DECLARATION. Both
 * front-trimmers are deleted, so `minOutputReserve` no longer exists in `agent/model.ts` and
 * this constant is not a copy of anything — it is the number itself, with its derivation
 * (below) attached. The provenance above is kept rather than tidied away: 4,096 is not an
 * arbitrary reserve, it is the floor a real transport demanded, and a later worker who reads
 * only "4096" without that history is one step from re-tuning it on taste.
 *
 * CHECKED against reality rather than assumed, because a floor inherited from one transport
 * is still a claim about what a model emits (#14). Measured on the dev body,
 * `SELECT output_tokens FROM cost_records WHERE output_tokens > 0` — **n = 8,244 real
 * calls**:
 *
 *     p50 227 · p90 674 · p99 1,581 · p99.9 3,121 · max 6,907
 *
 * So 4,096 covers better than 99.9% of everything this platform has ever generated, with
 * 31% headroom over p99.9. The all-time max (6,907, one call in 8,244) exceeds it, and that
 * is NOT a lie in the arithmetic: the reserve governs how much HISTORY the assembler
 * admits, while the transport's own `max_tokens` is computed from what the window actually
 * has left (`model.ts`: `min(maxOutputTokens, cw - inputEstimate - 500)`). A long answer
 * gets the room the window really has; the reserve only stops the assembler from spending
 * it in advance.
 *
 * Re-derive before changing it. The command is written above; never tune it to a number.
 */
export const OUTPUT_RESERVE_TOKENS = 4096;

/**
 * The reserve, COMPUTED — the tokens the assembler must not spend because the model layer
 * will.
 *
 * ── WHAT STOOD HERE, AND WHY IT HAD TO GO ──
 * `TOOL_AND_OUTPUT_RESERVE = 15000`, a literal that arrived in `assembler.ts:670` with no
 * derivation anywhere. T2 measured what it was standing in for and found it was not merely
 * imprecise, it had the wrong SIGN: the primary agent's tools array alone measures 70,006
 * chars = **17,502 tokens**, so the schemas exceeded the entire reserve before a single
 * output token. Read forward, the arithmetic said the assembler's ceiling was ALREADY over
 * the window:
 *
 *     assemblyBudget = floor(0.96 · cw) − 15,000
 *     what the wire carries = assemblyBudget + tools = floor(0.96 · cw) + 2,502
 *
 * On a 32K model that is 33,222 tokens of input against a 32,000-token window — over the
 * ceiling before output, every turn, which is exactly why the provider front-trimmers were
 * still doing real work. T2 refused to retune it (#14) and named the prerequisite: the
 * assembler has to know the payload. T3's S1 made the payload knowable; this closes it.
 *
 * With the reserve honest the arithmetic closes exactly:
 *
 *     assemblyBudget + tools + output = floor(0.96 · cw)
 *
 * `toolPayloadTokens` is MEASURED per agent per call (`measureAgentToolPayloadTokens`),
 * never a constant, because a sub-agent's array is a different size from the primary's and
 * one number for both would over-reserve for one and under-reserve for the other.
 * `maxOutputTokens` caps the output half at what the model can actually emit — reserving
 * 4,096 from a model that tops out at 2,048 sets aside room nothing can use.
 */
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

/**
 * Per-message cap the compaction GATE applies before summing the fresh tail, so one
 * 30K-token file_read cannot trigger compaction by itself while the assembler's own
 * `budgetFreshTail` would have trimmed it anyway. (Was `MAX_GATE_MESSAGE_TOKENS`,
 * `memory/compaction.ts:76`.)
 */
export const GATE_MESSAGE_CAP_TOKENS = 4000;

/**
 * The share of what remains after scaffolding that summaries may take. Declared here
 * because BOTH the assembler (`budgetSummaries`) and the compaction gate's model of it
 * used the same 0.7 and neither could see the other's copy. PHASE-3 T3 turns this into a
 * lane declaration; until then it is one number with one owner.
 */
export const SUMMARY_SHARE = 0.7;

/**
 * Canonical model-aware fresh-tail window size (FA-M3). Moved here from `memory/store.ts`
 * unchanged, byte for byte: the assembler's tail-shown count and compaction's inside-tail
 * count MUST be the same number or the tail-to-summary handoff drops or duplicates
 * messages. It lives with the budget because it IS a budget — a row budget rather than a
 * token one — and because leaving it in `store.ts` would have made this module cyclic.
 */
export function getFreshTailCount(contextWindow: number): number {
  const cw = clampWindow(contextWindow);
  if (cw >= 200000) return 80;   // 200k+ (Sonnet, Opus), ~15-20 turns
  if (cw >= 128000) return 64;   // 128k (GPT-4o), ~12-15 turns
  if (cw >= 32000) return 40;    // 32k models, ~8-10 turns
  return 24;                     // Small models, ~5 turns
}

// ── The policy ──

export interface ContextWindowPolicy {
  /** The model's full context window, clamped finite and >= 0. */
  contextWindow: number;
  /** 0.96 — the compaction gate and the assembler's fill fraction, one number. */
  compactionThreshold: number;
  /** 0.90 — log loudly + toast, do not compact. */
  warnThreshold: number;
  /** 0.99 — surrender the turn. */
  blockThreshold: number;
  /** Tokens the assembler does not control (tool schemas + output). */
  toolAndOutputReserve: number;
  /** What the assembler may spend on system prompt + messages. Never negative. */
  assemblyBudgetTokens: number;
  /** Rows of raw conversation kept live for this window. */
  freshTailCount: number;
  /** Per-message cap the compaction gate applies before summing. */
  gateMessageCap: number;
  /** Share of the remainder summaries may take. */
  summaryShare: number;
}

function clampWindow(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow < 0) return 0;
  return contextWindow;
}

/**
 * The eight-plus numbers, derived once, clamped, from the one place that owns them.
 *
 * `measured` IS REQUIRED, and that is the design (PHASE-3 T4). There is no default and no
 * overload without it, so no caller can quietly fall back to a constant nobody derived —
 * which is how the 15,000 survived four phases. Both production callers hold an `agentId`
 * and a window; measuring costs one already-memoised tool-list read.
 *
 * CLAMPING IS NOT COSMETIC. `floor(0.96 · 15000) − reserve` is negative on a small window,
 * and a negative budget does not fail — it flows into `budgetFreshTail(tail, maxTokens −
 * usedTokens)`, whose "include the last group anyway" safety then hands the model exactly
 * one message with nothing logged and nothing broadcast. Zero is representable; negative
 * is a lie. `assertSystemPromptFits` is what turns that zero into a loud failure.
 */
export function contextWindowPolicy(
  contextWindow: number,
  measured: { toolPayloadTokens: number; maxOutputTokens?: number },
): ContextWindowPolicy {
  const cw = clampWindow(contextWindow);
  const reserve = Math.max(0, toolAndOutputReserve(measured));
  return {
    contextWindow: cw,
    compactionThreshold: CONTEXT_THRESHOLD,
    warnThreshold: CONTEXT_WARN_THRESHOLD,
    blockThreshold: CONTEXT_BLOCK_THRESHOLD,
    toolAndOutputReserve: reserve,
    assemblyBudgetTokens: Math.max(0, Math.floor(CONTEXT_THRESHOLD * cw) - reserve),
    freshTailCount: getFreshTailCount(cw),
    gateMessageCap: GATE_MESSAGE_CAP_TOKENS,
    summaryShare: SUMMARY_SHARE,
  };
}

/** Thrown when a model's window cannot hold this agent's system prompt at all. */
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

/**
 * Fail loud rather than assemble a lie (research 06 requirement C11's philosophy, applied
 * to the one case T2 can already see). Before this, a window small enough to make the
 * budget negative produced a single-message context with no warning anywhere — the agent
 * looked like it had forgotten everything and no log said why.
 */
export function assertSystemPromptFits(systemPromptTokens: number, policy: ContextWindowPolicy): void {
  if (systemPromptTokens > policy.assemblyBudgetTokens) {
    throw new SystemPromptTooLargeError(systemPromptTokens, policy);
  }
}

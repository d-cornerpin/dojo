// ════════════════════════════════════════
// Phase 1E — output classifiers
//
// Per Part VI #10 + #20.
//
// outputTruncationClassifier: detect when the model's output was cut
// off (max_output_tokens hit, content_filter, etc.) and signal whether
// the engine can give the retry more output room. t195: the room is
// twice the budget the cut call was SENT with, bounded by the room that
// call reported it could be given, and given once per cut. There is no
// table of levels and no fixed wall in the engine.
//
// outputPersistenceClassifier: decide whether to persist trailing
// assistant text. Subsumes v1's "engine-level inter-agent silence"
// at runtime.ts:1326-1336 — when the agent already replied via
// send_to_agent on an inter-agent turn, any trailing text is filler
// and should be suppressed.
// ════════════════════════════════════════

import type { ToolCall } from '@dojo/shared';

// ── Truncation ──

export interface OutputTruncationInput {
  /** stop_reason from the model response (provider-specific). */
  stopReason: string | null;
  /** Length of the model's content in characters. */
  contentLength: number;
  /** The output budget the cut call was sent with, in tokens. 0 or absent when the transport did not report it. */
  currentBudget: number;
  /** The most output room a retry of that call could be given, in tokens (reported by the same call). */
  ceiling?: number;
  /** True when the cut call was itself the extra-room retry: extra room is given once. */
  alreadyEscalated?: boolean;
}

export type OutputTruncationDecision =
  | { truncated: false }
  | { truncated: true; escalateTo: number | null; reason: string };

const TRUNCATION_STOP_REASONS = new Set([
  'max_tokens',           // Anthropic
  'length',               // OpenAI
  'output_token_limit',   // various
  'max_output_tokens',
  'truncated',
]);

/** True when a provider's stop reason says the output was cut off by its budget. */
export function isOutputCut(stopReason: string | null | undefined): boolean {
  return TRUNCATION_STOP_REASONS.has((stopReason ?? '').toLowerCase());
}

// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP-A TB8 JOB 1 (moved here by t239) — THE STOP REASON IS NEVER FABRICATED, ON ANY TRANSPORT.
//
// The OpenAI-compatible path used to report `stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn'`
// and discard the provider's `finish_reason` entirely. Every call on that path therefore told the
// engine "the model finished normally" even when the provider had TRUNCATED it at the output cap, and
// the ladder that reads `TRUNCATION_STOP_REASONS` below could never once fire there.
//
// THE BOUND THAT MATTERS IS THE CAP THE PRODUCT ALREADY CONFIGURES, and it was derived from the
// durable sink rather than chosen: over 19,124 completed calls carrying a known cap (2026-07-27 →
// 2026-08-06, all four batteries), exactly 17 reached their model's own `max_output_tokens` —
// 0.089% — and every recorded runaway is one of them, across two different models and two different
// caps. A DURATION bound orders the two populations wrong (legitimate calls at 216.3 s against
// runaways at 129.95 s), and any sub-cap OUTPUT-TOKEN threshold sits 133 tokens (0.8%) from a
// legitimate call that ended in a tool call (both refused, with their numbers, in
// `steps/post-call-classify/__tests__/output-grind.test.ts`). The provider reporting its own
// truncation is the only signal that separates them categorically — 17 of 17 caught, 0 of 19,107
// false.
//
// t239: the Ollama transport kept the fabrication (`any parsed tool call => 'tool_use'`) after the
// OpenAI path lost it, and a reply cut mid-sentence whose tool call had already parsed ran as if it
// were whole. Both transports now go through THIS ONE rule. `'stop'` and `'tool_calls'` say only what
// the tool-call count already says, so they stay with it; anything else the provider reports
// (`length`, `max_tokens`, ...) is passed through untouched.
// ════════════════════════════════════════════════════════════════════════════════════════
export function resolveProviderStopReason(
  finishReason: string | null | undefined,
  toolCallCount: number,
): string {
  if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') return finishReason;
  return toolCallCount > 0 ? 'tool_use' : 'end_turn';
}

export function outputTruncationClassifier(
  input: OutputTruncationInput,
): OutputTruncationDecision {
  if (!isOutputCut(input.stopReason)) {
    return { truncated: false };
  }
  const stopReason = (input.stopReason ?? '').toLowerCase();

  if (input.alreadyEscalated) {
    return {
      truncated: true,
      escalateTo: null,
      reason: `output truncated (stop_reason=${stopReason}); the extra room was already given once`,
    };
  }
  // No report of the room means no honest number to escalate to.
  if (!(input.currentBudget > 0) || input.ceiling === undefined) {
    return {
      truncated: true,
      escalateTo: null,
      reason: `output truncated (stop_reason=${stopReason}); the transport reported no room to give`,
    };
  }
  const next = Math.min(input.currentBudget * 2, input.ceiling);
  if (next <= input.currentBudget) {
    return {
      truncated: true,
      escalateTo: null,
      reason: `output truncated (stop_reason=${stopReason}); already at the most room there is (${input.currentBudget})`,
    };
  }
  return {
    truncated: true,
    escalateTo: next,
    reason: `output truncated (stop_reason=${stopReason}); escalating budget ${input.currentBudget} → ${next}`,
  };
}

// ── Persistence (suppress trailing text in specific cases) ──

export interface OutputPersistenceInput {
  /** Agent's text content from the model response. */
  responseText: string | null;
  /** Tools the agent called this turn. */
  toolCallsThisTurn: ToolCall[];
  /** Whether this turn was triggered by an inter-agent message (A2A, group, PM poke). */
  isInterAgentTrigger: boolean;
  /** Whether the agent called send_to_agent or broadcast_to_group at any point this turn. */
  sentToAgentThisTurn: boolean;
}

export type OutputPersistenceDecision =
  | { decision: 'persist'; reason: string }
  | { decision: 'suppress'; reason: string };

/**
 * Decide whether to persist trailing assistant text. Verbatim from v1
 * runtime.ts:1326-1336 — on inter-agent turns where the agent already
 * called send_to_agent, any trailing text is by definition not the
 * primary response and is suppressed to keep chat clean.
 */
export function outputPersistenceClassifier(
  input: OutputPersistenceInput,
): OutputPersistenceDecision {
  if (!input.responseText || input.responseText.trim().length === 0) {
    return { decision: 'suppress', reason: 'no text to persist' };
  }
  // v3.1.10: an inter-agent (A2A / group / PM-poke) turn is entirely
  // agent-internal — the response goes to the other agent via send_to_agent,
  // never to the user. ALL user-facing text on such a turn is suppressed,
  // including intermediate planning text that rides alongside tool calls
  // ("Let me check the tracker for that deployment ticket" + work_update(action="list")).
  // Previously this only fired once send_to_agent had been called, so the
  // pre-reply planning text leaked into the user's dashboard. The agent's
  // text is still seen by the enforcer (raw) so the missed-reply nudge works,
  // and the inbound A2A + send_to_agent + tool results remain in the agent's
  // context and in wordy mode.
  if (input.isInterAgentTrigger) {
    return {
      decision: 'suppress',
      reason: 'inter-agent turn — all user-facing text is agent-internal',
    };
  }
  return { decision: 'persist', reason: 'normal text persistence' };
}

// ── Generic-closeout detection — DELETED, PHASE-2 T6 (cluster C1, requirement 1a) ──
//
// `CLOSEOUT_PHRASE` / `CLOSEOUT_WHOLE_RE` / `isGenericCloseout` were a twenty-phrase regex
// that decided whether the model's last line "was a closeout", and the redundant-closeout
// floor in the loop used that verdict to DROP the row. That is prose as authority in the
// suppression direction — the same shape as the near-duplicate swallow deleted beside it
// (P4b, "its known worst case silently ate a genuinely different short answer") and as the
// deliverable-claim floor removed twice on 2026-07-19 (research 21, caution 2: honesty
// floors are receipt-keyed, never prose-keyed).
//
// requirement preserved — "respond once": the floor still exists, in `agent/v2/loop.ts`,
// but its authority is now `turnDeliveredToPerson()` (agent/v2/answered-edge.ts) — a
// DELIVERY ROW written by the transport door that performed the send. The engine suppresses
// a second bare line because it can point at the answer the person already received, not
// because the line matched a phrase list. The ≤30-character bound is carried over verbatim
// from this function so nothing substantive can ever be dropped; no threshold was invented.

// ── Sanitization ──

/**
 * Normalize model text output before persistence (#39, mirrors v1 runtime.ts:1208-1219).
 *
 * Weak Ollama / DeepSeek / Qwen models routinely emit literal `\n` strings
 * (the two-character sequence) instead of real newlines, and over-pad with
 * 3+ consecutive blank lines. Skipped for JSON-shaped content so we don't
 * accidentally mangle structured tool arguments.
 */
export function sanitizeAssistantText(content: string | null): string | null {
  if (content == null) return content;
  const trimmed = content.trim();
  if (trimmed.length === 0) return content;
  // Don't touch JSON — could corrupt structured payloads.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return content;
  return content
    .replace(/\\n/g, '\n')        // literal `\n` → real newline
    .replace(/\n{3,}/g, '\n\n')   // collapse 3+ newlines to 2
    .trim();
}

// ── Leading time-stamp mimicry strip (2026-07-16) ──
//
// The assembler prefixes historical messages with their recorded time
// ("[Jul 16, 2026, 10:58 PM] ..."), and the floor model imitates the costume
// on its own replies despite the current-time footer legend telling it not to
// (observed in production the night the stamps shipped: "[Jul 16, 2026,
// 10:58 PM] Saved."). The stamp is context markup, not message content, so
// stripping a leading run of them at the persist source is lane attribution,
// not suppression: engine-enforced, same class as stripSystemTags. Tolerates
// the narrow/no-break spaces Intl inserts before AM/PM.
// Format-drift hardening (2026-07-20, production): the model paraphrased the
// stamp convention into ISO format ("[2026-07-20 07:40]") which the original
// month-name-only pattern missed, so the mimicked stamp reached the user in
// non-wordy chat. Both dialects are stripped now: the engine month-name shape
// and bracketed ISO date-times (optional seconds, T separator, AM/PM/UTC/Z
// tail). Still anchored at the reply start and strictly date-shaped, so real
// bracketed content is never touched.
const LEADING_TIME_STAMP_RE =
  /^\s*\[(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2},\s\d{4},\s\d{1,2}:\d{2}[\s\u202F\u00A0]?(?:AM|PM)|\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2})?[\s\u202F\u00A0]?(?:AM|PM|UTC|Z)?)\]\s*/;

export function stripLeadingTimeStamp(text: string): string {
  let out = text;
  while (LEADING_TIME_STAMP_RE.test(out)) out = out.replace(LEADING_TIME_STAMP_RE, '');
  return out;
}

// ════════════════════════════════════════
// Phase 1E — output classifiers
//
// Per Part VI #10 + #20.
//
// outputTruncationClassifier: detect when the model's output was cut
// off (max_output_tokens hit, content_filter, etc.) and signal whether
// the recovery cascade should escalate the output budget. This is the
// 8K → 16K → 32K → 64K escalation chain from Part IX.
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
  /** Current escalation level. */
  currentBudget: number;
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

const ESCALATION_CHAIN = [8000, 16000, 32000, 64000];

export function outputTruncationClassifier(
  input: OutputTruncationInput,
): OutputTruncationDecision {
  const stopReason = (input.stopReason ?? '').toLowerCase();
  const truncated = TRUNCATION_STOP_REASONS.has(stopReason);

  if (!truncated) {
    return { truncated: false };
  }

  // Find the next escalation level above current budget.
  const next = ESCALATION_CHAIN.find((b) => b > input.currentBudget);
  if (next === undefined) {
    return {
      truncated: true,
      escalateTo: null,
      reason: `output truncated (stop_reason=${stopReason}); escalation chain exhausted at ${input.currentBudget}`,
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
  // ("Let me check the tracker for that deployment ticket" + tracker_list_active).
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

// ── Generic-closeout detection ──

// Matches text that is ENTIRELY a generic acknowledgment/closeout and nothing
// else: "Done.", "All set.", "Got it.", "Done. Locked in.". Used by the loop
// to suppress a redundant closeout on a continuation iteration AFTER a real
// reply already surfaced this turn. Deliberately strict — anything with
// substantive content (a sentence, a specific confirmation like "Cancelled the
// noon reminder.", anything past ~30 chars) does NOT match and is never
// suppressed.
const CLOSEOUT_PHRASE =
  '(?:done|all done|all set|you\'?re all set|you are all set|all cleared|all wrapped|wrapped up|complete|completed|task complete|marked complete|finished|all good|noted|got it|on it|roger|understood|will do|consider it done|locked in)';
const CLOSEOUT_WHOLE_RE = new RegExp(
  `^[\\s\`*_>-]*${CLOSEOUT_PHRASE}(?:[.!,\\s—–-]+${CLOSEOUT_PHRASE})*[.!\\s\`*_]*$`,
  'i',
);

export function isGenericCloseout(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0 || t.length > 30) return false; // real closeouts are short
  return CLOSEOUT_WHOLE_RE.test(t);
}

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

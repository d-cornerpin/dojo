// Truncation: the retry gets twice the sent budget, capped by the reported ceiling, once per cut.

import type { ToolCall } from '@dojo/shared';

export interface OutputTruncationInput {
  stopReason: string | null;
  contentLength: number;
  /** Output budget the cut call was sent with, in tokens; 0 or absent when not reported. */
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
  'max_tokens',
  'length',
  'output_token_limit',
  'max_output_tokens',
  'truncated',
]);

export function isOutputCut(stopReason: string | null | undefined): boolean {
  return TRUNCATION_STOP_REASONS.has((stopReason ?? '').toLowerCase());
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

export interface OutputPersistenceInput {
  responseText: string | null;
  toolCallsThisTurn: ToolCall[];
  isInterAgentTrigger: boolean;
  sentToAgentThisTurn: boolean;
}

export type OutputPersistenceDecision =
  | { decision: 'persist'; reason: string }
  | { decision: 'suppress'; reason: string };

export function outputPersistenceClassifier(
  input: OutputPersistenceInput,
): OutputPersistenceDecision {
  if (!input.responseText || input.responseText.trim().length === 0) {
    return { decision: 'suppress', reason: 'no text to persist' };
  }
  // An inter-agent turn is entirely agent-internal: even planning text that
  // rides alongside tool calls is suppressed here. The enforcer still sees
  // the raw text, so the missed-reply nudge keeps working.
  if (input.isInterAgentTrigger) {
    return {
      decision: 'suppress',
      reason: 'inter-agent turn — all user-facing text is agent-internal',
    };
  }
  return { decision: 'persist', reason: 'normal text persistence' };
}

// The "respond once" floor lives in agent/v2/loop.ts, keyed on a delivery
// receipt written by the transport, never on phrase matching of the text.

/** Weak local models emit literal `\n` and pad with blank lines; JSON-shaped text is skipped. */
export function sanitizeAssistantText(content: string | null): string | null {
  if (content == null) return content;
  const trimmed = content.trim();
  if (trimmed.length === 0) return content;
  // JSON must never be rewritten: structured payloads are the user's data.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return content;
  return content
    .replace(/\\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The assembler time-stamps history and the model imitates the costume.
// Stripping a leading run at the persist source is lane attribution, not
// suppression: anchored at the reply start, strictly date-shaped (month-name
// and ISO shapes), so real bracketed content survives.
const LEADING_TIME_STAMP_RE =
  /^\s*\[(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2},\s\d{4},\s\d{1,2}:\d{2}[\s\u202F\u00A0]?(?:AM|PM)|\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2})?[\s\u202F\u00A0]?(?:AM|PM|UTC|Z)?)\]\s*/;

export function stripLeadingTimeStamp(text: string): string {
  let out = text;
  while (LEADING_TIME_STAMP_RE.test(out)) out = out.replace(LEADING_TIME_STAMP_RE, '');
  return out;
}

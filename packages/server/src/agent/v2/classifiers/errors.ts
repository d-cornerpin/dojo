// ════════════════════════════════════════
// Phase 1E — errors master switch
//
// Per Part VI #6 and Part IX. Single classification entry point used
// by the recovery cascade in agent/v2/recovery.ts. Maps every error
// to a categorized RecoveryAction the cascade can act on.
//
// This is intentionally a thin layer on top of the dedicated
// classifiers (provider.ts, etc.). The unified shape lets the
// recovery cascade in Phase 6 dispatch via a single switch.
// ════════════════════════════════════════

import { classifyRecoverableProviderError } from './provider.js';

export type RecoveryActionKind =
  | 'rate_limit'
  | 'overloaded'
  | 'context_overflow'
  | 'output_truncated'
  | 'vision_mismatch'
  | 'unsupported_modality'
  | 'unsupported_input'
  | 'tool_format_rejected'
  | 'malformed_request'
  | 'auto_router_fallback'
  | 'tool_crash'
  | 'network'
  | 'auth'
  // v2.3.19 additions from the expanded provider classifier
  | 'image_too_large_post_sips'
  | 'image_too_many'
  | 'tool_name_unknown'
  | 'tool_args_invalid_json'
  | 'tool_args_schema_mismatch'
  | 'refusal'
  | 'provider_garbage'
  | 'unknown';

export interface RecoveryAction {
  kind: RecoveryActionKind;
  /** Human-readable explanation of what classification fired. */
  reason: string;
  /** Optional retry-after hint in seconds (for rate_limit). */
  retryAfter?: number | null;
  /** Optional user-facing reason (for the system note we write to the agent). */
  userFacingReason?: string;
  /** Optional guidance for the agent (for tool_format_rejected, malformed_request, etc.). */
  guidance?: string;
}

/**
 * Master classifier. Inspects an error message and returns a structured
 * RecoveryAction. The recovery cascade (Phase 6) maps each kind to a
 * specific recovery strategy.
 */
export function errorRecoveryClassifier(error: Error | string): RecoveryAction {
  const message = typeof error === 'string' ? error : error.message;
  if (!message) {
    return { kind: 'unknown', reason: 'empty error message' };
  }
  const lower = message.toLowerCase();

  // Rate limit family
  if (/(rate.?limit|429)/.test(lower)) {
    return { kind: 'rate_limit', reason: 'rate limit detected' };
  }
  if (/(overloaded|529)/.test(lower)) {
    return { kind: 'overloaded', reason: 'provider overloaded' };
  }

  // Auth
  if (/(401|403|unauthorized|invalid.?api.?key|api key)/.test(lower)) {
    return { kind: 'auth', reason: 'auth failure' };
  }

  // Tool execution crash (check before network — "tool timed out" is a
  // tool problem, not a network problem; bare "timeout" stays network).
  if (/\btool\b.*(crash|timed out|timeout)/.test(lower)) {
    return { kind: 'tool_crash', reason: 'tool execution crashed' };
  }

  // Network / transient 5xx
  if (/(econnrefused|econnreset|etimedout|fetch failed|socket hang up|503|502|500)/.test(lower)) {
    return { kind: 'network', reason: 'network or transient 5xx' };
  }
  if (/(timeout|timed out)/.test(lower)) {
    return { kind: 'network', reason: 'request timeout' };
  }

  // Context overflow
  if (/(context.*overflow|context.*exceed|context.*too.?long|prompt.*too.?long|input.*too.?long|context_length_exceeded|maximum context)/.test(lower)) {
    return { kind: 'context_overflow', reason: 'context window exceeded' };
  }

  // Output truncation
  if (/(output.*token.*(limit|exceed|max)|max_output_tokens|truncat(ed|ion))/.test(lower)) {
    return { kind: 'output_truncated', reason: 'output truncated by token limit' };
  }

  // Provider 4xx with recoverable shape — defer to dedicated classifier
  const provider = classifyRecoverableProviderError(message);
  if (provider) {
    return {
      kind: provider.kind,
      reason: `provider 4xx — ${provider.kind}`,
      userFacingReason: provider.userFacingReason,
      guidance: provider.guidance,
    };
  }

  return { kind: 'unknown', reason: 'no classifier matched' };
}

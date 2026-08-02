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
import { classifyProviderErrorText } from '../../provider-error.js';

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

  // PHASE-4 T5 — ORDER IS THE FIX HERE, not just the matcher.
  //
  // The two conditions whose message CARRIES a large number are checked FIRST. Before this,
  // auth (`/(401|403|…)/`) was tested three branches ABOVE context overflow, and Anthropic's
  // over-length error — "prompt is too long: 204015 tokens > 200000 maximum" — contains
  // "401" inside its token count. So the one error this cascade exists to recover from
  // classified as an auth failure and the compaction never ran.
  //
  // Everything numeric below now goes through `classifyProviderErrorText`, which matches a
  // status as a TOKEN (a `401` inside `204015` has no boundary and cannot match) and is the
  // single table this tree keeps — the comment three files over calling out "a fourth
  // hand-rolled substring set" was describing this one.

  // Context overflow
  if (/(context.*overflow|context.*exceed|context.*too.?long|prompt.*too.?long|input.*too.?long|context_length_exceeded|maximum context)/.test(lower)) {
    return { kind: 'context_overflow', reason: 'context window exceeded' };
  }

  // Output truncation
  if (/(output.*token.*(limit|exceed|max)|max_output_tokens|truncat(ed|ion))/.test(lower)) {
    return { kind: 'output_truncated', reason: 'output truncated by token limit' };
  }

  // Tool execution crash (check before network — "tool timed out" is a
  // tool problem, not a network problem; bare "timeout" stays network).
  if (/\btool\b.*(crash|timed out|timeout)/.test(lower)) {
    return { kind: 'tool_crash', reason: 'tool execution crashed' };
  }

  const transport = classifyProviderErrorText(message);
  switch (transport.class) {
    case 'rate_limit':
    case 'quota':
      return { kind: 'rate_limit', reason: 'rate limit detected' };
    case 'overloaded':
      return { kind: 'overloaded', reason: 'provider overloaded' };
    case 'auth':
    case 'access_denied':
      return { kind: 'auth', reason: 'auth failure' };
    case 'network':
    case 'server':
      return { kind: 'network', reason: 'network or transient 5xx' };
    default:
      break;
  }
  // A credential named in prose with no status behind it: the text classifier has nothing
  // structured to read, and this is still an auth failure.
  if (lower.includes('api key')) {
    return { kind: 'auth', reason: 'auth failure' };
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

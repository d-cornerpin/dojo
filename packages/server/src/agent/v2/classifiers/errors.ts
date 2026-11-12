// Single classification entry: maps any error to a RecoveryAction for the
// cascade in agent/v2/recovery.ts; a thin layer over the dedicated classifiers.

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

/** Maps an error message to the RecoveryAction the recovery cascade dispatches on. */
export function errorRecoveryClassifier(error: Error | string): RecoveryAction {
  const message = typeof error === 'string' ? error : error.message;
  if (!message) {
    return { kind: 'unknown', reason: 'empty error message' };
  }
  const lower = message.toLowerCase();

  // Order is load-bearing: the branches whose message carries a large number run
  // first, and every status matches as a token via classifyProviderErrorText, the
  // single table: a "401" inside "204015" has no boundary and must not read as auth.

  if (/(context.*overflow|context.*exceed|context.*too.?long|prompt.*too.?long|input.*too.?long|context_length_exceeded|maximum context)/.test(lower)) {
    return { kind: 'context_overflow', reason: 'context window exceeded' };
  }

  if (/(output.*token.*(limit|exceed|max)|max_output_tokens|truncat(ed|ion))/.test(lower)) {
    return { kind: 'output_truncated', reason: 'output truncated by token limit' };
  }

  // Tool crash before network: "tool timed out" is a tool problem; bare "timeout" is network.
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
  // A credential named in prose with no status: nothing structured to read, still auth.
  if (lower.includes('api key')) {
    return { kind: 'auth', reason: 'auth failure' };
  }

  // Provider 4xx with a recoverable shape: defer to the dedicated classifier.
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

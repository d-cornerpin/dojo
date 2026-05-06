// ════════════════════════════════════════
// Phase 1A — recoverable provider error classifier
//
// Verbatim port of classifyRecoverableProviderError from v1
// runtime.ts:39-119. Behavior is identical so v1 and v2 handle
// the same provider 4xx errors the same way.
//
// Some provider errors aren't "the agent broke" — they're
// "the request was wrong for this model". The agent can adapt
// and retry differently if we just tell them what went wrong
// instead of injuring them and waiting for human intervention.
//
// Returns null if the error is NOT recoverable (real failure,
// transient 5xx, rate limit, network — those go through other
// paths in the v2 recovery cascade).
// ════════════════════════════════════════

export type RecoverableProviderErrorKind =
  | 'vision_mismatch'
  | 'unsupported_modality'
  | 'unsupported_input'
  | 'tool_format_rejected'
  | 'malformed_request';

export interface RecoverableProviderError {
  kind: RecoverableProviderErrorKind;
  userFacingReason: string;
  guidance: string;
}

export function classifyRecoverableProviderError(
  err: string,
): RecoverableProviderError | null {
  if (!err) return null;
  const lower = err.toLowerCase();

  // Don't recover transient or auth errors — those go through the existing
  // healer / rate-limit retry paths, not in-loop recovery.
  if (
    lower.includes('429') ||
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('overloaded') ||
    lower.includes('529') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('socket hang up') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('503') ||
    lower.includes('502') ||
    lower.includes('500') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid_api_key') ||
    lower.includes('api key')
  ) {
    return null;
  }

  // Vision / image input not supported — most common case the user hits.
  if (
    (lower.includes('image') || lower.includes('vision') || lower.includes('image_url')) &&
    (lower.includes('not support') ||
      lower.includes("don't support") ||
      lower.includes('does not support') ||
      lower.includes('unsupported') ||
      lower.includes('endpoints found that support') ||
      lower.includes('no endpoints found') ||
      lower.includes("can't handle") ||
      lower.includes('cannot handle'))
  ) {
    return {
      kind: 'vision_mismatch',
      userFacingReason: 'the configured model does not support image input',
      guidance:
        "Continue without trying to look at images. If the user asked you to analyze an image and you have a path to it, describe what you can infer from the filename, surrounding text, or metadata — or tell the user this model can't see images and they may want to switch.",
    };
  }

  // Generic "modality not supported" — audio, video, etc.
  if (lower.includes('modality') && (lower.includes('not support') || lower.includes('unsupported'))) {
    return {
      kind: 'unsupported_modality',
      userFacingReason: 'the model does not support the type of input that was sent',
      guidance: 'Try the same request without the unsupported attachment, or use a different tool.',
    };
  }

  // Tool format rejected — agent constructed a malformed tool call.
  if (
    (lower.includes('tool_use') || lower.includes('tool_call') || lower.includes('tool calls')) &&
    (lower.includes('invalid') ||
      lower.includes('malformed') ||
      lower.includes('not found') ||
      lower.includes('does not match'))
  ) {
    return {
      kind: 'tool_format_rejected',
      userFacingReason: 'the tool call format was rejected by the provider',
      guidance:
        'Re-issue the tool call with the correct argument types and required fields. Call load_tool_docs for the tool first if you need to recheck its schema.',
    };
  }

  // Generic malformed/unsupported 400 with enough specificity to be safe.
  if (
    lower.includes('400') &&
    (lower.includes('not support') ||
      lower.includes('unsupported') ||
      lower.includes('invalid_request_error') ||
      lower.includes('malformed') ||
      lower.includes('unrecognized'))
  ) {
    return {
      kind: 'malformed_request',
      userFacingReason: 'the provider rejected the request as malformed or unsupported',
      guidance: 'Adjust your approach — try a different tool, simpler input, or skip the step that triggered this.',
    };
  }

  // 404 specifically about input/endpoint support (catches OpenRouter-style
  // "404 No endpoints found that support image input" even if our other
  // matchers missed). Conservative — only fire on clear input/support phrasing.
  if (
    lower.includes('404') &&
    (lower.includes('endpoints found that support') ||
      lower.includes('does not support') ||
      lower.includes('not supported'))
  ) {
    return {
      kind: 'unsupported_input',
      userFacingReason: 'the model does not support what was sent',
      guidance:
        'Try the same request without the unsupported attachment or tool, or take a different approach.',
    };
  }

  return null;
}

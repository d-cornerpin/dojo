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
//
// v2.3.19 (Phase 1 of error-handling-spec): expanded with
// finer-grained kinds (image_too_large_post_sips, tool_name_unknown,
// tool_args_invalid_json, tool_args_schema_mismatch, refusal, etc.)
// plus a sibling classifyPlatformError() for Tier D conditions
// (auth_invalid, access_denied, quota_exhausted, dns_failure).
// ════════════════════════════════════════

import type { ErrorKind, ErrorContext } from '../error-format.js';

// The v2.3.19 classifier returns a richer kind. Old call sites that
// expect the legacy set (vision_mismatch, unsupported_modality, etc.)
// keep working because those values are still produced.
export type RecoverableProviderErrorKind =
  | 'vision_mismatch'
  | 'unsupported_modality'
  | 'unsupported_input'
  | 'tool_format_rejected'
  | 'malformed_request'
  // v2.3.19 additions
  | 'image_too_large_post_sips'
  | 'image_too_many'
  | 'tool_name_unknown'
  | 'tool_args_invalid_json'
  | 'tool_args_schema_mismatch'
  | 'refusal'
  | 'provider_garbage';

export interface RecoverableProviderError {
  kind: RecoverableProviderErrorKind;
  // Legacy fields — pre-v2.3.19 callers (and the existing system note
  // assembly path) still read these. New code should prefer error-format's
  // formatTierBNoteForAgent(kind, ctx) which has richer templates.
  userFacingReason: string;
  guidance: string;
  // v2.3.19 additions for template formatting via error-format.ts
  context?: ErrorContext;
}

export function classifyRecoverableProviderError(
  err: string,
): RecoverableProviderError | null {
  if (!err) return null;
  const lower = err.toLowerCase();

  // Don't recover transient or auth errors — those go through the
  // existing healer / rate-limit retry paths, or now classifyPlatformError.
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

  // ── v2.3.19 specific 4xx branches (order matters: most specific first) ──

  // Image too large AFTER sips downscale ran (v2.3.18). Engine drops the
  // image with a placeholder, agent gets told to apologize.
  if (
    (lower.includes('image exceeds') || lower.includes('image.source.base64')) &&
    (lower.includes('mb maximum') || lower.includes('bytes maximum') || lower.includes('size'))
  ) {
    return {
      kind: 'image_too_large_post_sips',
      userFacingReason: 'an attached image was too large for the model even after compression',
      guidance:
        'Tell the user the image exceeded the model size limit and ask for a smaller one.',
      context: { /* filename plumbed in by recovery.ts if available */ },
    };
  }

  // Too many images per request (Anthropic 100, OpenAI 50).
  if (
    lower.includes('images') &&
    (lower.includes('too many') || lower.includes('exceeds') || lower.includes('maximum'))
  ) {
    return {
      kind: 'image_too_many',
      userFacingReason: 'the request had too many images for the model',
      guidance: 'Mention to the user that not all images were processed.',
    };
  }

  // Tool name unknown — provider says tool isn't registered.
  if (
    (lower.includes('tool') || lower.includes('function')) &&
    (lower.includes('not found') || lower.includes('unknown') || lower.includes('does not exist'))
  ) {
    return {
      kind: 'tool_name_unknown',
      userFacingReason: 'a tool call referenced a name that does not exist',
      guidance: 'Use list_tool_docs to see what is available, then re-issue with a valid tool name.',
    };
  }

  // Tool args JSON malformed.
  if (
    (lower.includes('tool') || lower.includes('function')) &&
    (lower.includes('invalid json') || lower.includes('parse') || lower.includes('json'))
  ) {
    return {
      kind: 'tool_args_invalid_json',
      userFacingReason: 'a tool call had invalid JSON arguments',
      guidance: 'Re-issue with valid JSON.',
    };
  }

  // Tool args schema mismatch. Tightened to require explicit
  // schema/validation phrasing AND a tool-args context, so "tool_use_id
  // does not match" still flows to the legacy tool_format_rejected branch.
  if (
    (lower.includes('tool argument') || lower.includes('tool_args') || lower.includes('arguments') || lower.includes('input')) &&
    (lower.includes('schema validation') || lower.includes('schema') || lower.includes('required field') || lower.includes('missing'))
  ) {
    return {
      kind: 'tool_args_schema_mismatch',
      userFacingReason: 'a tool call did not match the tool schema',
      guidance: 'Re-call with correct argument types and required fields. Call load_tool_docs first if you need to recheck the schema.',
    };
  }

  // Model refused to comply (Anthropic refusal, OpenAI content_filter).
  if (
    (lower.includes('refus') || lower.includes('content_filter') || lower.includes('content policy') || lower.includes('safety')) &&
    !lower.includes('rate_limit')
  ) {
    return {
      kind: 'refusal',
      userFacingReason: 'the model declined the request',
      guidance: 'Rephrase or tell the user you cannot help with this.',
    };
  }

  // Provider returned a malformed response (not from our side — from theirs).
  if (
    (lower.includes('unexpected') || lower.includes('malformed response') || lower.includes('parse error') || lower.includes('truncated json')) &&
    !lower.includes('tool')
  ) {
    return {
      kind: 'provider_garbage',
      userFacingReason: 'the provider sent a malformed response',
      guidance: 'Apologize to the user and ask them to try again.',
    };
  }

  // ── Legacy branches preserved (existing classifications) ──

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

// ── v2.3.19 platform error classifier (Tier D) ─────────────────────────
//
// Conditions where the engine genuinely can't proceed without user
// intervention. Locks the agent, surfaces plain-English banner +
// iMessage, no agent system note (agent gets one at top of chat on
// next session). Distinct from classifyRecoverableProviderError to
// keep the cleanup of the spec from sprawling that classifier.

export type PlatformErrorKind =
  | 'auth_invalid'
  | 'access_denied'
  | 'quota_exhausted'
  | 'dns_failure';
  // db_write_fail, disk_full, oom_restart, no_models_available, and
  // all_providers_down are detected elsewhere (DB layer, watchdog,
  // model selector) — not from a provider error string.

export interface PlatformError {
  kind: PlatformErrorKind;
}

export function classifyPlatformError(err: string): PlatformError | null {
  if (!err) return null;
  const lower = err.toLowerCase();

  // 401 unauthorized / invalid API key.
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid_api_key') ||
    lower.includes('invalid api key') ||
    (lower.includes('api key') && (lower.includes('expired') || lower.includes('revoked') || lower.includes('not valid')))
  ) {
    return { kind: 'auth_invalid' };
  }

  // 403 forbidden — usually model access denied (org level).
  if (lower.includes('403') || lower.includes('forbidden')) {
    return { kind: 'access_denied' };
  }

  // Daily/monthly quota explicitly exhausted (distinct from 429 rate limit).
  if (
    (lower.includes('quota') && (lower.includes('exceed') || lower.includes('exhaust'))) ||
    lower.includes('insufficient_quota')
  ) {
    return { kind: 'quota_exhausted' };
  }

  // DNS / fundamental network resolution failure.
  if (lower.includes('enotfound') || lower.includes('getaddrinfo') || lower.includes('dns')) {
    return { kind: 'dns_failure' };
  }

  return null;
}

// Some provider errors aren't "the agent broke", they're "the request was
// wrong for this model": tell the agent what went wrong so it can adapt,
// instead of injuring it and waiting for a human. Returns null when the
// error is not recoverable: those go through other recovery-cascade paths.

import type { ErrorContext } from '../error-format.js';
import { AssemblyValidationError } from '../../../memory/assembly-validation.js';
import {
  classifyProviderErrorText,
  type ProviderErrorFacts,
} from '../../provider-error.js';

// Richer kind set; legacy values are still produced, so old call sites work.
export type RecoverableProviderErrorKind =
  | 'vision_mismatch'
  | 'unsupported_modality'
  | 'unsupported_input'
  | 'tool_format_rejected'
  | 'malformed_request'
  | 'image_too_large_post_sips'
  | 'image_too_many'
  | 'tool_name_unknown'
  | 'tool_args_invalid_json'
  | 'tool_args_schema_mismatch'
  | 'refusal'
  | 'provider_garbage';

export interface RecoverableProviderError {
  kind: RecoverableProviderErrorKind;
  // Older note-assembly callers still read these; new code prefers formatTierBNoteForAgent.
  userFacingReason: string;
  guidance: string;
  context?: ErrorContext;
}

/**
 * An `AssemblyValidationError` is an engine defect, never a provider answer;
 * its text holds "tool" and "unknown", which text rules would misread. The
 * TYPE decides, down the cause chain, before any text rule runs.
 */
export function isEngineAssemblyFault(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (e instanceof AssemblyValidationError) return true;
  }
  return false;
}

export function classifyRecoverableProviderError(
  err: string,
  facts?: ProviderErrorFacts,
): RecoverableProviderError | null {
  if (!err) return null;
  const lower = err.toLowerCase();

  // Ask the provider first: its STATUS when it answered, its transport code
  // when it did not, and only then its words, every status matched as a
  // token (digits inside "204015" are not a 401).
  const f = facts ?? classifyProviderErrorText(err);
  if (f.class !== 'bad_request' && f.class !== 'unknown') return null;
  // An unrecognised string that names a credential is still not this classifier's business;
  // `api key` carries no status and no provider type, so the text classifier cannot see it.
  if (lower.includes('api key')) return null;

  // Specific 4xx branches, most specific first.

  // Image too large even after sips downscale: the engine drops it with a placeholder.
  if (
    (lower.includes('image exceeds') || lower.includes('image.source.base64')) &&
    (lower.includes('mb maximum') || lower.includes('bytes maximum') || lower.includes('size'))
  ) {
    return {
      kind: 'image_too_large_post_sips',
      userFacingReason: 'an attached image was too large for the model even after compression',
      guidance:
        'Tell the person you are talking to the image exceeded the model size limit and ask for a smaller one.',
      context: { /* filename plumbed in by recovery.ts if available */ },
    };
  }

  if (
    lower.includes('images') &&
    (lower.includes('too many') || lower.includes('exceeds') || lower.includes('maximum'))
  ) {
    return {
      kind: 'image_too_many',
      userFacingReason: 'the request had too many images for the model',
      guidance: 'Mention to the person you are talking to that not all images were processed.',
    };
  }

  if (
    (lower.includes('tool') || lower.includes('function')) &&
    (lower.includes('not found') || lower.includes('unknown') || lower.includes('does not exist'))
  ) {
    return {
      kind: 'tool_name_unknown',
      userFacingReason: 'a tool call referenced a name that does not exist',
      guidance: 'Pick a name from your tool index (load_tool_docs shows a tool\'s full instructions), then re-issue with a valid tool name.',
    };
  }

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

  // Requires explicit schema phrasing AND a tool-args context, so
  // "tool_use_id does not match" flows to the tool_format_rejected branch.
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

  if (
    (lower.includes('refus') || lower.includes('content_filter') || lower.includes('content policy') || lower.includes('safety')) &&
    !lower.includes('rate_limit')
  ) {
    return {
      kind: 'refusal',
      userFacingReason: 'the model declined the request',
      guidance: 'Rephrase or tell the person you are talking to you cannot help with this.',
    };
  }

  if (
    (lower.includes('unexpected') || lower.includes('malformed response') || lower.includes('parse error') || lower.includes('truncated json')) &&
    !lower.includes('tool')
  ) {
    return {
      kind: 'provider_garbage',
      userFacingReason: 'the provider sent a malformed response',
      guidance: 'Apologize to the person you are talking to and ask them to try again.',
    };
  }


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
        "Continue without trying to look at images. If the person you are talking to asked you to analyze an image and you have a path to it, describe what you can infer from the filename, surrounding text, or metadata — or tell the person you are talking to this model can't see images and they may want to switch.",
    };
  }

  if (lower.includes('modality') && (lower.includes('not support') || lower.includes('unsupported'))) {
    return {
      kind: 'unsupported_modality',
      userFacingReason: 'the model does not support the type of input that was sent',
      guidance: 'Try the same request without the unsupported attachment, or use a different tool.',
    };
  }

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

  // Conservative: fire only on clear input/support phrasing, which also
  // catches "404 No endpoints found that support image input".
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

// Owner-action conditions: lock the agent, plain-English banner + iMessage,
// no agent system note (the agent gets one at top of chat next session).
// A separate classifier keeps these out of the recoverable one.

export type PlatformErrorKind =
  | 'auth_invalid'
  | 'access_denied'
  | 'quota_exhausted'
  | 'dns_failure';
  // db_write_fail, disk_full, oom_restart, no_models_available and
  // all_providers_down are detected elsewhere, not from an error string.

export interface PlatformError {
  kind: PlatformErrorKind;
}

export function classifyPlatformError(
  err: string,
  facts?: ProviderErrorFacts,
): PlatformError | null {
  if (!err && !facts) return null;
  const lower = (err ?? '').toLowerCase();

  // The verdict comes from what the provider actually said: the status when
  // it answered, its structured `error.type` when it named one, the
  // transport code when the call never landed, and only then its words,
  // with every status matched as a token that cannot occur inside a number
  // (a "401" inside a token count must never read as revoked credentials).
  const f = facts ?? classifyProviderErrorText(err ?? '');
  switch (f.class) {
    case 'auth': return { kind: 'auth_invalid' };
    case 'access_denied': return { kind: 'access_denied' };
    case 'quota': return { kind: 'quota_exhausted' };
    case 'network':
      // Only name-resolution failure is owner-actionable; the test is a CODE, never a digit run.
      return /enotfound|eai_again|getaddrinfo|\bdns\b/.test(lower)
        || f.transportCode === 'ENOTFOUND' || f.transportCode === 'EAI_AGAIN'
        ? { kind: 'dns_failure' }
        : null;
    default:
      // A credential named in prose with no status behind it still means the owner must act.
      if (lower.includes('api key')
        && (lower.includes('expired') || lower.includes('revoked') || lower.includes('not valid'))) {
        return { kind: 'auth_invalid' };
      }
      return null;
  }
}

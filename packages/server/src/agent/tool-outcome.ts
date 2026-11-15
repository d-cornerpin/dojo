// The tool-execution boundary's Outcome: the door answers with one of these so
// "the platform refused" and "the tool broke" are different facts, not prose.
// Classification reads `errorCode` and `isError`: a verdict from prose would move arms on a reword.
import type {
  LiveOutcome, OutcomeApplied, OutcomeFailed, OutcomeRefused, ToolErrorCode, ToolResult,
  ToolSeamReason,
} from '@dojo/shared';
import { providerFactsOf } from './provider-error.js';

/** Only STRUCTURED provider facts (status, `error.type`, transport code) map to a code. A
 *  'text' or 'none' basis stamps nothing: the tool stays `crashed`, which is what "no facts" means. */
export function toolErrorCodeForThrow(err: unknown): ToolErrorCode | undefined {
  const facts = providerFactsOf(err);
  if (facts.basis === 'text' || facts.basis === 'none') return undefined;
  switch (facts.class) {
    case 'rate_limit':
    case 'quota':
      return 'RATE_LIMITED';
    case 'auth':
    case 'access_denied':
      return 'PERMISSION_DENIED';
    case 'network':
      return 'NETWORK_ERROR';
    case 'bad_request':
      return 'INVALID_ARGS';
    default:
      return undefined;
  }
}

export type ToolOutcome =
  | OutcomeApplied<ToolResult>
  | (OutcomeRefused<ToolSeamReason> & { readonly result: ToolResult })
  | (OutcomeFailed<ToolSeamReason> & { readonly result: ToolResult });

/** Compile probe: breaks first if a non-live arm is ever added to `ToolOutcome`. */
export type ToolOutcomeIsLive = ToolOutcome extends LiveOutcome<ToolResult, ToolSeamReason> ? true : never;

export function toolResultOf(o: ToolOutcome): ToolResult {
  return o.kind === 'applied' ? o.value : o.result;
}

/** True when the door refused: nothing ran, and retrying the same call is a spin. */
export function toolWasBlocked(o: ToolOutcome): boolean {
  return o.kind === 'refused' && o.reason === 'blocked';
}

// no_change has no producer (its writers are prose in tracker/tools.ts); no structured reason reads crashed.
export function classifyToolResult(result: ToolResult): ToolOutcome {
  if (result.isError !== true) return { kind: 'applied', value: result };
  const code = result.errorCode;
  if (code === 'PERMISSION_DENIED' || code === 'RATE_LIMITED') {
    return {
      kind: 'refused', reason: 'blocked', result,
      detail: `${result.name}: ${code === 'RATE_LIMITED' ? 'rate limited' : 'not permitted'}`,
    };
  }
  if (code === 'TIMEOUT') {
    return { kind: 'failed', reason: 'cancelled', result, detail: `${result.name}: timed out` };
  }
  // A malformed call is a refusal, not a crash: nothing ran; retry with the arguments corrected.
  if (code === 'INVALID_ARGS' || code === 'UNKNOWN_ARGS') {
    return { kind: 'refused', reason: 'invalid_args', result, detail: `${result.name}: invalid arguments` };
  }
  return { kind: 'failed', reason: 'crashed', result, detail: `${result.name}: ${code ?? 'unclassified error'}` };
}

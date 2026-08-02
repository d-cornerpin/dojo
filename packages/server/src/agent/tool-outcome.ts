// ════════════════════════════════════════
// The TOOL-EXECUTION boundary's `Outcome` (PHASE-4 T1 Step 2, cluster 3 of 3).
//
// §T0-PINS A pins the boundary at `agent/tools.ts:executeTool`. It answered
// `ToolResult` — a BOOLEAN `isError` and a prose `content` — so "the platform
// refused this" and "the tool broke" arrived at the caller as the same fact, and
// the only way to tell them apart was to read the English.
//
// ── THE MEASUREMENT THAT SHAPED THIS, taken at dojo `1249866` ──
// `ToolErrorCode` (`packages/shared/src/types.ts:321`) declares SEVEN structured
// codes. Commands:
//   git grep -n "errorCode:"  1249866 -- packages/server/src | grep -v __tests__  -> 1 site
//   git grep -n "\.errorCode" 1249866 -- packages/                               -> 0 readers
// One writer (`PARSE_ERROR`), no readers, against 23 `isError: true` returns in
// `tools.ts` alone. The structured field existed and carried nothing; the reason a
// call failed lived in the prose — and `tools.ts` even DERIVES the boolean from the
// prose (`isError = content.startsWith('Error')`). This gives that field its first
// reader and its first real population, at the sites the DOOR ITSELF owns.
//
// ── WHY THE CLASSIFIER READS `errorCode` AND NEVER THE TEXT ──
// The phase's binding caution is receipt-keyed, never prose-keyed. Matching
// `[BLOCKED by engine]` or `Permission denied:` would classify more calls today and
// would be the banned move: the deliverable-claim floor was tried twice on prose
// and spiralled both times. So `blocked` is reachable only where a refusal SAYS so
// structurally, and T1 marks the door's own refusals — the tools_policy deny, the
// PM-verb refusal, the permission gates, the primary-only and system_control
// checks. An inner tool that throws its own error text still reads `failed/crashed`,
// which is honest: nobody has told us anything better.
//
// ── `cancelled` HAS NO PRODUCER TODAY, AND THAT IS REPORTED, NOT INVENTED ──
// Research 22 names the vocabulary `blocked | crashed | cancelled`. `cancelled`
// maps to `TIMEOUT`, which NOTHING writes at this HEAD. The site that would produce
// it is the loop's identical-call / spin-brake refusal (`loop.ts:7074`), which
// builds a `ToolResult` for a call that never ran — and that is T3's file, not
// T1's. The arm is declared and unreachable, and #15 says so out loud rather than
// letting a reader infer it does not exist.
// ════════════════════════════════════════
import type { LiveOutcome, OutcomeApplied, OutcomeFailed, OutcomeRefused, ToolResult, ToolSeamReason } from '@dojo/shared';

/**
 * What the tool door answers.
 *
 * Every arm carries a `ToolResult`, because the model must see SOMETHING back from
 * every call — a refusal has content too. `applied` carries it as the outcome's
 * proof (`value`); the other two carry it as `result`, so no arm can be read as
 * "there is nothing to hand back".
 */
export type ToolOutcome =
  | OutcomeApplied<ToolResult>
  | (OutcomeRefused<ToolSeamReason> & { readonly result: ToolResult })
  | (OutcomeFailed<ToolSeamReason> & { readonly result: ToolResult });

/** `unknown` is unrepresentable here: a tool call is a live act this process just
 *  performed, so there is no non-live provenance to be honest about. This line
 *  breaks first if an arm is added. */
export type ToolOutcomeIsLive = ToolOutcome extends LiveOutcome<ToolResult, ToolSeamReason> ? true : never;

/** The result to hand the model, from any arm. */
export function toolResultOf(o: ToolOutcome): ToolResult {
  return o.kind === 'applied' ? o.value : o.result;
}

/** True when the door refused: nothing ran, and retrying the same call is a spin. */
export function toolWasBlocked(o: ToolOutcome): boolean {
  return o.kind === 'refused' && o.reason === 'blocked';
}

/**
 * STRUCTURAL classification. `errorCode` and `isError`, never `content`.
 *
 *   no errorCode + !isError  -> applied
 *   PERMISSION_DENIED        -> refused / blocked   (the platform said no)
 *   RATE_LIMITED             -> refused / blocked   (the provider said no, for now)
 *   TIMEOUT                  -> failed  / cancelled (abandoned before an answer)
 *   anything else, or none   -> failed  / crashed
 *
 * `no_change` is deliberately NOT populated. The tool seam does express it — the
 * tracker's `[NO-OP]` prefix is exactly that fact — but it expresses it in PROSE,
 * and reading that prose here is the banned move. It stays unpopulated until a tool
 * result carries the fact structurally, and this comment is the record of why.
 */
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
  return { kind: 'failed', reason: 'crashed', result, detail: `${result.name}: ${code ?? 'unclassified error'}` };
}

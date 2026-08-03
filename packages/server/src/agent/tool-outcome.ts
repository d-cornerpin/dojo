// ════════════════════════════════════════
// The TOOL-EXECUTION boundary's `Outcome` (PHASE-4 T1 Step 2, cluster 3 of 3).
//
// §T0-PINS A pins the boundary at `executeTool` — `agent/tools.ts` when that
// pin was taken, `agent/tools/index.ts` since PHASE-5 T4 deleted that file.
// It answered
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
// ── `cancelled` NOW HAS A PRODUCER — and T1's pin is corrected by measurement ──
// T1 declared the arm unreachable and named the loop's identical-call / spin-brake
// refusal as the site that would populate it (`loop.ts`, T3's file). PHASE-4 T3 opened
// that site, and it has TWO arms, only ONE of which is `cancelled`:
//
//   • TERMINAL (`toolPhaseEndedBySpinBrake`) — the tool PHASE for the turn is over.
//     Nothing further will run; this call is abandoned before an answer. That is
//     `cancelled` literally, and it is marked `TIMEOUT` so the classification below is
//     what decides, not the call site. **This is the arm that gives `cancelled` its
//     first producer.**
//   • PER-SIGNATURE refusal — this ONE call already failed REFUSE_AT times and is not
//     re-executed. `toolWasBlocked`'s own words fit it exactly ("the door refused:
//     nothing ran, and retrying the same call is a spin") — but every `errorCode` that
//     reaches `blocked` (`PERMISSION_DENIED`, `RATE_LIMITED`) would be a LIE about WHY,
//     and inventing a structured reason to reach a nicer arm is the prose-keyed move
//     wearing a struct. It stays unmarked and reads `crashed`, which is what "nobody
//     told us anything better" honestly means. Reaching `blocked` honestly needs a code
//     that means "the engine refused this call", and adding one to `ToolErrorCode` is a
//     shared-type change with its own blast radius — named here, not smuggled in.
//
// `no_change` is still unpopulated for the reason below.
// ════════════════════════════════════════
import type {
  LiveOutcome, OutcomeApplied, OutcomeFailed, OutcomeRefused, ToolErrorCode, ToolResult,
  ToolSeamReason,
} from '@dojo/shared';
import { providerFactsOf } from './provider-error.js';

/**
 * PHASE-4 T5 — `ToolErrorCode`'s SECOND real population, and the first one that is not a
 * permission gate.
 *
 * T1 gave the field its first reader (`classifyToolResult` below) and marked the fifteen
 * refusals the DOOR owns. Everything else a tool threw arrived with no code at all and read
 * `crashed` — honest, because nobody had told us better. A tool that called a provider HAS
 * been told better: the throw carries a status, a structured `error.type`, or a transport
 * code, and `provider-error.ts` has already read them.
 *
 * THE LINE THIS WILL NOT CROSS: a verdict reached from the error's WORDS
 * (`basis: 'text' | 'none'`) populates NOTHING. Guessing "unauthorized" out of a tool's own
 * prose and stamping `PERMISSION_DENIED` on it would move the call into the `blocked` arm —
 * "the door refused, nothing ran" — on the strength of a substring. That is the banned class
 * wearing a struct, and the tool stays `crashed` instead, which is what "nobody told us
 * anything better" honestly means.
 */
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
      // `server` and `overloaded` are the provider breaking, which is what `crashed` says.
      return undefined;
  }
}

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
 *   PERMISSION_DENIED        -> refused / blocked      (the platform said no)
 *   RATE_LIMITED             -> refused / blocked      (the provider said no, for now)
 *   TIMEOUT                  -> failed  / cancelled    (abandoned before an answer)
 *   INVALID_ARGS             -> refused / invalid_args (the door refused a malformed call)
 *   anything else, or none   -> failed  / crashed
 *
 * `no_change` is STILL deliberately NOT populated, and PHASE-4 T5 re-derived why rather
 * than inheriting it. The fact exists and is expressed in prose at exactly four sites, all
 * of them in ONE file:
 *
 *   git grep -n "\[NO-OP\]" -- packages/server/src | grep -v __tests__
 *     tracker/tools.ts:403   (a status change that was already at that status)
 *     tracker/tools.ts:1408  (the same, on the work_update path)
 *     tracker/tools.ts:1687  (complete with no open scheduled run)
 *     tracker/tools.ts:3805  (validate with no open run)
 *
 * `:403` is the sharpest of the four — it is literally `if (r.kind === 'no_change')`, a
 * `WorkOutcome` arm being RENDERED into prose and then, one layer up, read back out of the
 * prose by nobody. The channel that would carry it structurally is a field on `ToolResult`,
 * and giving it one here — with no writer, because all four writers are in a file this task
 * may not touch — would rebuild the exact defect T1 measured on `ToolErrorCode` (a declared
 * field, one writer, zero readers). So: NOT taken, recorded with its sites. `tracker/tools.ts`
 * is T4's file for the whole of Phase 4 (§T0-PARALLELISM's T4∥T5 fence), and the change is
 * one line at each site plus one field here. Owner: whoever holds `tracker/tools.ts` next.
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
  // PHASE-5 T3 Step 3: the schema-validation boundary is INVALID_ARGS's first
  // writer, and this is the arm that makes the writer worth having. A
  // malformed-shape call used to fall through to `crashed` — the platform
  // reporting itself broken for a call it understood and refused. It is a
  // refusal, and a distinct one: `blocked` says retrying is a spin, whereas the
  // right answer to this is to retry with the arguments corrected, which is
  // exactly what the four messages tell the model to do.
  if (code === 'INVALID_ARGS') {
    return { kind: 'refused', reason: 'invalid_args', result, detail: `${result.name}: invalid arguments` };
  }
  return { kind: 'failed', reason: 'crashed', result, detail: `${result.name}: ${code ?? 'unclassified error'}` };
}

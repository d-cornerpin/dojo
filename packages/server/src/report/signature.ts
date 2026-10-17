// ════════════════════════════════════════════════════════════════════════════
// THE REPORT'S IDENTITY — WHAT MAKES TWO REPORTS THE SAME REPORT (DOJO-REPORT T2)
//
// A signature answers one question, on a PUBLIC page: "have we seen this before?"
// So it is derived from the FAILURE SHAPE and from nothing else.
//
//  1. NOT CONTENT-DERIVED, and that is a privacy property before it is a dedupe
//     property. Hashing the brief would put a fingerprint of the user's own words
//     on a GitHub issue and would make every report unique anyway — two boxes
//     hitting the same defect would never match. The inputs here are two platform
//     facts: the lane (a five-member closed set) and the DOMINANT failure, which is a
//     tool name plus an `audit_log.result` verdict or a `turns.exit_reason` — all
//     closed domains the platform itself authored. Nothing a user or an agent typed
//     reaches this function.
//
//  2. STABLE ACROSS BOXES. Same lane, same dominant failure → same token, on
//     anyone's machine. That is what lets T7 search the issue tracker for the digest
//     and comment on the existing issue instead of filing a duplicate. It also means
//     the caller's RANKING must be deterministic — see `dominantToken`.
//
//  3. VERSION-FREE (owner decision 17, v3.4). The same problem on a different release
//     is the same issue, so the platform version is NOT in the hash. The earlier
//     `ds1-` scheme keyed on it, which meant a defect re-reported after an update could
//     never find its own open issue. The cost of over-matching is one extra click (the
//     duplicate offer is a question, never an action); the cost of a miss is a second
//     thread for one defect.
//
//  4. THE DOMINANT FAILURE IS IN-WINDOW EVIDENCE ONLY (v3.4 E3). `gather.ts` builds it
//     from the window's own audit rows. The cumulative per-agent failure-streak counter
//     is not an input: it describes what the agent has been failing at lately, not what
//     this report is about, and it made two different problems share a signature.
//
//  5. `ds2-` IS A SCHEME PREFIX, not decoration. The derivation changed (version out,
//     in-window ranking), so `ds2-` tokens deliberately do not match `ds1-` ones. A
//     `ds1-` issue cannot be re-derived (its hash held the release and a streak count we
//     no longer have), so it is NOT matched or linked to; it stays findable by searching
//     the tracker for `dojo-sig: ds1-`. A bare hex string would silently collide two
//     different derivations.
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

/**
 * THE FIVE LANES. A closed set, on purpose: the lane rides into the signature and
 * into the telemetry attachment as an enum, and a free-form lane would be a free-text
 * field entering a public page through the back door (D1).
 */
export const FAILURE_LANES = ['tool-error', 'wrong-answer', 'silence', 'permission', 'other'] as const;
export type FailureLane = typeof FAILURE_LANES[number];

/** Exact membership. No case folding, no trimming: a near-miss is a caller's bug, not a lane. */
export function isFailureLane(v: unknown): v is FailureLane {
  return typeof v === 'string' && (FAILURE_LANES as readonly string[]).includes(v);
}

export interface DominantFailure {
  /** Ranked tool failures in the window: highest count first. */
  readonly toolFailures: readonly { tool: string; result: string; count: number }[];
  /** Ranked non-'answered' turn exits in the window: highest count first. */
  readonly turnExits: readonly { exitReason: string; count: number }[];
}

/**
 * THE ONE FACT THE SIGNATURE HASHES BESIDES THE LANE.
 *
 * Tool failures outrank turn exits deliberately: an exit reason is downstream of
 * whatever went wrong (a turn that hit a refused tool call often exits `brake`), so
 * ranking exits first would collapse many distinct defects onto one token.
 *
 * ⚠ RANKING IS THE CALLER'S JOB AND MUST BE DETERMINISTIC — sort by `count`
 * descending, ties broken by the key string ascending (`localeCompare`). Two boxes
 * with the same evidence must hand this function the same first element, or the
 * signature stops being stable and the whole dedupe is theatre. Only the HEAD of
 * each list is read, so a differing tail cannot move the token.
 */
export function dominantToken(d: DominantFailure): string {
  const t = d.toolFailures[0];
  if (t) return `tool:${t.tool}:${t.result}`;
  const e = d.turnExits[0];
  if (e) return `turn:${e.exitReason}`;
  return 'none';
}

/**
 * `ds2-` + the first 12 hex characters of sha256 over `lane|dominant`.
 *
 * Twelve is 48 bits — ample for a population of failure SHAPES (hundreds, not
 * millions) and short enough to read out loud in an issue title.
 */
export function deriveReportSignature(lane: FailureLane, dominant: DominantFailure): string {
  const input = `${lane}|${dominantToken(dominant)}`;
  return `ds2-${createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12)}`;
}

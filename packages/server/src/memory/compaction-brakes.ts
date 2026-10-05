// ════════════════════════════════════════════════════════════════════════════
// THE BRAKES WORK UNDER FORCE — AND THEY LET GO (v3.2.3 layer 1, re-aimed by OR-COMPACT-1)
//
// ── THE LOOP, TRACED (v3.2.3, and still the reason this file exists) ──
// `compactionGate` puts an agent at `compact` (≥96% of the compressible budget) or
// `block` (≥99%). The pre-call gate answers both by awaiting
// `checkAndCompact(..., { force: true })`. Inside, THREE brakes existed — the
// 15-minute low-yield backoff, the "outside-tail region too small" floor, and the
// "nothing outside the fresh tail" no-op guard — and **every one of them was
// `!force`-gated**. So in exactly the state that sets `force`, the platform had no
// brake at all: the same pass ran on every prompt, for ever, because the gate
// re-derives the same ratio from the same rows each turn.
//
// On the incident box that was ~4,000 uncompacted messages and ~86K tokens of existing
// summaries against a 64K-window model, with the summary writer pointed at a provider
// returning 402. Every prompt: full reactive cycle, one core pinned, dashboard and stop
// dead with it (better-sqlite3 is synchronous), nothing reclaimed, no exit.
//
// ── WHAT THIS FILE IS, IN ONE SENTENCE ──
// Emergency means FIRST, not INFINITE — and never TERMINAL.
//
//  1. A FORCED PASS IS BUDGETED. `forcedCompactionOptions()` gives the forced path the
//     same two bounds the routine drain has always had (`context-gates.ts`'s own
//     `maxChunksPerRun` + wall-clock abort). A forced pass does the FIRST slice of the
//     work and returns; the next turn continues if there is anything left to win.
//  2. THE BACKOFF SETS EVEN ON FORCE. `notePassOutcome` records what a pass achieved, and
//     a FORCED pass that reclaimed nothing arms the brake against everybody — including
//     the next forced pass. That anti-thrash property is the whole of what survives from
//     the first cut, and the owner kept it deliberately.
//  3. AND THERE IS NO TERMINAL STATE. **OR-COMPACT-1** (owner, 2026-10-02: *"there is
//     never a reason for compaction to end… an agent's memory can always compress"*). The
//     first cut answered the incident with a latch called INCOMPRESSIBLE and a card
//     telling the owner to archive the conversation or reset the session. The owner
//     abolished both: a memory that will not shrink is a DEFECT to repair, not a state to
//     live in. So what used to latch for ever now backs off for fifteen minutes and LETS
//     GO — on the clock, on a reset, on a bigger window, on a shrunken history, and the
//     moment the summary writer answers again. `memory/condense-until-fits.ts` makes the
//     memory shrink; `memory/compaction-defect.ts` reports the stage that refused; this
//     file is only the brake between passes.
//
// ⚠ WHAT IT DOES NOT DO: it does not lower a bound anybody declared, does not touch prompt
// assembly (the cache-preservation tenet binds — no reordering, no prefix bytes), and does
// not make the agent unusable. A backed-off agent keeps answering; it simply stops
// re-running a cycle that just failed, until the facts move or the clock runs out.
//
// The wedge this resolves is the one `dag.ts`'s own note records ("context never shrank
// and reactive compaction re-fired on every turn"); that note now points here.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import {
  writerBreaker, reportCompactionDefect, noteCompactionRecovered, clearCompactionFailure,
  __resetCompactionFailuresForTests, compactionFailureReason,
  type CompactionFailure, type CompactionPassFacts,
} from './compaction-defect.js';

const logger = createLogger('compaction-brakes');

/** Unchanged from the code this replaces: a low-yield run backs off for 15 minutes. */
export const LOW_YIELD_BACKOFF_MS = 15 * 60_000;
/** Unchanged: fewer rows than this outside the fresh tail cannot reclaim meaningfully. */
export const MIN_COMPACTABLE_ROWS = 6;

/**
 * A pass reclaiming less than this counts as reclaiming nothing. The owner's own words for
 * the shape this number exists for: *"compaction SO much, saving like 16 tokens"*. 1,000 is
 * the figure the compaction divider already uses to decide a run was worth telling the user
 * about, and the same floor `condense-until-fits.ts` calls progress.
 */
export const FORCED_YIELD_FLOOR_TOKENS = 1_000;

/**
 * THE FORCED PASS'S OWN BOUNDS — the routine drain's numbers, applied to the path that
 * never had them. `context-gates.ts` caps a routine drain at 1-10 chunks with a 60-180 s
 * abort; a forced pass is more urgent, not less bounded, so it gets the generous end of
 * both. Ten leaf chunks is ~300K tokens of history per turn — more than any single turn
 * can have added.
 */
export const FORCED_MAX_CHUNKS_PER_RUN = 10;
export const FORCED_WALL_CLOCK_MS = 180_000;

/**
 * THE BRAKE, AND WHAT IT REMEMBERS ABOUT WHY IT IS ON.
 *
 * `until` is the clock — a brake with no expiry is the terminal state OR-COMPACT-1
 * abolished. `bindsUnderForce` separates the two brakes the first cut conflated: a routine
 * low-yield skip still yields to a genuine 96% emergency, while a FORCED pass that already
 * ran and won nothing has earned the right to stop the next forced pass too.
 * `writerModelId` is set when the named cause was a dead summary writer, so the brake lets
 * go the instant that provider answers again (D4: no manual step). The three facts are the
 * HISTORY this brake is about: any of them moving makes it a different question.
 */
interface Backoff {
  until: number;
  bindsUnderForce: boolean;
  writerModelId: string | null;
  seqAtArm: number;
  sessionAtArm: string | null;
  modelAtArm: string | null;
}

const backoffs = new Map<string, Backoff>();

interface BrakeFacts { hi: number; session: string | null; model: string | null }

/**
 * THE FACTS A BRAKE IS ABOUT, in one read. (v3.2.3 review M2, carried forward.)
 *
 * `seq` IS the messages rowid alias (T10). `session_started_at` is the boundary the
 * assembler reads from, so moving it is what a session reset actually DOES. `model_id`
 * carries the context window, so switching models changes the budget this was measured
 * against. Read ONLY when a brake is on — an unbraked agent pays nothing for this.
 */
function brakeFacts(agentId: string): BrakeFacts {
  try {
    const row = getDb().prepare(
      'SELECT (SELECT MAX(seq) FROM messages WHERE agent_id = a.id) AS hi,'
      + ' a.session_started_at AS session, a.model_id AS model FROM agents a WHERE a.id = ?',
    ).get(agentId) as { hi: number | null; session: string | null; model: string | null } | undefined;
    return { hi: row?.hi ?? 0, session: row?.session ?? null, model: row?.model ?? null };
  } catch {
    return { hi: 0, session: null, model: null };
  }
}

/**
 * HAS THIS AGENT BEEN GIVEN ROOM SINCE THE BRAKE WENT ON? Three mechanisms, none of which
 * can rot: `model_id` is written at NINE sites and `session_started_at` at five, so a
 * release that depends on every door remembering to call a clear function is a release that
 * rots. Comparing the FACTS cannot: whichever door moved them, and whoever adds the tenth,
 * the brake sees a different question and lets go. A high-water mark that went DOWN counts
 * too — that is a purge or a trim, the most room an agent can gain.
 *
 * ⚠ OR-COMPACT-1 REMOVED A FOURTH ARM. The first cut also released on six NEW rows
 * (`MIN_COMPACTABLE_ROWS`), because a latch that never let go would otherwise be for ever.
 * The brake now expires on its own, and new rows are the CASE FOR compaction rather than
 * evidence the last refusal changed — so a growing history no longer buys a re-run every
 * six prompts, which is the treadmill the t87 review flagged as residual 3.
 */
function roomGained(agentId: string, b: Backoff): string | null {
  const now = brakeFacts(agentId);
  if (now.session !== b.sessionAtArm) return 'session_reset';
  if (now.model !== b.modelAtArm) return 'model_changed';
  if (now.hi < b.seqAtArm) return 'history_shrank';
  return null;
}

function releaseBrake(agentId: string, why: string): false {
  backoffs.delete(agentId);
  logger.info('Compaction backoff released: this agent may compact again', { why }, agentId);
  return false;
}

/**
 * ARE THE BRAKES ON? The one predicate the compaction entry point asks, and the reason it
 * takes `force`: a brake armed by a FORCED pass that won nothing binds even under force
 * (that is the anti-thrash fix), while a routine low-yield backoff still yields to an
 * emergency — a real 96% with real rows to compact should act.
 *
 * ⚠ AND IT ALWAYS LETS GO. No arm of this function can return `true` for ever: the clock,
 * the three facts, and the summary writer coming back each end it. That property is
 * OR-COMPACT-1, enforced here rather than promised in a comment.
 */
export function compactionIsBraked(agentId: string, force: boolean): boolean {
  const b = backoffs.get(agentId);
  if (!b) return false;
  if (b.until <= Date.now()) return releaseBrake(agentId, 'backoff_expired');
  // D4's "no manual step": the brake's own stated cause has gone away, so it is answering a
  // question nobody is asking any more.
  if (b.writerModelId && !writerBreaker(b.writerModelId)) return releaseBrake(agentId, 'summary_writer_is_back');
  const gained = roomGained(agentId, b);
  if (gained) return releaseBrake(agentId, gained);
  if (force && !b.bindsUnderForce) return false;
  logger.info('Compaction skipped: backing off after a pass that reclaimed nothing', {
    force, bindsUnderForce: b.bindsUnderForce, msLeft: b.until - Date.now(),
    failingStage: compactionFailureReason(agentId),
  }, agentId);
  return true;
}

function armBackoff(agentId: string, bindsUnderForce: boolean, writerModelId: string | null): void {
  const facts = brakeFacts(agentId);
  const existing = backoffs.get(agentId);
  backoffs.set(agentId, {
    until: Date.now() + LOW_YIELD_BACKOFF_MS,
    // Once a forced pass has lost, a later routine loss must not weaken the brake.
    bindsUnderForce: bindsUnderForce || !!existing?.bindsUnderForce,
    writerModelId: writerModelId ?? existing?.writerModelId ?? null,
    seqAtArm: facts.hi, sessionAtArm: facts.session, modelAtArm: facts.model,
  });
}

/** The 15-minute brake, armed by the existing "too small to reclaim" floor. */
export function noteLowYield(agentId: string): void {
  armBackoff(agentId, false, null);
}

/**
 * WHAT A PASS ACHIEVED — called after every full reactive cycle, forced or not.
 *
 * A pass that created nothing and reclaimed under the floor arms the 15-minute brake for
 * EVERY caller, and — when it was FORCED, i.e. the gate called this an emergency and the
 * emergency still produced nothing — arms it against the next forced pass too.
 *
 * A pass whose condensation stage NAMED a refusal reports the defect even when some other
 * stage won tokens, because a named refusal is a thing to repair (OR-COMPACT-1 part 3).
 *
 * Returns the failure note when this call created it, so the caller can stop.
 */
export function notePassOutcome(
  agentId: string,
  force: boolean,
  result: { leafCreated: number; condensedCreated: number; tokensReclaimed: number },
  facts?: CompactionPassFacts,
): CompactionFailure | null {
  const created = result.leafCreated + result.condensedCreated;
  const wonNothing = created === 0 && result.tokensReclaimed < FORCED_YIELD_FLOOR_TOKENS;
  const stage = facts?.stage ?? null;
  const overBudget = facts?.assembledTokens != null && facts.budgetTokens != null
    && facts.assembledTokens > facts.budgetTokens;

  if (!wonNothing && !stage) {
    // Progress resets everything: a pass that won means the next pressure is real.
    backoffs.delete(agentId);
    noteCompactionRecovered(agentId, result.tokensReclaimed);
    return null;
  }

  armBackoff(agentId, force && wonNothing, stage === 'summary_writer_unavailable' ? facts?.modelId ?? null : null);
  // A merely low-yield pass that is no longer over budget has nothing to report: the brake
  // is the whole answer, exactly as it was before this ruling.
  if (!stage && !overBudget) return null;
  return reportCompactionDefect(agentId, stage ?? 'no_yield', facts, result);
}

/**
 * THE EXPLICIT CLEAR, for a door that knows it gave the agent room before the facts settle.
 * Called by `archiveAgentConversation` — the one function all six archive/new-session/reset
 * doors funnel through — so a reset gets its fresh start on the spot rather than on the next
 * brake check. Session resets and model switches are ALSO covered by the facts comparison in
 * `compactionIsBraked`, deliberately: this call is the fast path, that is the one that cannot rot.
 */
export function clearCompactionBackoff(agentId: string): boolean {
  const hadBrake = backoffs.delete(agentId);
  const hadNote = clearCompactionFailure(agentId);
  if (hadBrake || hadNote) logger.info('Compaction backoff cleared: this agent has room again', {}, agentId);
  return hadBrake || hadNote;
}

/**
 * IS THE SUMMARY WRITER DIALLABLE AT ALL? (layer 2c + layer 3, the two meeting)
 *
 * The incident's inner loop built a summariser prompt for every one of ~4,000 chunks —
 * scrub, condense, join, estimate — and THEN sent it to a provider that had been answering
 * 402 for a day. Construction is the expensive half and it is pure waste once the provider
 * is known dead, so this is asked BEFORE the build, at the top of each iteration: the 402
 * that opens the breaker stops the very next chunk.
 *
 * `false` when there is no provider row to judge — an unknown provider is dialled exactly
 * as before, because this predicate exists to stop a KNOWN wall, not to invent one.
 */
export function summaryWriterUnavailable(agentId: string, modelId: string | undefined): boolean {
  const open = writerBreaker(modelId);
  if (!open) return false;
  logger.warn('Summary writer unavailable: its provider is circuit-broken, no chunk will be built', {
    modelId, providerId: open.providerId, reason: open.reason,
  }, agentId);
  return true;
}

/**
 * THE FORCED PASS'S OPTIONS — the whole of "emergency means FIRST, not INFINITE".
 *
 * Returns the option bag `checkAndCompact` already understands, so the gate's call site
 * changes by one argument and this module never imports the compactor (no cycle, and the
 * compactor keeps exactly one entry point). The abort is a real wall-clock timer, exactly as
 * `context-gates.ts` arms one for the routine drain.
 */
export function forcedCompactionOptions(): {
  force: true; maxChunksPerRun: number; abortSignal: AbortSignal;
} {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FORCED_WALL_CLOCK_MS);
  // Never keep the process alive for a compaction deadline.
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }
  return { force: true, maxChunksPerRun: FORCED_MAX_CHUNKS_PER_RUN, abortSignal: ctl.signal };
}

/** Test-only reset; the maps are per-process. Resets the failure notes with them, because a
 *  clause that cleared one and not the other would be testing half a state machine. */
export function __resetBrakesForTests(): void {
  backoffs.clear();
  __resetCompactionFailuresForTests();
}

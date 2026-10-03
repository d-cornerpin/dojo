// ════════════════════════════════════════════════════════════════════════════
// THE BRAKES WORK UNDER FORCE (v3.2.3 incident, layer 1)
//
// ── THE LOOP, TRACED ──
// `compactionGate` puts an agent at `compact` (≥96% of the compressible budget) or
// `block` (≥99%). The pre-call gate answers both by awaiting
// `checkAndCompact(..., { force: true })`. Inside, THREE brakes exist — the
// 15-minute low-yield backoff, the "outside-tail region too small" floor, and the
// "nothing outside the fresh tail" no-op guard — and **every one of them is
// `!force`-gated**. So in exactly the state that sets `force`, the platform has no
// brake at all: the same pass runs on every prompt, for ever, because the gate
// re-derives the same ratio from the same rows each turn.
//
// On the incident box that was ~4,000 uncompacted messages and ~86K tokens of
// existing summaries against a 64K-window model — a context that CANNOT be
// compressed further — with the summary writer pointed at a provider returning 402.
// Every prompt: full reactive cycle, one core pinned, dashboard and stop dead with
// it (better-sqlite3 is synchronous), nothing reclaimed, no exit.
//
// ── WHAT THIS FILE CHANGES, IN ONE SENTENCE ──
// Emergency means FIRST, not INFINITE.
//
//  1. A FORCED PASS IS BUDGETED. `forcedCompactionBudget()` gives the forced path
//     the same two bounds the routine drain has always had (`context-gates.ts`'s
//     own `maxChunksPerRun` + wall-clock abort): a bounded number of chunks and a
//     deadline. A forced pass now does the FIRST slice of the work and returns; the
//     next turn continues if there is anything left to win.
//  2. THE BACKOFF SETS EVEN ON FORCE. `noteForcedOutcome` records what a forced
//     pass actually achieved, and a pass that reclaimed nothing arms the brake for
//     everybody — including the next forced pass.
//  3. AND THERE IS A TERMINAL STATE. Two conditions mean *no future pass can help*:
//     a forced pass that created no summaries and reclaimed ~nothing, or summaries
//     that already exceed the assembly budget (there is nothing left to summarise —
//     the bloat IS the summaries). Either latches INCOMPRESSIBLE, which stops the
//     loop and surfaces one card telling the owner the only two things that work.
//
// ⚠ WHAT IT DOES NOT DO: it does not lower a bound anybody declared, does not touch
// prompt assembly (the cache-preservation tenet binds — no reordering, no prefix
// bytes), and does not make the agent unusable. An INCOMPRESSIBLE agent keeps
// answering; it simply stops re-running a cycle that cannot succeed.
//
// The wedge this resolves is the one `dag.ts`'s own note records ("context never
// shrank and reactive compaction re-fired on every turn"); that note now points here.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getDb } from '../db/connection.js';
import { providerBreaker } from '../providers/billing-breaker.js';

const logger = createLogger('compaction-brakes');

/** Unchanged from the code this replaces: a low-yield run backs off for 15 minutes. */
export const LOW_YIELD_BACKOFF_MS = 15 * 60_000;
/** Unchanged: fewer rows than this outside the fresh tail cannot reclaim meaningfully. */
export const MIN_COMPACTABLE_ROWS = 6;

/**
 * A forced pass reclaiming less than this counts as reclaiming nothing. The owner's
 * own words for the shape this number exists for: *"compaction SO much, saving like
 * 16 tokens"*. 1,000 is the same figure the compaction divider already uses to
 * decide a run was worth telling the user about.
 */
export const FORCED_YIELD_FLOOR_TOKENS = 1_000;

/**
 * THE FORCED PASS'S OWN BOUNDS — the routine drain's numbers, applied to the path
 * that never had them. `context-gates.ts` caps a routine drain at 1-10 chunks with
 * a 60-180 s abort; a forced pass is more urgent, not less bounded, so it gets the
 * generous end of both: ten chunks and three minutes. Ten leaf chunks is ~300K
 * tokens of history per turn — more than any single turn can have added.
 */
export const FORCED_MAX_CHUNKS_PER_RUN = 10;
export const FORCED_WALL_CLOCK_MS = 180_000;

/** Why an agent is latched. Both mean "no future pass can win". */
export type IncompressibleReason = 'no_yield' | 'summaries_exceed_budget';

interface Latch {
  reason: IncompressibleReason;
  since: string;
  assembledTokens: number;
  budgetTokens: number;
  /** The three facts this latch was ABOUT. Any of them moving makes it a different question. */
  seqAtLatch: number;
  sessionAtLatch: string | null;
  modelAtLatch: string | null;
}

const lowYieldBackoffUntil = new Map<string, number>();
const incompressible = new Map<string, Latch>();

/** The card the owner gets. One sentence of state, then the only two actions. */
export function incompressibleCardText(reason: IncompressibleReason): string {
  const why = reason === 'summaries_exceed_budget'
    ? 'its history is already summarised down to the point where the summaries alone fill the window'
    : 'a full compaction pass reclaimed nothing';
  return `This agent's memory cannot compress further — ${why}. `
    + 'It will keep answering, but it has stopped re-running compaction every turn. '
    + 'Archive this conversation or reset the agent\'s session to give it room; '
    + 'switching it to a model with a larger context window also clears this.';
}

/**
 * ARE THE BRAKES ON? The one predicate the compaction entry point asks, and the
 * reason it takes `force`: an INCOMPRESSIBLE latch binds even under force (that is
 * the whole fix), while the 15-minute low-yield backoff still yields to an
 * emergency — a real 96% with real rows to compact should act.
 */
export function compactionIsBraked(agentId: string, force: boolean): boolean {
  const latch = incompressible.get(agentId);
  if (latch) {
    // ⚠ A LATCH IS ABOUT A HISTORY, NOT ABOUT AN AGENT — and an existing clause taught me the
    // difference. `the-clock-does-not-overrule-the-token-math` drives a forced pass that wins
    // nothing (which latches) and then, on the SAME agent, a state that genuinely should compact;
    // a latch that outlived the first history silently refused the second. So the latch clears
    // once the agent has gained enough new rows to make a future pass a different question —
    // `MIN_COMPACTABLE_ROWS`, the same floor that decides a region is worth compacting at all.
    // On the incident box this costs ONE bounded pass every six prompts instead of an unbounded
    // pass on every prompt, and it re-latches immediately, which is the honest trade: the
    // platform re-checks reality rather than trusting a stale fact for ever.
    //
    // ⚠ AND THE CARD NAMES THREE MORE WAYS OUT, SO ALL THREE RELEASE IT. (review M2: the card
    // told the owner to archive, reset the session or switch to a bigger model, and none of those
    // cleared anything — a user-facing instruction that does not do what it says.) `model_id` is
    // written at NINE sites and `session_started_at` at five, so a release that depends on every
    // one of those doors remembering to call a clear function is a release that rots. Comparing
    // the FACTS cannot rot: whichever door moved them, and whoever adds the tenth, the latch sees
    // a different question and lets go. A high-water mark that went DOWN counts too — that is a
    // purge or a trim, which is the most room an agent can possibly gain.
    const now = latchFacts(agentId);
    const gained = now.session !== latch.sessionAtLatch ? 'session_reset'
      : now.model !== latch.modelAtLatch ? 'model_changed'
        : now.hi < latch.seqAtLatch ? 'history_shrank'
          : now.hi - latch.seqAtLatch >= MIN_COMPACTABLE_ROWS ? 'history_grew' : null;
    if (!gained) {
      logger.info('Compaction skipped: this agent\'s memory is latched INCOMPRESSIBLE', {
        reason: latch.reason, since: latch.since, force, rowsSinceLatch: now.hi - latch.seqAtLatch,
      }, agentId);
      return true;
    }
    logger.info('Compaction latch released: this agent has room again', {
      gained, rowsSinceLatch: now.hi - latch.seqAtLatch,
    }, agentId);
    incompressible.delete(agentId);
  }
  if (force) return false;
  return (lowYieldBackoffUntil.get(agentId) ?? 0) > Date.now();
}

/** The 15-minute brake, armed by the existing "too small to reclaim" floor. */
export function noteLowYield(agentId: string): void {
  lowYieldBackoffUntil.set(agentId, Date.now() + LOW_YIELD_BACKOFF_MS);
}

/**
 * WHAT A PASS ACHIEVED — called after every full reactive cycle, forced or not.
 *
 * A pass that created nothing and reclaimed under the floor arms the 15-minute
 * brake for EVERY caller, and — when it was a forced pass, i.e. the gate said this
 * was an emergency and the emergency still produced nothing — latches
 * INCOMPRESSIBLE and cards the owner once.
 *
 * Returns the latch when this call created it, so the caller can stop.
 */
export function noteForcedOutcome(
  agentId: string,
  force: boolean,
  result: { leafCreated: number; condensedCreated: number; tokensReclaimed: number },
  summaryTokens = 0,
  assemblyBudgetTokens = 0,
): Latch | null {
  const created = result.leafCreated + result.condensedCreated;
  const wonNothing = created === 0 && result.tokensReclaimed < FORCED_YIELD_FLOOR_TOKENS;
  if (!wonNothing) {
    // Progress resets everything: a pass that won means the next pressure is real.
    lowYieldBackoffUntil.delete(agentId);
    return null;
  }
  noteLowYield(agentId);
  if (!force) return null;
  // ⚠ TERMINALITY IS DECIDED ON EVIDENCE, NOT PREDICTION — and an existing clause is why.
  // The first cut latched BEFORE the work whenever summaries already exceeded the assembly
  // budget. `the-clock-does-not-overrule-the-token-math`'s "THE TOKEN PATH IS UNTOUCHED" clause
  // drives exactly that shape and expects a summary to be written: raw rows outside the fresh
  // tail can still be summarised even when the summaries are large, so "summaries over budget"
  // is a guess about the future and a forced pass is entitled to try once. What latches is a
  // forced pass that RAN and won nothing. The summaries fact survives only to name the reason,
  // which is what makes the card say something true about this agent rather than generic.
  const reason: IncompressibleReason =
    assemblyBudgetTokens > 0 && summaryTokens > assemblyBudgetTokens
      ? 'summaries_exceed_budget'
      : 'no_yield';
  return latchIncompressible(agentId, reason, summaryTokens, assemblyBudgetTokens);
}

/**
 * THE SECOND TERMINAL CONDITION — the one visible BEFORE spending a model call, and the reason it
 * takes a row count. (Wired at the entry point by review M3.)
 *
 * TWO facts have to be true together, and an existing clause is why it is two and not one.
 *
 *   1. The summaries alone already exceed what the assembler will admit.
 *   2. There is nothing left outside the fresh tail worth compacting — fewer than
 *      `MIN_COMPACTABLE_ROWS`, the floor that decides a region is worth a pass at all.
 *
 * Fact 1 alone is NOT terminal, and claiming it was is the mistake this signature now prevents.
 * `the-clock-does-not-overrule-the-token-math`'s "THE TOKEN PATH IS UNTOUCHED" clause drives large
 * summaries WITH raw rows outside the tail and expects a summary to be written — correctly: those
 * raw rows can still shrink, and the assembler caps admitted summaries at the budget anyway
 * (`summaryTokens = Math.min(rawSummaryTokens, summaryBudget)`), so big summaries are survivable
 * while the raw side still has give. A pass is entitled to try, and `noteForcedOutcome` latches it
 * on evidence if it wins nothing.
 *
 * With BOTH facts true there is no give left anywhere: large summaries, nothing to compact, and
 * every future turn re-asking the same question. That agent pays ZERO passes instead of one every
 * six prompts, which is exactly what review residual 3 asked for.
 */
export function latchIfSummariesExceedBudget(
  agentId: string, summaryTokens: number, assemblyBudgetTokens: number, compactableRows: number,
): Latch | null {
  if (assemblyBudgetTokens <= 0 || summaryTokens <= assemblyBudgetTokens) return null;
  if (compactableRows >= MIN_COMPACTABLE_ROWS) return null;
  return latchIncompressible(agentId, 'summaries_exceed_budget', summaryTokens, assemblyBudgetTokens);
}

/**
 * THE FACTS A LATCH IS ABOUT, in one read. (v3.2.3 review, M2)
 *
 * `seq` IS the messages rowid alias (T10). `session_started_at` is the boundary the assembler
 * reads from, so moving it is what a session reset actually DOES. `model_id` carries the context
 * window, so switching models changes the budget the latch was measured against.
 *
 * Read together because the card promises all three, and read ONLY when a latch exists — an
 * unlatched agent (every agent, nearly always) pays nothing for this.
 */
interface LatchFacts { hi: number; session: string | null; model: string | null }

function latchFacts(agentId: string): LatchFacts {
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

function latchIncompressible(
  agentId: string, reason: IncompressibleReason, assembledTokens: number, budgetTokens: number,
): Latch | null {
  if (incompressible.has(agentId)) return null;   // one latch, one card
  const facts = latchFacts(agentId);
  const latch: Latch = {
    reason, since: new Date().toISOString(), assembledTokens, budgetTokens,
    seqAtLatch: facts.hi, sessionAtLatch: facts.session, modelAtLatch: facts.model,
  };
  incompressible.set(agentId, latch);
  logger.error('Compaction latched INCOMPRESSIBLE: no further pass can reclaim anything', {
    reason, assembledTokens, budgetTokens,
  }, agentId);
  try {
    broadcast({
      type: 'chat:error',
      agentId,
      error: incompressibleCardText(reason),
      code: 'MEMORY_INCOMPRESSIBLE',
      severity: 'error',
      retryable: false,
    });
  } catch { /* best effort — the latch is the fix, the card is the courtesy */ }
  return latch;
}

/**
 * THE EXPLICIT CLEAR, for a door that knows it gave the agent room before the facts settle.
 * Called by `archiveAgentConversation` — the one function all six archive/new-session/reset doors
 * funnel through — so the card's first instruction takes effect on the spot rather than on the
 * next brake check. Session resets and model switches are ALSO covered by the facts comparison in
 * `compactionIsBraked`, deliberately: this call is the fast path, that is the one that cannot rot.
 */
export function clearIncompressible(agentId: string): boolean {
  lowYieldBackoffUntil.delete(agentId);
  const had = incompressible.delete(agentId);
  if (had) logger.info('Compaction latch cleared: this agent has room again', {}, agentId);
  return had;
}

export function isIncompressible(agentId: string): IncompressibleReason | null {
  return incompressible.get(agentId)?.reason ?? null;
}

/**
 * IS THE SUMMARY WRITER DIALLABLE AT ALL? (layer 2c + layer 3, the two meeting)
 *
 * The incident's inner loop built a summariser prompt for every one of ~4,000 chunks
 * — scrub, condense, join, estimate — and THEN sent it to a provider that had been
 * answering 402 for a day. Construction is the expensive half and it is pure waste
 * once the provider is known dead, so this is asked BEFORE the build, at the top of
 * each iteration: the 402 that opens the breaker stops the very next chunk.
 *
 * `false` when there is no provider row to judge — an unknown provider is dialled
 * exactly as before, because this predicate exists to stop a KNOWN wall, not to
 * invent one.
 */
export function summaryWriterUnavailable(agentId: string, modelId: string | undefined): boolean {
  if (!modelId) return false;
  try {
    const row = getDb().prepare('SELECT provider_id FROM models WHERE id = ?').get(modelId) as { provider_id?: string } | undefined;
    if (!row?.provider_id) return false;
    const open = providerBreaker(row.provider_id);
    if (!open) return false;
    logger.warn('Summary writer unavailable: its provider is circuit-broken, no chunk will be built', {
      modelId, providerId: row.provider_id, reason: open.reason,
    }, agentId);
    return true;
  } catch {
    return false;
  }
}

/**
 * THE FORCED PASS'S OPTIONS — the whole of "emergency means FIRST, not INFINITE".
 *
 * Returns the option bag `checkAndCompact` already understands, so the gate's call
 * site changes by one argument and this module never imports the compactor (no
 * cycle, and the compactor keeps exactly one entry point).
 *
 * The abort is a real wall-clock timer, exactly as `context-gates.ts` arms one for
 * the routine drain: a forced pass that is still summarising three minutes later is
 * not making the turn better, and before this it had no deadline at all.
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

/** Test-only reset; the maps are per-process. */
export function __resetBrakesForTests(): void {
  lowYieldBackoffUntil.clear();
  incompressible.clear();
}

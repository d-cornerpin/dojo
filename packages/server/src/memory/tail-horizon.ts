// ════════════════════════════════════════════════════════════════════════════════════════
// t94 — THE FRESH TAIL'S HORIZON. WHERE THE LIVE CONVERSATION STARTS, AND WHY IT HOLDS STILL.
//
// ── THE INCIDENT (owner, BACKLOG line 15, his own full capture) ──────────────────────────
// The dojo dropped a few oldest messages off the FRONT of the conversation each turn to hold
// a context budget. Prefix caching is POSITIONAL: every small front-trim renumbers everything
// behind it, so the provider re-prefills the whole remaining conversation — ~55K tokens ≈
// 270s of pure waste per turn at 205 tok/s, with the server's `common=` pinned at ~25K of an
// ~80K prompt and turns running 400–600s against a 600s client timeout.
//
// THE ECONOMICS INVERT ON LOCAL. Tokens are free, recomputation is expensive, so BYTE
// STABILITY BEATS SHORTNESS — and dropping 2 messages costs exactly what dropping 200 costs.
// Trim-a-little-every-turn is therefore the most expensive possible cadence. His prescription,
// in his order of preference: (1) grow until a real compaction boundary and reduce only there;
// (2) if trimming is unavoidable, batch it LARGE and RARE (~once per 40 turns); (3) never a
// few per turn.
//
// ── WHAT WAS ACTUALLY TRIMMING, MEASURED BY THIS LANE'S OWN INSTRUMENT ───────────────────
// NOT the token budget. `memory/__tests__/the-tail-trims-only-at-a-boundary.test.ts` drove 48
// fictional turns on a 32K window and read the assembled array's bytes across every pair:
// from the moment the conversation reached the row cap, EVERY turn dropped exactly 2 rows off
// the front and re-prefilled 8,856 of 8,908 bytes — 52 bytes of shared prefix, which is the
// JSON envelope of message 0 and nothing else. The array held ~2,200 tokens against an
// assembly budget of 25,624. The budget was nowhere near binding.
//
// The trimmer was `assembler.ts`'s own tail read:
//
//     getRecentMessages(agentId, policy.freshTailCount, turnCutoff)
//
// `policy.freshTailCount` is a ROW cap — `memory/budget.ts`'s `getFreshTailCount`, a ladder of
// 24 / 40 / 64 / 80 rows by window size. So the live conversation was "THE NEWEST N ROWS": a
// SCROLLING WINDOW, which front-trims every turn at any utilisation, for ever. Compaction's
// own code says so in passing where it explains why its token trigger never fires — *"fresh
// tail is bounded by count, so total tokens don't grow unboundedly"*.
//
// `memory/__tests__/the-tail-holds-still.test.ts` already states the law this broke, for every
// tail BLOCK: a block renders byte-identically *"not until a window scrolls its edge past a
// row that did not move"*. The fresh tail's own row window was the one scrolling window
// nobody had claused.
//
// ── THE POLICY (his option 1, which is the shape this subsystem was already built for) ───
// The tail is EVERY ROW SINCE THE COMPACTION BOUNDARY. The boundary is the newest row a
// summary already covers — and compaction, by construction, only ever summarises rows OUTSIDE
// the newest `getFreshTailCount` rows (`runLeafCompaction` reads
// `getMessagesOutsideFreshTail(agentId, getFreshTailCount(cw))`, on the forced path too), so
// the boundary can never cut into what the row cap would have shown. The row cap survives
// exactly as it was, as a FLOOR.
//
// Between two compactions the boundary does not move, so the tail is a PURE APPEND and not one
// prefix byte shifts. At a compaction the boundary advances ONCE — and the rows it passes are
// the rows the summary compaction just wrote ABOVE the tail now represents, so that turn's
// prefix was going to be rewritten anyway. That is the one turn the owner's prescription says
// should pay for the whole stable run after it.
//
// ── AND THE HARD STOP, BECAUSE "GROW UNTIL COMPACTION" NEEDS ONE ─────────────────────────
// If compaction cannot run — the summary writer is down, its provider is circuit-broken, the
// agent is mid-backlog — the uncompacted span grows without limit, and a tail that grows
// without limit eventually cannot be loaded, let alone sent. So there is a ceiling, and the
// ceiling is the one place a front-trim is legitimate. It is made LARGE, RARE and LOUD:
//
//   * LARGE and RARE because the front is quantised. It is never "the newest N rows"; it is
//     `boundary + k × block`, k the smallest integer that fits. k increments by ONE WHOLE
//     BLOCK at a time, so the front holds still for a block's worth of turns and then moves
//     once, by a lot. A quantity measured from the BACK of the array scrolls by construction;
//     a quantity measured from the FRONT, in blocks, cannot.
//   * LOUD because the row count it drops lands in FA-M1's `freshTailDropped`, which the loop
//     already surfaces as a warning. A trim this size is an event, and it says so.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { ContextWindowPolicy } from './budget.js';

const logger = createLogger('memory-tail-horizon');

/**
 * THE ROW CEILING, as a multiple of the window's own row cap.
 *
 * Why a multiple and not a constant: the row cap is already the one number in this subsystem
 * that is a function of the window (24 rows at 8K, 80 at 200K), and a constant ceiling would
 * mean a 200K box and an 8K box tolerate the same backlog. ×8 (320 rows on a 32K box, 640 on a
 * 200K one) is the largest live view this subsystem will carry between two condenses.
 *
 * t140: THIS NUMBER NOW HAS TWO READERS AND ONE OWNER. The cut below (`freshTailHorizon`) and
 * the condense trigger (`rowsLeavingView`) both read the ceiling and its step from here, so the
 * trigger can never disagree with the cut about which rows go next. The trigger fires one trim
 * block ahead of the ceiling (`ceilingLeadRows`) and folds exactly the rows the next cut would
 * skip, so on a box whose summary writer works the cut never fires at all: the rows it would
 * have dropped already have a summary and the boundary has moved past them. Reaching the
 * ceiling therefore still means compaction has been failing for a long time, which is the
 * condition this ceiling exists for. (Before t140 the routine row-gap drain kept a healthy agent
 * at `cap + ~30` rows by summarising rows the model was still reading; that drain is gone.)
 */
export const TAIL_HORIZON_CEILING_MULTIPLE = 8;

/**
 * THE CEILING'S STEP, in rows: HALF THE CEILING, and that fraction is load-bearing twice.
 *
 * CADENCE. A cut takes the span from just over the ceiling down to half of it, so the next cut
 * is half a ceiling of rows away — 160 rows ≈ 80 outer turns on a 32K box, 256 ≈ 128 turns on
 * a 128K one. Large, and rarer than the owner's "~once per 40 turns" asked for, which is the
 * right side to err on for a path that only exists when compaction is already broken.
 *
 * AND MONOTONICITY, WHICH IS THE PART THAT IS NOT TASTE. Two trimmers cut this tail's front —
 * this ceiling and `groupsToDropForBudget`'s token trim — and a composite front that can move
 * BACKWARDS is a prefix rewrite that buys nothing. (Measured, with the step at one row cap: a
 * ceiling cut shrank the loaded span, the token trim then found everything fitted and dropped
 * nothing, and the tail GREW back at the front — three discontinuities per twenty turns
 * instead of one.) At half the ceiling it cannot happen, and here is why: the token trim never
 * drops more than HALF the groups it is given, so the composite front before a cut is at most
 * `oldSkip + n/2`; and `n ≈ 2 × step` at the moment a cut fires, so that is at most
 * `oldSkip + step`, which is exactly the new skip. The new front is therefore never behind the
 * old one. The half in `maxDrop` and the half here are the same half.
 */
export function tailCeilingStepRows(freshTailCount: number): number {
  return Math.max(1, Math.floor((freshTailCount * TAIL_HORIZON_CEILING_MULTIPLE) / 2));
}

/**
 * THE CEILING'S CUT, in rows skipped past the boundary, for a span of `rowsSinceBoundary`.
 * 0 at or under the ceiling. Above it, a whole number of STEPS that takes the span down to
 * about half the ceiling — see `freshTailHorizon` for why the front moves this way. ONE
 * function, read by the cut itself AND by `rowsLeavingView`, so the condense trigger and the
 * cut cannot come to disagree about which rows leave next.
 */
export function ceilingSkipRows(rowsSinceBoundary: number, freshTailCount: number): number {
  const cap = Math.max(1, freshTailCount);
  const ceiling = cap * TAIL_HORIZON_CEILING_MULTIPLE;
  if (rowsSinceBoundary <= ceiling) return 0;
  const step = tailCeilingStepRows(cap);
  return (Math.floor(rowsSinceBoundary / step) - 1) * step;
}

/**
 * t140 — the condense trigger fires one token-trim block of rows ahead of the ceiling: room for
 * a background condense to finish before the cut (half a row cap — several tool calls of growth
 * against a handful of summariser calls). Larger folds rows sooner than the cut needs them gone;
 * smaller races the cut.
 */
export function ceilingLeadRows(freshTailCount: number): number {
  return tailTrimBlockGroups(freshTailCount);
}

/**
 * THE QUANTUM of a TOKEN trim, in whole tool-use groups. GRANULARITY, NOT CADENCE.
 *
 * The row horizon above is the dominant trimmer and the one the owner captured, but a tail can
 * still outgrow its TOKEN grant before the row ceiling binds — one enormous tool_result is
 * enough. `budgetFreshTail` drops whole groups off the front to fit, and it must drop them in
 * blocks. **WHY IT MUST** is the load-bearing sentence of this module, and review I2 is right
 * that the first version of this comment did not say it:
 *
 *     THE TOKEN TRIM IS STATELESS.
 *
 * `budgetFreshTail` is handed the whole span since the boundary on EVERY turn and recomputes
 * the drop from scratch; nothing anywhere remembers last turn's cut. So cross-turn stability
 * cannot come from memory — it can only come from the drop being a function that does not move
 * when its input grows by a row. Block quantisation IS that function: the front sits at a
 * multiple of the block and moves only when the needed drop crosses the next multiple. A later
 * worker who does not know this will read the quantisation as arithmetic noise, "simplify" it
 * to the minimum that fits, and bring the per-turn scroll back. That is the mutant §5 kills.
 *
 * SIZE, then. The block is GRANULARITY — the coarsest step the front may take — and it is
 * bounded ABOVE by the half-the-tail rule in `groupsToDropForBudget`: a block larger than half
 * the smallest tail that must be cuttable could never be dropped legally, and the search would
 * fall through to the loud minimum-fit path on exactly the healthy body it was meant to serve.
 * The smallest such tail is about one row cap, so the block is half a row cap — 12 groups at
 * 8K, 20 at 32K, 32 at 128K, 40 at 200K, one number across the ladder.
 *
 * IT IS NOT THE CADENCE. How far apart two cuts land is decided by how much the CUT frees,
 * which is `maxDrop`, not `block`. Review I2 named that conflation and it was mine.
 *
 * In GROUPS and not in rows because a group is the only unit `budgetFreshTail` may cut at: a
 * tool_use and its tool_result are one atom, and Anthropic-style providers reject a split pair.
 * The floor of 8 keeps the block meaningful on the smallest ladder rung.
 */
export function tailTrimBlockGroups(freshTailCount: number): number {
  return Math.max(8, Math.ceil(Math.max(0, freshTailCount) / 2));
}

export interface TailHorizon {
  /** The newest `messages.seq` already covered by a summary; 0 when nothing is compacted. */
  anchorSeq: number;
  /** Rows between the boundary and now, under the same session-boundary filter the tail
   *  reader applies. The quantity that grows while the prefix holds still. */
  rowsSinceBoundary: number;
  /** Keep rows with `seq >= this`. 0 means "apply no front filter" — the floor case, where
   *  the uncompacted span is smaller than the row cap and behaviour is exactly as it was. */
  keepFromSeq: number;
  /** Rows to ask `getRecentMessages` for. Bounded by the ceiling, never by the turn. */
  requestRows: number;
  /** How many rows the ceiling's quantised front skipped past the boundary. 0 in all healthy
   *  operation; a multiple of the block otherwise. */
  skippedRows: number;
  /** True when the ceiling bound the horizon — i.e. this is the rare large trim. */
  ceilingBound: boolean;
}

interface BoundaryRow { anchor: number; rows_since: number }

/**
 * ONE READ, both numbers. The session-boundary comparison is the house idiom
 * (`memory/store.ts`'s header: *"put `unixepoch(<text>) * 1000` on the TEXT side"*), so this
 * reader and `getRecentMessages` agree about which rows exist before either counts them.
 */
function readBoundary(agentId: string): BoundaryRow {
  const row = getDb().prepare(`
    WITH b AS (SELECT session_started_at AS st FROM agents WHERE id = @agentId),
         a AS (SELECT COALESCE(MAX(m.seq), 0) AS anchor
                 FROM messages m
                 JOIN summary_messages sm ON sm.message_id = m.id
                WHERE m.agent_id = @agentId)
    SELECT (SELECT anchor FROM a) AS anchor,
           (SELECT COUNT(*) FROM messages m, b
             WHERE m.agent_id = @agentId
               AND m.seq > (SELECT anchor FROM a)
               AND (b.st IS NULL OR m.created_at >= unixepoch(b.st) * 1000)) AS rows_since
  `).get({ agentId }) as BoundaryRow | undefined;
  return { anchor: row?.anchor ?? 0, rows_since: row?.rows_since ?? 0 };
}

/** The seq of the (skip+1)-th row after the boundary — the first row the horizon keeps. */
function seqAfterSkip(agentId: string, anchor: number, skip: number): number {
  const row = getDb().prepare(`
    SELECT m.seq AS seq
      FROM messages m
      LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.agent_id = @agentId
       AND m.seq > @anchor
       AND (a.session_started_at IS NULL OR m.created_at >= unixepoch(a.session_started_at) * 1000)
     ORDER BY m.seq ASC
     LIMIT 1 OFFSET @skip
  `).get({ agentId, anchor, skip }) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

/**
 * WHERE THE LIVE CONVERSATION STARTS THIS TURN.
 *
 * Pure of the turn: nothing here reads the clock, the turn counter, the live ask or the array
 * length. Its only inputs are the compaction boundary and the window's own policy, and the
 * boundary moves exactly once per compaction. That is the whole property.
 *
 * On any failure it returns the PRE-t94 answer — the row cap, no front filter — rather than
 * throwing: a tail is worth more than a cache.
 */
export function freshTailHorizon(agentId: string, policy: ContextWindowPolicy): TailHorizon {
  const cap = Math.max(1, policy.freshTailCount);
  const floorAnswer: TailHorizon = {
    anchorSeq: 0, rowsSinceBoundary: 0, keepFromSeq: 0,
    requestRows: cap, skippedRows: 0, ceilingBound: false,
  };

  let boundary: BoundaryRow;
  try {
    boundary = readBoundary(agentId);
  } catch (err) {
    logger.warn('fresh-tail horizon: boundary read failed, falling back to the row cap', {
      error: err instanceof Error ? err.message : String(err), freshTailCount: cap,
    }, agentId);
    return floorAnswer;
  }

  // THE FLOOR, NARROWER THAN IT WAS — t109 item E, the deep-compaction floor state.
  //
  // The floor is the pre-t94 answer: ask for the cap, filter nothing. Its condition was
  // `rows_since <= cap`, and that was one case too wide, because "filter nothing" means the
  // assembler asks for THE NEWEST cap ROWS — measured from the BACK, which is a scrolling
  // window by definition (this module's header). At `rows_since == cap` exactly those rows ARE
  // the post-boundary rows and nothing scrolls (§10's routine case). BELOW the cap they are the
  // post-boundary rows PLUS `cap - rows_since` from before it, which a summary in the same
  // prompt already covers — review I1's own defect — and each appended row pushes one off the
  // front. MEASURED in `__tests__` §11: a 32K → 128K switch steps the cap under a boundary that
  // did not move, and the eight turns after it were EIGHT OF EIGHT DISCONTINUOUS, 20.6× byte
  // waste. The window ladder is the reachable door: the cap is a function of the WINDOW while
  // `rows_since` is a property of the HISTORY.
  //
  // BOTH HALVES OF THE CONDITION ARE LOAD-BEARING. A span over the cap already took the branch
  // below; gating on the anchor ALONE would hand every uncompacted agent the unfiltered answer
  // (mutant M-E2 reds §4 on exactly that). The two anchorless cases that keep the floor are
  // `anchor === 0` (no compaction ever ran, so there is no boundary — every young conversation,
  // and §4's byte-identity) and `rows_since === 0` (a compaction covered everything, so
  // filtering would leave an EMPTY tail; summarised rows beside their summary beat no live
  // conversation, and it lasts until the next row is written). Everywhere else the front IS the
  // boundary, a fixed address, so the tail is a pure append.
  //
  // WHAT IT COSTS, stated: for `cap - rows_since` turns after a deep compaction the live view is
  // SHORTER than the row cap, by rows a summary already covers. The owner's ranking is explicit
  // — *"byte-stability beats shortness… dropping 2 messages costs exactly what dropping 200
  // costs"* — and the rows are persisted, so it is live-view loss, not data loss.
  //
  // `rowsSinceBoundary` reports the REAL count here, not the placeholder (review M5): the
  // handed-up `compaction.ts` one-liner and `__tests__` §9 both read this struct, and a
  // field whose doc says "rows between the boundary and now" may not answer 0 on the one
  // branch where that number is small enough to matter.
  if (boundary.rows_since <= cap
      && (boundary.anchor === 0 || boundary.rows_since === 0)) {
    return { ...floorAnswer, anchorSeq: boundary.anchor, rowsSinceBoundary: boundary.rows_since };
  }

  const ceiling = cap * TAIL_HORIZON_CEILING_MULTIPLE;
  const step = tailCeilingStepRows(cap);

  if (boundary.rows_since <= ceiling) {
    // THE COMMON CASE AND THE WHOLE POINT: grow. The front is the boundary, the boundary did
    // not move, so the prefix did not move.
    return {
      anchorSeq: boundary.anchor,
      rowsSinceBoundary: boundary.rows_since,
      keepFromSeq: boundary.anchor + 1,
      requestRows: boundary.rows_since,
      skippedRows: 0,
      ceilingBound: false,
    };
  }

  // THE CEILING, QUANTISED. `skip` is a whole number of STEPS, and a cut takes the span down
  // to half the ceiling rather than to just under it — so the front advances a long way, once,
  // and then holds still for half a ceiling of turns. Measured from the FRONT (the boundary),
  // never from the back, because a quantity measured from the back is a scrolling window by
  // definition. `rows_since > ceiling = 2 × step`, so this is always at least one whole step.
  const skip = ceilingSkipRows(boundary.rows_since, cap);
  let keepFromSeq = 0;
  try {
    keepFromSeq = seqAfterSkip(agentId, boundary.anchor, skip);
  } catch (err) {
    logger.warn('fresh-tail horizon: ceiling front read failed, falling back to the row cap', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return floorAnswer;
  }
  if (keepFromSeq <= 0) return { ...floorAnswer, anchorSeq: boundary.anchor };

  logger.warn('fresh-tail horizon: the row ceiling trimmed the live conversation', {
    freshTailCount: cap, ceilingRows: ceiling, stepRows: step,
    rowsSinceBoundary: boundary.rows_since, rowsSkipped: skip,
    why: 'compaction has not reclaimed this agent for a long time; this trim is large by design',
  }, agentId);

  return {
    anchorSeq: boundary.anchor,
    rowsSinceBoundary: boundary.rows_since,
    keepFromSeq,
    requestRows: boundary.rows_since - skip,
    skippedRows: skip,
    ceilingBound: true,
  };
}

/**
 * HOW MANY WHOLE GROUPS A TOKEN TRIM DROPS OFF THE FRONT.
 *
 * `groupTokens` is the cost of each group in the tail, oldest first — the front of this array
 * is the compaction boundary, which is what makes an index into it a stable address.
 *
 * Returns 0 whenever everything fits, which is the common case and is byte-identical to the
 * pre-t94 answer. Over budget it returns `maxDrop` — the LARGEST legal multiple of the block,
 * which is the half-the-tail bound rounded down to a block boundary. Dropping the minimum that
 * fits instead, which is what this replaced, is what made the front move every single turn;
 * dropping the smallest fitting multiple plus one block of margin, which is what this
 * function's own first cut did, only halved that (measured: ~10 turns between cuts on the
 * pressured fixture, against the ~40 the owner asked for).
 *
 * The last-group safety is preserved and unchanged in effect: when even the largest legal
 * multiple does not fit, the caller falls through to "keep the last group anyway and warn",
 * because an over-budget context is better than no context at all. That corner is a window too
 * small to hold one block of conversation; it was unstable before this function existed and it
 * is the reason the warn is there.
 */
/**
 * THE MOST A TOKEN TRIM MAY TAKE OFF THE FRONT, in units (groups for the trim, rows for the
 * trigger): half the live conversation, rounded DOWN to whole blocks. One function so the trim
 * and the condense trigger (`rowsLeavingView`, cause `full`) share one law.
 */
export function maxTrimUnits(units: number, blockUnits: number): number {
  const block = Math.max(1, Math.floor(blockUnits));
  return Math.floor(Math.floor(Math.max(0, units) / 2) / block) * block;
}

export function groupsToDropForBudget(
  groupTokens: readonly number[],
  availableTokens: number,
  blockGroups: number,
): number {
  const n = groupTokens.length;
  if (n === 0) return 0;

  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + groupTokens[i];
  if (suffix[0] <= availableTokens) return 0;

  const block = Math.max(1, Math.floor(blockGroups));
  // NEVER CUT MORE THAN HALF THE LIVE CONVERSATION IN ONE PASS, and only at block boundaries.
  // This bound is why the block above is HALF a row cap and not a whole one: the smallest tail
  // a token trim must be able to cut is about one row cap's worth of groups, and a block
  // larger than half of that could never be dropped legally — the search would fall through to
  // the loud minimum-fit path on exactly the healthy body it was meant to serve. It is a
  // function of the group count, but a coarsely quantised one (it only changes when the count
  // crosses a multiple of 2 × block), so it does not reintroduce a scrolling front.
  const maxDrop = maxTrimUnits(n, block);
  // CUT THE WHOLE BOUND — not the smallest multiple that fits, and not that plus one block of
  // margin (review I2: "a safe doubling inside your own proof"). The cadence is set by how much
  // a cut FREES. `maxDrop` frees half the tail, and `maxDrop` itself only changes when the
  // group count crosses a multiple of 2 × block, so the front then moves once per 2 × block
  // appended groups — the fixture's ~10 turns become ~20, a 64-row cap's ~16 become ~32. The
  // monotonicity argument needs only `drop <= n / 2`, which is exactly what this bound is, so
  // it is untouched and §2's clause stays green.
  //
  // The cost, stated: visible history oscillates between 50% and 100% of the grant instead of
  // ~85-100%. That is the owner's own ranking — *"byte-stability beats shortness… dropping 2
  // messages costs the same as dropping 200"* — and the rows are persisted and later
  // summarised, so it is live-view loss, not data loss.
  //
  // The loop is still what PROVES a legal cut exists: it walks up from one block, and the
  // bound is taken only once some multiple has been shown to fit. A tail that needs less than
  // the bound still gets the bound; a tail that cannot be fixed by any multiple falls through.
  for (let drop = block; drop <= maxDrop; drop += block) {
    if (suffix[drop] <= availableTokens) return maxDrop;
  }

  // NO LEGAL BLOCK MULTIPLE FITS — the tail holds fewer groups than one block and still
  // exceeds its grant. FIT IS NON-NEGOTIABLE HERE and the preference order says so: the hard
  // window is the one place a front-trim is legitimate, and a prompt the provider refuses is
  // worth less than a moved prefix. So this falls back to the MINIMUM drop that fits — exactly
  // the pre-t94 behaviour, per-turn cadence and all — and the caller's warn fires, every turn,
  // naming the number. That is the honest shape: this is not a cadence to optimise, it is a
  // window too small to hold one block of conversation, and the warn is how it gets fixed.
  let drop = maxDrop;
  while (drop < n - 1 && suffix[drop] > availableTokens) drop++;
  return drop;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// t140 — WHICH ROWS ARE ABOUT TO LEAVE THE LIVE VIEW: the condense trigger's one question
// (tracker #13; OR-V333-SET (1): condense only when the view is getting full for the model
// actually used, or messages are about to leave view — and only those messages). It replaces a
// row-count drain that folded rows the model was still reading. Two ways a row leaves, both
// owned here:
//   'ceiling' — within one trim block of the row ceiling: the rows its next cut would skip
//               (`ceilingSkipRows`), folded BEFORE the cut, so on a healthy box the cut never fires.
//   'full'    — the caller measured the view full for the dialed window: the rows the token trim
//               takes off the front (`maxTrimUnits`). Folding them moves the boundary to where the
//               trim's front is, so the live tail itself does not move.
// The newest `freshTailCount` rows never leave (the floor every compaction keeps). The answer is
// a SEQ: compaction folds every unsummarised row of the session with `seq <= throughSeq`, which
// includes rows an earlier refused chunk stranded before the boundary.
// ════════════════════════════════════════════════════════════════════════════════════════

/** 'out-of-view' (round 2): rows an assembly ALREADY took out of the view — the trim's front cut,
 *  floor rows included — owed their fold before the turn dials (`compaction.ts`). */
export type LeavingCause = 'ceiling' | 'full' | 'out-of-view';

export interface LeavingView {
  cause: LeavingCause;
  /** Fold every unsummarised row of this session with `seq <= throughSeq`. */
  throughSeq: number;
  /** Rows after the boundary that leave (stranded pre-boundary rows are not counted here). */
  rowsLeaving: number;
}

/** The seq of the tool result right after `seq`, if any — a fold ending at `seq` would split it. */
function seqOfPairedToolResult(agentId: string, seq: number): number | null {
  const row = getDb().prepare(`
    SELECT m.seq AS seq, m.role AS role
      FROM messages m
     WHERE m.agent_id = @agentId AND m.seq > @seq
     ORDER BY m.seq ASC
     LIMIT 1
  `).get({ agentId, seq }) as { seq: number; role: string } | undefined;
  return row && row.role === 'tool' ? row.seq : null;
}

/**
 * The rows about to leave this agent's live view, or null. `viewFull` is the caller's
 * measurement (`compaction.ts`'s `liveViewIsFull`); without it only the ceiling makes rows leave.
 * Never throws: a failed read answers null — condense nothing — the direction the ruling prefers.
 */
export function rowsLeavingView(
  agentId: string,
  policy: Pick<ContextWindowPolicy, 'freshTailCount'>,
  opts: { viewFull: boolean },
): LeavingView | null {
  const cap = Math.max(1, policy.freshTailCount);
  let boundary: BoundaryRow;
  try {
    boundary = readBoundary(agentId);
  } catch {
    return null;
  }
  const rowsSince = boundary.rows_since;
  const room = rowsSince - cap;   // the most that may leave without crossing the floor
  if (room <= 0) return null;

  const ceiling = cap * TAIL_HORIZON_CEILING_MULTIPLE;
  let cause: LeavingCause | null = null;
  let leaving = 0;
  if (rowsSince >= ceiling - ceilingLeadRows(cap)) {
    // The rows the next cut would skip: at the lead point the span has not crossed yet, so ask
    // the cut what it would take one row past the ceiling — or now, if it already has.
    cause = 'ceiling';
    leaving = ceilingSkipRows(Math.max(rowsSince, ceiling + 1), cap);
  } else if (opts.viewFull && room >= tailTrimBlockGroups(cap)) {
    // Fix round 1 (review I4): a full view with less than one trim block above the floor is a
    // view whose pressure sits INSIDE the floor. Folding the 1–5 rows above it bought nothing
    // and cost a summariser call and a prefix break on every turn; the trim handles it, as it
    // always has, and the next block of growth makes a real fold possible.
    cause = 'full';
    leaving = Math.max(tailTrimBlockGroups(cap), maxTrimUnits(rowsSince, tailTrimBlockGroups(cap)));
  }
  if (cause === null) return null;
  // No clamp is needed past this point, and it is argued rather than kept "to be safe": the
  // ceiling's step (4 × cap) is below `room` whenever the lead fires (room ≥ 6.5 × cap), and a
  // 'full' answer is half the span in whole blocks, below `room` whenever room ≥ one block (the
  // guard above). The fold's own selection excludes the floor a second time regardless.

  let throughSeq = 0;
  try {
    throughSeq = seqAfterSkip(agentId, boundary.anchor, leaving - 1);
    if (throughSeq <= 0) return null;
    // Never end a fold between a tool_use and its tool_result: the pair is one atom to every
    // reader of this tail. One row further keeps it whole; the floor clamp above leaves room.
    const pairedResult = leaving < room ? seqOfPairedToolResult(agentId, throughSeq) : null;
    if (pairedResult !== null) { throughSeq = pairedResult; leaving += 1; }
  } catch {
    return null;
  }
  return { cause, throughSeq, rowsLeaving: leaving };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// t144 — THE BOUNDARY STAYS TRUE WHEN NOTES ARE WRITTEN PER CONVERSATION. The live view starts after
// the newest summarised row (`readBoundary`'s single MAX(seq) anchor), which is only right while every
// session row at or below it is covered. A fold's chunks are now one conversation each, so one
// conversation's chunk can be refused while another's, holding newer rows, lands — and the refused
// rows would sit below the anchor, out of view, with nothing standing for them (this was already
// possible with sequential chunks; per-conversation chunks make it common). Membership stays the one
// anchor — the per-turn read is unchanged — and the fold re-establishes the invariant: this reader
// names the rows left below it, and `compaction.ts` covers them with placeholder notes at once.
// Bounded by the fold's own span (`fromSeq`), so it never scans the agent's history.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The anchor, and how many session rows in `[fromSeq, anchor]` no summary covers. Never throws. */
export function rowsStrandedBelowBoundary(agentId: string, fromSeq: number): { anchor: number; stranded: number } {
  try {
    const anchor = readBoundary(agentId).anchor;
    if (anchor <= 0 || anchor < fromSeq) return { anchor, stranded: 0 };
    const row = getDb().prepare(`
      SELECT COUNT(*) AS n FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
       WHERE m.agent_id = @agentId AND m.seq >= @fromSeq AND m.seq <= @anchor
         AND (a.session_started_at IS NULL OR m.created_at >= unixepoch(a.session_started_at) * 1000)
         AND NOT EXISTS (SELECT 1 FROM summary_messages sm WHERE sm.message_id = m.id)
    `).get({ agentId, fromSeq, anchor }) as { n: number } | undefined;
    return { anchor, stranded: row?.n ?? 0 };
  } catch {
    return { anchor: 0, stranded: 0 };
  }
}

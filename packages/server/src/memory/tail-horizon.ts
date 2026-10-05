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
 * mean a 200K box and an 8K box tolerate the same backlog. ×8 is chosen against the thing the
 * ceiling actually protects — compaction's own backlog. The routine gap drain fires at
 * `UNCOMPACTED_GAP_THRESHOLD = 30` rows past the cap and drains one chunk per turn, so a
 * HEALTHY agent lives at `cap + ~30` rows and never comes near ×8 (320 rows on a 32K box,
 * 512 on a 128K one). Reaching the ceiling therefore means compaction has been failing for
 * hundreds of rows, which is the condition this ceiling exists for and not a condition it
 * should be tuned to make comfortable.
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
 * THE QUANTUM of a TOKEN trim, in whole tool-use groups — HALF A TAIL PER CUT.
 *
 * The row horizon above is the dominant trimmer and the one the owner captured, but a tail can
 * still outgrow its TOKEN grant before the row ceiling binds — one enormous tool_result is
 * enough. `budgetFreshTail` drops whole groups off the front to fit, and it must drop them in
 * blocks for the same reason the row ceiling does.
 *
 * Derived from the window's own row cap rather than picked, so one number scales across the
 * ladder: half a cap is 12 groups at 8K, 20 at 32K, 32 at 128K, 40 at 200K. "Half a tail" is
 * the cadence as well as the size — a cut frees half a tail of headroom and the conversation
 * refills it in half a tail of turns, which is the owner's "~once per 40 turns" order of
 * magnitude at the windows real local agents run on.
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

  // THE FLOOR. A span smaller than the row cap is the pre-t94 answer, byte for byte: ask for
  // the cap, filter nothing. This is the case on every young conversation and on the turn
  // right after a compaction that reclaimed down to the cap.
  if (boundary.rows_since <= cap) return { ...floorAnswer, anchorSeq: boundary.anchor };

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
  const skip = (Math.floor(boundary.rows_since / step) - 1) * step;
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
 * pre-t94 answer. Over budget, it returns a MULTIPLE OF THE BLOCK: the smallest that fits,
 * capped at the largest multiple that still leaves a group standing. Dropping the minimum
 * possible instead — what this replaced — is what made the front move every single turn.
 *
 * The last-group safety is preserved and unchanged in effect: when even the largest legal
 * multiple does not fit, the caller falls through to "keep the last group anyway and warn",
 * because an over-budget context is better than no context at all. That corner is a window too
 * small to hold one block of conversation; it was unstable before this function existed and it
 * is the reason the warn is there.
 */
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
  const maxDrop = Math.floor(Math.floor(n / 2) / block) * block;
  for (let drop = block; drop <= maxDrop; drop += block) {
    if (suffix[drop] <= availableTokens) {
      // ONE BLOCK OF MARGIN, when the half-bound allows it. Dropping the smallest multiple
      // that fits leaves the tail sitting exactly at its grant, so the very next turn is over
      // again — the minimum-drop cadence wearing a block-sized coat. Taking one extra block
      // puts the next cut a whole block away, which is the half of "large and rare" that size
      // alone does not buy. Capped by the half-bound, so a tail that cannot afford the margin
      // does not pay it.
      return Math.min(drop + block, maxDrop);
    }
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

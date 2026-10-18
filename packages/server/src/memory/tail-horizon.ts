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
// ── t207 (D6): THERE IS NO ROW CEILING ───────────────────────────────────────────────────
// This header used to end with a hard stop: a ceiling of 8 x the row floor (640 rows at 200K) above
// which the front skipped whole half-ceiling steps. A row count standing in for "compaction has not run
// for a long time" limited what the agent saw without reading any signal, and 700 tiny rows (about 20K
// tokens) lost their front on a 200K window. The ceiling, its step, its lead and its 'ceiling' cause are
// deleted. The real signals are the ones that were already here: the token trim (view full) and the
// rows an assembly has already taken out of view, which the out-of-view fold summarises.
//
// What the ceiling also protected was the cost of READING an unbounded number of rows when compaction
// cannot run. That is bounded by tokens now: the read is newest-first and stops once the rows read cover
// the budget (`coverTokens`, twice the content budget so the half-the-tail trim law still has a legal
// cut). Rows before that point are UNREAD, are counted in `unreadRows`, count as set aside
// (`freshTailDropped`) and are owed their fold like any row the trim removed. While the boundary is
// within reach the front is the boundary and the tail is a pure append, exactly as before.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { CHARS_PER_TOKEN, type ContextWindowPolicy } from './budget.js';

const logger = createLogger('memory-tail-horizon');

/**
 * THE QUANTUM of a TOKEN trim, in whole tool-use groups. GRANULARITY, NOT CADENCE.
 *
 * The row horizon above is the dominant trimmer and the one the owner captured, but a tail can
 * still outgrow its TOKEN grant — one enormous tool_result is enough. `budgetFreshTail` drops whole groups off the front to fit, and it must drop them in
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
  /** Rows to ask `getRecentMessages` for. Bounded by the budget the read must cover, never by the turn. */
  requestRows: number;
  /** t207: rows past the boundary the read did NOT take because the newer rows already cover the budget
   *  (0 whenever the whole span is read, which is every healthy case). Set aside and owed a fold. */
  unreadRows: number;
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

/**
 * How many of the newest rows after the boundary reach `coverTokens` (walked newest-first, one cursor, stopped
 * early), or null when the whole span does not. A row's cost is its stored token count, else its text length at
 * the house ratio.
 */
function newestRowsCovering(agentId: string, anchor: number, coverTokens: number): number | null {
  const rows = getDb().prepare(`
    SELECT COALESCE(NULLIF(m.token_count, 0), (LENGTH(m.content) + @cpt - 1) / @cpt) AS cost
      FROM messages m
      LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.agent_id = @agentId
       AND m.seq > @anchor
       AND (a.session_started_at IS NULL OR m.created_at >= unixepoch(a.session_started_at) * 1000)
     ORDER BY m.seq DESC
  `).iterate({ agentId, anchor, cpt: CHARS_PER_TOKEN }) as IterableIterator<{ cost: number }>;
  let sum = 0;
  let read = 0;
  for (const r of rows) {
    sum += r.cost;
    read++;
    if (sum >= coverTokens) return read;
  }
  return null;
}

/** The (skip+1)-th row after the boundary — the first row a read that leaves `skip` rows unread keeps. */
function rowAfterSkip(agentId: string, anchor: number, skip: number): { seq: number; role: string } | null {
  return (getDb().prepare(`
    SELECT m.seq AS seq, m.role AS role
      FROM messages m
      LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.agent_id = @agentId
       AND m.seq > @anchor
       AND (a.session_started_at IS NULL OR m.created_at >= unixepoch(a.session_started_at) * 1000)
     ORDER BY m.seq ASC
     LIMIT 1 OFFSET @skip
  `).get({ agentId, anchor, skip }) as { seq: number; role: string } | undefined) ?? null;
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
export function freshTailHorizon(agentId: string, policy: ContextWindowPolicy, coverTokens?: number): TailHorizon {
  const cap = Math.max(1, policy.freshTailCount);
  const floorAnswer: TailHorizon = {
    anchorSeq: 0, rowsSinceBoundary: 0, keepFromSeq: 0,
    requestRows: cap, unreadRows: 0,
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

  // THE COMMON CASE AND THE WHOLE POINT: grow. The front is the boundary, the boundary did not move, so the
  // prefix did not move.
  const grow: TailHorizon = {
    anchorSeq: boundary.anchor,
    rowsSinceBoundary: boundary.rows_since,
    keepFromSeq: boundary.anchor + 1,
    requestRows: boundary.rows_since,
    unreadRows: 0,
  };
  if (coverTokens === undefined || boundary.rows_since <= cap) return grow;

  // t207: THE READ IS BOUNDED BY TOKENS, NOT BY A ROW COUNT. Walk the rows newest-first and see how many
  // cover the budget; the rows before that point are unread (counted, set aside, owed their fold).
  //
  // THE FRONT STILL MOVES IN BLOCKS. A cut at exactly the covering row would move by one row for every row
  // appended (a scrolling window, and a fold per turn). So the unread count is rounded DOWN to whole trim
  // blocks (`tailTrimBlockGroups`, the same quantum the token trim cuts in): the front holds still for a block's
  // worth of growth and then moves once. Reading a little more than the budget needs costs nothing the trim
  // does not already handle.
  let read = boundary.rows_since;
  try {
    read = newestRowsCovering(agentId, boundary.anchor, coverTokens) ?? read;
  } catch (err) {
    logger.warn('fresh-tail horizon: the bounded read failed, reading the whole span', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  const block = Math.max(1, tailTrimBlockGroups(cap));
  let unread = Math.floor((boundary.rows_since - read) / block) * block;
  let keepFromSeq = 0;
  // The front must not land on a tool result: back up to the row that made the call.
  while (unread > 0) {
    try {
      const at = rowAfterSkip(agentId, boundary.anchor, unread);
      if (!at) { unread = 0; break; }
      if (at.role !== 'tool') { keepFromSeq = at.seq; break; }
    } catch (err) {
      logger.warn('fresh-tail horizon: the front read failed, reading the whole span', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
      unread = 0;
      break;
    }
    unread--;
  }
  if (unread <= 0 || keepFromSeq <= 0) return grow;
  logger.info('fresh-tail horizon: the newest rows already cover the budget; older rows past the boundary are not read', {
    rowsSinceBoundary: boundary.rows_since, rowsRead: boundary.rows_since - unread, rowsUnread: unread, coverTokens,
  }, agentId);
  return { ...grow, keepFromSeq, requestRows: boundary.rows_since - unread, unreadRows: unread };
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
// row-count drain that folded rows the model was still reading. A row leaves two ways, both
// real signals:
//   'full'        — the gauge (`assembler.ts`'s `measureView`, t194) found the trim cutting within one
//                   block of growth: exactly the rows ITS cut takes, named by the trim itself. Folding
//                   them moves the boundary to where the trim's front is, so the live tail does not move.
//   'out-of-view' — rows an assembly ALREADY took out of the view (the trim's front cut, floor rows, rows
//                   the bounded read did not take): owed their fold before the turn dials (`compaction.ts`).
// t207: the third cause, 'ceiling' (a row count), is gone with the ceiling. The answer is a SEQ:
// compaction folds every unsummarised row of the session with `seq <= throughSeq`, which includes rows an
// earlier refused chunk stranded before the boundary.
// ════════════════════════════════════════════════════════════════════════════════════════

export type LeavingCause = 'full' | 'out-of-view';

export interface LeavingView {
  cause: LeavingCause;
  /** Fold every unsummarised row of this session with `seq <= throughSeq`. */
  throughSeq: number;
  /** Rows after the boundary that leave (stranded pre-boundary rows are not counted here). */
  rowsLeaving: number;
}

/**
 * The rows about to leave this agent's live view, or null: the gauge's answer (the trim's next cut,
 * `compaction.ts`'s `leavingFromView`). Nothing else makes rows leave on a signal of its own.
 */
export function rowsLeavingView(opts: { full?: { throughSeq: number; rows: number } | null }): LeavingView | null {
  return opts.full && opts.full.throughSeq > 0 ? { cause: 'full', throughSeq: opts.full.throughSeq, rowsLeaving: opts.full.rows } : null;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// t144 — THE BOUNDARY STAYS TRUE. Membership stays the one MAX(seq) anchor (the per-turn read is
// unchanged); it is right only while every session row at or below it is covered. Per-conversation
// chunks let one conversation's refused chunk sit below another's landed one, so the fold asks this
// reader for the rows stranded below it — bounded by the fold's own span — and covers them at once.
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

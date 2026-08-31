// ════════════════════════════════════════════════════════════════════════════════════════
// THE LANE TABLE AND THE TWO-PASS FIT. Priority is data, and the allocator reads it.
// PHASE-3 T3. Research 06 requirements B4–B8.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── THE DEFECT THIS MODULE DELETES ──────────────────────────────────────────────────────
// Research 06 §2, re-derived at `8f36cdb`: the assembler declared its priority order as
// PROSE THE MODEL READS (the combined ack, `assembler.ts:1118`) —
//
//     "directive > scratchpad > live conversation > tasks > continuity > vault > briefing"
//
// — and then consumed the budget in EXACTLY REVERSE ORDER. Briefing was tested first
// (`:767`, against a full budget) and the directive last (`:1098`, against a budget nine
// sections had already eaten). Under pressure the assembler dropped precisely what mattered
// most, and it told the model the opposite in the same array. There was no priority data
// structure anywhere: twelve independent `if (usedTokens + X < maxTokens)` gates, each with
// no `else`, no record, and no knowledge of the ten decisions before it.
//
// ── WHAT REPLACES IT ────────────────────────────────────────────────────────────────────
// One ordered table. Each lane declares six things — `{id, priority, min, max, render,
// truncate}` — plus its POSITION (`slot`), because the cache-prefix law (roadmap #10, OR7)
// makes position part of a lane's contract and not an afterthought of build order.
//
// PRIORITY IS INDEPENDENT OF POSITION. `lane.briefing` is emitted FIRST (slot 100) and
// drops FIRST (priority 110); `lane.directive` is emitted LAST of the scaffolding (slot
// 900) and survives LONGEST (priority 10). That separation is the whole point: physical
// order is what the model reads, priority is what the budget spends.
//
// EVERY LANE IMPLEMENTS `truncate()`. A lane that can only be taken whole is a lane that
// gets dropped whole, which is how a 40-token directive lost to a 4,000-token briefing.
// `truncate` is required by the type; `lanes.test.ts` proves every entry has one and that
// each one actually reduces.
//
// ── THE TWO-PASS FIT ────────────────────────────────────────────────────────────────────
//   Pass 1 (RESERVE):    walk in PRIORITY order; set aside `min(minTokens, cost)` for each
//                        lane while budget remains. A lane whose minimum cannot be reserved
//                        is rejected here, with a reason, and never silently.
//   Pass 2 (DISTRIBUTE): walk in PRIORITY order again; each lane may take up to
//                        `min(cost, maxTokens)` of what is left, but never the reservations
//                        still owed to the lanes below it. Granted < cost ⇒ `truncate()`.
//
// The two passes are why a floor is a floor: pass 1 is the guarantee, pass 2 is the
// generosity. One pass with a running total is what the assembler had, and one pass cannot
// express "the directive gets its 64 tokens even though the briefing was rendered first".
//
// ── EVERY DECISION IS RECORDED ──────────────────────────────────────────────────────────
// `AllocationReport` carries one `LaneGrant` per lane — `{requested, granted, status,
// reason}` — including the REJECTED ones. Before this, a rejected section produced a
// byte-identical context to a section that never existed (research 06 §8). The report is
// also what generates the scaffolding ack, so the array can no longer claim a section the
// budget dropped.
//
// ── OVER-BUDGET IS AN EVENT, NOT A SHRUG ────────────────────────────────────────────────
// `budgetFreshTail`'s "include the last group anyway" safety (requirement B8) is real and
// stays: a context with no live message at all is worse than one slightly over. It is now
// RECORDED as an `OverBudgetEvent` on the report instead of being a `logger.warn` nobody
// reads.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Anthropic from '@anthropic-ai/sdk';
import {
  estimateTokens, estimateImageTokens, imagePixelDimensions, IMAGE_TOKEN_CEILING,
} from './budget.js';
import { MessageSlot } from '../prompt/registry/types.js';

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────

export type LaneMessage = {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
  reasoningContent?: string;
};

/** What a lane produced, plus whatever its own `truncate` needs to shrink it. */
export interface LaneRender<P = unknown> {
  messages: LaneMessage[];
  /** Cost of carrying these messages, by the ONE estimator (`memory/budget.ts`). */
  tokens: number;
  /** Lane-private payload (e.g. the raw rows behind the fresh tail). */
  payload?: P;
}

export type LaneStatus = 'admitted' | 'truncated' | 'rejected' | 'empty' | 'failed';

export interface LaneGrant {
  id: string;
  slot: number;
  priority: number;
  /** What the lane's render actually cost. */
  requested: number;
  /** What the allocator gave it. */
  granted: number;
  status: LaneStatus;
  /** Plain words. Never empty — a decision with no reason is the thing this replaces. */
  reason: string;
}

export interface OverBudgetEvent {
  laneId: string;
  /** How many tokens past the budget this lane's forced inclusion put the assembly. */
  overBy: number;
  reason: string;
}

export interface AllocationReport {
  /** Tokens the content lanes were allowed to spend (after every declared reservation). */
  budgetTokens: number;
  /** Tokens pass 1 set aside as minimums. */
  reservedTokens: number;
  /** Tokens pass 2 actually granted. */
  spentTokens: number;
  /** Reservations taken off the top before the fit ran (ack + post-budget + loop tail). */
  offTheTopTokens: number;
  grants: LaneGrant[];
  /** Ids of the lanes that reached the model, in EMISSION (slot) order. */
  admittedIds: string[];
  overBudget: OverBudgetEvent[];
}

/**
 * One lane. `render` may be async (most read the database); `truncate` never is — shrinking
 * is arithmetic on something already in hand, and a truncate that could go to the database
 * would be a second render with a different answer.
 */
export interface Lane<C = unknown, P = unknown> {
  id: string;
  /** Physical position in the emitted array. `MessageSlot` values; see the cache law. */
  slot: number;
  /** Lower survives longer. Independent of `slot` — that independence IS the fix. */
  priority: number;
  /** Guaranteed floor, reserved in pass 1 before any lower-priority lane is considered. */
  minTokens: number;
  /** Ceiling in pass 2. `Infinity` = take what the remainder allows. */
  maxTokens: number;
  /**
   * Requirement B8. A lane whose floor MUST be honoured even when the budget cannot cover
   * it — the fresh tail, and only the fresh tail: a context with no live message at all is
   * worse than one slightly over. This is `budgetFreshTail`'s "include the last group
   * anyway" safety (`assembler.ts:2219-2228` pre-repin), promoted from a `logger.warn` to a
   * declared lane property that produces a recorded `OverBudgetEvent`.
   */
  mandatoryFloor?: boolean;
  render: (ctx: C) => Promise<LaneRender<P> | null> | LaneRender<P> | null;
  truncate: (render: LaneRender<P>, maxTokens: number) => LaneRender<P>;
}

// ── The declared priority ladder ─────────────────────────────────────────────────────────
//
// Seven of these eleven rungs are the owner-facing ladder the ack has always printed
// (research 06 §2 quotes it verbatim): directive > scratchpad > live conversation > tasks >
// continuity > vault > briefing. They keep that order exactly.
//
// FOUR LANES ARE NOT IN THAT PROSE and their placement is a DECLARED CHOICE, recorded here
// rather than buried in a comparator:
//
//   lane.events           directly under the live conversation. It is the same "what just
//                         happened" class, and it is the ONE lane that had no gate at all
//                         (`assembler.ts:1215`, pushed with no add and no test) — so an
//                         unbounded lane becomes a bounded one at the priority its content
//                         actually warrants.
//   lane.attempt-ledger   directly under the tasks it is the engine's record OF. It already
//                         declared its own 800-token ceiling and that ceiling is preserved.
//   lane.summaries        above the vault: summaries are THIS conversation's own compressed
//                         history, the vault is everything else.
//   (lane.relevant-memory LEFT this ladder at SWEEP CORE-2 item 4. Its rung read "beside the
//    vault, above it: a retrieval of raw history that has fallen out of the tail". The rung is
//    gone because the LANE is gone from here — it is a post-budget tail lane now
//    (`memory/recall-lane.ts`, MessageSlot.RecalledMemory = 1870), for the reason its own
//    header gives: its content is retrieved against the live ask, so it may not sit ahead of
//    the cache boundary. A priority rung is a statement about what to DROP under pressure, and
//    a lane the budget never ranks has nothing to say there.)
//
// The ack lane sits at 35 — just under the live conversation and above every scaffolding
// lane it closes — because an ack that survives while every section it acknowledges was
// dropped is a lie, and one that drops while sections survive leaves an unclosed block.
// Its reservation is taken off the top (see `SCAFFOLDING_ACK_RESERVE_TOKENS`), so its
// priority only decides whether it renders at all.
// T67b §7: `lane.directive` LEFT this table. Its rung read 10 — the highest priority in the
// assembly — and a priority rung is a statement about what to DROP under budget pressure. A
// lane the fit never ranks has nothing to say there: it is a post-budget tail lane now
// (`MessageSlot.ActiveDirectiveTail = 1890`) with a reserve taken off the top, which is
// STRONGER than priority 10 — the reserve cannot be outbid, where a priority can. Same shape
// as `lane.relevant-memory`'s exit at CORE-2 item 4, and for the same reason: its content is
// the newest unanswered user ask, so it may not sit ahead of the cache boundary at all.
export const LANE_PRIORITY: Record<string, number> = {
  'lane.scratchpad': 20,
  'lane.fresh-tail': 30,
  'lane.scaffolding-ack': 35,
  'lane.events': 40,
  'lane.active-tasks': 50,
  'lane.attempt-ledger': 60,
  'lane.continuity': 70,
  'lane.summaries': 80,
  'lane.vault': 100,
  'lane.briefing': 110,
};

/**
 * The ladder the ack prints, in declared priority order. Generated from `LANE_PRIORITY`, so
 * the sentence the model reads and the order the budget spends cannot disagree — which is
 * exactly how they came to disagree in the first place.
 */
export const LANE_LADDER_LABEL: Record<string, string> = {
  'lane.scratchpad': 'my scratchpad',
  'lane.fresh-tail': 'live conversation below',
  'lane.events': 'events & notices',
  'lane.active-tasks': 'active tracker tasks',
  'lane.attempt-ledger': 'attempt ledger',
  'lane.continuity': 'continuity brief',
  'lane.summaries': 'compressed history',
  'lane.vault': 'vault entries',
  'lane.briefing': 'briefing',
};

/** The section names the ack lists as reviewed, in EMISSION order. */
export const LANE_SECTION_LABEL: Record<string, string> = {
  'lane.briefing': 'briefing',
  'lane.vault': 'vault',
  'lane.summaries': 'summaries',
  'lane.attempt-ledger': 'attempt ledger',
  'lane.active-tasks': 'active tasks',
  'lane.continuity': 'continuity brief',
  'lane.scratchpad': 'scratchpad',
};

// ── The declared numbers ────────────────────────────────────────────────────────────────
//
// §T0-B's clusters C (15 row caps), D (12 char slices), E (8 sub-budgets) and F (6 retrieval
// knobs) were 41 bare literals scattered through 1,500 lines of `assembler.ts`, each one
// invisible to the lane that owned it. They are lane declarations now: one record per lane,
// read by that lane's render, with the pre-repin site beside every value so the move is
// auditable rather than asserted.

export interface LaneLimits {
  /** Row caps (§T0-B cluster C). */
  rows?: Record<string, number>;
  /** Char slices (§T0-B cluster D). */
  chars?: Record<string, number>;
  /** Token sub-budgets (§T0-B cluster E). */
  tokens?: Record<string, number>;
  /** Retrieval knobs (§T0-B cluster F). */
  retrieval?: Record<string, number>;
}

export const LANE_LIMITS: Record<string, LaneLimits> = {
  // §T0-B C `:681`(10) — the PM tail is its own lane and its own row cap.
  'lane.pm-tail': { rows: { tail: 10 } },

  // T67b: `queryMessages` and `query` are GONE with the retrieval they sized. This lane
  // built a query from the last 3 messages, sliced to 500 chars, and ran a semantic search
  // with it from slot 200 — ahead of the whole prefix. The retrieval is
  // `memory/recall-lane.ts`'s now (tail, past `volatileFrom`), so the caps that shaped its
  // query moved out of this record with it rather than lingering as numbers nobody reads.
  // What is left is the PINNED half, bounded by `vault/retrieval.ts`'s MAX_PINNED_ENTRIES,
  // which is that module's declaration and not this lane's.
  'lane.vault': {},

  // §T0-B C `:840`(30) — the fresh-technique scrub window. E `:1587`/`:1588`/`:1595`/`:1637`
  // — the relevance budget, the recency floor, and the share of what remains.
  //
  // T67b: `retrieval.limit` / `retrieval.minSimilarity` are RETIRED with the vector ranking
  // they parameterised — this lane sits ahead of the tail and no longer asks what the live
  // ask is (see `selectSummariesForPrefix`). `relevanceBudget` keeps its name and its job:
  // it is the lane's token CEILING and always was. `scrubWindow` keeps its number and gains
  // a new meaning stated where it is read — the cap on tool rows scanned SINCE SESSION START,
  // rather than a scrolling last-N window whose exit re-wrote the lane.
  'lane.summaries': {
    rows: { scrubWindow: 30 },
    tokens: { relevanceBudget: 6000, recencyFloor: 2 },
  },

  // §T0-B E `:1646`/`:1647`, F `:1755`(8/0.35), `:1758`(fts 8), `:1805`(6/0.45),
  // `:1807`(limit 6), D `:1771`(0,300), `:1812`(0,300), C `:1748`(80), `:1777`(≥5),
  // `:1818`(≥5), `:1684`(10), D `:1688`(−500), `:1694`(−500), `:1703`(8 words).
  //
  // REQUIREMENT B6, THE RECONCILE: `:1748`'s hardcoded 80 was `getFreshTailCount`'s
  // 200K-window answer written as a literal, so on a 32K model the recall window read 80
  // rows while the tail read 40. It is `freshTailCount` now — one number, one owner.
  // SWEEP CORE-2 item 4: the lane moved to the tail (`memory/recall-lane.ts`) and gained the
  // ANSWERED PAIRS it exists for. Three numbers are new and each is stated rather than
  // guessed:
  //   recallPairs 3     — the same bound `engine.recently-answered` already chose for "the
  //                       last few asks that already have answers" (RECENTLY_ANSWERED_LIMIT).
  //                       Carried, not re-invented (#14).
  //   answerPreview 220 — the answer half of a pair. Deliberately SHORTER than the 300-char
  //                       ask half: the ask is what the search matched and has to be
  //                       recognisable, the answer is a reminder of a conclusion the agent can
  //                       restate, not a re-delivery of it.
  //   quotedFloor 40    — `lane.deliveries`'s floor, verbatim: below one whole row the quote
  //                       is shortened, never taken to nothing.
  // The two `tokens` sub-budgets stay because the retrieval loop is gone from `assembler.ts`
  // but the LANE's ceiling is now the derived worst case (`recallLaneWorstCaseTokens`), which
  // is SMALLER than messageBudget + vaultBudget ever allowed and — unlike them — enforced.
  'lane.relevant-memory': {
    // HARNESS-LEARNINGS HL5 adds `snapshotCommitments` / `snapshotTitle`. 6 rows, because the
    // block whose job this one takes over (`work/obligations.ts`, OPEN WORK) fits about that
    // many inside its own 600-char budget, and because the snapshot's completeness claim is
    // carried by its stated COUNT rather than by its length — a capped list with an honest
    // "and N more" line is still a complete statement of what is owed. 120 chars is the
    // longest commitment title on the worn-in dev body plus room (the Bob fixtures run 79).
    rows: {
      recallWindow: 10, minTailForRecall: 5, minTailForVault: 5, recallPairs: 3,
      snapshotCommitments: 6,
    },
    chars: {
      recallHead: 500, recallTail: 500, queryWords: 8, hitPreview: 300, vaultPreview: 300,
      answerPreview: 220, quotedFloor: 40, snapshotTitle: 120,
    },
    tokens: { messageBudget: 1200, vaultBudget: 2000 },
    retrieval: {
      messageLimit: 8, messageMinSimilarity: 0.35, ftsLimit: 8,
      vaultLimit: 6, vaultMinSimilarity: 0.45, vaultEntryLimit: 6,
    },
  },

  // §T0-B E `:911`(800) — the ledger's own hard ceiling, and C `:896`/`:897`/`:898`,
  // D `:959`/`:962`, C `:892`(0,2), `:949`(0,5).
  'lane.attempt-ledger': {
    rows: { tasks: 2, observations: 4, transitions: 4, entries: 6 },
    tokens: { cap: 800 },
  },
  // T67b: `recentMentionWindow` is GONE with the suppression it sized. The lane dropped
  // itself when the last 6 rows happened to name its task ids — a decision derived from a
  // SCROLLING WINDOW, so the block came back unprompted as those rows aged out and rewrote
  // bytes ahead of the tail. It saved this lane's own few hundred tokens and spent every
  // cached token behind it.
  'lane.active-tasks': {
    rows: { tasks: 5 },
    chars: { description: 300, lastNote: 200 },
  },

  // §T0-B C `:1185`(−10), D `:1205`(0,400) — the awareness lane's row cap and gist slice.
  'lane.events': { rows: { events: 10 }, chars: { gist: 400 } },

  // §T0-B G `:43`, `:61`, `:2043`, `:2082`, `:256` — the content caps that shape the tail
  // before it is budgeted. Declared here; the constants stay exported from `assembler.ts`
  // where their incident history lives.
  'lane.fresh-tail': {
    tokens: { maxToolResult: 15000, stubAfterTurns: 12 },
    chars: { toolResultKeepFloor: 500 },
    rows: { maxKeepImages: 1 },
  },

  // §T0-B D `:440`(140), `:441`(160) — the awareness gist's structured slices.
  'lane.awareness-gist': { chars: { subject: 140, preview: 160 } },

  // PHASE-3 T7: THE DELIVERIES LANE. Three of the four numbers are RC-1's own, lifted from
  // the pending-question header they were literals inside (`agent/v2/loop.ts` pre-repin:
  // the 48-hour window, the 300-char quote, the 120-char echo probe). The FOURTH is the
  // change: `rows` was an implicit 1 (`LIMIT 1`) because the echo ROWS carried everything
  // older, and a lane that replaces those rows has to carry more than the newest one. 3 is
  // the cap, not a target — a conversation with more pending questions than that has a
  // bigger problem than this lane, and the reserve below is what pays for the choice.
  'lane.deliveries': {
    rows: { deliveries: 3 },
    chars: { quoted: 300, echoProbe: 120, quotedFloor: 40 },
    retrieval: { windowHours: 48 },
  },
};

/** Read a declared limit. Throws rather than defaulting: an undeclared number is a bug. */
export function laneLimit(laneId: string, group: keyof LaneLimits, key: string): number {
  const v = LANE_LIMITS[laneId]?.[group]?.[key];
  if (typeof v !== 'number') {
    throw new Error(`lane limit not declared: ${laneId}.${group}.${key}`);
  }
  return v;
}

// ── The reservations taken off the top ───────────────────────────────────────────────────
//
// Requirement B7: the seven post-budget appends and the loop's own tail-append become
// DECLARED lanes with RESERVED tokens. Before this they were spent after `usedTokens`
// stopped being consulted — research 06's "usedTokens is write-only" finding, re-confirmed
// by reading at `8f36cdb`.
//
// Every number below is MEASURED, from `checks/golden/assembled-context.json` (the nine
// turn-state matrix T1 blessed) or from the fixed string itself. None is invented; #14.

export interface PostBudgetLane {
  id: string;
  slot: number;
  reserveTokens: number;
  /** Where the number came from. A reserve with no derivation is a rumour. */
  measured: string;
}

export const POST_BUDGET_LANES: PostBudgetLane[] = [
  {
    id: 'lane.engine-end-of-history',
    slot: 1150,
    reserveTokens: 54,
    measured: 'fixed 216-char string (assembler.ts applyIntegrityPass); golden max 216 chars',
  },
  {
    id: 'lane.empty-context-fallback',
    slot: 1160,
    reserveTokens: 8,
    measured: "fixed 'Continue with your current task.' = 32 chars; fires only when the array is empty",
  },
  {
    id: 'lane.new-session',
    slot: 1170,
    reserveTokens: 74,
    measured: 'fixed 296-char [New Session] prefix, prepended to an existing message',
  },
  {
    id: 'lane.a2a-preempt',
    slot: 1180,
    reserveTokens: 225,
    measured: 'fixed template, 900 chars with the storm hint; prepended to an existing message',
  },
  {
    id: 'lane.stop-marker',
    slot: 1190,
    reserveTokens: 83,
    measured: 'fixed 331-char marker; prepended to an existing message',
  },
  {
    id: 'lane.a2a-salience',
    slot: 1195,
    reserveTokens: 108,
    measured: 'fixed 430-char reply directive; prepended to a message already in the array',
  },
  {
    id: 'lane.loop-tail',
    slot: MessageSlot.TurnContext,
    reserveTokens: 900,
    measured:
      'PHASE-3 T6, re-derived from the RECEIPT\'S REAL DISTRIBUTION (T3 acceptance, ' +
      'assignment a). 234 live receipts across two builds, summing every message at or ' +
      'after `volatileFrom`: min 156 · p50 298 · p90 378 · p99 693 · MAX 742 tokens. ' +
      'Per entry, max/mean: msg.pending-nudge 479/248 · msg.turn-context 227/127 · ' +
      'msg.current-time 87/87 · engine.settled-hint 65/65 · engine.open-work 60/60 · ' +
      'engine.recent-outbound 41/36 · msg.peer-status 20/20. (engine.settled-hint was STRIPPED at T7 Step 2, so this ' +
      'reserve is now 65 looser than its own derivation; left at 900 — a reserve proven not tight is not a defect, and ' +
      'lowering it is a budget change with its own evidence.) Plus msg.tool-note, which ' +
      'never fired in the sample (the floor model has tools) and is bounded by its own ' +
      'fixed 299-char string at 75. 742 + 75 = 817, declared 900. ' +
      'THE OLD 1,420 WAS A SUM OF PER-ENTRY MAXIMA over golden-v0\'s nine cells — not a single turn that ever happened — and its largest term (msg.turn-context at 1,195) is 5.3x the largest this lane has been measured at. ' +
      'WHAT THIS RESERVE DELIBERATELY DOES NOT COVER, stated rather than discovered: ' +
      '`msg.technique-strong` rides this lane and the loop caps it at MAX_INLINE_CHARS = ' +
      '25,000 chars (`agent/v2/loop.ts`), i.e. ~6,250 tokens plus its frame — 7x this ' +
      'reserve, and it appeared 0 times in 234 receipts because this box holds three ' +
      'fixture techniques of 1.3-3.2 KB. Reserving 6,350 off the top of EVERY assembly ' +
      'for a lane that rare is a permanent tax on history; a strong technique match is ' +
      'therefore a RECORDED over-budget event at the validator, not a silent one, which ' +
      'is the same disposition requirement B8 gives the forced last group. Narrowing the ' +
      '25,000 cap is a product-behaviour change and is enumerated for T9, not taken here.',
  },
  {
    id: 'lane.deliveries',
    slot: MessageSlot.Deliveries,
    reserveTokens: 316,
    measured:
      'PHASE-3 T7, DERIVED FROM THE GENERATOR, not guessed beside it: the worst case ' +
      '`memory/deliveries-lane.ts` can render under its own declared caps above — ' +
      '3 rows x (300-char quote + frame) + the list header + the truncation marker = ' +
      '1,262 chars = 316 tokens. `deliveries-lane.test.ts` calls ' +
      '`deliveriesLaneWorstCaseTokens()` and pins this literal to it, so the declaration ' +
      'and the renderer cannot drift, and a second clause proves no input can exceed it ' +
      '(this lane is the first post-budget lane whose content VARIES, so its reserve is ' +
      'ENFORCED by `truncate()` rather than merely recorded). ' +
      'THE REAL DISTRIBUTION, measured on the live body at `5d82dc8` (43 ' +
      'conversation-days with a delivered non-dashboard/voice row): 28 carry 1 delivery, ' +
      '3 carry 2, 7 carry 3, 1 carries 4, 1 carries 6 — and three storm buckets carry 49, ' +
      '87 and 196, which is what the row cap is FOR. Delivery-linked receipt text runs ' +
      '2-145 chars (mean 37, n=18); all send receipts 2-500 (mean 111, n=467), so the ' +
      '300-char quote binds only the longest few. ' +
      'WHAT IT BUYS, stated rather than assumed: 316 tokens leave the content budget on ' +
      'EVERY assembly. The mechanism it replaces charges MORE and charges it forever — an ' +
      'echo row is a PERSISTED message in the recipient\'s conversation, so it is re-billed ' +
      'inside the fresh tail on every turn until it ages out, and it can never be ' +
      'truncated because it is indistinguishable from history.',
  },
  {
    id: 'lane.directive',
    slot: MessageSlot.ActiveDirectiveTail,
    reserveTokens: 2081,
    measured:
      'T67b §7, DERIVED FROM THE GENERATOR: the worst case `memory/directive.ts` can render '
      + 'under its own declared cap — `formatDirectiveBlock` at DIRECTIVE_MAX_CHARS = 8,000 '
      + 'body chars, plus the two frame lines and the `history_get` truncation pointer with a '
      + 'full 36-char message id = 8,321 chars = 2,081 tokens. '
      + 'WHY IT IS A RESERVE AT ALL, stated rather than assumed: this lane was a `fitLanes` '
      + 'candidate at MessageSlot.ActiveDirective = 900 with PRIORITY 10 — the highest in the '
      + 'assembly — while its content IS the newest unanswered user ask. So it changed on '
      + 'every substantive user turn, at the FRONT of the cacheable region, re-billing the '
      + 'whole message history behind it: the largest single term in the owner\'s measured '
      + '~14,200-tokens-per-turn recompute (2026-08-31). Priority 10 said "never drop this"; '
      + 'a reserve says it more strongly, because a reserve cannot be outbid where a priority '
      + 'can. Same disposition as `lane.relevant-memory`, whose exit from the fit at CORE-2 '
      + 'item 4 is the precedent this follows. '
      + 'WHAT IT COSTS: 2,081 tokens leave the content budget on every assembly. What it '
      + 'replaces spent the SAME tokens — it just spent them from inside the prefix, where '
      + 'they were re-billed with everything behind them on every turn instead of once.',
  },
  {
    id: 'lane.relevant-memory',
    slot: MessageSlot.RecalledMemory,
    reserveTokens: 2179,
    measured:
      'SWEEP CORE-2 item 4, DERIVED FROM THE GENERATOR, not guessed beside it: the worst case ' +
      '`memory/recall-lane.ts` can render under its own declared caps above — 3 answered ' +
      'pairs x (300-char ask + 220-char answer + frame) + 5 recalled lines x 300 chars + 5 ' +
      'vault lines x 300 chars + the three section headers + the truncation marker. ' +
      'HARNESS-LEARNINGS HL5 raised it from 1,407 to 1,807, and the +400 is the SNAPSHOT at ' +
      'its own declared cap: 6 rows x (printable id + 120-char title + state + relative age) ' +
      'plus the superseding preamble, the elision line and the two rules. ' +
      'UX-REPAIR ROUND 11 T44 raised it again, 1,807 -> 1,911, and the +104 is the BOARD-COUNTS ' +
      'line: four numbers at five digits each (99,999 open rows on one agent — the worn-in dev ' +
      'body\'s largest per-agent count of any kind is three figures) plus the completeness ' +
      'sentence and the list-door pointer. It carries NO row cap and no truncation rung ' +
      'because it renders no rows: counts are O(1) bytes, which is exactly why completeness is ' +
      'affordable here and is not affordable in `engine.open-work`. WHAT THE 400 COSTS ' +
      'AND WHAT IT BUYS, stated rather than assumed: it leaves the content budget on every ' +
      'assembly, and it buys the whole of what this agent owes, republished every time, ' +
      'against a defect that survived three cheaper fixes — T20 a lane-header sentence, T28 ' +
      'an appended per-line marker, T28b a front-loaded one; the floor model parroted the ' +
      'dead line 2/2 after each of the last two. Part of it is also displacement rather than ' +
      'growth: the obligation-shaped vault lines the snapshot withdraws were already inside ' +
      'this reserve at up to 300 chars each, and unlike them a snapshot cannot be stale. ' +
      'T67b raised it again, 1,911 -> 2,179, and the +268 is the FN-1 UNFILED-ARCHIVE BRIDGE ' +
      'at its own declared caps (`vault/retrieval.ts`: 3 snippets x 300 chars, each in its ' +
      '`- [<stamp>] ` frame, plus the shared label). The bridge did not grow — it MOVED. It ' +
      'ran inside `retrieveForContext`, which `lane.vault` rendered from MessageSlot.VaultPull ' +
      '= 200, and it searches the just-archived-but-unfiled session BY THE QUERY, so it was ' +
      'one of the per-ask retrievals rewriting the cacheable prefix on every turn. Its whole ' +
      'cost is visible here now instead of being spent unbudgeted up there. ' +
      '`recall-lane.test.ts` calls `recallLaneWorstCaseTokens()` and pins this literal to it, ' +
      'so the declaration and the renderer cannot drift, and a second clause proves no input ' +
      'can exceed it. Like `lane.deliveries` this lane\'s content VARIES, so the reserve is ' +
      'ENFORCED by `truncate()` rather than merely recorded — the render fits itself before it ' +
      'leaves the module. ' +
      'WHAT IT COSTS AND WHAT IT REPLACES, stated rather than assumed: 1,407 tokens leave the ' +
      'content budget on every assembly, and the lane can no longer be dropped by the fit. ' +
      'What it replaces was WORSE on both counts — as a `fitLanes` candidate it declared ' +
      '`messageBudget + vaultBudget` = 3,200 tokens as its ceiling with NO truncate any input ' +
      'could reach, so a heavy recall turn spent more than double this and spent it from ' +
      'INSIDE the cacheable prefix at slot 400, re-billing every message behind it whenever ' +
      'the ask moved. The undroppability is the point rather than a cost: the owner decided ' +
      'per-message recall ENABLED (2026-07-26), and a lane that silently disappears under ' +
      'pressure is the "constantly forgets" mechanism SWEEP-C T4 is named after.',
  },
];

export const POST_BUDGET_RESERVE_TOKENS = POST_BUDGET_LANES.reduce((t, l) => t + l.reserveTokens, 0);

// ── WHICH POST-BUDGET LANE EACH TAGGED ENTRY RIDES (PHASE-6 T13) ────────────────────────
//
// `lane.loop-tail` and `lane.deliveries` are DECLARED by the assembler and FILLED by the
// loop, so the messages that land in them carry their own ENTRY id — `msg.turn-context`,
// `engine.open-work` — and never the lane's. The receipt already knows this and measures the
// group at the receipt boundary (`agent/v2/receipt.ts withMeasuredLoopTail`). `repairAssembly`
// did not, and read those entry ids as lanes "no lane table declares" — so a real over-budget
// engine assembly was REFUSED before the priority repair ran at all. This is the table that
// closes that gap, and it is held BOTH WAYS by a runtime census
// (`__tests__/assembly-repair-lane-census.test.ts`) against the prompt registry itself.
export const POST_BUDGET_ENTRY_LANE: Record<string, string> = {
  // The message-side prompt-registry entries, injected through `injectRegistryMessage`.
  'msg.tool-note': 'lane.loop-tail',
  'msg.pending-nudge': 'lane.loop-tail',
  'msg.context-gap': 'lane.loop-tail',
  'msg.delegation-hint': 'lane.loop-tail',
  'msg.technique-strong': 'lane.loop-tail',
  'msg.technique-weak': 'lane.loop-tail',
  'msg.turn-context': 'lane.loop-tail',
  'msg.peer-status': 'lane.loop-tail',
  'msg.current-time': 'lane.loop-tail',
  // The deliveries lane declares its OWN reserve, so its entry is attributed to it and not
  // to the tail it sits inside — the same split the receipt makes.
  'msg.deliveries': 'lane.deliveries',
  // SWEEP CORE-2 item 4: the recall lane, same split for the same reason.
  'msg.relevant-memory': 'lane.relevant-memory',
  // T67b §7: the directive pin, same split for the same reason — it declares its own reserve.
  'msg.directive': 'lane.directive',
  // The three engine-side injections that still push directly (`pre-call-injections.ts`).
  'engine.open-work': 'lane.loop-tail',
  'engine.recent-outbound': 'lane.loop-tail',
  'engine.recently-answered': 'lane.loop-tail',
};

/**
 * The PM path's only lane. It is tagged (`assembler.ts` PM branch), it is declared — it has
 * a row cap in `LANE_LIMITS` and emits its own grant — and it is not in `LANE_PRIORITY`,
 * because the PM assembly has no ladder to drop down: the tail IS the context.
 */
const PM_TAIL_LANE_ID = 'lane.pm-tail';

/**
 * Is this a lane the repair must RECOGNISE but must never DROP?
 *
 * The allocator's twelve lanes (`LANE_PRIORITY`) are the droppable ladder. Everything else
 * the tree declares — the post-budget lanes, the entries that ride them, the PM tail — is
 * content that arrived AFTER the budget decision or IS the context, and dropping it is the
 * oldest-first front-trimmer behaviour requirement C10 exists to delete
 * (`assembly-validation.ts`'s header names the tail-append as its first casualty).
 *
 * An id in NEITHER table is still a finding and still refuses: that is the guard's remaining
 * job, and the census keeps this list honest so a new injection cannot quietly join it.
 */
export function isProtectedLaneId(id: string): boolean {
  if (POST_BUDGET_ENTRY_LANE[id] !== undefined) return true;
  if (id === PM_TAIL_LANE_ID) return true;
  return POST_BUDGET_LANES.some((l) => l.id === id);
}

// ── The scaffolding ack, generated and BYTE-STABLE ──────────────────────────────────────
//
// The ack sits at slot 1000, AHEAD of the tail boundary, so the cache-prefix law binds it
// absolutely: it must be byte-identical across turns or every message after it re-bills.
// Requirement B says it must be GENERATED from the allocator report so it can no longer
// claim sections the budget dropped. Those two look like a contradiction and are not.
//
// THE RESOLUTION: the ack is a PURE FUNCTION OF THE ADMITTED LANE ID SET. Nothing else
// reaches it — no clock, no token counts, no percentages, no row counts, no agent id.
// Two turns that admit the same lanes produce byte-identical acks; two turns that admit
// different lanes were ALREADY divergent at the lane that changed, which sits AHEAD of the
// ack, so the ack adds no new invalidation. `lanes.test.ts` pins that with a purity clause
// (a generated ack may not contain a digit that did not come from the lane table) and the
// assembled-array golden pins the bytes.
//
// The old string was a hardcoded 576-char paragraph that named all seven sections
// unconditionally — the model was told "I have reviewed my briefing" on turns where the
// briefing had been dropped for budget.

const ACK_HEAD = 'Understood, I have reviewed my background context (';
const ACK_MID = '). Source priority for this turn: ';
// T67b: the sentence "The active user directive is the WHAT, never lose it." LEFT this
// string. The ack closes the SCAFFOLDING BLOCK it sits inside, and the directive is no
// longer in that block — it is a tail lane at 1890 now. An ack that names a section the
// array does not contain at this position is the exact defect this generator was built to
// make impossible (research 06 §2: the ack's prose and the budget's order disagreeing). The
// sentence itself is not lost: `formatDirectiveBlock` carries the pin's own framing, and the
// tail position states the same primacy by construction.
const ACK_TAIL =
  '. When sources disagree, trust the most recent and most specific. The scratchpad is my ' +
  'own working outline; I maintain it via scratchpad_set as I make progress and read from ' +
  'it when I need to remember where I am.';

/**
 * Generate the ack from the admitted lane ids. Pure: same ids in, same bytes out.
 *
 * The ladder always carries `live conversation below` because the fresh tail is the one
 * lane that cannot be absent — `budgetFreshTail`'s last-group safety guarantees it — and a
 * priority ladder with a hole where the live conversation should be reads as a claim that
 * there is none.
 */
export function renderScaffoldingAck(admittedLaneIds: readonly string[]): string | null {
  const admitted = new Set(admittedLaneIds);
  const sections = Object.keys(LANE_SECTION_LABEL)
    .filter((id) => admitted.has(id))
    .map((id) => LANE_SECTION_LABEL[id]);
  if (sections.length === 0) return null;

  const ladder = Object.keys(LANE_PRIORITY)
    .sort((a, b) => LANE_PRIORITY[a] - LANE_PRIORITY[b])
    .filter((id) => id === 'lane.fresh-tail' || admitted.has(id))
    .map((id) => LANE_LADDER_LABEL[id])
    .filter((label): label is string => Boolean(label));

  return `${ACK_HEAD}${sections.join(', ')}${ACK_MID}${ladder.join(' > ')}${ACK_TAIL}`;
}

/**
 * The ack's reservation: the worst case the generator can produce, derived FROM the
 * generator rather than guessed beside it. A constant that cannot disagree with the string
 * it budgets for.
 */
export const SCAFFOLDING_ACK_RESERVE_TOKENS = (() => {
  const all = Object.keys(LANE_SECTION_LABEL);
  const text = renderScaffoldingAck(all) ?? '';
  return estimateTokens(text);
})();

// ── Cost ────────────────────────────────────────────────────────────────────────────────

/**
 * How many base64 characters are decoded to sniff an image's dimensions. A PNG/GIF/WebP
 * header lives in the first 30 bytes; a JPEG's SOFn sits after its EXIF and thumbnail, which
 * a phone camera can push past 60 KB. A multiple of 4, so the slice is whole base64 groups.
 */
const IMAGE_HEADER_B64_CHARS = 262_144;

/**
 * What ONE image block costs, by the MEASURED per-pixel rate (`memory/budget.ts`).
 *
 * An image whose size cannot be read — a `url` source carrying no bytes at all, a format the
 * sniffer does not know — is billed at the measured CEILING. That is deliberate and it is
 * the safe direction: guessing lower would let the allocator admit an assembly the provider
 * then refuses, which is the failure C11 exists to prevent, and "probably a small one" is
 * exactly the invented threshold #14 forbids.
 */
function imageBlockTokens(block: Record<string, unknown>): number {
  const source = block.source as { type?: unknown; data?: unknown } | undefined;
  if (source?.type === 'base64' && typeof source.data === 'string') {
    const head = Buffer.from(source.data.slice(0, IMAGE_HEADER_B64_CHARS), 'base64');
    const dims = imagePixelDimensions(head);
    if (dims) return estimateImageTokens(dims.width, dims.height);
  }
  return IMAGE_TOKEN_CEILING;
}

const isImageBlock = (b: unknown): b is Record<string, unknown> =>
  typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'image';

/**
 * What one emitted message costs, by the ONE estimator, exactly as the transports count it.
 *
 * PHASE-6 T4-CAP: an image block is billed by its PIXELS, which is the only thing 84 driven
 * provider receipts show anyone charging for — not by the length of its base64, which is
 * what this function used to count and what produced the captioner's 185,178-token payload.
 * The derivation, the corpus and the three constants are `memory/budget.ts`'s own header.
 *
 * A message carrying NO image block returns exactly what it returned before, character for
 * character: this function has five production readers and four of them are the allocator's
 * own budget accounting, so image-free arithmetic that moved by even one token would change
 * what the allocator admits on every turn on the platform. Neither reference file carries an
 * image block, and neither does any of the dev body's 23,101 stored messages — the image
 * path is reached only by a live attachment or by the captioner's own hand-built payload.
 */
export function messageTokens(m: LaneMessage): number {
  if (typeof m.content === 'string') return estimateTokens(m.content);
  // The same cast `assembly-validation.ts`'s `blocksOf` uses: the SDK's block union is
  // read structurally here, because what matters is `type === 'image'` and nothing else.
  const blocks = m.content as unknown as Array<Record<string, unknown>>;
  const images = blocks.filter(isImageBlock);
  if (images.length === 0) return estimateTokens(JSON.stringify(m.content));
  // The block's ENVELOPE is still text and is still counted as text; only the payload the
  // provider does not charge for is replaced by what the provider does charge for.
  const withoutPayloads = blocks.map((b) =>
    isImageBlock(b) ? { ...b, source: { ...(b.source as object), data: '' } } : b,
  );
  return estimateTokens(JSON.stringify(withoutPayloads))
    + images.reduce((t, b) => t + imageBlockTokens(b), 0);
}

export function renderTokens(messages: LaneMessage[]): number {
  return messages.reduce((t, m) => t + messageTokens(m), 0);
}

// ── Truncators ──────────────────────────────────────────────────────────────────────────

/**
 * The marker a truncated lane carries. The model must be able to tell "this section was
 * shortened to fit" from "this is all there was" — silence is how a partial brief gets read
 * as a complete one.
 */
export const LANE_TRUNCATION_MARKER = '\n[… this section was shortened to fit the context budget …]';

/** Smallest truncation that still says something. Below this a lane is rejected, not sliced. */
export const MIN_TRUNCATION_TOKENS = estimateTokens(LANE_TRUNCATION_MARKER) + 8;

/**
 * Shrink a wrapped block (`═══ HEADER ═══ … ═══ END … ═══`) to fit, keeping the header and
 * the closing line so the model still knows what it is looking at and where it ends.
 */
export function truncateWrappedText(text: string, maxTokens: number): string {
  const budgetChars = Math.max(0, maxTokens * 4 - LANE_TRUNCATION_MARKER.length);
  if (text.length <= budgetChars) return text;
  const lines = text.split('\n');
  const head = lines[0].startsWith('═══') ? lines[0] : '';
  const tailLine = lines.length > 1 && lines[lines.length - 1].startsWith('═══') ? lines[lines.length - 1] : '';
  const fixed = (head ? head.length + 1 : 0) + (tailLine ? tailLine.length + 1 : 0);
  const bodyBudget = Math.max(0, budgetChars - fixed);
  const body = text.slice(head ? head.length + 1 : 0, tailLine ? text.length - tailLine.length - 1 : text.length);
  const cut = body.slice(0, bodyBudget);
  return [head, cut + LANE_TRUNCATION_MARKER, tailLine].filter(Boolean).join('\n');
}

/** The default truncate for a single-message text lane. */
export function truncateTextLane<P>(render: LaneRender<P>, maxTokens: number): LaneRender<P> {
  const m = render.messages[0];
  if (!m || typeof m.content !== 'string') return render;
  const content = truncateWrappedText(m.content, maxTokens);
  const messages = [{ ...m, content }];
  return { messages, tokens: renderTokens(messages), payload: render.payload };
}

// ── The fit ─────────────────────────────────────────────────────────────────────────────

export interface LaneCandidate<C = unknown, P = unknown> {
  lane: Lane<C, P>;
  render: LaneRender<P> | null;
  /** PHASE-4 T1 2b: set when `render` THREW. `render` is null either way, so without
   *  this the receipt cannot tell "nothing to say" from "failed to say it". */
  renderError?: string | null;
}

export interface FitResult {
  /** Admitted lanes in EMISSION (slot) order, with the messages to push. */
  emitted: Array<{ id: string; slot: number; messages: LaneMessage[]; tokens: number }>;
  report: AllocationReport;
}

/**
 * The two-pass fit. Pure arithmetic over already-rendered lanes: no database, no clock, no
 * i/o — so it is testable without a server and deterministic by construction.
 */
export function fitLanes(
  candidates: Array<LaneCandidate<unknown, unknown>>,
  budgetTokens: number,
  opts: { offTheTopTokens?: number } = {},
): FitResult {
  const budget = Math.max(0, Math.floor(budgetTokens));
  const grants: LaneGrant[] = [];
  const overBudget: OverBudgetEvent[] = [];

  // Lanes that rendered nothing are recorded as `empty`, never omitted: "the briefing did
  // not exist" and "the briefing was dropped" are different facts and the receipt must be
  // able to tell them apart (research 06 §8).
  // PHASE-4 T1 2b: a lane whose render THREW is a THIRD fact and this used to assert the
  // first one about it. `failed` carries the error into the RECEIPT, not just a log.
  const live: Array<{ c: LaneCandidate; cost: number; reserved: number; granted: number }> = [];
  for (const c of candidates) {
    if (!c.render || c.render.messages.length === 0) {
      grants.push({
        id: c.lane.id, slot: c.lane.slot, priority: c.lane.priority,
        requested: 0, granted: 0,
        status: c.renderError ? 'failed' : 'empty',
        reason: c.renderError
          ? `lane render threw: ${String(c.renderError).slice(0, 300)}`
          : 'lane rendered no content on this turn',
      });
      continue;
    }
    live.push({ c, cost: c.render.tokens, reserved: 0, granted: 0 });
  }

  const byPriority = [...live].sort((a, b) =>
    a.c.lane.priority - b.c.lane.priority || a.c.lane.slot - b.c.lane.slot,
  );

  // ── Pass 1: reserve the minimums, highest priority first ──
  let reserved = 0;
  for (const e of byPriority) {
    const want = Math.min(e.c.lane.minTokens, e.cost);
    if (want <= 0) continue;
    if (reserved + want <= budget) {
      e.reserved = want;
      reserved += want;
    } else if (e.c.lane.mandatoryFloor) {
      // B8: the floor is honoured anyway, and the overrun is RECORDED.
      e.reserved = want;
      reserved += want;
      overBudget.push({
        laneId: e.c.lane.id,
        overBy: reserved - budget,
        reason:
          `lane declares a MANDATORY ${e.c.lane.minTokens}-token floor and the ${budget}-token ` +
          `budget could not cover it; included anyway because a context with no live ` +
          `conversation is worse than one over budget (requirement B8)`,
      });
    } else {
      e.reserved = -1; // rejected in pass 1; recorded below
    }
  }

  // ── Pass 2: distribute the remainder, highest priority first ──
  let spent = 0;
  for (let i = 0; i < byPriority.length; i++) {
    const e = byPriority[i];
    if (e.reserved < 0) {
      e.granted = 0;
      grants.push({
        id: e.c.lane.id, slot: e.c.lane.slot, priority: e.c.lane.priority,
        requested: e.cost, granted: 0, status: 'rejected',
        reason:
          `budget exhausted before this lane's ${e.c.lane.minTokens}-token minimum could be ` +
          `reserved (priority ${e.c.lane.priority}, ${budget} tokens for all lanes)`,
      });
      continue;
    }
    // Never spend a reservation still owed to a lane below this one.
    let owedBelow = 0;
    for (let j = i + 1; j < byPriority.length; j++) {
      if (byPriority[j].reserved > 0) owedBelow += byPriority[j].reserved;
    }
    const available = Math.max(0, budget - spent - owedBelow);
    const ceiling = Math.min(e.cost, e.c.lane.maxTokens);
    // A lane never gets less than the floor pass 1 already set aside for it.
    const grant = Math.max(e.reserved, Math.min(ceiling, available));

    // A lane that RENDERED CONTENT is never rejected for costing nothing. Zero cost with a
    // non-empty render is a measurement problem, not a reason to drop the section — and it
    // is exactly what a stored `token_count = 0` used to produce (see `storedRowCost`).
    if (grant <= 0 && e.cost > 0) {
      e.granted = 0;
      grants.push({
        id: e.c.lane.id, slot: e.c.lane.slot, priority: e.c.lane.priority,
        requested: e.cost, granted: 0, status: 'rejected',
        reason:
          `no tokens left at priority ${e.c.lane.priority}: ${spent} of ${budget} spent by ` +
          `higher-priority lanes, ${owedBelow} still reserved below`,
      });
      continue;
    }

    e.granted = grant;
    spent += grant;

    if (grant >= e.cost) {
      grants.push({
        id: e.c.lane.id, slot: e.c.lane.slot, priority: e.c.lane.priority,
        requested: e.cost, granted: grant, status: 'admitted',
        reason: 'fit whole',
      });
    } else {
      const shrunk = e.c.lane.truncate(e.c.render as LaneRender, grant);
      (e.c as { render: LaneRender | null }).render = shrunk;
      grants.push({
        id: e.c.lane.id, slot: e.c.lane.slot, priority: e.c.lane.priority,
        requested: e.cost, granted: shrunk.tokens, status: 'truncated',
        reason:
          `shortened from ${e.cost} to ${grant} tokens` +
          (e.c.lane.maxTokens < e.cost ? ` (lane ceiling ${e.c.lane.maxTokens})` : ''),
      });
      spent += shrunk.tokens - grant;
    }
  }

  const admitted = live
    // `granted > 0 || cost === 0` — a rendered lane that measured zero cost is admitted,
    // not silently dropped. See the zero-cost clause in `lanes.test.ts`.
    .filter((e) => (e.granted > 0 || e.cost === 0) && e.c.render && e.c.render.messages.length > 0)
    .sort((a, b) => a.c.lane.slot - b.c.lane.slot);

  return {
    emitted: admitted.map((e) => ({
      id: e.c.lane.id,
      slot: e.c.lane.slot,
      messages: (e.c.render as LaneRender).messages,
      tokens: (e.c.render as LaneRender).tokens,
    })),
    report: {
      budgetTokens: budget,
      reservedTokens: reserved,
      spentTokens: spent,
      offTheTopTokens: opts.offTheTopTokens ?? 0,
      grants: grants.sort((a, b) => a.slot - b.slot),
      admittedIds: admitted.map((e) => e.c.lane.id),
      overBudget,
    },
  };
}

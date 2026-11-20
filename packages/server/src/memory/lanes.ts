// The lane table and the two-pass fit. Priority is data, and the allocator reads it. A lane declares `{id,
// priority, min, max, render, truncate}` plus its position (`slot`). Position is what the model reads (the
// cache-prefix law makes it part of a lane's contract); priority is what the budget spends; the two are
// independent. Every lane implements `truncate()`, since a lane taken only whole is dropped whole. Pass 1
// reserves `min(minTokens, cost)` per lane in priority order and rejects (with a reason) a lane whose
// minimum does not fit. Pass 2 walks again: each lane takes up to `min(cost, maxTokens)` of what is left,
// never the reservations still owed below it, and granted < cost means `truncate()`. Every grant, rejected
// ones included, is recorded in the `AllocationReport`; a forced last group is recorded as an
// `OverBudgetEvent`.

import type Anthropic from '@anthropic-ai/sdk';
import {
  estimateTokens, estimateImageTokens, imagePixelDimensions, IMAGE_TOKEN_CEILING,
  CACHED_REGION_SHARE,
} from './budget.js';
import { MessageSlot } from '../prompt/registry/types.js';

export type LaneMessage = {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
  reasoningContent?: string;
};

export interface LaneRender<P = unknown> {
  messages: LaneMessage[];
  tokens: number;
  payload?: P;
}

export type LaneStatus = 'admitted' | 'truncated' | 'rejected' | 'empty' | 'failed';

export interface LaneGrant {
  id: string;
  slot: number;
  priority: number;
  requested: number;
  granted: number;
  status: LaneStatus;
  reason: string;
}

export interface OverBudgetEvent {
  laneId: string;
  overBy: number;
  reason: string;
}

export interface AllocationReport {
  budgetTokens: number;
  reservedTokens: number;
  spentTokens: number;
  offTheTopTokens: number;
  loopTailExtraTokens?: number;
  grants: LaneGrant[];
  admittedIds: string[];
  overBudget: OverBudgetEvent[];
}

/** One lane. `render` may be async; `truncate` never is: shrinking is arithmetic on what is in hand. */
export interface Lane<C = unknown, P = unknown> {
  id: string;
  slot: number;
  /** Lower survives longer; independent of `slot`. */
  priority: number;
  minTokens: number;
  maxTokens: number;
  /** Honoured even over budget (the fresh tail only); recorded as an `OverBudgetEvent`. */
  mandatoryFloor?: boolean;
  render: (ctx: C) => Promise<LaneRender<P> | null> | LaneRender<P> | null;
  truncate: (render: LaneRender<P>, maxTokens: number) => LaneRender<P>;
}

// The declared priority ladder. Post-budget tail lanes (active-tasks, attempt-ledger, events, scratchpad,
// relevant-memory) are not here: a priority says what to DROP under pressure, while a post-budget lane
// carries a reserve in `POST_BUDGET_LANES` that cannot be outbid, and whatever a tool can mutate must
// render below the conversation. The ack sits at 35, just under the live conversation: an ack that survives
// while its sections were dropped is a lie. Its reservation comes off the top
// (`SCAFFOLDING_ACK_RESERVE_TOKENS`); priority only gates rendering.
export const LANE_PRIORITY: Record<string, number> = {
  'lane.fresh-tail': 30,
  'lane.scaffolding-ack': 35,
  'lane.summaries': 80,
  'lane.vault': 100,
  'lane.briefing': 110,
};

export const LANE_LADDER_LABEL: Record<string, string> = {
  'lane.fresh-tail': 'live conversation below',
  'lane.summaries': 'compressed history',
  'lane.vault': 'vault entries',
  'lane.briefing': 'briefing',
};

/** The sections the ack lists as reviewed; key order is emission (slot) order, which the ack prints. */
export const LANE_SECTION_LABEL: Record<string, string> = {
  'lane.briefing': 'briefing',
  'lane.vault': 'vault',
  'lane.summaries': 'summaries',
};

// The declared numbers: one record per lane, read by that lane's render.

export interface LaneLimits {
  rows?: Record<string, number>;
  chars?: Record<string, number>;
  tokens?: Record<string, number>;
  retrieval?: Record<string, number>;
}

export const LANE_LIMITS: Record<string, LaneLimits> = {
  // `lane.pm-tail` has no row cap: a count window measured from the back scrolls and moves the PM's prompt
  // prefix on every call. The PM tail is bounded by the horizon (`tail-horizon.ts`) and the token trim
  // (`assembler.ts`, PM branch).

  // The vault's per-ask retrieval is `recall-lane.ts`; its pinned half is every permanent entry plus the
  // newest `MAX_PINNED_ENTRIES` other pins (`vault/retrieval.ts`).
  'lane.vault': {},

  // `scrubWindow` caps the tool rows scanned since session start. `relevanceBudget` decides how many older
  // summaries ride along and never cuts the newest (`summaries-lane.ts`).
  'lane.summaries': {
    rows: { scrubWindow: 30 },
    tokens: { relevanceBudget: 6000 },
  },

  // `recallPairs` 3 matches `RECENTLY_ANSWERED_LIMIT`; `answerPreview` 220 is shorter than the 300-char ask
  // half (the ask must be recognisable, the answer is a reminder); `quotedFloor` 40 is `lane.deliveries`'s
  // floor (a quote is shortened, never taken to nothing). The lane's ceiling is the derived worst case
  // (`recallLaneWorstCaseTokens`).
  'lane.relevant-memory': {
    // `snapshotCommitments` 6 is about what the open-work block fits in its 600-char budget; completeness
    // rides on the stated count ("and N more"). `snapshotTitle` 120 covers the longest commitment title
    // seen, with room.
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

  // `rows.integrations` is a ceiling on the platform's family union (`'google' | 'microsoft' | 'plaud'`): 4
  // leaves one spare so a new family is not silently dropped (`the-status-line-beats-the-note.test.ts`
  // fails on a fifth). `chars.tool` bounds the tool name read from `agent_tool_outcomes`.
  'lane.integration-status': {
    rows: { integrations: 4 },
    chars: { tool: 60 },
  },

  // No row counts and no token cap: the ledger is laid out in the room left after the task list
  // (`work-board-lane.ts`).
  'lane.attempt-ledger': {
    chars: { title: 120, entryFloor: 400 },
  },
  // None of these is a ceiling: the list is laid out in the room the assembly left it
  // (`activeTasksRoomTokens`), whole when every task fits. They are the guarantee the reserve is derived
  // at: `tasksFloor` rows always listed (a row left off is counted), `originalWordsFloor` characters of the
  // requester's words as one pool (a cut names the message via `history_get`), and title, label and note
  // widths used only when the view cannot hold them whole.
  'lane.active-tasks': {
    rows: { tasksFloor: 5 },
    chars: { title: 120, originalWordsFloor: 8000, originLabel: 120, lastNote: 200 },
  },

  'lane.events': { rows: { events: 10 }, chars: { gist: 400 } },

  // `pad` caps the scratchpad, which the agent writes itself; it truncates rather than drops.
  'lane.scratchpad': { chars: { pad: 4000 } },

  // Nothing reads these: the live tail caps are constants in `assembler.ts` and `tool-result-view.ts`.
  'lane.fresh-tail': {
    tokens: { maxToolResult: 15000, stubAfterTurns: 12 },
    chars: { toolResultKeepFloor: 500 },
    rows: { maxKeepImages: 1 },
  },

  'lane.awareness-gist': { chars: { subject: 140, preview: 160 } },

  // `deliveries` 3 is a cap, not a target; its reserve in `POST_BUDGET_LANES` pays for it.
  'lane.deliveries': {
    rows: { deliveries: 3 },
    chars: { quoted: 300, echoProbe: 120, quotedFloor: 40 },
    retrieval: { windowHours: 48 },
  },
};

export function laneLimit(laneId: string, group: keyof LaneLimits, key: string): number {
  const v = LANE_LIMITS[laneId]?.[group]?.[key];
  if (typeof v !== 'number') {
    throw new Error(`lane limit not declared: ${laneId}.${group}.${key}`);
  }
  return v;
}

// Reserved off the top: each post-budget append and the loop's tail-append is a lane with reserved tokens.

export interface PostBudgetLane {
  id: string;
  slot: number;
  reserveTokens: number;
  /** Where the number came from; a reserve with no derivation is a rumour. It ships: `assembler.ts` puts it
   *  in `report.grants[].reason`, so it reaches an assembly receipt. Roles and measurements, never a name. */
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
    id: 'lane.loop-tail',
    slot: MessageSlot.TurnContext,
    reserveTokens: 1650,
    measured:
      'v3.3.3 merge, RE-DERIVED by the PHASE-3 T6 method (that one — 234 receipts, MAX 742 + 75 = 817, declared 900 — ' +
      'predates two entries that now ride this lane: engine.report-state and engine.other-threads, 2026-09-26). ' +
      '5,267 dev-box receipts 2026-08-01..10-13, summing every entry POST_BUDGET_ENTRY_LANE gives this lane: min 155 · ' +
      'p50 346 · p90 536 · p99 1,215 · MAX 1,478 tokens; 161 (3.1%) exceeded 900, 160 of them carrying a newcomer. ' +
      'Per entry, max/mean: msg.pending-nudge 581/103 · engine.report-state 517/483 · engine.other-threads 292/274 · ' +
      'msg.turn-context 227/140 · engine.recently-answered 159/126 · engine.open-work 148/77 · msg.current-time 89/87 · ' +
      'engine.recent-outbound 87/51 · msg.peer-status 21/20. The receipts predate t141\'s zoned instant (+10 chars each); ' +
      'the MAX receipt renders at most 31 (report-state 5 rows, other-threads 3, recently-answered 3, recent-outbound <=10, ' +
      'open-work <=8, current-time 2) = +78. Plus msg.tool-note, bounded by its fixed 299-char string at 75. ' +
      '1,478 + 78 + 75 = 1,631, declared 1,650: an under-declared reserve is what forces repair drops of the live conversation. ' +
      'THE OLD 1,420 WAS A SUM OF PER-ENTRY MAXIMA over golden-v0\'s nine cells — not a single turn that ever happened — and its largest term (msg.turn-context at 1,195) is 5.3x the largest this lane has been measured at. ' +
      'WHAT THIS RESERVE DELIBERATELY DOES NOT COVER, stated rather than discovered: ' +
      '`msg.technique-strong` rides this lane and the loop caps it at MAX_INLINE_CHARS = ' +
      '25,000 chars (`agent/v2/loop.ts`), i.e. ~6,250 tokens plus its frame — ~4x this ' +
      'reserve, and it appeared 0 times in 5,267 receipts because this box holds three ' +
      'fixture techniques of 1.3-3.2 KB. Reserving 6,350 off the top of EVERY assembly ' +
      'for a lane that rare is a permanent tax on history; a strong technique match is ' +
      'therefore a RECORDED over-budget event at the validator, not a silent one, which ' +
      'is the same disposition requirement B8 gives the forced last group. Narrowing the ' +
      '25,000 cap is a product-behaviour change and is enumerated for T9, not taken here. ' +
      't211: THE OTHER-THREADS BLOCK IS NO LONGER BOUNDED BY THIS LITERAL. Its 292-token maximum is inside the ' +
      '1,650 (`LOOP_TAIL_OTHER_THREADS_COVERED_TOKENS`); the part of the block this turn would render beyond that is ' +
      'added to the reserve each assembly (`loopTailExtraTokens`, `reserveLadderFor`), so many people waiting cannot overflow it.',
  },
  // The four lanes below left the cached region. Each reserve is derived by calling the renderer with every
  // cap flooded at once and is pinned to it by `the-prefix-holds-still.test.ts`, so a cap change moves the
  // reserve.
  {
    id: 'lane.attempt-ledger',
    slot: MessageSlot.AttemptLedgerTail,
    reserveTokens: 239,
    measured:
      't207 (D6), DERIVED BY CALLING THE RENDERER: `attemptLedgerWorstCaseTokens()` '
      + '(`memory/attempt-ledger.ts`) renders the smallest block the ledger promises: the frame, one task at the '
      + 'title width carrying a revert note, a pointer to its notes and an "earlier entries" line, and its newest '
      + 'entry at the entry floor = 239 tokens. It was 800 (W81, the lane\'s old hard ceiling, which also capped '
      + 'it at 2 tasks and 6 entries each); the ledger now has no ceiling and is laid out in the room the array '
      + 'leaves after the task list, so this is a GUARANTEE, not a maximum. WHAT IT COSTS: 561 tokens come off the '
      + 'reserved top of every assembly and go to the content budget; the post-budget block is recomputed every '
      + 'turn as before and sits behind the conversation, so no cached prefix byte moves (the content budget, and '
      + 'with it where the trim and the fold cut, shifts once, at the next compaction boundary).',
  },
  {
    id: 'lane.active-tasks',
    slot: MessageSlot.ActiveTasksTail,
    // Derived by calling `activeTasksWorstCaseTokens()`. At run time the list is laid out in this reserve
    // plus the content fit's unspent budget (`activeTasksRoomTokens`), so the reserve is the list's
    // guarantee, not its ceiling.
    reserveTokens: 4743,   // derived by the renderer; `user_outlook_search` is the longest measure tool name
    measured:
      'W81 + t139, DERIVED BY CALLING THE RENDERER: `activeTasksWorstCaseTokens()` '
      + '(`memory/work-board-lane.ts`) builds 5 task lines (rows.tasks) through the REAL '
      + '`taskLine` + `renderActiveTasksBlock`, every cap flooded at once — a 120-char title '
      + '(chars.title, NEW at W81 and the one term this move added, because an unbounded '
      + 'title is why this lane could never declare a worst case), the GUARANTEED WORDS FLOOR '
      + '(chars.originalWordsFloor = 8,000, t139: the deleted pin\'s own cap, shared across '
      + 'the open tasks in block order) spent in full by an over-cap first request, the closing '
      + '"N more unfinished tasks not shown" line at a 10-digit count (round 5), every line '
      + 'linked and over the cap so each carries the longer "continues … history_get(id=…)" '
      + 'line with a 36-char message id and a 10-digit count, a 120-char conversation label '
      + '(chars.originLabel) and the widest recorded-instant stamp, a 200-char last note '
      + '(chars.lastNote), the widest waiting-status line (t139: every unfinished task is listed), '
      + 'an edited-description head and its pointer-only cut line and a 10-digit newer-messages count on every '
      + 'current task, the owner\'s LATER messages (t145: a labelled head, a message cut to its `history_get` pointer, '
      + 'and one collapse line naming a 10-digit count of older messages and the newest; the generator sweeps the first '
      + 'row\'s newest message across every length that leaves a partial remainder of the pool, because that case '
      + 'prints more than a collapse line), the waiting line (status, whom, not-current, pointer) for every split of the rows, a full 36-char id and '
      + 'the widest `renderTaskStamps({relative:false})` / `renderStepFacts` terms, both '
      + 'measured by CALLING those two renderers rather than counted beside them. '
      + 'WHY IT IS A RESERVE AT ALL: this lane was a `fitLanes` candidate at '
      + 'MessageSlot.ActiveTasks = 600 with `maxTokens: Infinity`, stating the WORK BOARD — '
      + 'the most-written surface an agent has. Every `work_*` tool moves it, and so does the '
      + 'engine\'s >=6-non-trivial-tool-call tracker floor '
      + '(`agent/v2/steps/execute/tracker-floors.ts`), which mints an in_progress row out of '
      + 'six PURE READS: that is why `plaud_*` and `outlook_*` appear in the owner\'s list of '
      + 'six occurrences alongside the two `work_update`s. '
      + 'WHAT IT COSTS: the block is uncached now, and its title is capped where it was not. '
      + 't139 adds 2,379 tokens off the top of every assembly for the requester\'s words, and t145 adds the '
      + 'later-message framing; the pin\'s own 2,081 for the same 8,000 characters is freed by t145. '
      + 'ROUND 5: this reserve is the list\'s GUARANTEE, not its ceiling — the block is laid out '
      + 'in this reserve plus whatever the content fit left unspent (`activeTasksRoomTokens`), so '
      + 'a roomy view carries every request whole and a full one still carries this much.',
  },
  {
    id: 'lane.scratchpad',
    slot: MessageSlot.ScratchpadTail,
    reserveTokens: 1049,
    measured:
      'W81, DERIVED BY CALLING THE RENDERER: `scratchpadWorstCaseTokens()` '
      + '(`memory/assembler.ts`) renders the real frame around a pad flooded to '
      + 'LANE_LIMITS[\'lane.scratchpad\'].chars.pad = 4,000 — NEW at W81 for the reason '
      + '`chars.title` is new next door: the pad was unbounded, and an unbounded lane cannot '
      + 'declare a reserve. 4,000 chars is ~4x the largest pad on the worn-in dev body '
      + '(the primary agent\'s, at 1,046 chars) and the block truncates rather than drops, so the cap costs the '
      + 'tail of a runaway pad and never the pad itself. '
      + 'WHY IT IS A RESERVE AT ALL: `scratchpad_set`, `scratchpad_clear` and `reset_session` '
      + 'all rewrite `agents.config.scratchpad` MID-CONVERSATION, and the block sat at '
      + 'MessageSlot.Scratchpad = 800 with priority 20 — ahead of the entire conversation, '
      + 'and ahead of it at the HIGHEST content priority in the assembly. The ack\'s own '
      + 'deleted sentence stated the volatility out loud: "I maintain it via scratchpad_set '
      + 'as I make progress."',
  },
  {
    id: 'lane.events',
    slot: MessageSlot.EventsTail,
    reserveTokens: 1513,
    measured:
      'W81, DERIVED BY CALLING THE RENDERER: `eventsLaneWorstCaseTokens()` '
      + '(`memory/assembler.ts`) renders the real frame around 10 bullets (rows.events), each '
      + 'a 400-char gist (chars.gist) behind the widest label and a full '
      + '`renderMessageTimeStamp` instant. '
      + 'WHY IT IS A RESERVE AT ALL, and it is the subtlest of the four: NO TOOL WRITES THIS '
      + 'LANE. Its content is `awarenessEvents.slice(-10)` over the fresh tail\'s FIXED ROW '
      + 'WINDOW (`getRecentMessages(agentId, policy.freshTailCount)`), so every tool call '
      + 'appends two rows and eventually pushes an awareness row out of the window — the '
      + 'block re-renders because the CONVERSATION moved, with nothing mutated anywhere. '
      + 'Driven at `0cc9a3ba` across a single `outlook_search` on a 14-notice body: 1,344 -> '
      + '1,276 chars at slot 1050, ahead of everything. That is the same scrolling-window '
      + 'defect T67b deleted from `lane.active-tasks`\'s recent-mention suppression, and it is '
      + 'the one that explains the READ tools in the owner\'s six. '
      + 'WHAT IT COSTS: a lane that was a cache hit between notices is recomputed every turn. '
      + 'A scrolling window cannot be re-keyed into stability — the window IS the content — '
      + 'so position is the only door, which is the disposition the rule already names.',
  },
  {
    id: 'lane.integration-status',
    slot: MessageSlot.IntegrationStatusTail,
    reserveTokens: 612,   // the failure term names its account
    measured:
      'T76b, DERIVED BY CALLING THE RENDERER: `integrationStatusWorstCaseTokens()` '
      + '(`memory/integration-status-lane.ts`) builds LANE_LIMITS[\'lane.integration-status\'] '
      + '.rows.integrations maximal rows through the REAL `integrationStatusLine` + '
      + '`renderIntegrationStatusBlock`, every optional term present at once — the longer '
      + 'DISCONNECTED state clause, a last-successful-use instant, an unresolved-failure term '
      + 'carrying a name over chars.tool (so the `...` suffix is counted) and a six-digit hit '
      + 'count — plus one extra no-ledger row so the FOOTER is inside the measurement. The '
      + 'widest instants come from CALLING `recordedInstant` rather than being counted beside '
      + 'it, the `recall-lane.ts` / `work-board-lane.ts` discipline. '
      + 'WHY IT IS A RESERVE AT ALL: it is a post-budget TAIL lane by charter, not by rescue. '
      + 'Its content is the live connection state and the activity ledgers, both of which a '
      + 'tool call and a background reconnect can move, so roadmap non-negotiable #10 forbids '
      + 'it the cached region — and its whole job is to be READ on the turn it is true, which '
      + 'a lane the fit can drop cannot promise. '
      + 'WHAT IT COSTS AND WHAT IT BUYS: these tokens leave the content budget on every '
      + 'assembly. What they replace is the W84 failure mode — a false memory about a broken '
      + 'connection, recalled through `msg.relevant-memory` directly behind this block, with '
      + 'nothing in context to outrank it. That cost a day and a hand-deleted vault row.',
  },
  {
    id: 'lane.deliveries',
    slot: MessageSlot.Deliveries,
    // Derived by calling `deliveriesLaneWorstCaseTokens()`, which `deliveries-lane.test.ts` pins this
    // literal to.
    reserveTokens: 331,
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
    id: 'lane.relevant-memory',
    slot: MessageSlot.RecalledMemory,
    // Derived by calling `recallLaneWorstCaseTokens()` (snapshot and recall halves), which
    // `recall-lane.test.ts` pins this literal to. The snapshot is its own message, emitted first, so an ask
    // does not re-bill the board state.
    reserveTokens: 2250,
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

/**
 * The loop tail's reserve follows what the loop will append. `lane.loop-tail` is a measured literal that
 * covers an other-threads block of at most 292 tokens; the part of this turn's block beyond that is added
 * to the reserve the assembler takes off the top (`reserveLadderFor`).
 */
export const LOOP_TAIL_OTHER_THREADS_COVERED_TOKENS = 292;
/** The extra rounds up to whole steps so the trim point moves in steps (the cache tenet). */
export const LOOP_TAIL_EXTRA_STEP_TOKENS = 512;
export const loopTailExtraTokens = (otherThreadsBlockTokens: number): number => {
  const beyond = Math.max(0, otherThreadsBlockTokens - LOOP_TAIL_OTHER_THREADS_COVERED_TOKENS);
  return Math.ceil(beyond / LOOP_TAIL_EXTRA_STEP_TOKENS) * LOOP_TAIL_EXTRA_STEP_TOKENS;
};

// Which post-budget lane each tagged entry rides. `lane.loop-tail` and `lane.deliveries` are filled by the
// loop, so their messages carry entry ids; `repairAssembly` reads this table so those are not refused as
// undeclared lanes, and `assembly-repair-lane-census.test.ts` holds it both ways against the prompt
// registry.
export const POST_BUDGET_ENTRY_LANE: Record<string, string> = {
  'msg.tool-note': 'lane.loop-tail',
  'msg.pending-nudge': 'lane.loop-tail',
  'msg.context-gap': 'lane.loop-tail',
  'msg.delegation-hint': 'lane.loop-tail',
  'msg.technique-strong': 'lane.loop-tail',
  'msg.technique-weak': 'lane.loop-tail',
  'msg.turn-context': 'lane.loop-tail',
  'msg.peer-status': 'lane.loop-tail',
  'msg.current-time': 'lane.loop-tail',
  // A lane that declares its own reserve is attributed to itself, not to the tail it sits inside (as the
  // receipt does).
  'msg.deliveries': 'lane.deliveries',
  'msg.relevant-memory': 'lane.relevant-memory',
  // One lane, one reserve, two entries: the snapshot is its own message so it can be ordered ahead of the
  // per-ask half.
  'engine.open-commitments': 'lane.relevant-memory',
  'msg.attempt-ledger': 'lane.attempt-ledger',
  'msg.active-tasks': 'lane.active-tasks',
  'msg.scratchpad': 'lane.scratchpad',
  'msg.events': 'lane.events',
  'msg.integration-status': 'lane.integration-status',
  // The three engine-side injections that still push directly (`pre-call-injections.ts`).
  'engine.open-work': 'lane.loop-tail',
  'engine.recent-outbound': 'lane.loop-tail',
  'engine.recently-answered': 'lane.loop-tail',
  // Engine state lanes pushed by `pre-call-injections.ts` past `volatileFrom`; declared here because the
  // census test needs this table to equal the injected `engine.*` literals, and being declared protects a
  // lane from the priority repair.
  'engine.report-state': 'lane.loop-tail',
  'engine.other-threads': 'lane.loop-tail',
};

/** The PM path's only lane: not in `LANE_PRIORITY`, as the PM assembly has no ladder. */
const PM_TAIL_LANE_ID = 'lane.pm-tail';

/** A lane the repair must recognise but never drop: post-budget lanes, their entries, the PM tail. */
export function isProtectedLaneId(id: string): boolean {
  if (POST_BUDGET_ENTRY_LANE[id] !== undefined) return true;
  if (id === PM_TAIL_LANE_ID) return true;
  return POST_BUDGET_LANES.some((l) => l.id === id);
}

// The scaffolding ack is a pure function of the admitted lane id set (no clock, counts or agent id), so it
// is byte-identical across turns that admit the same lanes. `lanes.test.ts` pins this with a purity clause.
const ACK_HEAD = 'Understood, I have reviewed my background context (';
const ACK_MID = '). Source priority for this turn: ';
// The ack closes the scaffolding block it sits in, so it names only that block's sections, never tail lanes.
const ACK_TAIL =
  '. When sources disagree, trust the most recent and most specific.';

/** Generate the ack from the admitted lane ids (pure); the live conversation is always listed. */
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

export const SCAFFOLDING_ACK_RESERVE_TOKENS = (() => {
  const all = Object.keys(LANE_SECTION_LABEL);
  const text = renderScaffoldingAck(all) ?? '';
  return estimateTokens(text);
})();

/** The lanes that fire whatever happens: the floor the ladder never scales below. */
const UNCONDITIONAL_POST_BUDGET_IDS = ['lane.engine-end-of-history', 'lane.empty-context-fallback'];

/**
 * The share of the available budget the reserve ladder may claim (a half): after the system prompt only the
 * content and these appends remain, and an append cannot exist without a conversation. This is accounting,
 * not enforcement: nothing truncates a post-budget lane to its reserve, so a scaled assembly can overshoot,
 * and the pre-dial gate in `agent/model.ts` refuses a doomed request. `assertSystemPromptFits`
 * (`budget.ts`) throws before a non-positive budget.
 */
export const RESERVE_LADDER_SHARE_DENOMINATOR = 2;

export const RESERVE_LADDER_FLOOR_TOKENS = SCAFFOLDING_ACK_RESERVE_TOKENS
  + POST_BUDGET_LANES
    .filter((l) => UNCONDITIONAL_POST_BUDGET_IDS.includes(l.id))
    .reduce((t, l) => t + l.reserveTokens, 0);

export interface ReserveLadder {
  offTheTop: number;
  scaled: boolean;
  declared: number;
}

/** The ladder, against the budget actually left after the system prompt. Pure: the caller logs. */
export function reserveLadderFor(availableTokens: number, loopTailExtra = 0): ReserveLadder {
  const declared = SCAFFOLDING_ACK_RESERVE_TOKENS + POST_BUDGET_RESERVE_TOKENS + loopTailExtra;
  const ceiling = Math.floor(Math.max(0, availableTokens) / RESERVE_LADDER_SHARE_DENOMINATOR);
  if (declared <= ceiling) return { offTheTop: declared, scaled: false, declared };
  return { offTheTop: Math.max(RESERVE_LADDER_FLOOR_TOKENS, ceiling), scaled: true, declared };
}

/** Base64 chars decoded to sniff dimensions (a JPEG's SOFn can sit past 60 KB); a multiple of 4. */
const IMAGE_HEADER_B64_CHARS = 262_144;

/** Per-pixel cost; an unreadable size bills the ceiling: a lower guess risks a provider refusal. */
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

/** One message's cost by the one estimator; an image is billed by its pixels, not its base64 length.
 *  Image-free cost must stay exactly `estimateTokens`: the allocator's lane costs are counted with it. */
export function messageTokens(m: LaneMessage): number {
  if (typeof m.content === 'string') return estimateTokens(m.content);
  // Read structurally: only `type === 'image'` matters.
  const blocks = m.content as unknown as Array<Record<string, unknown>>;
  const images = blocks.filter(isImageBlock);
  if (images.length === 0) return estimateTokens(JSON.stringify(m.content));
  // The block envelope is counted as text; only the payload is replaced by what the provider charges.
  const withoutPayloads = blocks.map((b) =>
    isImageBlock(b) ? { ...b, source: { ...(b.source as object), data: '' } } : b,
  );
  return estimateTokens(JSON.stringify(withoutPayloads))
    + images.reduce((t, b) => t + imageBlockTokens(b), 0);
}

export function renderTokens(messages: LaneMessage[]): number {
  return messages.reduce((t, m) => t + messageTokens(m), 0);
}

/** The marker a truncated lane carries, so the model can tell "shortened to fit" from "all there was". */
export const LANE_TRUNCATION_MARKER = '\n[… this section was shortened to fit the context budget …]';

export const MIN_TRUNCATION_TOKENS = estimateTokens(LANE_TRUNCATION_MARKER) + 8;

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

export function truncateTextLane<P>(render: LaneRender<P>, maxTokens: number): LaneRender<P> {
  const m = render.messages[0];
  if (!m || typeof m.content !== 'string') return render;
  const content = truncateWrappedText(m.content, maxTokens);
  const messages = [{ ...m, content }];
  return { messages, tokens: renderTokens(messages), payload: render.payload };
}

export interface LaneCandidate<C = unknown, P = unknown> {
  lane: Lane<C, P>;
  render: LaneRender<P> | null;
  /** Set when `render` threw, so the receipt can tell "nothing to say" from "failed to say it". */
  renderError?: string | null;
}

export interface FitResult {
  emitted: Array<{ id: string; slot: number; messages: LaneMessage[]; tokens: number }>;
  report: AllocationReport;
}

export function fitLanes(
  candidates: Array<LaneCandidate<unknown, unknown>>,
  budgetTokens: number,
  opts: { offTheTopTokens?: number } = {},
): FitResult {
  const budget = Math.max(0, Math.floor(budgetTokens));
  const grants: LaneGrant[] = [];
  const overBudget: OverBudgetEvent[] = [];

  // Lanes that rendered nothing are recorded as `empty` (`failed` when render threw), never omitted.
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

  // Pass 2 walks the cached phase (`slot < MessageSlot.FreshTail`) to completion before the live phase. No
  // lane's grant may depend on a lane emitted after it: the tail grows on every tool call, so a cached lane
  // that read it would change bytes ahead of the conversation and re-bill everything behind them. Pass 1
  // still walks pure priority.
  const CACHED_PHASE = (slot: number) => slot < MessageSlot.FreshTail;
  const byPhase = [...byPriority].sort((a, b) =>
    (CACHED_PHASE(a.c.lane.slot) ? 0 : 1) - (CACHED_PHASE(b.c.lane.slot) ? 0 : 1),
  );
  // Without a cap, one lane with `maxTokens: Infinity` could take the whole budget and leave a one-message
  // conversation.
  const cachedRegionCap = Math.floor(budget * CACHED_REGION_SHARE);
  let cachedSpent = 0;

  let reserved = 0;
  for (const e of byPriority) {
    const want = Math.min(e.c.lane.minTokens, e.cost);
    if (want <= 0) continue;
    if (reserved + want <= budget) {
      e.reserved = want;
      reserved += want;
    } else if (e.c.lane.mandatoryFloor) {
      // the mandatory floor is honoured anyway, and the overrun is recorded
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

  let spent = 0;
  for (let i = 0; i < byPhase.length; i++) {
    const e = byPhase[i];
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
    // Never spend a reservation still owed to a lane later in the walk (phase, then priority); a cached
    // lane therefore withholds the tail's reserved floor.
    let owedBelow = 0;
    for (let j = i + 1; j < byPhase.length; j++) {
      if (byPhase[j].reserved > 0) owedBelow += byPhase[j].reserved;
    }
    const inCachedPhase = CACHED_PHASE(e.c.lane.slot);
    // A cached lane sees the cached cap, never `spent`, which carries the tail's size.
    const available = inCachedPhase
      ? Math.max(0, Math.min(cachedRegionCap - cachedSpent, budget - cachedSpent - owedBelow))
      : Math.max(0, budget - spent - owedBelow);
    const ceiling = Math.min(e.cost, e.c.lane.maxTokens);
    const grant = Math.max(e.reserved, Math.min(ceiling, available));

    // A lane that rendered content is never rejected for costing nothing: zero cost with content is a
    // measurement problem.
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
    if (inCachedPhase) cachedSpent += grant;

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
      if (inCachedPhase) cachedSpent += shrunk.tokens - grant;
    }
  }

  const admitted = live
    // A rendered lane that measured zero cost is admitted, not dropped.
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

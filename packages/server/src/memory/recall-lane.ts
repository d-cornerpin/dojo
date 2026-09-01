// ════════════════════════════════════════════════════════════════════════════════════════
// THE RECALL LANE — per-message semantic recall, and the conclusions it carries.
// SWEEP CORE-2 item 4 (from `SWEEP-C.md` T4; owner-decided GO 2026-07-26: "Enable per-message
// recall"). Moved out of `memory/assembler.ts`, where it was ~250 lines of retrieval inside a
// 2,600-line file, and repositioned.
//
// ── WHY IT MOVED POSITION, WHICH IS THE WHOLE OF THE CACHE HALF ──────────────────────────
// The lane sat at `MessageSlot.RelevantMemory = 400`: ahead of the fresh tail (1100) and far
// ahead of the volatile boundary `msg.turn-context` (1850). Its CONTENT, meanwhile, has been
// re-derived from the live ask on every turn since PHASE-3 T3 gave it a per-turn query. That
// is the one combination roadmap non-negotiable #10 forbids and SWEEP-C T4's rider names
// outright: *"a lane whose content changes with the live ask CANNOT sit at its current
// position (MessageSlot 400, ahead of the fresh tail) — per-turn retrieval rides the TAIL
// (behind MessageSlot.TurnContext); the front-position lane may hold only session-stable
// content. Position is decided here in the plan, not at runtime."*
//
// `MessageSlot.RecalledMemory = 1870` sits between the deliveries lane (1860) and peer-status
// (1875), so the preserved near-tail order 1850 -> 1875 -> 1900 is untouched and adding a
// number BETWEEN two existing ones renumbers nothing (the same move as Events=1050 and
// Deliveries=1860). It goes AFTER deliveries because it is the more volatile of the two: a
// delivery row changes when the agent sends, this changes with every ask.
//
// The read still happens in the assembler — it owns the window policy and knows whether this
// is a scaffolding turn — and the LOOP appends the rendered block past `volatileFrom`. That
// is the deliveries-lane split in mirror image, and it is what keeps the dev context-dump
// honest about content it no longer emits itself.
//
// ── WHY IT CARRIES ANSWERS NOW, WHICH IS THE OWNER'S INCIDENT ────────────────────────────
// 2026-08-09: his agent investigated a question, answered it, and minutes later investigated
// it again from scratch. CORE-1 fixed the re-serve half. This is the other half — an agent
// should know what it already did.
//
// The lane used to recall RAW ROWS and nothing else. A similarity hit on an old question
// surfaced THE QUESTION; the answer was a different row that had to win the same search on
// its own merits, and nothing tied them together. So the model could be shown that it had
// once been asked something, with no way to see what it had concluded — and re-doing the work
// is the rational response to that prompt.
//
// The fix is not a new memory of answers. `messages.answer_message_id` (migration 113) is
// already the completion-truth stamp, `agent/v2/answered-edge.ts` is already its one owner,
// and this lane asks that owner (`answeredPairsForMessages`) to resolve a hit — on either
// half — into the PAIR. Nothing here parses prose to decide what an answer is.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────
// It does not widen scope. Both halves of a pair are bound to `agent_id` by the reader, the
// vault lookups stay `personalOnly` and agent-scoped exactly as they were, and a hit whose
// row the assembled tail already carries is dropped rather than quoted twice. An ask that
// `engine.recently-answered` already names in THIS conversation is dropped too — that block
// is the within-conversation ledger, this is the cross-boundary one, and one statement gets
// one owner.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { MessageSlot } from '../prompt/registry/types.js';
import { getRecentMessages } from './store.js';
import { type contextWindowPolicy } from './budget.js';
import {
  LANE_TRUNCATION_MARKER, laneLimit, renderTokens,
  type Lane, type LaneRender,
} from './lanes.js';
import {
  answeredPairsForMessages, recentlyAnsweredAsks, RECENTLY_ANSWERED_LIMIT, type AnsweredPair,
} from '../agent/v2/answered-edge.js';
import { recordedInstant } from './message-stamp.js';
import {
  obligationVerdict, liveCommitments, hasCommitmentHistory, openBoardCounts,
  type LiveCommitment, type BoardCounts,
} from '../work/obligation-memory.js';
import { UNFILED_ARCHIVE_LABEL, unfiledArchiveWorstCaseLines } from '../vault/retrieval.js';
import { parseDivider, NEW_SESSION_DIVIDER_LABEL } from '@dojo/shared';
import { turnBoundary } from '../agent/turn-state.js';

const logger = createLogger('recall-lane');

export const RECALL_LANE_ID = 'lane.relevant-memory';
/** The registry entry the loop injects this lane under. */
export const RECALL_LANE_ENTRY_ID = 'msg.relevant-memory';

// ── The declared caps, read from the lane table. A number this lane uses and does not
//    declare is the thing `laneLimit` throws about. ──────────────────────────────────────
const pairCap = () => laneLimit(RECALL_LANE_ID, 'rows', 'recallPairs');
const msgRowCap = () => laneLimit(RECALL_LANE_ID, 'rows', 'minTailForRecall');
const vaultRowCap = () => laneLimit(RECALL_LANE_ID, 'rows', 'minTailForVault');
const snapshotRowCap = () => laneLimit(RECALL_LANE_ID, 'rows', 'snapshotCommitments');
const snapshotTitleChars = () => laneLimit(RECALL_LANE_ID, 'chars', 'snapshotTitle');
const askChars = () => laneLimit(RECALL_LANE_ID, 'chars', 'hitPreview');
const answerChars = () => laneLimit(RECALL_LANE_ID, 'chars', 'answerPreview');
const vaultChars = () => laneLimit(RECALL_LANE_ID, 'chars', 'vaultPreview');
const quotedFloor = () => laneLimit(RECALL_LANE_ID, 'chars', 'quotedFloor');

// ════════════════════════════════════════════════════════════════════════════════════════
// The per-turn recall query. Moved verbatim from `assembler.ts`; both readers (this lane and
// the summaries lane's relevance selection) now import it from here.
// ════════════════════════════════════════════════════════════════════════════════════════

export function isSyntheticRow(content: string): boolean {
  return content.startsWith('[SOURCE:') || content.startsWith('[A2A:')
    || content.startsWith('[Engine') || content.startsWith('[ENGINE')
    || content.startsWith('[System') || content.startsWith('[DOJO:')
    // PHASE-1 T8: the divider's shape is @dojo/shared's, not a literal re-typed here.
    || parseDivider(content)?.label.startsWith(NEW_SESSION_DIVIDER_LABEL) === true;
}

// D4: strip a leading engine/A2A envelope so the recall query is the actual
// content. "[A2A:QUESTION thread:ab from:PM] can you ship X?" -> "can you ship X?"
// "[SOURCE:scheduler] remind the owner about Y" -> "remind the owner about Y".
function stripRecallEnvelope(content: string): string {
  const m = content.match(/^\[[^\]]*\]\s*/);
  return m ? content.slice(m[0].length) : content;
}

// ── THE PER-TURN RECALL QUERY IS ACTUALLY PER-TURN (PHASE-3 T3), carried verbatim ────────
//
// FOUND BY MEASUREMENT, not by reading: with the generated ack proven byte-stable across four
// consecutive iterations of one turn, the remaining message-array churn was ISOLATED to the
// summaries lane changing size mid-turn. The mechanism: `deriveRecallQuery` reads the last N
// rows and prefers the genuine human user rows among them; mid-turn each tool iteration
// appends an assistant row and a tool row, so the human row is PUSHED OUT of that window and
// the function falls through to "the newest substantive row, envelope-stripped" — a DIFFERENT
// row on every iteration. Memoising against `turnBoundary` — the timestamp the turn stamps at
// pickup and clears at idle — makes the docstring's claim true: iteration 1 computes exactly
// what it computed before, and iterations 2..N reuse it. Outside a turn there is no boundary
// and no memo, which is correct: there is no turn to be stable within.
const perTurnRecallQuery = new Map<string, { boundary: string; query: string }>();

export function buildPerTurnRecallQuery(agentId: string): string {
  const boundary = turnBoundary.get(agentId);
  if (boundary) {
    const memo = perTurnRecallQuery.get(agentId);
    if (memo && memo.boundary === boundary) return memo.query;
  }
  const query = deriveRecallQuery(agentId);
  if (boundary) perTurnRecallQuery.set(agentId, { boundary, query });
  return query;
}

// D4: ONE per-turn recall query, used by both summary-relevance and this block. Preference:
// the newest genuine human user rows (non-synthetic); else, on A2A/engine turns or
// mid-tool-iteration when no human row is in the recent window, the newest substantive row
// with its envelope stripped. The old derivation read only the last 3 user rows and went
// EMPTY on A2A/engine turns (zero semantic recall).
function deriveRecallQuery(agentId: string): string {
  let recent: ReturnType<typeof getRecentMessages> = [];
  try { recent = getRecentMessages(agentId, laneLimit(RECALL_LANE_ID, 'rows', 'recallWindow')); } catch { return ''; }
  const humanUser = recent
    .filter((m) => m.role === 'user' && typeof m.content === 'string' && !isSyntheticRow(m.content))
    .map((m) => m.content as string);
  const q = humanUser.join('\n').slice(-laneLimit(RECALL_LANE_ID, 'chars', 'recallHead'));
  if (q.trim().length > 10) return q;
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i]?.content;
    if (typeof c !== 'string') continue;
    const stripped = stripRecallEnvelope(c).replace(/\s+/g, ' ').trim();
    if (stripped.length > 10) return stripped.slice(-laneLimit(RECALL_LANE_ID, 'chars', 'recallTail'));
  }
  return '';
}

// ════════════════════════════════════════════════════════════════════════════════════════
// The render. PURE over the rows it is handed — retrieval happens above it, so every clause
// of the shape can be driven without an embedder.
// ════════════════════════════════════════════════════════════════════════════════════════

export interface RecallHit { sourceId: string }
export interface RecallVaultHit { id: string; type: string; content: string }

export interface RecallLaneContext {
  agentId: string;
  /** Non-scaffolding turns pull the vault here; scaffolding turns already injected it. */
  includeVault: boolean;
  /** Message ids the assembled array already carries — never quoted a second time. */
  excludeIds: Set<string>;
  /** Message hits, best-first, from the vector search (or the FTS degrade). */
  msgHits: RecallHit[];
  vaultHits: RecallVaultHit[];
  /** Asks `engine.recently-answered` is already naming this turn. One statement, one owner. */
  alreadyAnsweredAskIds: Set<string>;
  /** T67b: FN-1 unfiled-archive snippets, already capped by `unfiledArchiveBridgeLines`. */
  bridgeLines?: string[];
}

export interface RecallLanePayload {
  /**
   * Answered pairs: what this agent already concluded, newest LAST.
   *
   * T69b: `askAgo`/`answerAgo` were `relativeTimeAgo(...)` off `Date.now()`, so a pair set
   * that had not changed emitted different bytes at every bucket boundary. They are `askAt`
   * / `answerAt` and hold the RECORDED INSTANT, in the stamp the fresh tail already uses.
   * `answerAtMs` is the ORDERING key and is never rendered — see the sort below.
   */
  pairs: Array<{ ask: string; answer: string; askAt: string; answerAt: string; answerAtMs: number }>;
  /** Raw recalled lines that are not part of a pair, chronological. */
  msgLines: string[];
  vaultLines: string[];
  /**
   * T67b — THE FN-1 UNFILED-ARCHIVE BRIDGE, MOVED HERE WITH THE RETRIEVAL IT BELONGS TO.
   *
   * It peeks at the agent's newest still-unfiled conversation archives so a fact told just
   * before a session reset stays recallable until the Dreamer files it. It lived inside
   * `vault/retrieval.ts`'s `retrieveForContext`, which `lane.vault` rendered from slot 200 —
   * and it searches BY THE QUERY, so it was one of the per-ask retrievals rewriting the
   * cacheable prefix. Its caps are unchanged (`UNFILED_*`, 200 tokens); only its position is.
   */
  bridgeLines: string[];
  /** True when a row was dropped or a quote shortened relative to the read. */
  cut: boolean;
  /**
   * HL5: the COMPLETE live-commitment snapshot, or null when this agent has never recorded a
   * commitment. `total` is the whole set even when `rows` is capped — that is what keeps the
   * "anything not listed is not owed" sentence checkable rather than merely confident.
   *
   * T44: `board` is the REST of the board in four numbers, published in the same block for the
   * same reason and never listed. See `snapshotBoardLine`.
   */
  snapshot: { total: number; rows: string[]; board: BoardCounts } | null;
}

const HEAD = '═══ RELEVANT MEMORY (retrieved by meaning, context only, not live conversation) ═══';
const TAIL = '═══ END RELEVANT MEMORY ═══';
const PAIRS_HEAD =
  'Questions you have ALREADY ANSWERED (engine record, read from the answer stamps — the ' +
  'question was asked and you answered it. Do NOT re-run the work: restate what you ' +
  'concluded, or point at the earlier answer):';
const PAIR_ROW = (askAt: string, ask: string, answerAt: string, answer: string) =>
  `\n- ${askAt} you were asked: "${ask}"\n  → you answered ${answerAt}: "${answer}"`;
// Carried verbatim from the block this replaces: the framing states the precedence
// deterministically, because conflict arbitration is the engine's job, not the model's.
const MSG_HEAD =
  'Older messages retrieved by meaning (ordered oldest → newest; when they conflict, the ' +
  'NEWEST line supersedes the older ones):';
const VAULT_HEAD = 'From your long-term vault (retrieved by meaning):';
/** T17: an obligation-shaped memory that resolves to NO commitment record. Not dead — the
 *  spine simply has nothing to say about it, and "nothing" is not "still owed". The marker
 *  says exactly that and names the check, so the model neither drops it nor repeats it. */
export const UNRESOLVED_OBLIGATION_MARK =
  '[no live commitment matches this on the work board — verify before repeating as owed]';

// ── HARNESS-LEARNINGS HL5 — THE SNAPSHOT, AND WHY IT SITS OUTSIDE THE FRAME ──────────────
//
// Everything above this line is retrieval: material fetched by meaning, framed as "context
// only, not live conversation" because that is what it is. The snapshot is the opposite —
// it is CURRENT STATE, read from the spine at assembly time — and putting it inside a frame
// whose own header says "context only" would undercut the one claim it exists to make. So it
// is emitted as its own block, outside the `END RELEVANT MEMORY` frame.
//
// T69b MOVED IT FROM LAST TO FIRST, and it is now its OWN MESSAGE rather than a second half
// of the recall message. The position sentence that stood here ("the last thing in the lane
// because that is the recency-salient position") was written against the retrieved half only
// and was costing a full re-bill of this block on every ask; `toLaneRender` below carries the
// measurement and the re-decision.
//
// The three parts are dsh's (`deepseek-harness-findings.md` P2.3, from their shipped
// strings): (i) a COMPLETE replacement, (ii) an explicit statement that earlier versions no
// longer apply, (iii) a negative instruction naming the failure mode. The failure mode here
// is not hypothetical — it is the exact vocabulary five recorded replies used ("still
// parked", "waiting on Bob's address", "pending", "outstanding", "on deck"), so the negative
// instruction names those words.
//
// ── T69b: THE HEADER STAMP IS GONE, AND ITS ROW AGES WITH IT ────────────────────────────
// HL5 ruled "the stamp is an INSTANT, not a clock", and T67b then keyed that instant to the
// board's last change so an identical board stopped ticking once a minute. Both were right
// and neither was enough, because of a fact only the dev box could show (`7c95ab5`, four
// consecutive quiet turns): SERVING A TURN OPENS AN ASK ROW, that row is open while the turn
// is assembled, and it is counted by this very block — so ANY definition of "when the board
// last changed" lands on the current turn. Measured: across three consecutive judged pairs
// the ONLY byte that differed in the whole 995-char block was the `as of` MINUTE, and it put
// 995 chars back into the re-billed region on every single turn.
//
// So the stamp is removed rather than re-keyed, and the row ages become RECORDED INSTANTS
// like every other time term T69b touched. What remains is a pure function of what the block
// PRINTS — the open commitments and the four board counts — which is the property the whole
// task is about: this block is byte-identical until what it says changes.
//
// NOTHING IS LOST. The snapshot's authority was never in the stamp; it is in the completeness
// claim and the superseding sentence, both untouched. The block is rebuilt on every assembly,
// so there is no version of it that could be stale, and `msg.current-time` is the LAST message
// in the tail with the legend that reads these stamps ("subtract from the current time"). The
// six words the stamp cost bought a date the model had no use for and a cache break it did.
export const SNAPSHOT_HEAD = '═══ OPEN COMMITMENTS — COMPLETE SNAPSHOT ═══';
export const SNAPSHOT_TAIL = '═══ END OPEN COMMITMENTS ═══';

const SNAPSHOT_SUPERSEDES =
  'This snapshot supersedes every earlier mention of what you owe — in summaries, in '
  + 'recalled memory, and earlier in this conversation.';

/** The empty set gets its own sentence, said out loud. dsh publish "none … no longer apply"
 *  rather than publishing nothing, and publishing nothing is exactly what the dojo did for
 *  four recorded runs while the model went on reciting the dead lines. */
export const SNAPSHOT_EMPTY_BODY =
  `${SNAPSHOT_SUPERSEDES} The work board holds NO open commitments for you: every commitment `
  + 'it ever recorded is closed. Nothing is owed. If an earlier line still reads as parked, '
  + 'pending, outstanding or waiting on someone, that line is history and no longer applies '
  + '— do not report it as current.';

const snapshotOpenBody = (total: number): string =>
  `${SNAPSHOT_SUPERSEDES} The work board holds ${total} open commitment${total === 1 ? '' : 's'} `
  + 'for you, listed below, and that is the whole of what is owed. Anything not listed here is '
  + 'not owed — do not report it as outstanding, parked, pending or waiting.';

// ── UX-REPAIR ROUND 11 T44 — THE LINE THAT STATES THE REST OF THE BOARD ─────────────────
//
// Round-11 S4: "One thing's still on my plate", written over a board holding ten non-terminal
// rows (six blocked asks, four tracker rows) by a turn that had made no board-wide read. The
// count was not a lie the model told itself — nothing in its context stated one. The snapshot
// above is commitments-only by charter, and `engine.open-work` is conversation-scoped, capped
// at 600 chars, ageing-filtered and excludes `claimed`, so it cannot carry a whole-board
// claim either (HL6's own migration argument, one noun over).
//
// This is the same charter — COMPLETE set-rendering of owed state — extended by one line, and
// the design is entirely in what it does NOT do: it publishes COUNTS, never rows. Counts are
// O(1) bytes, so this line needs no cap, no ageing horizon and no truncation rung; and a
// count cannot be misread as a rival enumeration of the rows `engine.open-work` shows,
// because it names itself the complete number and sends the model to the list door for the
// rows. Two surfaces, two jobs, one of them saying which it is.
//
// THE DOOR IS NAMED WITHOUT BEING OVER-CLAIMED. `work_update(action="list")` lists the
// tracker's tasks and projects — it has never listed asks, and HL6 §2 is the finding that it
// says nothing about commitments either. A line that sent the model there "for the rows" and
// let it believe the asks were in that list would be the same defect this task closes,
// pointed at a tool result instead of a reply, so the sentence states the door's scope.
export const snapshotBoardLine = (b: BoardCounts): string =>
  `Beyond commitments, your work board holds ${b.asks} open ask${b.asks === 1 ? '' : 's'} `
  + `(${b.asksBlocked} blocked) and ${b.tracker} open tracker `
  + `item${b.tracker === 1 ? '' : 's'} — tasks and projects — of which `
  + `${b.trackerBlocked} ${b.trackerBlocked === 1 ? 'is' : 'are'} blocked. Those two counts are `
  + 'complete: they are the whole board, not a sample, so do not state a different number for '
  + 'what you have open. For the rows themselves call work_update(action="list"), which lists '
  + 'the tracker items — not the asks, and not the commitments above.';

// T69b: no stamp to compute — the header IS the header. See SNAPSHOT_HEAD's note.
function renderSnapshot(s: { total: number; rows: string[]; board: BoardCounts }): string {
  const head = SNAPSHOT_HEAD;
  const board = snapshotBoardLine(s.board);
  if (s.total === 0) return `${head}\n${SNAPSHOT_EMPTY_BODY}\n${board}\n${SNAPSHOT_TAIL}`;
  const shown = s.rows.map((r, i) => `${i + 1}. ${r}`);
  const hidden = s.total - s.rows.length;
  // An elision is never silent: the count above is still the truth, and the line says which
  // part of it is on the page. The same rule `buildOpenWorkInjection` learned in SWEEP-A TB4.
  const tail = hidden > 0
    ? `\n… and ${hidden} more open commitment${hidden === 1 ? '' : 's'} not listed `
      + `(the ${s.rows.length} newest are shown; the count above is the whole set)`
    : '';
  return `${head}\n${snapshotOpenBody(s.total)}\n${board}\n${shown.join('\n')}${tail}\n${SNAPSHOT_TAIL}`;
}

/** The RETRIEVED half: everything fetched by meaning against THIS TURN'S ask. */
export function renderRecalledBlock(p: RecallLanePayload): string | null {
  const parts: string[] = [];
  if (p.pairs.length > 0) {
    parts.push(PAIRS_HEAD + p.pairs.map((x) => PAIR_ROW(x.askAt, x.ask, x.answerAt, x.answer)).join(''));
  }
  if (p.msgLines.length > 0) parts.push(`${MSG_HEAD}\n${p.msgLines.join('\n')}`);
  if (p.vaultLines.length > 0) parts.push(`${VAULT_HEAD}\n${p.vaultLines.join('\n')}`);
  if (p.bridgeLines.length > 0) parts.push(`${UNFILED_ARCHIVE_LABEL}\n${p.bridgeLines.join('\n')}`);
  return parts.length > 0
    ? `${HEAD}\n${parts.join('\n\n')}${p.cut ? LANE_TRUNCATION_MARKER : ''}\n${TAIL}`
    : null;
}

/** The STATE half: the HL5 snapshot, a pure function of the work board. */
export function renderCommitmentsBlock(p: RecallLanePayload): string | null {
  return p.snapshot ? renderSnapshot(p.snapshot) : null;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// T69b — TWO MESSAGES, SNAPSHOT FIRST. THE ONE CHANGE THAT MOVES THE MOST BYTES.
//
// ── THE MEASUREMENT (dev box, `2557747`, three consecutive quiet turns, full receipts) ──
// This lane emitted ONE message of ~3,900 chars carrying two things with completely
// different sources:
//
//   the RETRIEVED half   — answered pairs, recalled rows, vault hits, the FN-1 bridge.
//                          Retrieved against the LIVE ASK, so it changes on every turn
//                          BY DESIGN (roadmap #10; it is why this lane rides the tail).
//   the STATE half (HL5) — OPEN COMMITMENTS, ~1,400 chars of it, read from the work board
//                          and stamped with the board's own last-change instant.
//
// They were joined with `'\\n\\n'` and the STATE half was SECOND, so on every single turn the
// per-ask half changed and re-billed the whole snapshot behind it. A provider's prefix cache
// breaks at the first differing token and never recovers, so the ORDER inside the string was
// the whole cost: 1,400 chars of board state, re-processed on every ask, forever.
//
// Emitting them as TWO messages with the STATE half FIRST puts the tail's own ordering rule
// — most-stable-first — inside the lane that was breaking it. The snapshot now sits in front
// of the divergence instead of behind it, and it stays cached until the BOARD moves.
//
// ── WHY THIS AND NOT A NEW LANE, ARGUED RATHER THAN ASSUMED ─────────────────────────────
// A separate `MessageSlot` + registry entry + reserve would say the same thing and cost a
// renumbering, a reserve re-derivation and a golden. It would buy nothing the provider can
// see: prompt caching matches a TOKEN PREFIX, not a message boundary, so what pays is the
// snapshot being EARLIER — which two messages in the right order already achieve. The two
// halves keep ONE reserve because they always had one and the derivation
// (`recallLaneWorstCaseTokens`) still feeds both through the real renderer; and they get
// DISTINCT lane tags at the injection site (`engine.open-commitments` / `msg.relevant-memory`)
// so the receipt and the cross-turn gate can judge them separately, which is the only thing
// a split slot would have added.
//
// ── HL5's OWN POSITION ARGUMENT, RE-DECIDED IN THE OPEN ─────────────────────────────────
// The snapshot's note says it is last in the lane "because that is the recency-salient
// position". That argument was made against the RETRIEVED half only, and it is now paid for
// in cache on every turn. It is overturned here, narrowly: the snapshot moves ahead of a
// block whose own header calls itself "context only, not live conversation", and it is still
// inside the volatile tail, still after the entire conversation, and still ahead of only
// ~2,500 chars. The two things the salience argument actually protects it from — an EARLIER
// mention of what is owed, and a rival enumeration — are both still behind it or suppressed
// (`renderRecallLane` drops obligation-shaped vault hits while the snapshot publishes).
// ════════════════════════════════════════════════════════════════════════════════════════
function toLaneRender(p: RecallLanePayload): LaneRender<RecallLanePayload> | null {
  const commitments = renderCommitmentsBlock(p);
  const recalled = renderRecalledBlock(p);
  const messages = [commitments, recalled]
    .filter((c): c is string => c !== null)
    .map((content) => ({ role: 'user' as const, content }));
  if (messages.length === 0) return null;
  return { messages, tokens: renderTokens(messages), payload: p };
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** SQLite row shape for a recalled raw message. */
interface RecallRow { id: string; role: string; content: string; created_at: string; agent_id: string }

/**
 * Build the lane from hits that have already been retrieved.
 *
 * Selection stays similarity-ranked (best hits win the budget); PRESENTATION is chronological
 * for the raw lines, because similarity ordering once put a stale statement of a
 * since-corrected fact FIRST and the weakest floor model echoed it (observed live: an old
 * membership code recited over the corrected one told minutes before).
 */
export function renderRecallLane(ctx: RecallLaneContext): LaneRender<RecallLanePayload> | null {
  const db = getDb();
  const ids = ctx.msgHits.map((h) => h.sourceId).filter((id) => !ctx.excludeIds.has(id));
  // THE COMPLETION-TRUTH KEY, asked of its owner. Both halves of a pair are agent-bound by the
  // reader, so this cannot reach another agent's answer.
  const pairs = ids.length > 0 ? answeredPairsForMessages(ctx.agentId, ids) : new Map<string, AnsweredPair>();

  const seenPairs = new Set<string>();
  const pairRows: RecallLanePayload['pairs'] = [];
  const msgCandidates: Array<{ at: string; line: string }> = [];

  for (const id of ids) {
    const pair = pairs.get(id);
    if (pair) {
      // Deduped on the ANSWER id, so a pair whose two halves both won the search renders once.
      if (seenPairs.has(pair.answerId)) continue;
      // The within-conversation ledger already names this ask; do not say it twice.
      if (ctx.alreadyAnsweredAskIds.has(pair.askId)) continue;
      if (ctx.excludeIds.has(pair.askId) || ctx.excludeIds.has(pair.answerId)) continue;
      if (isSyntheticRow(pair.askContent)) continue;
      seenPairs.add(pair.answerId);
      if (pairRows.length >= pairCap()) continue;
      pairRows.push({
        ask: oneLine(pair.askContent).slice(0, askChars()),
        answer: oneLine(pair.answerContent).slice(0, answerChars()),
        askAt: recordedInstant(pair.askAt),
        answerAt: recordedInstant(pair.answerAt),
        answerAtMs: pair.answerAt,
      });
      continue;
    }
    if (msgCandidates.length >= msgRowCap()) continue;
    const row = db.prepare(
      `SELECT id, agent_id, role, content, datetime(created_at/1000,'unixepoch') AS created_at
         FROM messages WHERE id = ?`,
    ).get(id) as RecallRow | undefined;
    if (!row || typeof row.content !== 'string') continue;
    // W3-4 in the same shape the vault lookups already had it: a recalled row that is not this
    // agent's is not this agent's memory.
    if (row.agent_id !== ctx.agentId) continue;
    if (row.content.trim().startsWith('[') && row.content.includes('"type"')) continue; // tool JSON rows
    if (isSyntheticRow(row.content)) continue;
    msgCandidates.push({
      at: row.created_at,
      line: `- [${row.created_at}] ${row.role}: ${oneLine(row.content).slice(0, askChars())}`,
    });
  }
  msgCandidates.sort((a, b) => a.at.localeCompare(b.at));

  // ── HL5: THE SNAPSHOT IS BUILT FIRST, because whether it renders decides whether the
  //    per-hit obligation serving below runs at all. Two answers to "what do I owe" in one
  //    message is the parallel memory T17 exists to prevent, said one noun over.
  //
  // ── T44 FOLLOW-UP: THE GATE IS THE WHOLE BOARD, NOT THE COMMITMENT PAST ALONE ──────────
  // HL5's gate was `hasCommitmentHistory` and its stated job was render cost — one indexed
  // lookup that spares an agent with nothing to publish. Once this block carries the BOARD
  // counts, that gate holds back the case the counts exist for: an agent with open asks and
  // no commitment past published nothing at all, which is round-11 S4's own gap re-created
  // one agent over. The cost argument does not reach the counts — they are O(1) bytes, the
  // same argument the reserve derivation makes — so the gate asks the wider question.
  // For such an agent the commitments half says the true thing rather than being suppressed:
  // it holds NO open commitments, and `SNAPSHOT_EMPTY_BODY` is exactly that sentence.
  //
  // IT IS STILL A GATE, and what it spares is the point: an agent with no commitment past
  // AND nothing open on its board publishes nothing. There is no earlier mention for a
  // snapshot to supersede and no board to count, so the block would be noise — HL5's own
  // judgement, now made over the whole board instead of one kind of row. `board` is read
  // ONCE and serves both the decision and the render; there is no second query.
  const board = openBoardCounts(ctx.agentId);
  const publishesSnapshot = hasCommitmentHistory(ctx.agentId) || board.asks > 0 || board.tracker > 0;
  const snapshot = publishesSnapshot
    ? (() => {
        const rows: LiveCommitment[] = liveCommitments(ctx.agentId);
        return {
          total: rows.length,
          rows: rows.slice(0, snapshotRowCap()).map((r) =>
            `[${r.id}] ${oneLine(r.title || '(no description)').slice(0, snapshotTitleChars())} `
            // T69b: the RECORDED INSTANT, like every other time term in the tail. It was
            // `relativeTimeAgo(..., asOfMs)`, which needed the header stamp as its reference
            // — and the stamp is gone because nothing could key it to this block's content.
            + `(${r.state}, opened ${recordedInstant(r.openedAt)})`),
          // T44: read at the same moment as the commitment set, from the same module and the
          // same `closed_at IS NULL` predicate, so the block cannot state two boards.
          board,
        };
      })()
    : null;

  const vaultLines: string[] = [];
  if (ctx.includeVault) {
    for (const e of ctx.vaultHits) {
      if (vaultLines.length >= vaultRowCap()) break;
      // ── UX-REPAIR ROUND 3 T17 — NO PARALLEL MEMORY OF OBLIGATIONS ──
      // CORE-2 item 4 already resolves a recalled QUESTION against the answer stamp before
      // quoting it. The same rule, one noun over: a recalled PROMISE is resolved against the
      // spine before the model is told it is owed. A dead promise served in the present tense
      // under "From your long-term vault" is the round-3 F3 defect, and this is where it was
      // handed to the model. `not-an-obligation` is every other row and takes the byte-for-byte
      // path it always did; only the four commitment-shaped outcomes are new.
      const verdict = obligationVerdict(e.content);
      if (verdict.kind === 'closed') continue;  // the spine says it is not owed: it is not memory, it is noise
      // ── HARNESS-LEARNINGS HL5 — SET-RENDERING REPLACES PER-HIT RENDERING ──
      // T17 answered "is THIS line still owed?" three ways: drop the closed one, mark the
      // unresolvable one, serve the live one verbatim. Two of those three still put an
      // obligation sentence in front of the model beside a snapshot that has just published
      // the whole truth — a second, older, less complete answer to the question the snapshot
      // just answered. So while the snapshot renders, the obligation-shaped hits are its
      // material and not their own lines. The rendering they lose is not information the
      // model loses: a LIVE one is in the snapshot by construction (same predicate, same
      // module), and an UNRESOLVABLE one is precisely what "anything not listed here is not
      // owed" is for — a stronger statement than the marker it replaces, made once.
      // When there is no snapshot (an agent with no commitment history), every branch below
      // behaves exactly as it did before this task.
      if (snapshot !== null && verdict.kind !== 'not-an-obligation') continue;
      const line = `- [vault:${e.type}] ${oneLine(e.content).slice(0, vaultChars())}`;
      vaultLines.push(verdict.kind === 'unresolvable' ? `${line} ${UNRESOLVED_OBLIGATION_MARK}` : line);
    }
    // ── T69b: DETERMINISTIC PRESENTATION, THE SAME RULE THE RAW LINES ALREADY OBEY ────────
    // `msgCandidates` are sorted (chronologically) two blocks above, for a stated reason: the
    // vector search's own ordering "once put a stale statement of a since-corrected fact FIRST
    // and the weakest floor model echoed it". The vault lines were left in SIMILARITY-RANK
    // order, so the same SET of entries — the common case turn to turn — rendered in a
    // different order whenever the ask nudged the ranking, and the lane's bytes moved with no
    // entry having changed. Measured on the dev box at `2557747`: turn 2 -> 3, three vault
    // lines, one genuinely new, and the other two simply swapped.
    //
    // Sorted on the ENTRY ID rather than on a date: a `vault_entries` row has `created_at` but
    // this render does not read it, and inventing a chronology the block does not carry would
    // be a claim rather than an ordering. The id is stable, total and says nothing.
    vaultLines.sort();
  }

  // ── T69b: OLDEST PAIR FIRST — BY ANSWER TIME, WHICH IS WHAT THE SENTENCE ALWAYS CLAIMED ──
  // This was `pairRows.reverse()`, and the array it reversed was in SIMILARITY-RANK order (the
  // `ids` loop above walks the vector search's own ranking). So the comment said chronological
  // and the code said "least similar first", two different things, and neither the model's
  // recency salience nor byte-stability got what it was promised: the SAME three pairs
  // retrieved with a slightly different ranking — which is what a different ask produces —
  // rendered in a different ORDER, so this lane's bytes moved for a reason that was not a
  // content change. Sorting on `answerAtMs` makes the sentence true and makes the block a pure
  // function of its SET rather than of the ranking that found it. Ties break on the answer's
  // own text so the order is total, never the insertion order of a Map iteration.
  pairRows.sort((a, b) => a.answerAtMs - b.answerAtMs || a.answer.localeCompare(b.answer));
  const render = toLaneRender({
    pairs: pairRows,
    msgLines: msgCandidates.map((c) => c.line),
    vaultLines,
    bridgeLines: ctx.bridgeLines ?? [],
    cut: false,
    snapshot,
  });
  if (!render) return null;
  // The reserve is ENFORCED here, so the declared budget is a bound the array actually obeys
  // rather than a number in a table. `lane.deliveries` is the precedent.
  const max = recallLaneWorstCaseTokens();
  return render.tokens > max ? truncateRecallLane(render, max) : render;
}

/**
 * Shrink to fit, in a declared order: the vault (curated, and re-findable by tool) goes
 * first, then the raw recalled lines, then the quotes inside the conclusions. The
 * CONCLUSIONS are the last thing to go, because they are what this lane exists for — and the
 * lane is never emptied while it holds a row, because a lane that can only be taken whole is
 * a lane that gets dropped whole (`lanes.ts`, the truncate contract).
 */
export const truncateRecallLane: Lane<RecallLaneContext, RecallLanePayload>['truncate'] = (
  render, maxTokens,
) => {
  const p = render.payload;
  if (!p || render.tokens <= maxTokens) return render;
  const attempt = (next: RecallLanePayload): LaneRender<RecallLanePayload> | null => {
    const r = toLaneRender(next);
    return r && r.tokens <= maxTokens ? r : null;
  };
  const state: RecallLanePayload = { ...p, cut: true };

  // T67b: the FN-1 bridge goes FIRST. It is a stopgap over raw un-distilled conversation —
  // the least curated material in the lane, and the only part of it the Dreamer will file
  // into real vault entries within hours anyway.
  while (state.bridgeLines.length > 0) {
    state.bridgeLines = state.bridgeLines.slice(0, -1);
    const r = attempt(state);
    if (r) return r;
  }

  while (state.vaultLines.length > 0) {
    state.vaultLines = state.vaultLines.slice(0, -1);
    const r = attempt(state);
    if (r) return r;
  }
  while (state.msgLines.length > 0) {
    state.msgLines = state.msgLines.slice(0, -1);
    const r = attempt(state);
    if (r) return r;
  }
  while (state.pairs.length > 1) {
    // Drop the OLDEST conclusion first; the newest is the one a follow-up is binding to.
    state.pairs = state.pairs.slice(1);
    const r = attempt(state);
    if (r) return r;
  }
  if (state.pairs.length === 1) {
    const floor = quotedFloor();
    const only = state.pairs[0];
    for (const len of [answerChars(), 160, 120, 80, floor]) {
      state.pairs = [{
        ...only,
        ask: only.ask.slice(0, Math.max(floor, len)),
        answer: only.answer.slice(0, Math.max(floor, len)),
      }];
      const r = attempt(state);
      if (r) return r;
    }
  }
  // HL5: THE SNAPSHOT GOES LAST, and its rows go before its sentence. Everything above is
  // recalled material — useful, and re-findable by tool. The snapshot is the current truth
  // about what is owed, and the whole point of it is that it is COMPLETE, so it gives way
  // only when nothing else is left. Rows drop oldest-first (the list is newest-first) and
  // the render's own elision line then states how many are missing, which keeps the count
  // sentence true at every size. The preamble itself is never dropped while the snapshot
  // exists: the count and the superseding sentence are the load, the rows are the detail.
  while (state.snapshot !== null && state.snapshot.rows.length > 0) {
    state.snapshot = { ...state.snapshot, rows: state.snapshot.rows.slice(0, -1) };
    const r = attempt(state);
    if (r) return r;
  }
  // Nothing left to give. Return whichever is SMALLER — the shrunk render, or the one we were
  // handed. Below a certain size the fixed section frames plus the truncation marker cost more
  // than the quotes they replaced, and a "truncation" that grows the lane is not one. This is
  // the branch the reserve is derived to make unreachable in production (the reserve IS the
  // worst case), so reaching it means a caller passed a maxTokens the lane never agreed to.
  const shrunk = toLaneRender(state);
  return shrunk && shrunk.tokens < render.tokens ? shrunk : render;
};

/**
 * THE WORST CASE THE RENDERER CAN PRODUCE under its own declared caps — the derivation behind
 * the declared reserve. Not a guess beside the code: this calls the code.
 *
 * Computed lazily and memoised, because `laneLimit` throws on an undeclared key and a
 * module-load-time constant would make that throw a startup crash rather than a test failure.
 */
let worstCase: number | null = null;
export function recallLaneWorstCaseTokens(): number {
  if (worstCase !== null) return worstCase;
  // T69b: the widest stamp `recordedInstant` can return, replacing the widest label
  // `relativeTimeAgo` could. en-US `month: 'short'` + 2-digit day + 4-digit year + 2-digit
  // clock + AM/PM is fixed-width apart from the month name, and every short month is 3 chars,
  // so ANY instant produces this width — the derivation stays a pure function.
  const longest = '[Sep 30, 2026, 11:41 PM]';
  const render = toLaneRender({
    pairs: Array.from({ length: pairCap() }, (_unused, i) => ({
      ask: 'x'.repeat(askChars()),
      answer: 'x'.repeat(answerChars()),
      askAt: longest,
      answerAt: longest,
      answerAtMs: i,
    })),
    msgLines: Array.from({ length: msgRowCap() }, () =>
      `- [2026-08-09 12:00:00] assistant: ${'x'.repeat(askChars())}`),
    vaultLines: Array.from({ length: vaultRowCap() }, () =>
      `- [vault:preference] ${'x'.repeat(vaultChars())}`),
    // T67b: the FN-1 bridge at ITS OWN declared cap (`vault/retrieval.ts`'s UNFILED_*), read
    // from the module that owns those caps rather than copied here — the same rule the rest
    // of this derivation follows.
    bridgeLines: unfiledArchiveWorstCaseLines(),
    // `cut: true` so the truncation marker is inside the worst case rather than able to push a
    // truncated render back OVER the reserve that authorised the truncation.
    cut: true,
    // HL5: the snapshot at its cap, with `total` ABOVE the cap so the elision line is inside
    // the worst case too — the render's largest shape, not its commonest one.
    snapshot: {
      total: snapshotRowCap() + 1,
      rows: Array.from({ length: snapshotRowCap() }, () =>
        // T69b: the widest recorded instant, replacing the widest relative age.
        `[cmt:000000000000] ${'x'.repeat(snapshotTitleChars())} (abandoned, opened ${longest})`),
      // T44: the board line has no row cap because it renders no rows — its whole size is the
      // four numbers, so its worst case is the widest number a board could plausibly reach.
      // Five digits is 99,999 open rows on ONE agent; the worn-in dev body's largest per-agent
      // count of any kind is three figures, and the plural branches are all taken here.
      board: { asks: 99_999, asksBlocked: 99_999, tracker: 99_999, trackerBlocked: 99_999 },
    },
  });
  worstCase = render?.tokens ?? 0;
  return worstCase;
}

/** The lane, in the shape `lanes.ts` declares for every lane. `maxTokens` is a getter because
 *  the worst case is derived by CALLING the renderer, and `laneLimit` throws on an undeclared
 *  key — a module-load-time constant would turn a missing declaration into a boot crash. */
export const RECALL_LANE: Lane<RecallLaneContext, RecallLanePayload> = {
  id: RECALL_LANE_ID,
  slot: MessageSlot.RecalledMemory,
  // The post-budget sentinel the assembler records for a lane RESERVED off the top rather
  // than ranked by the fit.
  priority: Number.MAX_SAFE_INTEGER,
  minTokens: 0,
  get maxTokens() { return recallLaneWorstCaseTokens(); },
  render: renderRecallLane,
  truncate: truncateRecallLane,
};

// ════════════════════════════════════════════════════════════════════════════════════════
// Retrieval + render in one call: what the assembler asks for and the loop injects.
// ════════════════════════════════════════════════════════════════════════════════════════

const RELEVANT_MEMORY_CACHE_MS = 60_000;

/**
 * T69b: the lane's two halves, returned separately so the LOOP can put the STATE half ahead
 * of the per-ask half in the tail (see `toLaneRender`'s note). One retrieval, one render, two
 * messages — never two reads.
 */
export interface RecallLaneBlocks {
  /** HL5's OPEN COMMITMENTS snapshot: a pure function of the work board. Injected FIRST. */
  commitments: string | null;
  /** Everything retrieved by meaning against this turn's ask. Injected SECOND. */
  recall: string | null;
}

const EMPTY_BLOCKS: RecallLaneBlocks = { commitments: null, recall: null };

// Derived-data cache only (loss = recompute); keyed by (agent, includeVault), validated by
// query text, so N tool iterations of one turn run vector search (and one query embed) at
// most once.
const recallCache = new Map<string, { at: number; queryText: string; blocks: RecallLaneBlocks }>();

// D4: warn at most once per outage window when the query embedding is unavailable and we
// degrade to FTS, so a chronic embed outage is visible without spamming every turn.
let lastEmbedDegradeWarnAt = 0;

// D4: FTS degrade for message recall when the query embedding is unavailable.
function ftsMessageHits(query: string, agentId: string, limit: number): RecallHit[] {
  try {
    const db = getDb();
    const safe = query.replace(/["']/g, ' ').split(/\s+/).filter((w) => w.length > 2)
      .slice(0, laneLimit(RECALL_LANE_ID, 'chars', 'queryWords')).join(' ');
    if (!safe) return [];
    const rows = db.prepare(
      `SELECT m.id FROM messages_fts fts JOIN messages m ON m.rowid = fts.rowid
        WHERE messages_fts MATCH ? AND m.agent_id = ? ORDER BY rank LIMIT ?`,
    ).all(safe, agentId, limit) as Array<{ id: string }>;
    return rows.map((r) => ({ sourceId: r.id }));
  } catch {
    return [];
  }
}

export async function buildRecallLaneMessage(
  agentId: string,
  includeVault: boolean,
  policy: ReturnType<typeof contextWindowPolicy>,
  conversationId: string | null,
): Promise<RecallLaneBlocks> {
  const queryText = buildPerTurnRecallQuery(agentId);
  // ⚠ T69b, STATED BECAUSE IT IS A REAL BOUND AND IT PRE-DATES THIS TASK: with no usable
  // query there is no retrieval AND no snapshot, because the snapshot has always been built
  // inside this lane. That is unchanged here — the split is about ORDER in the tail, not
  // about giving the snapshot a second door — but it is why the block is `null` on a turn
  // whose newest row is ten characters or fewer.
  if (queryText.trim().length <= 10) return EMPTY_BLOCKS;

  const cacheKey = `${agentId}::${includeVault ? 'v' : 'm'}::${conversationId ?? '-'}`;
  const cached = recallCache.get(cacheKey);
  if (cached && cached.queryText === queryText && Date.now() - cached.at < RELEVANT_MEMORY_CACHE_MS) {
    return cached.blocks;
  }

  // D4 step 2: embed the recall query ONCE; share it across the message + vault lanes so a
  // single turn embeds at most once. On failure, degrade to FTS/LIKE so recall still returns
  // something.
  let queryEmbedding: Float32Array | null = null;
  try {
    const { generateEmbedding } = await import('./embeddings.js');
    queryEmbedding = await generateEmbedding(queryText);
  } catch (err) {
    if (Date.now() - lastEmbedDegradeWarnAt > 300_000) {
      lastEmbedDegradeWarnAt = Date.now();
      logger.warn('per-turn recall: query embed unavailable, degrading to FTS', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  let blocks: RecallLaneBlocks = EMPTY_BLOCKS;
  try {
    // The fresh tail already includes these; this lane is only for what fell out.
    // `getRecentMessages` is session-aware, so a fact taught just before a reset stays
    // ELIGIBLE (it is outside the new session's tail) — which is the whole cross-session half.
    //
    // REQUIREMENT B6, THE RECONCILE. This read was a literal copy of `getFreshTailCount`'s
    // 200K-window answer, so on a 32K model 40 rows were excluded from recall that were NOT in
    // the tail: unreachable by either path. One number, one owner (`memory/budget.ts`).
    const excludeIds = new Set(getRecentMessages(agentId, policy.freshTailCount).map((m) => m.id));

    let msgHits: RecallHit[];
    if (queryEmbedding) {
      const { vectorSearch } = await import('./vector-search.js');
      msgHits = await vectorSearch(queryText, agentId, {
        sourceType: 'message',
        limit: laneLimit(RECALL_LANE_ID, 'retrieval', 'messageLimit'),
        minSimilarity: laneLimit(RECALL_LANE_ID, 'retrieval', 'messageMinSimilarity'),
        queryEmbedding,
      });
    } else {
      msgHits = ftsMessageHits(queryText, agentId, laneLimit(RECALL_LANE_ID, 'retrieval', 'ftsLimit'));
    }

    const vaultHits: RecallVaultHit[] = [];
    if (includeVault) {
      // W3-4: all lookups scoped to THIS agent's vault. Unscoped, every agent's assembled
      // context could recall other agents' private entries. FA-V6: personalOnly so this
      // auto-recall path matches its own listEntries fallback and exact mode's contract —
      // squad-namespaced entries stay out of PERSONAL recall (D-A, squad namespaces opt-in).
      const { semanticSearch, getPinnedEntries, listEntries } = await import('../vault/store.js');
      const pinnedIds = new Set(getPinnedEntries(agentId).map((e) => e.id));
      const hits = queryEmbedding
        ? await semanticSearch(queryText, {
            limit: laneLimit(RECALL_LANE_ID, 'retrieval', 'vaultLimit'),
            minSimilarity: laneLimit(RECALL_LANE_ID, 'retrieval', 'vaultMinSimilarity'),
            queryEmbedding, agentId, personalOnly: true,
          })
        : listEntries({
            search: queryText,
            limit: laneLimit(RECALL_LANE_ID, 'retrieval', 'vaultEntryLimit'),
            agentId, includeOwnerScope: true,
          });
      for (const e of hits) {
        // Dedupe against pinned entries, which are always injected.
        if (!pinnedIds.has(e.id)) vaultHits.push({ id: e.id, type: e.type, content: e.content });
      }
    }

    const alreadyAnsweredAskIds = new Set(
      conversationId
        ? recentlyAnsweredAsks(agentId, conversationId, RECENTLY_ANSWERED_LIMIT).map((a) => a.askId)
        : [],
    );

    // T67b: the FN-1 unfiled-archive bridge, run HERE now. It searches the agent's newest
    // still-unfiled conversation archives BY THE QUERY, which is why it could not stay inside
    // `retrieveForContext` at `MessageSlot.VaultPull = 200`. Same caps, same label, same
    // deterministic matcher — only the position changed, and it changed to the one every
    // per-ask retrieval in this codebase already occupies.
    let bridgeLines: string[] = [];
    if (includeVault) {
      try {
        const { unfiledArchiveBridgeLines } = await import('../vault/retrieval.js');
        bridgeLines = unfiledArchiveBridgeLines(agentId, queryText);
      } catch { /* best effort: a failed bridge costs the bridge, never the lane */ }
    }

    const render = renderRecallLane({
      agentId, includeVault, excludeIds, msgHits, vaultHits, alreadyAnsweredAskIds, bridgeLines,
    });
    // Read off the PAYLOAD the fitted render carries, not off `messages[0]` by position: after
    // `truncate` has run the array may hold one message or two, and which one it is depends on
    // which half survived. The payload is the render's own record of what it decided.
    blocks = render
      ? { commitments: renderCommitmentsBlock(render.payload!), recall: renderRecalledBlock(render.payload!) }
      : EMPTY_BLOCKS;
  } catch (err) {
    logger.debug('recall lane retrieval failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  recallCache.set(cacheKey, { at: Date.now(), queryText, blocks });
  return blocks;
}

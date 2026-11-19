// The recall lane: per-message semantic recall plus the answered conclusions it carries. It rides the volatile
// tail (MessageSlot.RecalledMemory) because its content is re-derived from the live ask every turn; the
// assembler reads it and the loop appends the rendered block. Both halves of a pair are bound to agent_id.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
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
import { PRE_RESET_PAIR_TAG, sessionBoundaryMs } from './session-boundary.js';
import { recalledRowLabel } from './party-label.js';
import { ftsSafeQuery } from './fts-query.js';
import {
  obligationVerdict, liveCommitments, hasCommitmentHistory, openBoardCounts,
  type LiveCommitment, type BoardCounts,
} from '../work/obligation-memory.js';
import { UNFILED_ARCHIVE_LABEL, unfiledArchiveWorstCaseLines } from '../vault/retrieval.js';
import { formatCitationSuffix } from '../vault/store.js';
import { parseDivider, NEW_SESSION_DIVIDER_LABEL } from '@dojo/shared';
import { turnBoundary } from '../agent/turn-state.js';

const logger = createLogger('recall-lane');

export const RECALL_LANE_ID = 'lane.relevant-memory';

const pairCap = () => laneLimit(RECALL_LANE_ID, 'rows', 'recallPairs');
const msgRowCap = () => laneLimit(RECALL_LANE_ID, 'rows', 'minTailForRecall');
const vaultRowCap = () => laneLimit(RECALL_LANE_ID, 'rows', 'minTailForVault');
const snapshotRowCap = () => laneLimit(RECALL_LANE_ID, 'rows', 'snapshotCommitments');
const snapshotTitleChars = () => laneLimit(RECALL_LANE_ID, 'chars', 'snapshotTitle');
const askChars = () => laneLimit(RECALL_LANE_ID, 'chars', 'hitPreview');
const answerChars = () => laneLimit(RECALL_LANE_ID, 'chars', 'answerPreview');
const vaultChars = () => laneLimit(RECALL_LANE_ID, 'chars', 'vaultPreview');
const quotedFloor = () => laneLimit(RECALL_LANE_ID, 'chars', 'quotedFloor');


export function isSyntheticRow(content: string): boolean {
  return content.startsWith('[SOURCE:') || content.startsWith('[A2A:')
    || content.startsWith('[Engine') || content.startsWith('[ENGINE')
    || content.startsWith('[System') || content.startsWith('[DOJO:')
    || parseDivider(content)?.label.startsWith(NEW_SESSION_DIVIDER_LABEL) === true;
}

// Strip a leading [..] envelope so the query is the content: "[A2A:QUESTION thread:ab from:PM] go" -> "go".
function stripRecallEnvelope(content: string): string {
  const m = content.match(/^\[[^\]]*\]\s*/);
  return m ? content.slice(m[0].length) : content;
}

// Memoised on turnBoundary: mid-turn tool iterations push the human row out of the window, so recomputing
// would pick a different row each iteration and churn the prompt. No boundary outside a turn, so no memo.
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

// ONE per-turn recall query for summary-relevance and this lane: the newest human user rows, else the newest
// substantive row with its envelope stripped.
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


export interface RecallHit { sourceId: string }
export interface RecallVaultHit { id: string; type: string; content: string; citation?: string | null }

export interface RecallLaneContext {
  agentId: string;
  includeVault: boolean;
  /** Message ids the assembled array already carries - never quoted a second time. */
  excludeIds: Set<string>;
  msgHits: RecallHit[];
  vaultHits: RecallVaultHit[];
  /** Asks engine.recently-answered already names this turn: that block owns them, so this lane skips them. */
  alreadyAnsweredAskIds: Set<string>;
  conversationId?: string | null;   // served conversation: a recalled row from ANOTHER thread gets a party label, one from this thread does not
  bridgeLines?: string[];
}

export interface RecallLanePayload {
  /** Answered pairs, newest LAST. askAt/answerAt are recorded instants; answerAtMs only orders them. */
  pairs: Array<{ ask: string; answer: string; askAt: string; answerAt: string; answerAtMs: number; preReset?: boolean }>;
  msgLines: string[];
  vaultLines: string[];
  /** The entry id of each vault line, in line order; truncation drops lines from the end. */
  vaultIds: string[];
  /**
   * Newest still-unfiled conversation archive snippets: keeps a fact told before a session reset recallable until
   * the Dreamer files it. Searched by the query, so it lives in this per-ask lane (caps: vault/retrieval.ts).
   */
  bridgeLines: string[];
  cut: boolean;
  /**
   * The COMPLETE live-commitment snapshot, or null when there is no commitment history and nothing open. `total`
   * is the whole set even when `rows` is capped (keeps "anything not listed is not owed" checkable).
   */
  snapshot: { total: number; rows: string[]; board: BoardCounts } | null;
}

const HEAD = '═══ RELEVANT MEMORY (retrieved by meaning, context only, not live conversation) ═══';
const TAIL = '═══ END RELEVANT MEMORY ═══';
const PAIRS_HEAD =
  'Questions you have ALREADY ANSWERED (engine record, read from the answer stamps — the ' +
  'question was asked and you answered it. Do NOT re-run the work: restate what you ' +
  'concluded, or point at the earlier answer):';
const PAIR_ROW = (askAt: string, ask: string, answerAt: string, answer: string, preReset = false) =>
  `\n- ${askAt} you were asked: "${ask}"\n  → you answered ${answerAt}: "${answer}"${preReset ? PRE_RESET_PAIR_TAG : ''}`;
const MSG_HEAD =
  'Older messages retrieved by meaning (ordered oldest → newest; when they conflict, the ' +
  'NEWEST line supersedes the older ones):';
const VAULT_HEAD = 'From your long-term vault (retrieved by meaning):';
/** An obligation-shaped memory with NO matching commitment record: "nothing" is not "still owed". */
export const UNRESOLVED_OBLIGATION_MARK =
  '[no live commitment matches this on the work board — verify before repeating as owed]';

// The snapshot is CURRENT STATE, so it is its own block outside the END RELEVANT MEMORY frame ("context only").
// It carries no as-of stamp: serving a turn opens an ask row it counts, so a stamp would change every turn and
// the block must stay byte-identical until its content changes.
export const SNAPSHOT_HEAD = '═══ OPEN COMMITMENTS — COMPLETE SNAPSHOT ═══';
export const SNAPSHOT_TAIL = '═══ END OPEN COMMITMENTS ═══';

const SNAPSHOT_SUPERSEDES =
  'This snapshot supersedes every earlier mention of what you owe — in summaries, in '
  + 'recalled memory, and earlier in this conversation.';

export const SNAPSHOT_EMPTY_BODY =
  `${SNAPSHOT_SUPERSEDES} The work board holds NO open commitments for you: every commitment `
  + 'it ever recorded is closed. Nothing is owed. If an earlier line still reads as parked, '
  + 'pending, outstanding or waiting on someone, that line is history and no longer applies '
  + '— do not report it as current.';

const snapshotOpenBody = (total: number): string =>
  `${SNAPSHOT_SUPERSEDES} The work board holds ${total} open commitment${total === 1 ? '' : 's'} `
  + 'for you, listed below, and that is the whole of what is owed. Anything not listed here is '
  + 'not owed — do not report it as outstanding, parked, pending or waiting.';

// States the REST of the board as four counts, never rows (O(1) bytes, so no cap needed).
// work_update(action="list") lists tracker items only, not asks or commitments, and the sentence says so.
export const snapshotBoardLine = (b: BoardCounts): string =>
  `Beyond commitments, your work board holds ${b.asks} open ask${b.asks === 1 ? '' : 's'} `
  + `(${b.asksBlocked} blocked) and ${b.tracker} open tracker `
  + `item${b.tracker === 1 ? '' : 's'} — tasks and projects — of which `
  + `${b.trackerBlocked} ${b.trackerBlocked === 1 ? 'is' : 'are'} blocked. Those two counts are `
  + 'complete: they are the whole board, not a sample, so do not state a different number for '
  + 'what you have open. For the rows themselves call work_update(action="list"), which lists '
  + 'the tracker items — not the asks, and not the commitments above.';

function renderSnapshot(s: { total: number; rows: string[]; board: BoardCounts }): string {
  const head = SNAPSHOT_HEAD;
  const board = snapshotBoardLine(s.board);
  if (s.total === 0) return `${head}\n${SNAPSHOT_EMPTY_BODY}\n${board}\n${SNAPSHOT_TAIL}`;
  const shown = s.rows.map((r, i) => `${i + 1}. ${r}`);
  const hidden = s.total - s.rows.length;
  const tail = hidden > 0
    ? `\n… and ${hidden} more open commitment${hidden === 1 ? '' : 's'} not listed `
      + `(the ${s.rows.length} newest are shown; the count above is the whole set)`
    : '';
  return `${head}\n${snapshotOpenBody(s.total)}\n${board}\n${shown.join('\n')}${tail}\n${SNAPSHOT_TAIL}`;
}

export function renderRecalledBlock(p: RecallLanePayload): string | null {
  const parts: string[] = [];
  if (p.pairs.length > 0) {
    parts.push(PAIRS_HEAD + p.pairs.map((x) => PAIR_ROW(x.askAt, x.ask, x.answerAt, x.answer, x.preReset)).join(''));
  }
  if (p.msgLines.length > 0) parts.push(`${MSG_HEAD}\n${p.msgLines.join('\n')}`);
  if (p.vaultLines.length > 0) parts.push(`${VAULT_HEAD}\n${p.vaultLines.join('\n')}`);
  if (p.bridgeLines.length > 0) parts.push(`${UNFILED_ARCHIVE_LABEL}\n${p.bridgeLines.join('\n')}`);
  return parts.length > 0
    ? `${HEAD}\n${parts.join('\n\n')}${p.cut ? LANE_TRUNCATION_MARKER : ''}\n${TAIL}`
    : null;
}

export function renderCommitmentsBlock(p: RecallLanePayload): string | null {
  return p.snapshot ? renderSnapshot(p.snapshot) : null;
}

// Two messages, snapshot first: the retrieved half changes with every ask but the snapshot only with the board,
// and a prefix cache breaks at the first differing token. Both share one reserve (recallLaneWorstCaseTokens);
// distinct lane tags (engine.open-commitments, msg.relevant-memory) let the receipt judge them separately.
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

interface RecallRow { id: string; role: string; content: string; created_at: string; agent_id: string; conversation_id: string | null }

/** Build the lane from hits already retrieved. Selection is similarity-ranked; raw lines are shown in
 *  chronological order so a stale statement of a since-corrected fact is never shown first. */
export function renderRecallLane(ctx: RecallLaneContext): LaneRender<RecallLanePayload> | null {
  const db = getDb();
  const ids = ctx.msgHits.map((h) => h.sourceId).filter((id) => !ctx.excludeIds.has(id));
  const pairs = ids.length > 0 ? answeredPairsForMessages(ctx.agentId, ids) : new Map<string, AnsweredPair>();
  const boundaryMs = sessionBoundaryMs(ctx.agentId);  // read once here, so the renderer stays a pure function of the payload

  const seenPairs = new Set<string>();
  const pairRows: RecallLanePayload['pairs'] = [];
  const msgCandidates: Array<{ at: string; line: string }> = [];

  for (const id of ids) {
    const pair = pairs.get(id);
    if (pair) {
      if (seenPairs.has(pair.answerId)) continue;
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
        ...(boundaryMs !== null && pair.askAt < boundaryMs ? { preReset: true } : {}),  // the ASK's instant decides: it is what the imperative is about
      });
      continue;
    }
    if (msgCandidates.length >= msgRowCap()) continue;
    const row = db.prepare(
      `SELECT id, agent_id, role, content, conversation_id, datetime(created_at/1000,'unixepoch') AS created_at
         FROM messages WHERE id = ?`,
    ).get(id) as RecallRow | undefined;
    if (!row || typeof row.content !== 'string') continue;
    if (row.agent_id !== ctx.agentId) continue;
    if (row.content.trim().startsWith('[') && row.content.includes('"type"')) continue; // tool JSON rows
    if (isSyntheticRow(row.content)) continue;
    const party = recalledRowLabel(row.conversation_id, ctx.conversationId);  // rule and suppression argument in `party-label.ts`
    msgCandidates.push({
      at: row.created_at,
      line: `- ${recordedInstant(row.created_at)}${party ? ` (${party})` : ''} ${row.role}: ${oneLine(row.content).slice(0, askChars())}`,
    });
  }
  msgCandidates.sort((a, b) => a.at.localeCompare(b.at));

  // The snapshot is built first: whether it renders decides whether per-hit obligation serving runs (two answers
  // to "what do I owe" would be a parallel memory). The gate is the whole board, not only commitment history;
  // `board` is read once for both the decision and the render.
  const board = openBoardCounts(ctx.agentId);
  const publishesSnapshot = hasCommitmentHistory(ctx.agentId) || board.asks > 0 || board.tracker > 0;
  const snapshot = publishesSnapshot
    ? (() => {
        const rows: LiveCommitment[] = liveCommitments(ctx.agentId);
        return {
          total: rows.length,
          rows: rows.slice(0, snapshotRowCap()).map((r) =>
            `[${r.id}] ${oneLine(r.title || '(no description)').slice(0, snapshotTitleChars())} `
            + `(${r.state}, opened ${recordedInstant(r.openedAt)})`),
          // Read with the same predicate as the commitment set (closed_at IS NULL), so the block cannot state two boards.
          board,
        };
      })()
    : null;

  const vault: Array<{ id: string; line: string }> = [];
  if (ctx.includeVault) {
    for (const e of ctx.vaultHits) {
      if (vault.length >= vaultRowCap()) break;
      // A recalled promise is resolved against the work board before it is served as owed; a dead one would be wrong.
      const verdict = obligationVerdict(e.content);
      if (verdict.kind === 'closed') continue;  // the spine says it is not owed: it is not memory, it is noise
      // While the snapshot renders, obligation-shaped hits are its material: a live one is already in it, and
      // "anything not listed is not owed" covers an unresolvable one. With no snapshot, each hit renders as itself.
      if (snapshot !== null && verdict.kind !== 'not-an-obligation') continue;
      // The source leads and shares the preview's room, so the lane's worst case is unchanged.
      const source = formatCitationSuffix(e.citation).trim().replace(/^(\[source: .{80}).+\]$/, '$1…]');
      const line = `- [vault:${e.type}] ${oneLine(`${source} ${e.content}`).slice(0, vaultChars())}`;
      vault.push({ id: e.id, line: verdict.kind === 'unresolvable' ? `${line} ${UNRESOLVED_OBLIGATION_MARK}` : line });
    }
    // Sorted on the line: the same set renders in the same bytes whatever the ranking, with no implied chronology.
    vault.sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  }

  // Oldest first by answer time, ties on the answer text: a pure function of the set, not of the ranking.
  pairRows.sort((a, b) => a.answerAtMs - b.answerAtMs || a.answer.localeCompare(b.answer));
  const render = toLaneRender({
    pairs: pairRows,
    msgLines: msgCandidates.map((c) => c.line),
    vaultLines: vault.map((v) => v.line),
    vaultIds: vault.map((v) => v.id),
    bridgeLines: ctx.bridgeLines ?? [],
    cut: false,
    snapshot,
  });
  if (!render) return null;
  const max = recallLaneWorstCaseTokens();
  return render.tokens > max ? truncateRecallLane(render, max) : render;
}

/**
 * Shrink to fit in a declared order: bridge, vault, raw recalled lines, older conclusions, quote lengths, then
 * snapshot rows. The lane is never emptied while it holds a row, because a lane that can only be taken whole
 * gets dropped whole (`lanes.ts`, the truncate contract).
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

  // The unfiled-archive bridge goes first: it is raw un-distilled conversation, the least curated material in the lane.
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
  // The snapshot goes last, rows before its sentence: it is the current truth about what is owed, so it gives way
  // only when nothing else is left. The elision line keeps the count true; the preamble is never dropped.
  while (state.snapshot !== null && state.snapshot.rows.length > 0) {
    state.snapshot = { ...state.snapshot, rows: state.snapshot.rows.slice(0, -1) };
    const r = attempt(state);
    if (r) return r;
  }
  // Nothing left to give: return the smaller of the shrunk render and the one handed in, since below a certain size
  // the frames plus the truncation marker cost more than the quotes they replace. The reserve is derived to make
  // this unreachable in production; reaching it means a caller passed a maxTokens the lane never agreed to.
  const shrunk = toLaneRender(state);
  return shrunk && shrunk.tokens < render.tokens ? shrunk : render;
};

/** The worst case the renderer can produce under its own declared caps, derived by calling it. Lazy and
 *  memoised: laneLimit throws on an undeclared key, so a load-time constant would be a startup crash. */
let worstCase: number | null = null;
export function recallLaneWorstCaseTokens(): number {
  if (worstCase !== null) return worstCase;
  // The widest stamp recordedInstant returns: its en-US format is fixed-width (every short month is 3 chars),
  // so any instant gives this width and the derivation stays a pure function.
  const longest = recordedInstant('2026-09-30T23:41:59Z');  // the one formatter, fixed width
  const render = toLaneRender({
    pairs: Array.from({ length: pairCap() }, (_unused, i) => ({
      ask: 'x'.repeat(askChars()),
      answer: 'x'.repeat(answerChars()),
      askAt: longest,
      answerAt: longest,
      answerAtMs: i,
    })),
    msgLines: Array.from({ length: msgRowCap() }, () =>
      `- ${longest} assistant: ${'x'.repeat(askChars())}`),
    vaultLines: Array.from({ length: vaultRowCap() }, () =>
      `- [vault:preference] ${'x'.repeat(vaultChars())}`),
    vaultIds: [],
    bridgeLines: unfiledArchiveWorstCaseLines(),
    // The truncation marker is inside the worst case, so a truncated render never exceeds the reserve.
    cut: true,
    snapshot: {
      // Above the cap so the elision line is inside the worst case too.
      total: snapshotRowCap() + 1,
      rows: Array.from({ length: snapshotRowCap() }, () =>
        `[cmt:000000000000] ${'x'.repeat(snapshotTitleChars())} (abandoned, opened ${longest})`),
      // The board line renders no rows, so its size is its four numbers: five digits is the widest count a
      // board could plausibly reach, and every plural branch is taken.
      board: { asks: 99_999, asksBlocked: 99_999, tracker: 99_999, trackerBlocked: 99_999 },
    },
  });
  worstCase = render?.tokens ?? 0;
  return worstCase;
}

const RELEVANT_MEMORY_CACHE_MS = 60_000;

/** The lane's two halves, returned separately so the loop injects commitments ahead of the per-ask half.
 *  One retrieval, one render, two messages. */
export interface RecallLaneBlocks {
  commitments: string | null;
  recall: string | null;
  /** The vault entries the recall half rendered: the turn records them as used. */
  vaultIds: string[];
}

const EMPTY_BLOCKS: RecallLaneBlocks = { commitments: null, recall: null, vaultIds: [] };

// Derived-data cache only (loss = recompute), keyed by (agent, includeVault) and validated by query text, so N
// tool iterations of one turn run the vector search (and one query embed) at most once.
const recallCache = new Map<string, { at: number; queryText: string; blocks: RecallLaneBlocks }>();

// Warn at most once per outage window when the query embed is unavailable and we degrade to FTS.
let lastEmbedDegradeWarnAt = 0;

function ftsMessageHits(query: string, agentId: string, limit: number): RecallHit[] {
  try {
    const db = getDb();
    const safe = ftsSafeQuery(query, laneLimit(RECALL_LANE_ID, 'chars', 'queryWords'));
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
  // With no usable query there is neither retrieval nor snapshot (the snapshot is built inside this lane), so
  // the blocks are empty when the newest row is ten characters or fewer.
  if (queryText.trim().length <= 10) return EMPTY_BLOCKS;

  const cacheKey = `${agentId}::${includeVault ? 'v' : 'm'}::${conversationId ?? '-'}`;
  const cached = recallCache.get(cacheKey);
  if (cached && cached.queryText === queryText && Date.now() - cached.at < RELEVANT_MEMORY_CACHE_MS) {
    return cached.blocks;
  }

  let queryEmbedding: Float32Array | null = null;
  try {
    const { generateEmbedding } = await import('./embeddings.js');
    queryEmbedding = await generateEmbedding(queryText, { agentId });
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
    // The fresh tail already includes these; this lane is only for what fell out. getRecentMessages is session-aware,
    // so a fact taught just before a reset stays eligible. The window is policy.freshTailCount (memory/budget.ts).
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
      // All lookups are scoped to THIS agent's vault (unscoped, every agent's context could recall other agents'
      // private entries); personalOnly keeps squad-namespaced entries out of personal recall.
      const { semanticSearch, listEntriesBounded } = await import('../vault/store.js');
      const { pinnedContextSection } = await import('../vault/retrieval.js');
      const pinnedIds = new Set(pinnedContextSection(agentId).entryIds);
      const hits = queryEmbedding
        ? await semanticSearch(queryText, {
            limit: laneLimit(RECALL_LANE_ID, 'retrieval', 'vaultLimit'),
            minSimilarity: laneLimit(RECALL_LANE_ID, 'retrieval', 'vaultMinSimilarity'),
            queryEmbedding, agentId, personalOnly: true,
          })
        // Embed-outage fallback, run every turn of an outage: listEntriesBounded is listEntries off-thread.
        : await listEntriesBounded({
            search: queryText,
            limit: laneLimit(RECALL_LANE_ID, 'retrieval', 'vaultEntryLimit'),
            agentId, includeOwnerScope: true,
          });
      for (const e of hits) {
        // Skipped only when the pinned block rendered it: a pin past the block's cap is still recallable.
        if (!pinnedIds.has(e.id)) vaultHits.push({ id: e.id, type: e.type, content: e.content, citation: e.citation });
      }
    }

    const alreadyAnsweredAskIds = new Set(
      conversationId
        ? recentlyAnsweredAsks(agentId, conversationId, RECENTLY_ANSWERED_LIMIT).map((a) => a.askId)
        : [],
    );

    // The unfiled-archive bridge searches by the query, so it lives in this per-ask lane, not the cacheable vault prefix.
    let bridgeLines: string[] = [];
    if (includeVault) {
      try {
        const { unfiledArchiveBridgeLines } = await import('../vault/retrieval.js');
        bridgeLines = unfiledArchiveBridgeLines(agentId, queryText);
      } catch { /* best effort: a failed bridge costs the bridge, never the lane */ }
    }

    const render = renderRecallLane({
      agentId, includeVault, excludeIds, msgHits, vaultHits, alreadyAnsweredAskIds, bridgeLines, conversationId,
    });
    // Read off the payload the fitted render carries, not off messages[0]: after truncate the array may hold one
    // message or two, depending on which half survived.
    const p = render?.payload;
    blocks = p
      ? { commitments: renderCommitmentsBlock(p), recall: renderRecalledBlock(p), vaultIds: p.vaultIds.slice(0, p.vaultLines.length) }
      : EMPTY_BLOCKS;
  } catch (err) {
    logger.debug('recall lane retrieval failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  recallCache.set(cacheKey, { at: Date.now(), queryText, blocks });
  return blocks;
}

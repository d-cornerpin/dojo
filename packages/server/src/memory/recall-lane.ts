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
import { estimateTokens, type contextWindowPolicy } from './budget.js';
import {
  LANE_TRUNCATION_MARKER, laneLimit, renderTokens,
  type Lane, type LaneRender,
} from './lanes.js';
import {
  answeredPairsForMessages, recentlyAnsweredAsks, RECENTLY_ANSWERED_LIMIT, type AnsweredPair,
} from '../agent/v2/answered-edge.js';
import { relativeTimeAgo } from '../agent/v2/outbound-ledger.js';
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
}

export interface RecallLanePayload {
  /** Answered pairs: what this agent already concluded, newest LAST. */
  pairs: Array<{ ask: string; answer: string; askAgo: string; answerAgo: string }>;
  /** Raw recalled lines that are not part of a pair, chronological. */
  msgLines: string[];
  vaultLines: string[];
  /** True when a row was dropped or a quote shortened relative to the read. */
  cut: boolean;
}

const HEAD = '═══ RELEVANT MEMORY (retrieved by meaning, context only, not live conversation) ═══';
const TAIL = '═══ END RELEVANT MEMORY ═══';
const PAIRS_HEAD =
  'Questions you have ALREADY ANSWERED (engine record, read from the answer stamps — the ' +
  'question was asked and you answered it. Do NOT re-run the work: restate what you ' +
  'concluded, or point at the earlier answer):';
const PAIR_ROW = (askAgo: string, ask: string, answerAgo: string, answer: string) =>
  `\n- ${askAgo} you were asked: "${ask}"\n  → you answered ${answerAgo}: "${answer}"`;
// Carried verbatim from the block this replaces: the framing states the precedence
// deterministically, because conflict arbitration is the engine's job, not the model's.
const MSG_HEAD =
  'Older messages retrieved by meaning (ordered oldest → newest; when they conflict, the ' +
  'NEWEST line supersedes the older ones):';
const VAULT_HEAD = 'From your long-term vault (retrieved by meaning):';

function renderPayload(p: RecallLanePayload): string | null {
  const parts: string[] = [];
  if (p.pairs.length > 0) {
    parts.push(PAIRS_HEAD + p.pairs.map((x) => PAIR_ROW(x.askAgo, x.ask, x.answerAgo, x.answer)).join(''));
  }
  if (p.msgLines.length > 0) parts.push(`${MSG_HEAD}\n${p.msgLines.join('\n')}`);
  if (p.vaultLines.length > 0) parts.push(`${VAULT_HEAD}\n${p.vaultLines.join('\n')}`);
  if (parts.length === 0) return null;
  return `${HEAD}\n${parts.join('\n\n')}${p.cut ? LANE_TRUNCATION_MARKER : ''}\n${TAIL}`;
}

function toLaneRender(p: RecallLanePayload): LaneRender<RecallLanePayload> | null {
  const content = renderPayload(p);
  if (content === null) return null;
  const messages = [{ role: 'user' as const, content }];
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
        askAgo: relativeTimeAgo(pair.askAt),
        answerAgo: relativeTimeAgo(pair.answerAt),
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

  const vaultLines: string[] = [];
  if (ctx.includeVault) {
    for (const e of ctx.vaultHits) {
      if (vaultLines.length >= vaultRowCap()) break;
      vaultLines.push(`- [vault:${e.type}] ${oneLine(e.content).slice(0, vaultChars())}`);
    }
  }

  // Oldest pair first, so the newest conclusion sits in the recency-salient position.
  pairRows.reverse();
  const render = toLaneRender({
    pairs: pairRows,
    msgLines: msgCandidates.map((c) => c.line),
    vaultLines,
    cut: false,
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
  const longest = '59 minutes ago';
  const render = toLaneRender({
    pairs: Array.from({ length: pairCap() }, () => ({
      ask: 'x'.repeat(askChars()),
      answer: 'x'.repeat(answerChars()),
      askAgo: longest,
      answerAgo: longest,
    })),
    msgLines: Array.from({ length: msgRowCap() }, () =>
      `- [2026-08-09 12:00:00] assistant: ${'x'.repeat(askChars())}`),
    vaultLines: Array.from({ length: vaultRowCap() }, () =>
      `- [vault:preference] ${'x'.repeat(vaultChars())}`),
    // `cut: true` so the truncation marker is inside the worst case rather than able to push a
    // truncated render back OVER the reserve that authorised the truncation.
    cut: true,
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
// Derived-data cache only (loss = recompute); keyed by (agent, includeVault), validated by
// query text, so N tool iterations of one turn run vector search (and one query embed) at
// most once.
const recallCache = new Map<string, { at: number; queryText: string; block: string | null }>();

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
): Promise<string | null> {
  const queryText = buildPerTurnRecallQuery(agentId);
  if (queryText.trim().length <= 10) return null;

  const cacheKey = `${agentId}::${includeVault ? 'v' : 'm'}::${conversationId ?? '-'}`;
  const cached = recallCache.get(cacheKey);
  if (cached && cached.queryText === queryText && Date.now() - cached.at < RELEVANT_MEMORY_CACHE_MS) {
    return cached.block;
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

  let block: string | null = null;
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

    const render = renderRecallLane({
      agentId, includeVault, excludeIds, msgHits, vaultHits, alreadyAnsweredAskIds,
    });
    block = render ? (render.messages[0]?.content as string) : null;
  } catch (err) {
    logger.debug('recall lane retrieval failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  recallCache.set(cacheKey, { at: Date.now(), queryText, block });
  return block;
}

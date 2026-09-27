// ════════════════════════════════════════════════════════════════════════════
// THE SESSION TOOL SET, BOUNDED (W2 — `.superpowers/sdd/BACKLOG-CAMPAIGN/
// caps-design.md` §2; finding from the two-phase-loader audit).
//
// `load_tool_docs` adds a name to a per-agent set and the set only ever GREW: the
// single shrink was a whole-session reset. Every name in it rides in the API tools
// array behind the cache breakpoint, so an unbounded accumulator is unbounded
// per-call payload — and the set is the one lane nothing was watching.
//
// ── THE TWO NUMBERS, AND WHY THEY ARE NOT TASTE ──
// Measured over 372 live `load_tool_docs` calls and the lifetime accumulation of
// the 22 agents that ever called it:
//
//   PER CALL = 12   1.5× the largest array ever observed (8; 98.4% were ≤ 4), so
//                   nothing that has ever happened is refused and a model batching
//                   an unusually wide load still succeeds, while a runaway 50-name
//                   array cannot land.
//   SESSION  = 64   above the widest REAL agent's entire lifetime accumulation
//                   (56) and above the observed post-restart rehydration count
//                   (43), below the harness bot's outlier (74). A genuine working
//                   set is never evicted; an unbounded accumulator is.
//
// ── WHY EVICTION IS LRU-BY-CALL, AND WHERE THE RECENCY COMES FROM ──
// The corpus is a small hot set (three names dominate) against a long tail of 118.
// FIFO would evict the hot set on a long session; LRU keeps it. "Clear at N" would
// drop the whole array back to the always-loaded head mid-session and re-bill the
// ~24.7K-token prefix in one spike — the exact cost profile the two-phase loader
// exists to avoid.
//
// The recency key is READ, NOT INSTRUMENTED. Every tool call is already an
// assistant `tool_use` block in `messages`, which is the same record
// `rehydrateSessionToolsFromHistory` replays; this asks it the one question it can
// answer — "in what order were these names last called?" — and only at the moment
// the ceiling is crossed, which the corpus says is approximately never. No new
// per-call bookkeeping, no hook in the dispatcher, nothing to keep in sync.
//
// ── THE TWO PINS ──
//  1. NEVER EVICT A NAME CALLED IN THE CURRENT TURN. Removing a tool from the array
//     between iterations of a live turn is prefix churn mid-flight, and it would
//     take a tool away from a model that is using it. Enforced as a hard filter,
//     not as an ordering preference: when every candidate is pinned, the set is
//     left OVER the ceiling and nothing is evicted. Over by a few names for one
//     turn is strictly cheaper than a broken prefix, and the next load re-asks.
//  2. NEVER EVICT AN ALWAYS-LOADED NAME. Those are not in this set at all —
//     `getDefaultForAgent` supplies them separately — so this is a no-op assertion
//     that documents the intent rather than a branch that can fire.
//
// Eviction is REPORTED, never silent: the caller appends the names to the tool
// result, because a model that believes a tool is loaded and gets "not found"
// cannot explain it. Same reason the handler already reports `notFound`.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';

/** Per call. Refusal is prose the model reads and can act on. */
export const LOAD_TOOL_DOCS_MAX_PER_CALL = 12;

/** Per session, per agent. Crossing it evicts the least-recently-CALLED names. */
export const SESSION_TOOL_SET_MAX = 64;

/**
 * How many recent assistant rows the recency read walks. Bounded for the same
 * reason the load-sequence replay is bounded: this is a runaway guard, not a
 * window with a meaning of its own. 400 rows covers far more than the longest
 * measured session's tool traffic, and the query runs only when the ceiling is
 * crossed.
 */
const RECENCY_ROW_SCAN = 400;

// agentId -> the names loaded this session, in LOAD order (a JS Set preserves
// insertion order, which is what makes the API tail append-only).
const sessionLoadedTools: Map<string, Set<string>> = new Map();

export function getSessionLoadedTools(agentId: string): Set<string> {
  return sessionLoadedTools.get(agentId) ?? new Set();
}

/** The map half of a session reset. The rehydration flag is the caller's to set. */
export function forgetSessionLoadedTools(agentId: string): void {
  sessionLoadedTools.delete(agentId);
}

/** Test seam: the process boundary for the set itself, made addressable. */
export function resetSessionToolSetsForTests(): void {
  sessionLoadedTools.clear();
}

interface Recency {
  /** name -> position, higher is more recently called. Absent = never called. */
  rank: Map<string, number>;
  /** Names called in the newest turn on record. Pin 1. */
  currentTurn: Set<string>;
}

/**
 * When was each name last CALLED, from the record that already exists. Newest
 * rows first, so the first sighting of a name is its most recent call.
 *
 * Best effort by construction: an unreadable table answers "nothing is ranked",
 * which sends every candidate to the same bucket and leaves load order as the
 * tie-break. A failed read must never break a turn, and it must never be the
 * reason a tool is evicted out of turn.
 */
function calledRecency(agentId: string): Recency {
  const rank = new Map<string, number>();
  const currentTurn = new Set<string>();
  try {
    const rows = getDb().prepare(
      `SELECT content, turn_number FROM messages
        WHERE agent_id = ? AND role = 'assistant' AND content LIKE '%tool_use%'
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(agentId, RECENCY_ROW_SCAN) as Array<{ content: string; turn_number: number | null }>;
    // The newest turn ON RECORD, not "the turn now": a turn whose rows are not
    // written yet has nothing to protect, and taking the max keeps the pin on the
    // safe side (it can over-protect, never under-protect).
    let newestTurn: number | null = null;
    for (const r of rows) {
      if (r.turn_number != null && (newestTurn == null || r.turn_number > newestTurn)) newestTurn = r.turn_number;
    }
    let seq = rows.length;
    for (const r of rows) {
      seq -= 1;
      if (typeof r.content !== 'string') continue;
      let parsed: unknown;
      try { parsed = JSON.parse(r.content); } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      for (const block of parsed as Array<Record<string, unknown>>) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        if (!rank.has(block.name)) rank.set(block.name, seq);
        if (newestTurn != null && r.turn_number === newestTurn) currentTurn.add(block.name);
      }
    }
  } catch { /* best effort — see the docstring */ }
  return { rank, currentTurn };
}

/**
 * Mark names as loaded for this session and return whatever the ceiling evicted.
 *
 * The return value is new (it was `void`): eviction has to be reportable, because
 * a name leaving the set is a fact the model needs. Callers that ignore it are
 * unchanged in behaviour — at or under the ceiling this returns `[]` and does
 * exactly what it always did.
 */
export function markToolsLoaded(agentId: string, toolNames: string[]): string[] {
  let loaded = sessionLoadedTools.get(agentId);
  if (!loaded) {
    loaded = new Set();
    sessionLoadedTools.set(agentId, loaded);
  }
  for (const name of toolNames) {
    loaded.add(name);
  }
  return evictToCeiling(agentId, loaded, new Set(toolNames));
}

/**
 * Bring a set back to the ceiling, least-recently-CALLED first, and answer with
 * what left.
 *
 * ── TWO TIERS, AND THE SECOND ONE IS WHY REHYDRATION STAYS BOUNDED ──
 * A name this very call asked for is normally pinned: evicting it would tell a
 * model the tool it just asked for is gone, and it would ask again next turn.
 * But a BULK REPLAY hands this function a whole session at once
 * (`rehydrateSessionToolsFromHistory`), and there the pin cannot be honoured
 * without disabling the ceiling completely — measured at 71 names surviving a 64
 * ceiling before this tier existed. So the batch becomes evictable on exactly the
 * condition that makes the pin impossible: WHEN THE BATCH ALONE EXCEEDS THE
 * CEILING. A batch that fits is never the reason the bound broke, so nothing it
 * asked for is evicted by it; a batch that does not fit has to give something up,
 * and the coldest go first — which for a replay with no call record is the FRONT
 * of the replayed sequence, the oldest loads, leaving the survivors in the order
 * the record placed them.
 */
function evictToCeiling(agentId: string, loaded: Set<string>, justLoaded: Set<string>): string[] {
  if (loaded.size <= SESSION_TOOL_SET_MAX) return [];
  const { rank, currentTurn } = calledRecency(agentId);
  const order = [...loaded];
  // Least recently called first; a name never called ranks below every name that
  // was. Load order (the set's own order) is the tie-break, so the result is
  // deterministic for identical state.
  const coldestFirst = (a: string, b: string) =>
    (rank.get(a) ?? -1) - (rank.get(b) ?? -1) || order.indexOf(a) - order.indexOf(b);
  const evictable = order.filter((name) => !currentTurn.has(name));
  const batchAloneBustsTheBound = justLoaded.size > SESSION_TOOL_SET_MAX;
  const candidates = [
    ...evictable.filter((name) => !justLoaded.has(name)).sort(coldestFirst),
    ...(batchAloneBustsTheBound ? evictable.filter((name) => justLoaded.has(name)).sort(coldestFirst) : []),
  ];
  const evicted: string[] = [];
  for (const name of candidates) {
    if (loaded.size <= SESSION_TOOL_SET_MAX) break;
    loaded.delete(name);
    evicted.push(name);
  }
  return evicted;
}

/** The per-call refusal. One owner, so the handler and the executor cannot drift. */
export function loadToolDocsOverflowRefusal(received: number): string {
  return `Error: load_tool_docs accepts at most ${LOAD_TOOL_DOCS_MAX_PER_CALL} tool names per call `
    + `(received ${received}). Load the ones you need for THIS step; you can call again for the rest.`;
}

/** The eviction note, appended to a tool result. Never silent. */
export function evictionNote(evicted: string[]): string {
  return `\n\nEvicted from your session set (unused longest): ${evicted.join(', ')}. `
    + 'Re-load if you need them.';
}

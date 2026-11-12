// The session tool set, bounded: names from `load_tool_docs` ride in the API tools array, so the set has
// a ceiling (12 names per call, 64 per session, above any real working set). Eviction is LRU by call,
// read from the assistant `tool_use` rows (`rehydrateSessionToolsFromHistory` replays the same record)
// only when the ceiling is crossed. A name called in the newest turn is never evicted (mid-turn prefix
// churn); if every candidate is pinned the set stays over the ceiling. The caller reports evictions.

import { getDb } from '../db/connection.js';

export const LOAD_TOOL_DOCS_MAX_PER_CALL = 12;

export const SESSION_TOOL_SET_MAX = 64;

const RECENCY_ROW_SCAN = 400;

// agentId -> names in LOAD order (a JS Set keeps insertion order, so the API tail stays append-only).
const sessionLoadedTools: Map<string, Set<string>> = new Map();

export function getSessionLoadedTools(agentId: string): Set<string> {
  return sessionLoadedTools.get(agentId) ?? new Set();
}

export function forgetSessionLoadedTools(agentId: string): void {
  sessionLoadedTools.delete(agentId);
}

export function resetSessionToolSetsForTests(): void {
  sessionLoadedTools.clear();
}

interface Recency {
  rank: Map<string, number>;
  currentTurn: Set<string>;
}

/** When each name was last CALLED, newest first. Best effort: a failed read ranks nothing, so eviction
 *  falls back to load order. */
function calledRecency(agentId: string): Recency {
  const rank = new Map<string, number>();
  const currentTurn = new Set<string>();
  try {
    const rows = getDb().prepare(
      `SELECT content, turn_number FROM messages
        WHERE agent_id = ? AND role = 'assistant' AND content LIKE '%tool_use%'
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(agentId, RECENCY_ROW_SCAN) as Array<{ content: string; turn_number: number | null }>;
    // The newest turn ON RECORD, not the turn now: the max can over-protect, never under-protect.
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
  } catch { /* best effort: see the docstring */ }
  return { rank, currentTurn };
}

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
 * Bring a set back to the ceiling, least-recently-CALLED first, and return what left. A name this call
 * asked for is pinned unless the batch alone exceeds the ceiling (a bulk replay from
 * `rehydrateSessionToolsFromHistory`, where the pin would disable the ceiling); then the batch is
 * evictable too, coldest first (for a replay, the oldest loads).
 */
function evictToCeiling(agentId: string, loaded: Set<string>, justLoaded: Set<string>): string[] {
  if (loaded.size <= SESSION_TOOL_SET_MAX) return [];
  const { rank, currentTurn } = calledRecency(agentId);
  const order = [...loaded];
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

export function loadToolDocsOverflowRefusal(received: number): string {
  return `Error: load_tool_docs accepts at most ${LOAD_TOOL_DOCS_MAX_PER_CALL} tool names per call `
    + `(received ${received}). Load the ones you need for THIS step; you can call again for the rest.`;
}

export function evictionNote(evicted: string[]): string {
  return `\n\nEvicted from your session set (unused longest): ${evicted.join(', ')}. `
    + 'Re-load if you need them.';
}

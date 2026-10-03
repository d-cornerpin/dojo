// ════════════════════════════════════════════════════════════════════════════
// THE SAME ANSWER, COMPUTED ONCE (v3.2.3 incident, layer 2)
//
// ── WHAT THE TRACE MEASURED ──
// One forced compaction pass calls `estimateAssembledTokens` THREE times over
// identical rows: the pre-call gate asks (`context-gates.ts`), then the entry point
// asks again before deciding, then again afterwards to report what it reclaimed.
// Each call does the expensive part from scratch:
//
//   · `measureAgentToolPayloadTokens` → `getFilteredTools` + `JSON.stringify` of the
//     WHOLE tool array (~100 KB on a fully-granted agent), and
//   · `getContextSummaries` → every summary row for the agent out of SQLite
//     (86K tokens ≈ 340 KB of text on the incident box), plus the fresh tail.
//
// better-sqlite3 is SYNCHRONOUS, so all of that is event-loop time: it is why the
// dashboard and the stop button died with the prompt rather than merely beside it.
//
// ⚠ AND NOTE WHAT IS *NOT* THE COST, because the obvious suspect is innocent:
// `estimateTokens` is `chars / 4` (`budget.ts`), well under a millisecond over a
// 114K-token context. Caching it would buy nothing. The cost is the re-reads and
// the re-stringify, so that is what this file removes.
//
// ── THE KEY IS THE FACTS, NOT A CLOCK ──
// `(agentId, MAX(seq), messageCount, SUM(message tokens), summaryCount, SUM(summary tokens),
// modelId, contextWindow)`:
//
//   · a new message → `MAX(seq)` moves (seq is the rowid alias, T10),
//   · a new or dropped summary → `summaryCount` moves,
//   · a different model or window → the last two move,
//   · the agent's tool surface changes → its own key, below.
//
// ⚠ THE TWO SUMS ARE THERE BECAUSE COUNTS ARE NOT SIZES, and an existing clause proved it: the
// first cut keyed on counts alone, and `the-clock-does-not-overrule-the-token-math` rebuilds its
// fixture between clauses with the SAME row count and a different `token_count` per row. The cache
// served the small history's estimate to the big one, the gate read "under threshold", and a
// compaction that should have run did not. On a real box the same shape is an edited row or a
// token_count backfill. Two more indexed aggregates, and the key now moves when the SIZE moves.
//
// There is NO time-to-live on purpose. A TTL would be a guess about staleness when
// the facts are cheap to read exactly (two indexed `MAX`/`COUNT` reads, sub-
// millisecond), and a stale budget number is precisely the class of bug that makes
// a gate fire on a history that no longer exists.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getToolConfigGeneration } from '../agent/tool-config-generation.js';
import { getSessionLoadedTools } from '../tools/tool-session-set.js';

const logger = createLogger('assembled-estimate-cache');

/** What `estimateAssembledTokens` answers. Structural, so this module needs no
 *  import from `compaction.ts` and cannot create a cycle with it. */
export interface AssembledEstimate {
  total: number;
  summaryTokens: number;
  freshTailTokens: number;
  briefTokens: number;
  freshTailCount: number;
  summaryCount: number;
  reserveTokens: number;
}

interface Entry { key: string; value: AssembledEstimate }

const estimates = new Map<string, Entry>();
const toolPayloads = new Map<string, { key: string; tokens: number }>();

let hits = 0;
let misses = 0;

/**
 * The two cheap reads that make the key exact. Indexed, sub-millisecond.
 *
 * ⚠ `MAX(seq)`, not `MAX(rowid)`: `seq` IS this table's rowid alias (T10), and
 * `lane-readers.test.ts` refuses a bare `rowid` projection from `messages` — it
 * caught this module's first cut. The insertion key has one name in SQL.
 */
function factsKey(agentId: string, modelId: string | undefined, contextWindow: number): string {
  const db = getDb();
  const m = db.prepare('SELECT MAX(seq) AS r, COUNT(*) AS n, COALESCE(SUM(token_count), 0) AS t FROM messages WHERE agent_id = ?')
    .get(agentId) as { r: number | null; n: number; t: number } | undefined;
  const s = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(token_count), 0) AS t FROM summaries WHERE agent_id = ?')
    .get(agentId) as { n: number; t: number } | undefined;
  return `${agentId}|${m?.r ?? 0}|${m?.n ?? 0}|${m?.t ?? 0}|${s?.n ?? 0}|${s?.t ?? 0}|${modelId ?? '-'}|${contextWindow}`;
}

/**
 * Memoised `estimateAssembledTokens`. `compute` is the real function, passed in by
 * the caller — this module deliberately does not import it, so the estimate keeps
 * exactly one implementation and this stays a cache rather than a second opinion.
 */
export async function cachedAssembledEstimate(
  agentId: string,
  contextWindow: number,
  modelId: string | undefined,
  compute: () => Promise<AssembledEstimate>,
): Promise<AssembledEstimate> {
  let key: string;
  try {
    key = factsKey(agentId, modelId, contextWindow);
  } catch {
    // No database to key against (a unit test, a boot race): never serve a cached
    // number you cannot justify — compute it.
    return compute();
  }
  const cached = estimates.get(agentId);
  if (cached && cached.key === key) {
    hits += 1;
    return cached.value;
  }
  misses += 1;
  const value = await compute();
  estimates.set(agentId, { key, value });
  return value;
}

/**
 * THE SURFACE THIS CACHE IS ABOUT, named by the facts that move it. (v3.2.3 review, M4)
 *
 * The first cut keyed on `agentId:modelId` while its own doc said the tool surface moves with
 * grants, with `load_tool_docs` in a session, and with the always-loaded head — none of which the
 * model id can see. The review was exact: a wrong key here makes an agent's budget reflect a tool
 * set it does not carry. So the key names each mover, cheapest first:
 *
 *   · `getToolConfigGeneration()` — bumped by every write that widens or narrows the GLOBAL
 *     surface (an integration connected, a service enabled, an account removed). The same counter
 *     `getFilteredTools` keys its own memo on, which is the review's point.
 *   · `agents.updated_at` — every per-agent surface fact (`permissions`, `tools_policy`,
 *     `group_id`, `classification`, `task_id`, the always-loaded declaration) lives on that row,
 *     and materialising grants writes it with `updated_at = datetime('now')`. Reading the stamp
 *     rather than re-listing the columns is deliberate: `computeAgentToolFingerprint` owns that
 *     list, and a second copy here would be the drift the review is complaining about. It
 *     over-invalidates — any agent write costs one stringify — which is the safe direction.
 *   · the session's loaded doc set — what `load_tool_docs` actually changes, read from the one
 *     module that owns it.
 *
 * Model id stays in the key because the output cap and the ceiling travel with it.
 */
export function toolSurfaceKey(agentId: string, modelId: string | null | undefined): string {
  let stamp = '';
  try {
    stamp = (getDb().prepare('SELECT updated_at FROM agents WHERE id = ?')
      .get(agentId) as { updated_at?: string } | undefined)?.updated_at ?? '';
  } catch { stamp = ''; }
  const loaded = [...getSessionLoadedTools(agentId)].sort().join(',');
  return `${agentId}|${modelId ?? '-'}|${getToolConfigGeneration()}|${stamp}|${loaded}`;
}

/**
 * The ~100 KB `JSON.stringify` of the tool array, cached per agent + SURFACE.
 *
 * The key is required rather than defaulted, and `toolSurfaceKey` above is the one that answers
 * it: a caller that invents its own would be the finding this replaced.
 */
export async function cachedToolPayloadTokens(
  agentId: string, surfaceKey: string, compute: () => Promise<number>,
): Promise<number> {
  const cached = toolPayloads.get(agentId);
  if (cached && cached.key === surfaceKey) return cached.tokens;
  const tokens = await compute();
  toolPayloads.set(agentId, { key: surfaceKey, tokens });
  return tokens;
}

/** Observability for the reproduction: the headline is that a pass goes 3 → 1. */
export function assembledEstimateStats(): { hits: number; misses: number } {
  return { hits, misses };
}

export function __resetEstimateCacheForTests(): void {
  estimates.clear();
  toolPayloads.clear();
  hits = 0;
  misses = 0;
  logger.debug('assembled-estimate cache reset');
}

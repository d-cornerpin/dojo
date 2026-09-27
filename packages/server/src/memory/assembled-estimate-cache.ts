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
 * The ~100 KB `JSON.stringify` of the tool array, cached per agent + SURFACE.
 *
 * The surface key is the caller's: tools change with grants, with
 * `load_tool_docs` in a session, and with the always-loaded head, and the caller
 * already knows which of those it is asking about. A wrong key here would make an
 * agent's budget reflect a tool set it does not carry, so the key is required
 * rather than defaulted.
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

/** Drop everything known about one agent. Called where the facts change wholesale
 *  (a session reset, a purge) rather than trusted to the key. */
export function invalidateAssembledEstimate(agentId: string): void {
  estimates.delete(agentId);
  toolPayloads.delete(agentId);
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

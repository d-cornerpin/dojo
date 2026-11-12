// Memoises the assembled-token estimate and tool-payload size per agent, keyed on the row facts
// (max seq, counts and token sums, model, window), never a clock or TTL: a stale budget is worse.
// Counts alone are not sizes, so the token sums are in the key.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getToolConfigGeneration } from '../agent/tool-config-generation.js';
import { getSessionLoadedTools } from '../tools/tool-session-set.js';

const logger = createLogger('assembled-estimate-cache');

/** What `estimateAssembledTokens` answers; structural so this module never imports `compaction.ts`. */
export interface AssembledEstimate {
  total: number;
  summaryTokens: number;
  freshTailTokens: number;
  freshTailCount: number;
  summaryCount: number;
  reserveTokens: number;
}

interface Entry { key: string; value: AssembledEstimate }

const estimates = new Map<string, Entry>();
const toolPayloads = new Map<string, { key: string; tokens: number }>();


// Uses `MAX(seq)`, not `MAX(rowid)`: `lane-readers.test.ts` refuses a bare `rowid` projection
// from `messages`.
function factsKey(agentId: string, modelId: string | undefined, contextWindow: number): string {
  const db = getDb();
  const m = db.prepare('SELECT MAX(seq) AS r, COUNT(*) AS n, COALESCE(SUM(token_count), 0) AS t FROM messages WHERE agent_id = ?')
    .get(agentId) as { r: number | null; n: number; t: number } | undefined;
  const s = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(token_count), 0) AS t FROM summaries WHERE agent_id = ?')
    .get(agentId) as { n: number; t: number } | undefined;
  return `${agentId}|${m?.r ?? 0}|${m?.n ?? 0}|${m?.t ?? 0}|${s?.n ?? 0}|${s?.t ?? 0}|${modelId ?? '-'}|${contextWindow}`;
}

/** Memoised `estimateAssembledTokens`; `compute` is passed in so the estimate has one implementation. */
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
    // No database to key against (a unit test, a boot race): never serve a number you cannot justify.
    return compute();
  }
  const cached = estimates.get(agentId);
  if (cached && cached.key === key) return cached.value;
  const value = await compute();
  estimates.set(agentId, { key, value });
  return value;
}

// Facts that move a tool surface: global config generation, the agent row's `updated_at` (stamp
// read instead of a second copy of `computeAgentToolFingerprint`'s columns; over-invalidates, which
// is safe), the session's loaded doc set, and the model id (the output cap travels with it).
export function toolSurfaceKey(agentId: string, modelId: string | null | undefined): string {
  let stamp = '';
  try {
    stamp = (getDb().prepare('SELECT updated_at FROM agents WHERE id = ?')
      .get(agentId) as { updated_at?: string } | undefined)?.updated_at ?? '';
  } catch { stamp = ''; }
  const loaded = [...getSessionLoadedTools(agentId)].sort().join(',');
  return `${agentId}|${modelId ?? '-'}|${getToolConfigGeneration()}|${stamp}|${loaded}`;
}

export async function cachedToolPayloadTokens(
  agentId: string, surfaceKey: string, compute: () => Promise<number>,
): Promise<number> {
  const cached = toolPayloads.get(agentId);
  if (cached && cached.key === surfaceKey) return cached.tokens;
  const tokens = await compute();
  toolPayloads.set(agentId, { key: surfaceKey, tokens });
  return tokens;
}

export function __resetEstimateCacheForTests(): void {
  estimates.clear();
  toolPayloads.clear();
  logger.debug('assembled-estimate cache reset');
}

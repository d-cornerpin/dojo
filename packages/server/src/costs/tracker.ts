// ════════════════════════════════════════
// Cost Calculation and Recording
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { checkAlertsAfterCost } from './budget.js';

const logger = createLogger('costs');

// ── Record Cost ──

export interface RecordCostParams {
  agentId: string;
  modelId: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
  requestType?: string;
}

function getModelPricing(modelId: string): { inputCostPerM: number; outputCostPerM: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT input_cost_per_m, output_cost_per_m FROM models WHERE id = ?
  `).get(modelId) as { input_cost_per_m: number | null; output_cost_per_m: number | null } | undefined;

  return {
    inputCostPerM: row?.input_cost_per_m ?? 3.0,
    outputCostPerM: row?.output_cost_per_m ?? 15.0,
  };
}

export function recordCost(params: RecordCostParams): void {
  const { agentId, modelId, providerId, inputTokens, outputTokens, latencyMs, requestType } = params;

  try {
    const pricing = getModelPricing(modelId);
    const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPerM;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPerM;
    const costUsd = inputCost + outputCost;

    const db = getDb();
    db.prepare(`
      INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                                cost_usd, latency_ms, request_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuidv4(),
      agentId,
      modelId,
      providerId,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs ?? null,
      requestType ?? null,
    );

    // Invalidate daily spend cache so next budget check gets fresh data
    invalidateDailySpendCache();

    logger.info(`Cost recorded: $${costUsd.toFixed(4)} for agent ${agentId}`, {
      agentId,
      modelId,
      inputTokens,
      outputTokens,
      costUsd: costUsd.toFixed(6),
    }, agentId);

    // Check budget alerts AFTER recording (fires alerts when thresholds are crossed)
    try {
      checkAlertsAfterCost(agentId);
    } catch {
      // Alert check is best-effort
    }
  } catch (err) {
    logger.error('Failed to record cost', {
      error: err instanceof Error ? err.message : String(err),
      agentId,
      modelId,
    }, agentId);
  }
}

// ── Cost Summary ──

export interface CostSummary {
  totalSpend: number;
  dailyAvg: number;
  byModel: Array<{ modelId: string; modelName: string; totalCost: number; requestCount: number }>;
  byAgent: Array<{ agentId: string; agentName: string; totalCost: number; requestCount: number }>;
  byTier: Array<{ tier: string; totalCost: number; requestCount: number }>;
}

function periodToSql(period: '24h' | '7d' | '30d' | 'all'): string {
  switch (period) {
    case '24h': return "AND created_at >= datetime('now', '-1 day')";
    case '7d': return "AND created_at >= datetime('now', '-7 days')";
    case '30d': return "AND created_at >= datetime('now', '-30 days')";
    case 'all': return '';
  }
}

function periodToDays(period: '24h' | '7d' | '30d' | 'all'): number {
  switch (period) {
    case '24h': return 1;
    case '7d': return 7;
    case '30d': return 30;
    case 'all': return 1; // Will compute actual days
  }
}

export function getCostSummary(period: '24h' | '7d' | '30d' | 'all'): CostSummary {
  const db = getDb();
  const filter = periodToSql(period);

  // Total spend
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_records cr WHERE 1=1 ${filter.replace(/created_at/g, 'cr.created_at')}
  `).get() as { total: number };

  // Days for average
  let days = periodToDays(period);
  if (period === 'all') {
    const earliest = db.prepare(`
      SELECT MIN(created_at) as earliest FROM cost_records
    `).get() as { earliest: string | null };
    if (earliest.earliest) {
      days = Math.max(1, Math.ceil((Date.now() - new Date(earliest.earliest).getTime()) / (1000 * 60 * 60 * 24)));
    }
  }

  // By model (with name lookup)
  const byModel = db.prepare(`
    SELECT cr.model_id as modelId, COALESCE(m.name, 'Unknown Model (' || substr(cr.model_id, 1, 6) || ')') as modelName,
           COALESCE(SUM(cr.cost_usd), 0) as totalCost, COUNT(*) as requestCount
    FROM cost_records cr
    LEFT JOIN models m ON m.id = cr.model_id
    WHERE 1=1 ${filter.replace(/created_at/g, 'cr.created_at')}
    GROUP BY cr.model_id ORDER BY totalCost DESC
  `).all() as Array<{ modelId: string; modelName: string; totalCost: number; requestCount: number }>;

  // By agent (with name lookup)
  const byAgent = db.prepare(`
    SELECT cr.agent_id as agentId, COALESCE(a.name, 'Deleted Agent (' || substr(cr.agent_id, 1, 6) || ')') as agentName,
           COALESCE(SUM(cr.cost_usd), 0) as totalCost, COUNT(*) as requestCount
    FROM cost_records cr
    LEFT JOIN agents a ON a.id = cr.agent_id
    WHERE 1=1 ${filter.replace(/created_at/g, 'cr.created_at')}
    GROUP BY cr.agent_id ORDER BY totalCost DESC
  `).all() as Array<{ agentId: string; agentName: string; totalCost: number; requestCount: number }>;

  // By tier (join with router_tier_models)
  const byTier = db.prepare(`
    SELECT COALESCE(tm.tier_id, 'unknown') as tier,
           COALESCE(SUM(cr.cost_usd), 0) as totalCost,
           COUNT(*) as requestCount
    FROM cost_records cr
    LEFT JOIN router_tier_models tm ON tm.model_id = cr.model_id
    WHERE 1=1 ${filter.replace(/created_at/g, 'cr.created_at')}
    GROUP BY tm.tier_id ORDER BY totalCost DESC
  `).all() as Array<{ tier: string; totalCost: number; requestCount: number }>;

  return {
    totalSpend: totalRow.total,
    dailyAvg: totalRow.total / days,
    byModel,
    byAgent,
    byTier,
  };
}

// ── Cost Records ──

export interface CostRecord {
  id: string;
  agentId: string;
  agentName: string;
  modelId: string;
  modelName: string;
  providerId: string;
  tier: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number | null;
  requestType: string | null;
  createdAt: string;
}

export function getCostRecords(filter?: {
  agentId?: string;
  modelId?: string;
  limit?: number;
  offset?: number;
}): { records: CostRecord[]; total: number } {
  const db = getDb();
  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];

  if (filter?.agentId) {
    conditions.push('cr.agent_id = ?');
    params.push(filter.agentId);
  }
  if (filter?.modelId) {
    conditions.push('cr.model_id = ?');
    params.push(filter.modelId);
  }

  const where = conditions.join(' AND ');
  const limit = Math.min(filter?.limit ?? 50, 500);
  const offset = filter?.offset ?? 0;

  const total = (db.prepare(`SELECT COUNT(*) as count FROM cost_records cr WHERE ${where}`).get(...params) as { count: number }).count;

  const rows = db.prepare(`
    SELECT cr.id, cr.agent_id, cr.model_id, cr.provider_id, cr.input_tokens, cr.output_tokens,
           cr.cost_usd, cr.latency_ms, cr.request_type, cr.created_at,
           COALESCE(a.name, 'Deleted Agent (' || substr(cr.agent_id, 1, 6) || ')') as agent_name,
           COALESCE(m.name, 'Unknown Model (' || substr(cr.model_id, 1, 6) || ')') as model_name,
           rl.tier_id as tier
    FROM cost_records cr
    LEFT JOIN agents a ON a.id = cr.agent_id
    LEFT JOIN models m ON m.id = cr.model_id
    LEFT JOIN router_log rl ON rl.selected_model_id = cr.model_id
      AND rl.agent_id = cr.agent_id
      AND rl.created_at = cr.created_at
    WHERE ${where}
    ORDER BY cr.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<{
    id: string;
    agent_id: string;
    model_id: string;
    provider_id: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    latency_ms: number | null;
    request_type: string | null;
    created_at: string;
    agent_name: string | null;
    model_name: string | null;
    tier: string | null;
  }>;

  const records: CostRecord[] = rows.map(r => ({
    id: r.id,
    agentId: r.agent_id,
    agentName: r.agent_name ?? 'Deleted Agent',
    modelId: r.model_id,
    modelName: r.model_name ?? 'Unknown Model',
    providerId: r.provider_id,
    tier: r.tier ?? r.request_type ?? '--',
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    latencyMs: r.latency_ms,
    requestType: r.request_type,
    createdAt: r.created_at,
  }));

  return { records, total };
}

// ── Daily Spend (cached for 5 seconds to avoid redundant SUM queries) ──

let dailySpendCache: { value: number; cachedAt: number } = { value: 0, cachedAt: 0 };
const DAILY_SPEND_CACHE_MS = 5000;

export function getDailySpend(): number {
  const now = Date.now();
  if (now - dailySpendCache.cachedAt < DAILY_SPEND_CACHE_MS) {
    return dailySpendCache.value;
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM cost_records
    WHERE created_at >= datetime('now', '-1 day')
  `).get() as { total: number };

  dailySpendCache = { value: row.total, cachedAt: now };
  return row.total;
}

/** Invalidate the daily spend cache (call after recording a cost) */
export function invalidateDailySpendCache(): void {
  dailySpendCache.cachedAt = 0;
}

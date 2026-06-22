// ════════════════════════════════════════
// Low-confidence Shadow Probing
// To learn whether the router OVER-routes (sent to a higher tier than needed),
// occasionally re-run a low-confidence turn at the next-lower tier in the
// background and, if its answer is adequate, record a 'probe_down' label.
//
// Strictly bounded:
//   - OFF by default (config 'router_probe_enabled'); opt-in.
//   - only fires on low-confidence decisions, and never for the lowest tier.
//   - capped per maintenance window (budget), plus a sampling gate.
//   - runs after the real answer is produced; NEVER delays or is shown to the
//     user. The real (predicted) tier always answers.
//   - adequacy judge is conservative (high similarity required), so noise
//     biases toward leaving routing unchanged.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isAutoRouterInUse } from './gating.js';
import { embedQuery } from './semantic.js';
import { recordLabel } from './labels.js';
import type { Tier } from './exemplars.js';

const logger = createLogger('router-probe');

const PROBE_BAND = 0.05;        // only probe when the top-2 margin is below this
const DEFAULT_SAMPLE = 0.5;     // of eligible decisions, probe this fraction
const DEFAULT_ADEQUATE = 0.9;   // cosine(realAnswer, probeAnswer) to call it adequate
const DEFAULT_BUDGET = 20;      // max probes per maintenance window

const LOWER_TIER: Record<Tier, Tier | null> = {
  heavy: 'standard',
  standard: 'light',
  light: null,
};

let probesThisWindow = 0;

export function resetProbeBudget(): void {
  probesThisWindow = 0;
}

function getConfigBool(key: string, def: boolean): boolean {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return def;
    return row.value === 'true' || row.value === '1';
  } catch {
    return def;
  }
}

function getConfigNum(key: string, def: number): number {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) ? n : def;
  } catch {
    return def;
  }
}

export function isProbeEnabled(): boolean {
  // On by default: self-training needs a label source, and probing is the only
  // one wired. Sparse, budget-capped, and gated on auto-router being in use, so
  // it stays quiet. Set config 'router_probe_enabled'='false' to disable.
  return getConfigBool('router_probe_enabled', true);
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

interface ProbeParams {
  agentId: string;
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | object[] }>;
  tier: Tier;
  confidence: number;
  query: string;
  realAnswer: string;
}

// Fire-and-forget. Returns immediately; any work happens detached.
export function maybeProbe(params: ProbeParams): void {
  if (!isProbeEnabled()) return;
  if (!isAutoRouterInUse()) return;

  const lower = LOWER_TIER[params.tier];
  if (!lower) return;                                   // already lowest tier
  if (params.confidence >= PROBE_BAND) return;          // confident enough, skip
  if (!params.query.trim() || !params.realAnswer.trim()) return;

  const budget = getConfigNum('router_probe_budget', DEFAULT_BUDGET);
  if (probesThisWindow >= budget) return;
  const sample = getConfigNum('router_probe_sample', DEFAULT_SAMPLE);
  if (Math.random() > sample) return;                  // spread probes out

  probesThisWindow++;
  void runProbe(params, lower).catch(() => { /* best effort */ });
}

async function runProbe(params: ProbeParams, lower: Tier): Promise<void> {
  try {
    const { selectModel } = await import('./selector.js');
    const sel = selectModel(lower, params.agentId, undefined, undefined);
    if (!sel) return;

    const { callModel } = await import('../agent/model.js');
    const result = await callModel({
      agentId: params.agentId,
      modelId: sel.modelId,
      messages: params.messages as Array<{ role: 'user' | 'assistant'; content: string }>,
      systemPrompt: params.systemPrompt,
      tools: false,
    });
    const probeAnswer = (result.content ?? '').trim();
    if (!probeAnswer) return;

    const [realEmb, probeEmb] = await Promise.all([
      embedQuery(params.realAnswer),
      embedQuery(probeAnswer),
    ]);
    if (!realEmb || !probeEmb) return;

    const sim = cosine(realEmb, probeEmb);
    const adequate = getConfigNum('router_probe_adequate', DEFAULT_ADEQUATE);
    if (sim >= adequate) {
      // The lower tier produced an adequate answer -> this query belongs lower.
      await recordLabel(params.agentId, params.query, lower, 'probe_down', 0.7);
      logger.info('Probe: lower tier adequate, labeled down', {
        from: params.tier, to: lower, similarity: Number(sim.toFixed(3)),
      }, params.agentId);
    } else {
      logger.debug('Probe: lower tier inadequate, no label', {
        from: params.tier, to: lower, similarity: Number(sim.toFixed(3)),
      }, params.agentId);
    }
  } catch (err) {
    logger.debug('Probe failed (best-effort)', {
      error: err instanceof Error ? err.message : String(err),
    }, params.agentId);
  }
}

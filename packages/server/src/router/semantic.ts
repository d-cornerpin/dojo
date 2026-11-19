// Semantic tier classifier: embeds the query with the memory engine's local embedder (nomic-embed-text via
// Ollama) and matches it to per-tier exemplar centroids by cosine. Returns null on any embedder failure so the
// caller falls back to the keyword heuristic.

import { generateEmbedding } from '../memory/embeddings.js';
import { createLogger } from '../logger.js';
import { EXEMPLARS, TIERS, type Tier } from './exemplars.js';

const logger = createLogger('router-semantic');

// nomic-embed-text is trained with task-instruction prefixes. Apply the SAME
// prefix to exemplars and the query so the cosine comparison is symmetric.
const TASK_PREFIX = 'classification: ';

// Version tag recorded with each decision so a past route is reconstructable.
const CENTROID_VERSION = 'centroid-1';

// Routing is on the turn-start critical path, so the routing embed gets a short deadline: a slow or cold
// embedder degrades to the keyword scorer instead of stalling first token. The warmer pre-builds the
// centroids, so a live route pays at most one query embed.
const ROUTER_EMBED_DEADLINE_MS = 1500;

interface Centroids {
  light: Float32Array;
  standard: Float32Array;
  heavy: Float32Array;
}

let centroidCache: Centroids | null = null;
let buildPromise: Promise<Centroids | null> | null = null;

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

// Mean of L2-normalized vectors: the average direction, which is what cosine similarity cares about.
function meanDirection(vectors: Float32Array[]): Float32Array {
  const dim = vectors[0].length;
  const acc = new Float32Array(dim);
  for (const v of vectors) {
    const n = normalize(v);
    for (let i = 0; i < dim; i++) acc[i] += n[i];
  }
  for (let i = 0; i < dim; i++) acc[i] /= vectors.length;
  return acc;
}

// Centroid build: lazy and single-flight; never at startup (see gating.ts).

async function buildCentroids(): Promise<Centroids | null> {
  try {
    const perTier: Record<Tier, Float32Array[]> = { light: [], standard: [], heavy: [] };
    for (const tier of TIERS) {
      for (const text of EXEMPLARS[tier]) {
        perTier[tier].push(await generateEmbedding(TASK_PREFIX + text));
      }
    }
    const centroids: Centroids = {
      light: meanDirection(perTier.light),
      standard: meanDirection(perTier.standard),
      heavy: meanDirection(perTier.heavy),
    };
    logger.info('Semantic router centroids built', {
      light: perTier.light.length,
      standard: perTier.standard.length,
      heavy: perTier.heavy.length,
      dimensions: centroids.light.length,
    });
    return centroids;
  } catch (err) {
    logger.warn('Failed to build semantic centroids; heuristic fallback in effect', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Single-flight the 52-embed centroid build. The build runs detached and caches
// its result (or re-arms on failure), so a live route that raced it can bail on a
// deadline WITHOUT abandoning the work: the next route finds the populated cache.
function ensureCentroidsBuilding(): Promise<Centroids | null> {
  if (!buildPromise) {
    buildPromise = buildCentroids().then((built) => {
      if (built) centroidCache = built;
      else buildPromise = null; // allow a retry next call (embedder may have been down)
      return built;
    });
  }
  return buildPromise;
}

// deadlineMs bounds only the caller's wait, never the build. If the warmer has not finished, return null
// (keyword scorer) and let the detached build continue so the next route is centroid-routed.
async function getCentroids(deadlineMs?: number): Promise<Centroids | null> {
  if (centroidCache) return centroidCache;
  const p = ensureCentroidsBuilding();
  if (deadlineMs === undefined) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SemanticResult {
  tier: Tier;
  // Normalized top-2 separation (0..1): 0 = top and second tied, 1 = top dominates.
  confidence: number;
  topScore: number;         // top cosine similarity
  scores: Record<Tier, number>;
  headVersion: string;      // which centroid set decided, e.g. 'centroid-1'
}

function rank(scores: Record<Tier, number>, headVersion: string): SemanticResult {
  const ordered = TIERS.slice().sort((a, b) => scores[b] - scores[a]);
  const top = scores[ordered[0]];
  const second = scores[ordered[1]];
  const third = scores[ordered[2]];
  // Cosine sims share a high baseline (raw margins tiny); subtracting the least-likely tier removes it, parameter-free:
  // confidence = (top - second) / ((top - third) + (second - third)); all-equal gives 0 (maximally uncertain).
  const spread = (top - third) + (second - third);
  const confidence = spread > 0 ? (top - second) / spread : 0;
  return {
    tier: ordered[0],
    confidence,
    topScore: top,
    scores,
    headVersion,
  };
}

export async function classifyTierSemantic(query: string): Promise<SemanticResult | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  let queryEmb: Float32Array;
  try {
    // Short deadline on the routing embed (also covers decide.ts's short-confirmation path).
    queryEmb = await generateEmbedding(TASK_PREFIX + trimmed, { timeoutMs: ROUTER_EMBED_DEADLINE_MS });
  } catch (err) {
    logger.debug('Query embedding failed or timed out; heuristic fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Bound the wait on the (usually pre-warmed) centroids so a first-turn race with the warmer cannot stall the
  // route; degrade to the scorer.
  const centroids = await getCentroids(ROUTER_EMBED_DEADLINE_MS);
  if (!centroids) return null;
  const sims: Record<Tier, number> = {
    light: cosine(queryEmb, centroids.light),
    standard: cosine(queryEmb, centroids.standard),
    heavy: cosine(queryEmb, centroids.heavy),
  };
  return rank(sims, CENTROID_VERSION);
}

// ── Embedder keep-warm (gated, see gating.ts) ──
// Ollama unloads an idle model after its keep_alive window, so we tell it to hold the model for a window and
// re-assert well within it; when auto-router is off we stop re-pinning and it unloads on its own.

const WARM_KEEP_ALIVE = '30m';            // how long Ollama holds the model
const WARM_INTERVAL_MS = 10 * 60 * 1000;  // re-pin every 10m (well inside 30m)

let warmTimer: ReturnType<typeof setInterval> | null = null;

async function pinEmbedder(): Promise<void> {
  try {
    const { isAutoRouterInUse } = await import('./gating.js');
    if (!isAutoRouterInUse()) return;
    await generateEmbedding(TASK_PREFIX + 'warmup', { keepAlive: WARM_KEEP_ALIVE });
    // Pre-build the tier centroids off the critical path; single-flighted and cached, so a cheap no-op once
    // built. A build failure re-arms for the next interval.
    await getCentroids();
  } catch { /* best effort */ }
}

export function startEmbedderWarmer(): void {
  if (warmTimer) return;
  void pinEmbedder();
  warmTimer = setInterval(() => { void pinEmbedder(); }, WARM_INTERVAL_MS);
  if (typeof warmTimer.unref === 'function') warmTimer.unref();
}

// ════════════════════════════════════════
// Semantic Tier Classifier
// Embeds the user's query with the local embedder (nomic-embed-text via Ollama,
// reused from the memory engine) and matches it to per-tier exemplar centroids
// by cosine similarity. If a trained head is active (Phase 3), it is preferred
// over the centroids. Returns null on ANY embedder failure so the caller can
// fall back to the keyword heuristic. See SEMANTIC-ROUTER-PLAN (local doc).
// ════════════════════════════════════════

import { generateEmbedding } from '../memory/embeddings.js';
import { createLogger } from '../logger.js';
import { EXEMPLARS, TIERS, type Tier } from './exemplars.js';

const logger = createLogger('router-semantic');

// nomic-embed-text is trained with task-instruction prefixes. Apply the SAME
// prefix to exemplars and the query so the cosine comparison is symmetric.
const TASK_PREFIX = 'classification: ';

// Version tag recorded with each decision so a past route is reconstructable.
const CENTROID_VERSION = 'centroid-1';

// FA-R4: routing rides the turn-start critical path, so the routing embed gets a
// short deadline instead of the memory engine's 30s background timeout. A slow or
// cold embedder blows this budget and the caller degrades to the deterministic
// keyword scorer rather than stalling first token. The centroids are pre-built by
// the warmer (below), so a live route pays at most one query embed under this
// deadline; the rare critical-path build is bounded by the same budget.
const ROUTER_EMBED_DEADLINE_MS = 1500;

interface Centroids {
  light: Float32Array;
  standard: Float32Array;
  heavy: Float32Array;
}

let centroidCache: Centroids | null = null;
let buildPromise: Promise<Centroids | null> | null = null;

// ── Vector helpers ──

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

// Mean of L2-normalized vectors — the average direction, which is what cosine
// similarity cares about.
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

// ── Centroid build (lazy, single-flight; never at startup, see Gating) ──

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

// deadlineMs bounds ONLY the caller's wait (FA-R4), never the build itself. On a
// live route the first turn after boot may still be mid-build if the warmer hasn't
// finished; rather than stall the turn, return null (→ keyword scorer) and let the
// detached build keep going so the next route is centroid-routed.
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

export function clearSemanticCache(): void {
  centroidCache = null;
  buildPromise = null;
}

// ── Classification ──

export interface SemanticResult {
  tier: Tier;
  // FA-R5: normalized top-2 separation on ONE scale (0..1), NOT the raw margin.
  // 0 = top and second tied (uncertain), 1 = top dominates. Same meaning whether
  // the scores came from cosine centroid sims or head softmax probs, so a single
  // PROBE_BAND and the router_log.confidence column no longer mix scales.
  confidence: number;
  topScore: number;         // top similarity (centroid) or top probability (head)
  scores: Record<Tier, number>;
  headVersion: string;      // which model decided: 'centroid-1' or a trained-head tag
}

function rank(scores: Record<Tier, number>, headVersion: string): SemanticResult {
  const ordered = TIERS.slice().sort((a, b) => scores[b] - scores[a]);
  const top = scores[ordered[0]];
  const second = scores[ordered[1]];
  const third = scores[ordered[2]];
  // FA-R5: normalize the top-2 margin to one scale. Cosine centroid sims share a
  // high common baseline (all tiers ~0.5-0.7) so raw margins are tiny and PROBE
  // fires constantly; head softmax probs spread wider so raw margins are large and
  // PROBE rarely fires. Subtracting the least-likely tier (min) removes that
  // baseline, giving a parameter-free [0,1] separation (no temperature to
  // mis-tune): confidence = (top - second) / ((top - third) + (second - third)).
  // Degenerate all-equal case → 0 (maximally uncertain).
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
    // FA-R4: short deadline on the routing embed. Covers both the direct route
    // and the short-confirmation path (decide.ts calls this with the prior text).
    queryEmb = await generateEmbedding(TASK_PREFIX + trimmed, { timeoutMs: ROUTER_EMBED_DEADLINE_MS });
  } catch (err) {
    logger.debug('Query embedding failed or timed out; heuristic fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Prefer a trained head if Phase 3 has produced one; else exemplar centroids.
  try {
    const { getActiveHead } = await import('./head.js');
    const head = getActiveHead();
    if (head && head.dimensions === queryEmb.length) {
      const probs = head.predict(queryEmb);
      return rank(probs, head.version);
    }
  } catch {
    // head module/data not available — fall through to centroids
  }

  // FA-R4: bound the wait on the (usually pre-warmed) centroids so a first-turn
  // race with the warmer's build can't stall the route; degrade to the scorer.
  const centroids = await getCentroids(ROUTER_EMBED_DEADLINE_MS);
  if (!centroids) return null;
  const sims: Record<Tier, number> = {
    light: cosine(queryEmb, centroids.light),
    standard: cosine(queryEmb, centroids.standard),
    heavy: cosine(queryEmb, centroids.heavy),
  };
  return rank(sims, CENTROID_VERSION);
}

// Embed an arbitrary query (used by the label collector and probe paths so they
// store the SAME representation the classifier sees). Returns null on failure.
export async function embedQuery(query: string): Promise<Float32Array | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;
  try {
    return await generateEmbedding(TASK_PREFIX + trimmed);
  } catch {
    return null;
  }
}

// ── Embedder keep-warm (gated; see Gating) ──
// Ollama unloads an idle model after its keep_alive window, which would make the
// next route pay a cold load (~300ms). Instead of racing that timeout with
// frequent pings, we explicitly tell Ollama to hold the model for a window and
// re-assert it well within that window. Net effect: while at least one agent is
// on auto-router, the embedder stays resident; when auto-router is turned off we
// stop re-pinning and Ollama lets it unload on its own after the window.

const WARM_KEEP_ALIVE = '30m';            // how long Ollama holds the model
const WARM_INTERVAL_MS = 10 * 60 * 1000;  // re-pin every 10m (well inside 30m)

let warmTimer: ReturnType<typeof setInterval> | null = null;

async function pinEmbedder(): Promise<void> {
  try {
    const { isAutoRouterInUse } = await import('./gating.js');
    if (!isAutoRouterInUse()) return;
    await generateEmbedding(TASK_PREFIX + 'warmup', { keepAlive: WARM_KEEP_ALIVE });
    // FA-R4: pre-build the tier centroids off the critical path so the first
    // auto-routed turn after boot never pays the 52-embed build inline. Gated on
    // auto-router (above) and single-flighted + cached by getCentroids, so this is
    // a cheap no-op once built. Awaited here (background, unref'd timer) so a build
    // failure just re-arms for the next interval.
    await getCentroids();
  } catch { /* best effort */ }
}

export function startEmbedderWarmer(): void {
  if (warmTimer) return;
  // Pin immediately (gated), then re-assert on the interval.
  void pinEmbedder();
  warmTimer = setInterval(() => { void pinEmbedder(); }, WARM_INTERVAL_MS);
  if (typeof warmTimer.unref === 'function') warmTimer.unref();
}

export function stopEmbedderWarmer(): void {
  if (warmTimer) {
    clearInterval(warmTimer);
    warmTimer = null;
  }
}

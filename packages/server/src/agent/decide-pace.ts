// ════════════════════════════════════════════════════════════════════════════
// v3.5 (proof-fix T) — decide()'s PATIENCE, LEARNED FROM THIS BOX'S OWN CALLS.
//
// `decideTimeoutMs` (decide-sizing.ts) is B5's fit from one fast Mac: a warm call takes F = 62 + 1.33·T + 94·(Q−1) ms
// and the call is given F × 2.05 (the observed ÷ fitted p99). On a slower box (an 8 GB laptop) the same F is too
// short and calls that would have answered are cut. So the 2.05 is the PRIOR of a per-box PACE: each call that
// answers teaches the pace the ratio latency ÷ F, and a call cut by its OWN clock teaches that the true ratio is
// AT LEAST the one it was given (a censored sample — it records no latency, which is why a naive learner never
// lengthens a slow box's patience) — but ONLY when the runner was seen working on it (`services/ollama-runner-progress.ts`,
// asked by decide.ts): a hung model teaches nothing, so repeated hangs never lengthen the wait. The pace is never below the prior, so a fast box keeps today's behaviour exactly.
//
// Samples are the last few calls' [at, ratio, cut] in the `config` table (key `decide_pace.<model>`), the same place
// and the same best-effort handling as `services/token-density.ts`: a missing, corrupt or unreadable store is the
// prior; an older build ignores the key; nothing here ever throws into the call it rides on.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';

/** B5's observed ÷ fitted at p99 — the pace of a box that has no samples (and the floor of every box's). */
export const PRIOR_PACE = 2.05;
/** A pace is the box's 95th-percentile ratio with a quarter on top, so one slow call does not set the next one's clock. */
const QUANTILE = 0.95;
const HEADROOM = 1.25;
/** A call cut at ratio b has a true ratio above b and nothing says by how much: the next try is half as long again. */
const CUT_GROWTH = 1.5;
/** Recent calls are kept, not a count of quota: the box's speed changes (a busy week, a fresh model), old samples must age out. */
const KEEP = 40;

type Sample = [atMs: number, ratio: number, cut: 0 | 1];
const keyOf = (modelId: string): string => `decide_pace.${modelId}`;
const legal = (s: unknown): s is Sample =>
  Array.isArray(s) && s.length === 3 && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > 0 && (s[2] === 0 || s[2] === 1);

function samplesOf(modelId: string): Sample[] {
  try {
    const raw = (getDb().prepare('SELECT value FROM config WHERE key = ?').get(keyOf(modelId)) as { value: string } | undefined)?.value;
    const all = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(all) ? all.filter(legal) : [];
  } catch { return []; }
}

/** What each sample says the box needs, as a ratio: a call that answered, its ratio; a call that was cut, one step past
 *  the ratio it was given — unless a call that answered since proved a ratio at least that long (then it was just slow). */
function needs(samples: Sample[]): number[] {
  const longestAnswer = Math.max(0, ...samples.filter((s) => s[2] === 0).map((s) => s[1]));
  return samples.flatMap((s) => (s[2] === 0 ? [s[1]] : s[1] <= longestAnswer ? [] : [s[1] * CUT_GROWTH]));
}

/** The pace this box's calls are given: its own 95th percentile with headroom, never below B5's prior. */
export function decidePace(modelId: string | null | undefined): number {
  const xs = modelId ? needs(samplesOf(modelId)).sort((a, b) => a - b) : [];
  if (xs.length === 0) return PRIOR_PACE;
  return Math.max(PRIOR_PACE, HEADROOM * xs[Math.ceil(QUANTILE * xs.length) - 1]);
}

/** One call's outcome as a ratio of its fitted time `fitMs`: `tookMs` answered, or (`cut`) was cut by its own clock at
 *  `tookMs`. Best-effort; never throws. */
export function recordDecidePace(modelId: string | null | undefined, tookMs: number, fitMs: number, cut: boolean): void {
  if (!modelId || !(tookMs > 0) || !(fitMs > 0)) return;
  try {
    getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(keyOf(modelId), JSON.stringify([...samplesOf(modelId), [Date.now(), tookMs / fitMs, cut ? 1 : 0]].slice(-KEEP)));
  } catch { /* a sample is a courtesy; never break the call it rides on */ }
}

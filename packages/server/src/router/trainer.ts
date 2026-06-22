// ════════════════════════════════════════
// On-device Head Trainer
// Trains a multinomial logistic-regression head over router_labels and promotes
// it only if it beats the current champion on a held-out slice (champion/
// challenger). Pure CPU, no framework. Runs infrequently from the maintenance
// loop, never in the request path. See SEMANTIC-ROUTER-PLAN (local doc).
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { TIERS, type Tier } from './exemplars.js';
import { loadLabels, type LabelRow } from './labels.js';
import { saveHead, getActiveHeadEval } from './head.js';

const logger = createLogger('router-trainer');

const WINDOW = 2000;          // rolling training window (most recent labels)
const MIN_LABELS = 120;       // don't train on too little data
const ITERATIONS = 150;
const LEARNING_RATE = 0.5;
const L2 = 1e-3;              // regularization toward zero
const MIN_PROMOTE_ACC = 0.6;  // a challenger must clear this to ever go live
const PROMOTE_MARGIN = 0.02;  // ...and beat the current champion by this much
const HOLDOUT_EVERY = 5;      // every 5th example (by recency) is held out

export interface TrainResult {
  trained: boolean;
  promoted: boolean;
  reason: string;
  evalScore?: number;
  trainedOn?: number;
}

function l2normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function argmax(arr: number[]): number {
  let bi = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[bi]) bi = i;
  return bi;
}

export function trainAndMaybePromote(): TrainResult {
  const rows = loadLabels(WINDOW);
  if (rows.length < MIN_LABELS) {
    return { trained: false, promoted: false, reason: `not enough labels (${rows.length}/${MIN_LABELS})` };
  }

  const dim = rows[0].dimensions;
  // Guard against mixed-dimension rows (e.g., embedder model changed).
  const clean = rows.filter(r => r.dimensions === dim);
  if (clean.length < MIN_LABELS) {
    return { trained: false, promoted: false, reason: 'not enough labels at a consistent dimension' };
  }

  const classIndex: Record<Tier, number> = { light: 0, standard: 1, heavy: 2 };
  const K = TIERS.length;

  // Deterministic train/holdout split by recency index (no RNG).
  const train: LabelRow[] = [];
  const holdout: LabelRow[] = [];
  clean.forEach((r, i) => (i % HOLDOUT_EVERY === 0 ? holdout : train).push(r));
  if (train.length < MIN_LABELS - holdout.length || holdout.length === 0) {
    return { trained: false, promoted: false, reason: 'split too small' };
  }

  // Pre-normalize features.
  const Xtr = train.map(r => l2normalize(r.embedding));
  const ytr = train.map(r => classIndex[r.label]);
  const wtr = train.map(r => r.weight);

  // Weights: K rows of (dim + 1), last column is bias. Float64 for training.
  const stride = dim + 1;
  const W = new Float64Array(K * stride);

  // Batch gradient descent on softmax cross-entropy with L2.
  const grad = new Float64Array(K * stride);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    grad.fill(0);
    let totalW = 0;
    for (let s = 0; s < Xtr.length; s++) {
      const x = Xtr[s];
      const sw = wtr[s];
      totalW += sw;
      // logits + softmax
      const logits = new Array<number>(K);
      for (let k = 0; k < K; k++) {
        const base = k * stride;
        let z = W[base + dim];
        for (let i = 0; i < dim; i++) z += W[base + i] * x[i];
        logits[k] = z;
      }
      const mx = Math.max(...logits);
      let sum = 0;
      const p = logits.map(l => { const e = Math.exp(l - mx); sum += e; return e; });
      for (let k = 0; k < K; k++) p[k] /= sum;
      // gradient
      for (let k = 0; k < K; k++) {
        const gl = (p[k] - (ytr[s] === k ? 1 : 0)) * sw;
        const base = k * stride;
        for (let i = 0; i < dim; i++) grad[base + i] += gl * x[i];
        grad[base + dim] += gl;
      }
    }
    const scale = LEARNING_RATE / Math.max(totalW, 1);
    for (let k = 0; k < K; k++) {
      const base = k * stride;
      for (let i = 0; i < dim; i++) {
        const g = grad[base + i] + L2 * W[base + i]; // regularize weights, not bias
        W[base + i] -= scale * g;
      }
      W[base + dim] -= scale * grad[base + dim];
    }
  }

  // Evaluate on holdout.
  let correct = 0;
  for (const r of holdout) {
    const x = l2normalize(r.embedding);
    const logits = new Array<number>(K);
    for (let k = 0; k < K; k++) {
      const base = k * stride;
      let z = W[base + dim];
      for (let i = 0; i < dim; i++) z += W[base + i] * x[i];
      logits[k] = z;
    }
    if (argmax(logits) === classIndex[r.label]) correct++;
  }
  const evalScore = correct / holdout.length;

  // Champion/challenger: only promote a clearly-better head.
  const championEval = getActiveHeadEval();
  const beatsFloor = evalScore >= MIN_PROMOTE_ACC;
  const beatsChampion = championEval === null || evalScore > championEval + PROMOTE_MARGIN;
  const promote = beatsFloor && beatsChampion;

  const version = `head-${clean.length}-${Math.round(evalScore * 1000)}`;
  const weightsF32 = new Float32Array(W);
  saveHead({
    version,
    weights: weightsF32,
    dimensions: dim,
    classes: TIERS,
    trainedOn: train.length,
    evalScore,
    activate: promote,
  });

  const reason = promote
    ? `promoted (eval ${evalScore.toFixed(3)} vs champion ${championEval === null ? 'none' : championEval.toFixed(3)})`
    : `kept as challenger (eval ${evalScore.toFixed(3)}, floor ${MIN_PROMOTE_ACC}, champion ${championEval === null ? 'none' : championEval.toFixed(3)})`;
  logger.info('Router head training complete', { promote, evalScore, trainedOn: train.length, holdout: holdout.length });
  return { trained: true, promoted: promote, reason, evalScore, trainedOn: train.length };
}

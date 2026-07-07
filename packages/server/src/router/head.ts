// ════════════════════════════════════════
// Router Head (on-device trained classifier)
// A multinomial logistic-regression head mapping a query embedding to a tier.
// Trained on-device from router_labels (see trainer.ts) and stored in the
// router_head table. The semantic classifier prefers an active head over the
// shipped exemplar centroids. Weights are a Float32 blob, row-major per class,
// each class row being [w_0 .. w_{D-1}, bias].
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { TIERS, type Tier } from './exemplars.js';

const logger = createLogger('router-head');

// FA-X7(a): saveHead INSERTs a row on EVERY weekly train, promoted or not, and
// nothing ever pruned them, so challenger (is_active = 0) rows grew without
// bound. After each save, keep only the most-recent HEAD_HISTORY_KEEP inactive
// rows; every active/promoted row is kept regardless (the DELETE only ever
// touches is_active = 0). getActiveHead / getActiveHeadEval only ever read
// is_active = 1, so a pruned challenger can never be loaded.
const HEAD_HISTORY_KEEP = 8;

export interface ActiveHead {
  version: string;
  dimensions: number;
  classes: Tier[];
  predict(emb: Float32Array): Record<Tier, number>;
}

let cache: ActiveHead | null = null;
let loaded = false;

export function clearHeadCache(): void {
  cache = null;
  loaded = false;
}

export function getActiveHead(): ActiveHead | null {
  if (loaded) return cache;
  loaded = true;
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT version, weights, dimensions, classes
      FROM router_head WHERE is_active = 1
      ORDER BY trained_at DESC LIMIT 1
    `).get() as { version: string; weights: Buffer; dimensions: number; classes: string } | undefined;
    if (!row) { cache = null; return null; }

    const classes = JSON.parse(row.classes) as Tier[];
    const dim = row.dimensions;
    const stride = dim + 1; // weights + bias
    const w = new Float32Array(row.weights.buffer, row.weights.byteOffset, row.weights.byteLength / 4);

    cache = {
      version: row.version,
      dimensions: dim,
      classes,
      predict(emb: Float32Array): Record<Tier, number> {
        const logits: number[] = [];
        for (let ci = 0; ci < classes.length; ci++) {
          const base = ci * stride;
          let s = w[base + dim]; // bias
          for (let i = 0; i < dim; i++) s += w[base + i] * emb[i];
          logits.push(s);
        }
        const m = Math.max(...logits);
        let sum = 0;
        const exps = logits.map(l => { const e = Math.exp(l - m); sum += e; return e; });
        const out = {} as Record<Tier, number>;
        for (const t of TIERS) out[t] = 0;
        for (let ci = 0; ci < classes.length; ci++) out[classes[ci]] = exps[ci] / sum;
        return out;
      },
    };
    logger.info('Active router head loaded', { version: row.version, dimensions: dim });
    return cache;
  } catch (err) {
    logger.debug('No active router head', { error: err instanceof Error ? err.message : String(err) });
    cache = null;
    return null;
  }
}

export function getActiveHeadEval(): number | null {
  try {
    const row = getDb().prepare(
      'SELECT eval_score FROM router_head WHERE is_active = 1 ORDER BY trained_at DESC LIMIT 1'
    ).get() as { eval_score: number | null } | undefined;
    return row?.eval_score ?? null;
  } catch {
    return null;
  }
}

export function saveHead(params: {
  version: string;
  weights: Float32Array;
  dimensions: number;
  classes: Tier[];
  trainedOn: number;
  evalScore: number;
  activate: boolean;
}): void {
  const db = getDb();
  const tx = db.transaction(() => {
    if (params.activate) {
      db.prepare('UPDATE router_head SET is_active = 0 WHERE is_active = 1').run();
    }
    db.prepare(`
      INSERT INTO router_head (id, version, weights, dimensions, classes, trained_on, eval_score, is_active, trained_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuidv4(),
      params.version,
      Buffer.from(params.weights.buffer, params.weights.byteOffset, params.weights.byteLength),
      params.dimensions,
      JSON.stringify(params.classes),
      params.trainedOn,
      params.evalScore,
      params.activate ? 1 : 0,
    );
    // FA-X7(a): prune old challenger heads. Delete every inactive row except
    // the HEAD_HISTORY_KEEP most-recently-trained ones. Active rows are never
    // eligible (is_active = 0 guard), so the live head and any promoted
    // history survive.
    db.prepare(`
      DELETE FROM router_head
      WHERE is_active = 0
        AND id NOT IN (
          SELECT id FROM router_head
          WHERE is_active = 0
          ORDER BY trained_at DESC
          LIMIT ?
        )
    `).run(HEAD_HISTORY_KEEP);
  });
  tx();
  clearHeadCache();
  logger.info('Router head saved', {
    version: params.version, activated: params.activate, evalScore: params.evalScore, trainedOn: params.trainedOn,
  });
}

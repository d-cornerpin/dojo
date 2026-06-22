// ════════════════════════════════════════
// Router Label Collection
// Stores (embedding -> correct tier) training examples for the on-device head.
// Labels come from independent signals, never from the router's own past tier
// choices (that would re-bake existing bias). Sources:
//   - 'implicit_under': under-routing signal (cheap tier was too weak)
//   - 'probe_down':     over-routing confirmed by a low-confidence shadow probe
//   - 'correction':     explicit user correction (future)
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { embedQuery } from './semantic.js';
import type { Tier } from './exemplars.js';

const logger = createLogger('router-labels');

export type LabelSource = 'implicit_under' | 'probe_down' | 'correction';

export async function recordLabel(
  agentId: string | null,
  query: string,
  label: Tier,
  source: LabelSource,
  weight = 1.0,
): Promise<void> {
  try {
    const emb = await embedQuery(query);
    if (!emb) return;
    const db = getDb();
    db.prepare(`
      INSERT INTO router_labels (id, agent_id, embedding, dimensions, label, source, weight, query_preview, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuidv4(),
      agentId,
      Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength),
      emb.length,
      label,
      source,
      weight,
      query.slice(0, 120),
    );
    logger.debug('Router label recorded', { label, source });
  } catch (err) {
    logger.debug('recordLabel failed (best-effort)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function countLabels(): number {
  try {
    return (getDb().prepare('SELECT COUNT(*) AS c FROM router_labels').get() as { c: number }).c;
  } catch {
    return 0;
  }
}

// Loaded for training. Rolling window keeps adaptation responsive without
// letting an anomalous stretch dominate.
export interface LabelRow {
  embedding: Float32Array;
  dimensions: number;
  label: Tier;
  weight: number;
}

export function loadLabels(windowSize: number): LabelRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT embedding, dimensions, label, weight
    FROM router_labels ORDER BY created_at DESC LIMIT ?
  `).all(windowSize) as Array<{ embedding: Buffer; dimensions: number; label: Tier; weight: number }>;

  return rows.map(r => ({
    embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.dimensions),
    dimensions: r.dimensions,
    label: r.label,
    weight: r.weight,
  }));
}

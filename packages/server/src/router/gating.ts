// ════════════════════════════════════════
// Auto-router Gating
// The semantic router, its keep-warm, label collection, probing, and the
// maintenance loop must all stay dormant unless at least one agent is actually
// on auto-routing. An agent is auto-routed when agents.model_id = 'auto'
// (the per-decision gate lives in agent/v2/loop.ts as isAutoRouted).
//
// The check is a microsecond PK-scan, so it is intentionally uncached: simpler
// and always correct, no invalidation to get wrong. Revisit only if it ever
// shows up in a hot path (it is only called on interval ticks today).
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';

export function isAutoRouterInUse(): boolean {
  try {
    const row = getDb()
      .prepare("SELECT EXISTS(SELECT 1 FROM agents WHERE model_id = 'auto') AS inUse")
      .get() as { inUse: number };
    return row.inUse === 1;
  } catch {
    return false;
  }
}

// Router machinery stays dormant unless an agent is on auto-routing (agents.model_id = 'auto'); the
// per-turn gate is isAutoRouted (router-window.ts, preflight/turn-trigger.ts). Uncached: a cheap PK scan.

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

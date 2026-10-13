// ════════════════════════════════════════════════════════════════════════════════════════
// t140 — THE TURN'S PATIENCE: how long condensing work may hold the owner's turn.
//
// The out-of-view fold (round 5) and the forced emergency pass (round 6, H3) both sit in front of
// the turn's own model call. Neither has a clock of its own: each may take as long as the owner
// already lets the model this turn dials take to start answering — its provider's declared
// first-chunk patience, or the transport's standing one. One owner of that number, so the two can
// never disagree. (Owner ruling 2026-10-13: no hard limits; the dojo knows when enough is enough.)
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { resolveStreamPatience } from '../agent/stream-patience.js';

/** `dialedModelId` when the caller knows the pick; else the agent's configured model's (an
 *  auto-routed agent's assembly, before the router names its pick, gets the standing one). */
export function turnPatienceMs(agentId: string, dialedModelId?: string): number {
  try {
    const db = getDb();
    const modelId = dialedModelId ?? (db.prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id;
    const row = modelId ? db.prepare(
      'SELECT p.first_chunk_timeout_ms AS ms FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?',
    ).get(modelId) as { ms: number | null } | undefined : undefined;
    return resolveStreamPatience({ firstChunkTimeoutMs: row?.ms ?? null, streamIdleTimeoutMs: null }).firstChunkMs;
  } catch {
    return resolveStreamPatience(null).firstChunkMs;
  }
}

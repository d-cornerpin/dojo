// Condensing work may hold the owner's turn only as long as the dialed model takes to start answering (its
// provider's first-chunk patience, else the transport's): one owner of that number.
import { getDb } from '../db/connection.js';
import { resolveStreamPatience } from '../agent/stream-patience.js';

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

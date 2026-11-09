// What the ladder tests read back: the hints an agent was sent, the trail entries the ladder left, the
// owner's cards and texts, and a PM review run against a stand-in runtime.
//
//   vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
//   vi.mock('../../../services/imessage-bridge.js', async (orig) => ({ ...(await orig()), sendAlert: texts }));
import { vi } from 'vitest';
import { doneDb } from './done-db.js';

export const MIN = 60_000;

/** The stand-in runtime: what the PM's review turn did (`ran`, or `queued` then how the queued turn ended). */
export const turn: { asked: 'ran' | 'queued' | 'not-run'; queued: 'ran' | 'not-run'; during: () => void } = { asked: 'ran', queued: 'ran', during: () => {} };
export function runtimeMock(): { getAgentRuntime: () => unknown } {
  return {
    getAgentRuntime: () => ({
      handleMessage: async () => { turn.during(); return turn.asked; },
      whenQueuedRunEnds: async () => turn.queued,
    }),
  };
}

/** Every owner card and owner text raised, by the broadcast and the bridge's text door. */
export const cards: Array<{ error: string; cardKey?: string }> = [];
export const texts = vi.fn(async () => {});
export function wsMock(): { broadcast: (e: { type: string; error?: string; cardKey?: string; severity?: string }) => void; stampPersistedRow: (e: unknown) => unknown } {
  return {
    broadcast: (e) => { if (e.type === 'chat:error' && e.error && e.severity !== 'info') cards.push({ error: e.error, cardKey: e.cardKey }); },
    stampPersistedRow: (e) => e,
  };
}

/** The engine hints `agentId` was sent. */
export const hintsTo = (agentId: string): string[] => (doneDb().prepare(
  "SELECT content FROM messages WHERE agent_id = ? AND content LIKE '[Engine hint:%' ORDER BY seq",
).all(agentId) as Array<{ content: string }>).map((r) => r.content);

/** The trail entries of one kind on a row. */
export const entries = (workId: string, entryKind: string): number => (doneDb().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = ?",
).get(workId, entryKind) as { n: number }).n;

/** The PM's newest situation report, or ''. */
export const lastReport = (pmId: string): string => (doneDb().prepare(
  "SELECT content FROM messages WHERE agent_id = ? AND origin_intent = 'pm_review' ORDER BY seq DESC LIMIT 1",
).get(pmId) as { content: string } | undefined)?.content ?? '';

/** Give the PM a model, so its review can run. */
export function pmCanRun(pmId: string): void {
  doneDb().prepare("INSERT OR IGNORE INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at) VALUES ('p', 'P', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1, datetime('now'), datetime('now'))").run();
  doneDb().prepare("INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at) VALUES ('m', 'p', 'M', 'm', '[\"text\"]', 32000, 1024, 1, datetime('now'), datetime('now'))").run();
  doneDb().prepare("UPDATE agents SET model_id = 'm' WHERE id = ?").run(pmId);
}

/** Reset what the stand-ins recorded. */
export function resetLadderWorld(): void {
  cards.length = 0;
  texts.mockClear();
  Object.assign(turn, { asked: 'ran', queued: 'ran', during: () => {} });
}

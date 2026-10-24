// K36 — GET /api/agents/:id/prompt-cost: the agent's standing instruction piece by piece,
// biggest first, with its token cost, share, and growth, plus the tool head. A report, not a limit.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 4321 }));

import { runMigrations } from '../../../db/migrations.js';
import { recordPromptSections } from '../../../memory/prompt-sections.js';
import { promptCostRouter } from '../prompt-cost.js';

const J = '\n\n---\n\n';
const AGENT = 'agent-cost';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES (?, 'Cost', 'idle', '{}')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const get = async (id: string) => promptCostRouter.request(`/${id}/prompt-cost`);

describe('GET /:id/prompt-cost', () => {
  it('lists every section biggest first, with tokens, share of the standing instruction and the tool head', async () => {
    recordPromptSections(AGENT, ['a'.repeat(400), 'b'.repeat(1200 - J.length), 'c'.repeat(400 - J.length)].join(J), ['sys.small', 'sys.big', 'sys.mid'],
      [{ id: 'lane.fresh-tail', slot: 5, priority: 1, requested: 500, granted: 500, status: 'admitted', reason: 'ok' }]);
    const res = await get(AGENT);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: any };
    expect(body.data.sections.map((s: any) => s.entryId)).toEqual(['sys.big', 'sys.mid', 'sys.small']);
    expect(body.data.sections[0]).toMatchObject({ tokens: 300, share: 300 / 500 });
    expect(body.data.systemTokens).toBe(500);
    expect(body.data.lanes).toEqual([expect.objectContaining({ entryId: 'lane.fresh-tail', tokens: 500, share: 1 })]);
    expect(body.data.toolHeadTokens).toBe(4321);
  });

  it('an agent that has not been assembled yet gets an empty list, not an error', async () => {
    const res = await get(AGENT);
    expect(res.status).toBe(200);
    expect((await res.json() as any).data.sections).toEqual([]);
  });

  it('an unknown agent is a 404', async () => {
    expect((await get('nobody')).status).toBe(404);
  });
});

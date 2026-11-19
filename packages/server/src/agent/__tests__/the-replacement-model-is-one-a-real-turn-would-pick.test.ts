// The model an agent is moved to must support tools and must fit this Mac's memory, as a real turn requires.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../local-model-fit.js', async (orig) => ({
  ...(await orig<typeof import('../local-model-fit.js')>()),
  localModelFit: async (id: string) => (id === 'too-big'
    ? { fits: false, message: 'too big', openBytes: 0, needBytes: 1, contextTokens: 1 }
    : null),
}));

import { runMigrations } from '../../db/migrations.js';
import { cheapestAgentModel } from '../main-model-floor.js';

const model = (id: string, caps: string, cost: number): void => {
  mockDb.current!.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled)
    VALUES (?, 'p', ?, ?, ?, 128000, ?, 1)`).run(id, id, id, caps, cost);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare('DELETE FROM models').run();
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('p', 'P', 'openai', 'https://api.example.com/v1', 'api_key', 1)").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the replacement model for an agent', () => {
  it('skips a cheaper model that cannot call tools', async () => {
    model('no-tools', '["text"]', 0);
    model('tooled', '["text","tools"]', 2);
    expect(await cheapestAgentModel()).toBe('tooled');
  });
  it('skips a cheaper local model that does not fit this Mac', async () => {
    model('too-big', '["text","tools"]', 0);
    model('fits', '["text","tools"]', 2);
    expect(await cheapestAgentModel()).toBe('fits');
  });
});

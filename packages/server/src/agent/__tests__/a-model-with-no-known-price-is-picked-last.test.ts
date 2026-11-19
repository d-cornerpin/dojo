// The replacement pick for an agent prefers a free local model to a model whose price is unknown.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../db/migrations.js';
import { cheapestAgentModel } from '../main-model-floor.js';

const model = (id: string, cost: number | null): void => {
  mockDb.current!.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled)
    VALUES (?, 'p', ?, ?, '["chat"]', 128000, ?, 1)`).run(id, id, id, cost);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare('DELETE FROM models').run();
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('p', 'P', 'openai', 'https://api.example.com/v1', 'api_key', 1)").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the cheapest agent model', () => {
  it('a free local model beats one with no known price, and a priced one beats the unpriced too', async () => {
    model('a-unpriced', null);
    model('b-paid', 3);
    model('c-free', 0);
    expect(await cheapestAgentModel()).toBe('c-free');
    expect(await cheapestAgentModel(['c-free'])).toBe('b-paid');
    expect(await cheapestAgentModel(['c-free', 'b-paid'])).toBe('a-unpriced');
  });
});

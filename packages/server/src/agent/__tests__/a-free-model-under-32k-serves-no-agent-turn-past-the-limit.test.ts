// Past the spending limit an agent turn goes only to a free model that clears the 32K floor; with none, the
// turn stops on the limit. A helper job may still use the small free model.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { redirectToAFreeModel } from '../budget-redirect.js';

const check = { allowed: false, reason: 'Daily budget limit reached.', freeModelFallbacks: [{ modelId: 'm-free-small', modelName: 'Small', providerId: 'local' }] };
const dialed: string[] = [];
const dial = async (p: { modelId: string }) => { dialed.push(p.modelId); return { content: 'ok' } as never; };

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('local', 'Local', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, output_cost_per_m, is_enabled)
    VALUES ('m-free-small', 'local', 'Small', 'small', '["chat","tools"]', 8192, 0, 0, 1)`).run();
  dialed.length = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a free model under 32K serves no agent turn past the limit', () => {
  it('the agent turn stops on the limit without dialing it; a helper job dials it', async () => {
    await expect(redirectToAFreeModel({ agentId: 'a', modelId: 'm-paid', purpose: 'agent_turn' } as never, check as never, dial as never))
      .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(dialed).toEqual([]);
    await redirectToAFreeModel({ agentId: 'a', modelId: 'm-paid', purpose: 'summary' } as never, check as never, dial as never);
    expect(dialed).toEqual(['m-free-small']);
  });
});

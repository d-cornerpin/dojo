// A call estimated at $0 is never over a limit, and the free stand-ins never include the decision model.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../services/imessage-bridge.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendAlert: vi.fn(async () => undefined),
}));

import { runMigrations } from '../../db/migrations.js';
import { checkBudget } from '../budget.js';
import { exceededBudget, invalidateDailySpendCache } from '../spend.js';

describe('a free call is never over the daily limit', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations();
    mockDb.current.exec(`
      INSERT INTO providers (id, name, type, auth_type) VALUES ('paid', 'Paid', 'openai', 'api_key');
      INSERT INTO providers (id, name, type, auth_type) VALUES ('loc', 'Local', 'ollama', 'none');
      INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, output_cost_per_m, is_enabled)
        VALUES ('m-paid', 'paid', 'Paid Model', 'paid-1', '["tools"]', 200000, 1, 1, 1);
      INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, output_cost_per_m, is_enabled)
        VALUES ('m-chat0', 'loc', 'Chat Zero', 'chat0', '["tools"]', 65536, 0, 0, 1);
      INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, output_cost_per_m, is_enabled)
        VALUES ('m-dec', 'loc', 'Decider', 'dec', '["decision"]', 8192, 0, 0, 1);
      INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
        VALUES ('cr-1', 'a1', 'm-paid', 'paid', 0, 0, 30, datetime('now'));
    `);
    invalidateDailySpendCache();
  });

  afterEach(() => {
    mockDb.current?.close();
    mockDb.current = null;
  });

  it('a call that costs nothing is not over the limit', () => {
    expect(exceededBudget('a1', 0)).toBeNull();
    expect(checkBudget('a1', 0).allowed).toBe(true);
  });

  it('a paid call is still over the limit', () => {
    const r = checkBudget('a1', 0.01);
    expect(r.allowed).toBe(false);
    expect(r.budgetExceeded).toBe(true);
    expect(r.dailySpend).toBe(30);
    expect(r.dailyLimit).toBe(25);
    expect(r.reason).toBe('Daily budget limit reached ($30.00 spent of $25.00 limit).');
  });

  it('the decision model is never the free stand-in', () => {
    expect(checkBudget('a1', 0.01).freeModelFallbacks?.map((m) => m.modelId)).toEqual(['m-chat0']);
  });

  it('an agent limit still holds', () => {
    mockDb.current!.prepare(`DELETE FROM budgets WHERE id = 'global_daily'`).run();
    mockDb.current!.prepare(`
      INSERT INTO budgets (id, scope, limit_usd, period, created_at, updated_at)
      VALUES ('agent_a1', 'agent', 10, 'daily', datetime('now'), datetime('now'))
    `).run();
    invalidateDailySpendCache();
    const r = checkBudget('a1', 0.01);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('Agent budget exceeded: $30.0000 spent of $10 limit (daily)');
    expect(checkBudget('a1', 0).allowed).toBe(true);
  });
});

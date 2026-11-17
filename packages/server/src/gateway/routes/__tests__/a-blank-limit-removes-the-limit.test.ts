// A blank limit (0 or null) removes the budget row: there is no limit any more.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendAlert: vi.fn(async () => undefined),
}));

import { runMigrations } from '../../../db/migrations.js';
import { costsRouter } from '../costs.js';
import { exceededBudget } from '../../../costs/spend.js';

const put = (path: string, body: unknown) => costsRouter.request(path, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}) as Promise<Response>;
const budgetRows = (id: string) => (mockDb.current!.prepare('SELECT COUNT(*) AS n FROM budgets WHERE id = ?').get(id) as { n: number }).n;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('PUT /budget routes, a blank limit removes the limit', () => {
  it('a null global limit removes the limit', async () => {
    const r = await put('/budget/global', { limitUsd: null });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, data: { scope: 'global', limitUsd: null, period: 'daily' } });
    expect(budgetRows('global_daily')).toBe(0);
    expect(exceededBudget('nobody', 1000)).toBeNull();
  });

  it('a zero global limit removes the limit', async () => {
    const r = await put('/budget/global', { limitUsd: 0 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, data: { scope: 'global', limitUsd: null, period: 'daily' } });
    expect(budgetRows('global_daily')).toBe(0);
    expect(exceededBudget('nobody', 1000)).toBeNull();
  });

  it('a null agent limit removes that agent\'s limit', async () => {
    await put('/budget/agent/a1', { limitUsd: 5, period: 'weekly' });
    expect(budgetRows('agent_a1')).toBe(1);
    const r = await put('/budget/agent/a1', { limitUsd: null, period: 'weekly' });
    expect(await r.json()).toEqual({ ok: true, data: { agentId: 'a1', limitUsd: null, period: 'weekly' } });
    expect(budgetRows('agent_a1')).toBe(0);
  });

  it('a negative limit is refused', async () => {
    const r = await put('/budget/global', { limitUsd: -1 });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: 'limitUsd must be a number above 0, or 0 or null for no limit' });
    expect(budgetRows('global_daily')).toBe(1);
  });

  it('a positive limit still sets the limit', async () => {
    const r = await put('/budget/global', { limitUsd: 12 });
    expect((await r.json()).data).toEqual({ scope: 'global', limitUsd: 12, period: 'daily' });
    const row = mockDb.current!.prepare("SELECT limit_usd FROM budgets WHERE id = 'global_daily'").get() as { limit_usd: number };
    expect(row.limit_usd).toBe(12);
  });
});

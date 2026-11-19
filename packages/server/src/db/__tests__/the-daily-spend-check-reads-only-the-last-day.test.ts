// The daily-spend check (costs/spend.ts getDailySpend) filters cost_records by created_at alone. Its plan must
// seek an index, not read every cost ever written, and its sum must count only the last day.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as w from '../../services/__tests__/mail-world.js';

vi.mock('../connection.js', async () => (await import('../../services/__tests__/mail-world.js')).dbModule());

import { getDailySpend, invalidateDailySpendCache } from '../../costs/spend.js';

beforeEach(async () => { await w.freshWorld(); invalidateDailySpendCache(); });

const addCost = (id: string, usd: number, age: string): void => {
  w.world.db!.prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
                       VALUES (?, 'primary', 'm', 'p', 1, 1, ?, datetime('now', ?))`).run(id, usd, age);
};

describe('the daily spend check reads only the last day', () => {
  it('the sum is planned through the created_at index', () => {
    const plan = w.world.db!.prepare(`EXPLAIN QUERY PLAN SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_records WHERE created_at >= datetime('now', '-1 day')`).all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' | ')).toContain('idx_cost_records_created_at');
  });

  it('the sum counts only the last day', () => {
    addCost('c-old', 5, '-2 days');
    addCost('c-new', 1.25, '-1 hours');
    expect(getDailySpend()).toBe(1.25);
  });
});

// Activity logs are trimmed daily and spending is not: one job keeps 180 days of the Google and Microsoft activity
// rows (30 for the watchers' own polls) and leaves every other table as it was.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as w from '../../services/__tests__/mail-world.js';

vi.mock('../connection.js', async () => (await import('../../services/__tests__/mail-world.js')).dbModule());

import { runDailyDatabaseUpkeep } from '../daily-upkeep.js';

beforeEach(() => w.freshWorld());
const add = (table: string, id: string, agentId: string, age: string): void => {
  w.world.db!.prepare(`INSERT INTO ${table} (id, agent_id, action, action_type, created_at) VALUES (?, ?, 'x', 'read', datetime('now', ?))`).run(id, agentId, age);
};
const ids = (table: string): string[] =>
  (w.world.db!.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);

describe('activity rows older than 180 days are trimmed and spending is not', () => {
  it.each(['microsoft_activity', 'google_activity'])('%s keeps exactly the rows the rule keeps', async (t) => {
    add(t, 'a-agent-181d', 'primary', '-181 days');
    add(t, 'b-agent-179d', 'primary', '-179 days');
    add(t, 'c-poll-31d', 'system', '-31 days');
    add(t, 'd-poll-29d', 'system', '-29 days');
    await runDailyDatabaseUpkeep();
    expect(ids(t)).toEqual(['b-agent-179d', 'd-poll-29d']);
  });

  it('a backlog larger than one batch is trimmed in one run', async () => {
    const ins = w.world.db!.prepare(`INSERT INTO microsoft_activity (id, agent_id, action, action_type, created_at) VALUES (?, 'system', 'x', 'read', datetime('now', '-40 days'))`);
    w.world.db!.transaction(() => { for (let i = 0; i < 12000; i++) ins.run(`old-${i}`); })();
    await runDailyDatabaseUpkeep();
    expect((w.world.db!.prepare('SELECT COUNT(*) AS n FROM microsoft_activity').get() as { n: number }).n).toBe(0);
  });

  it('spending is never trimmed', async () => {
    w.world.db!.prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
                         VALUES ('cost-400d', 'primary', 'm', 'p', 1, 1, 2.5, datetime('now', '-400 days'))`).run();
    await runDailyDatabaseUpkeep();
    expect(w.world.db!.prepare("SELECT id FROM cost_records WHERE id = 'cost-400d'").get()).toEqual({ id: 'cost-400d' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE COST-LIST ROW IS ONE PER CALL. `getCostRecords` joins `router_log` on model + agent +
// second-granular `created_at`, so two routing decisions in the same second duplicate the call;
// `total` counts `cost_records` only, so the list can show more rows than it says.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-cost-records-once', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { getCostRecords } from '../tracker.js';

const db = (): Database.Database => mockDb.current!;

/** One cost row and two routing decisions that landed in the same second for the same call. */
function twoDecisionsOneSecond(): void {
  const d = db();
  d.prepare(`
    INSERT INTO cost_records
      (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
    VALUES ('cr-1', 'ag', 'mdl', 'prov', 1000, 100, 0.01, '2020-01-01 12:00:00')
  `).run();
  // Two quick calls: two router_log rows, identical agent_id / selected_model_id / created_at.
  d.prepare(`
    INSERT INTO router_log
      (id, agent_id, dimension_scores, raw_score, tier_id, selected_model_id, created_at)
    VALUES ('rl-1', 'ag', '[]', 0.5, 'light', 'mdl', '2020-01-01 12:00:00')
  `).run();
  d.prepare(`
    INSERT INTO router_log
      (id, agent_id, dimension_scores, raw_score, tier_id, selected_model_id, created_at)
    VALUES ('rl-2', 'ag', '[]', 0.5, 'standard', 'mdl', '2020-01-01 12:00:00')
  `).run();
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the cost list shows each call once', () => {
  it('RED-CRITICAL: two routing decisions in one second list the call once, not twice', () => {
    twoDecisionsOneSecond();
    const { records, total } = getCostRecords();
    expect(
      records.length,
      'one cost row matched two router_log rows, so the list shows the call twice',
    ).toBe(1);
    expect(
      records.length,
      'the list can show more rows than `total` — and paging then skips or repeats calls',
    ).toBe(total);
  });
});

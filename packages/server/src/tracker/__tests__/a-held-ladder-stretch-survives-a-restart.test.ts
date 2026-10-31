// A held stretch of the PM ladder (the sweep leaving a task alone while its assignee works) must
// survive a process restart. Before, it lived in process memory only, so a restart during a long
// carried job lost the stretch and the first sweep after the job counted its whole length as idleness.
// "Restart" here = the module graph is thrown away and loaded again; the database stays.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));

import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const MIN = 60_000;
const db = (): Database.Database => mockDb.current!;
const resumedRows = (id: string): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'ladder_resumed'",
).get(id) as { n: number }).n;

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'P', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'M', 'm')`).run();
  d.prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES ('helper', 'Helper', 'idle', 'm-a', 'apprentice')`).run();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

describe('a held ladder stretch is on the record, not in memory', () => {
  it('a restart in the middle of a long hold keeps the stretch: it closes with its full length', async () => {
    const t0 = Date.now();
    seedTrackerTask(db(), { id: 'x-1', agentId: 'helper', status: 'in_progress', title: 'a long job', opened_at: t0, updated_at: t0 } as never);
    const before = await import('../../work/ladder-clock.js');
    before.holdLadder('x-1', 'pm');
    vi.setSystemTime(t0 + 20 * MIN);
    vi.resetModules();                                   // the restart
    const after = await import('../../work/ladder-clock.js');
    after.holdLadder('x-1', 'pm');                       // the sweep after the restart: still held
    vi.setSystemTime(t0 + 50 * MIN);
    after.resumeLadder('x-1', 'pm', 5 * MIN);
    expect(resumedRows('x-1')).toBe(1);
    expect(after.heldMsSince('x-1', t0)).toBe(50 * MIN);
  });

  it('a short stretch leaves nothing behind (ordinary idleness), and the marker never shows in the task log', async () => {
    const t0 = Date.now();
    seedTrackerTask(db(), { id: 'x-2', agentId: 'helper', status: 'in_progress', title: 'a quick job', opened_at: t0, updated_at: t0 } as never);
    const clock = await import('../../work/ladder-clock.js');
    const { readAuditTrail } = await import('../../work/audit-trail.js');
    clock.holdLadder('x-2', 'pm');
    expect(readAuditTrail('x-2').map((r) => r.entry_kind)).not.toContain('ladder_held');
    vi.setSystemTime(t0 + MIN);
    clock.resumeLadder('x-2', 'pm', 5 * MIN);
    expect((db().prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = 'x-2'").get() as { n: number }).n).toBe(0);
  });
});

// Owner law: done is measured, never declared; an ack never closes a task. What the engine may count on
// its own (`engineProofLine`: strike-0 and strike-2 close on it, and every engine "already delivered"
// reading names it) includes a measure at 0 only when the count came DOWN to it: its first reading was
// above 0. A measure that counted nothing from the start (a glob of the wrong case, the wrong folder) is
// not work on record. A measure that could not be read at set takes its first successful reading as its start.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-came-down', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { engineProofLine } from '../../work/done/proof.js';
import { recordMeasured } from '../../work/ledger-store.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const db = (): Database.Database => mockDb.current!;
const MEASURE = JSON.stringify({ tool: 'file_list', args: { path: '~/Inbox', pattern: '*.pdf' }, unit: 'files' });

function measured(id: string, initial: number | null, remaining: number | null): void {
  seedTrackerTask(db(), { id, agentId: 'helper', status: 'in_progress', title: 'file the PDFs', opened_at: Date.now(), updated_at: Date.now(), priority: 'normal' } as never);
  db().prepare('UPDATE work SET measure_json = ?, measure_initial = ?, measure_remaining = ?, measure_at = ? WHERE id = ?')
    .run(MEASURE, initial, remaining, Date.now(), id);
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO agents (id, name, status) VALUES ('helper', 'Helper', 'idle')`).run();
});

describe('an engine close counts a 0 only when the count came down to it', () => {
  it('THE RED: a measure that read 0 from the moment it was set is not work on record (strike-0 leaves the task open)', () => {
    measured('t-zero', 0, 0);
    recordMeasured('t-zero', { ok: true, count: 0 }, Date.now());
    expect(engineProofLine('t-zero')).toBeNull();
  });

  it('THE RED: unread at set, its first successful reading is 0: still not work on record', () => {
    measured('t-unread', null, null);
    recordMeasured('t-unread', { ok: true, count: 0 }, Date.now());
    expect(engineProofLine('t-unread')).toBeNull();
  });

  it('CONTROL: a count that came down to 0 is work on record', () => {
    measured('t-down', 12, 12);
    recordMeasured('t-down', { ok: true, count: 0 }, Date.now());
    expect(engineProofLine('t-down')).toMatch(/the task's measure: 0 files left, from 12/);
  });

  it('CONTROL: unread at set, first read at 4, now 0: it came down, so it counts', () => {
    measured('t-late', null, null);
    recordMeasured('t-late', { ok: true, count: 4 }, Date.now());
    recordMeasured('t-late', { ok: true, count: 0 }, Date.now());
    expect(engineProofLine('t-late')).toMatch(/the task's measure: 0 files left, from 4/);
  });
});

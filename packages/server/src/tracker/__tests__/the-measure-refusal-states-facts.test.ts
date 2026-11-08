// The measured-close refusal (`remainderRefusal`, tracker/measure-gate.ts) states facts and never
// coaches a close: no "close it with" or "close again with" menu (product law, "Finishing, not closing").
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-measure-facts', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { openTrackerTask } from '../../work/tracker-store.js';
import { remainderRefusal } from '../measure-gate.js';

const AGENT = 'agent-measured';

beforeEach(() => {
  mockDb.current?.close();
  const d = new Database(':memory:');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'A', 'idle')`).run(AGENT);
});

describe('the measured-close refusal states facts only', () => {
  it('complete_task on a measured task with items left: the count, and the hand-in that takes a remainder, with no "close it" menu', () => {
    const id = openTrackerTask({
      title: 'Sort the inbox', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
    });
    mockDb.current!.prepare(`UPDATE work SET measure_json = ?, measure_initial = 50, measure_remaining = 7, measure_at = ? WHERE id = ?`)
      .run(JSON.stringify({ tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' }), Date.now(), id);
    const text = remainderRefusal(id, 'complete_task(status="complete")') ?? '';
    expect(text).toContain('still returns 7 messages');
    expect(text).toContain('outcome="cant_be_done"');
    expect(text).not.toMatch(/close it with|close again with/);
  });
});

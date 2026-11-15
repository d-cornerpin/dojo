// v3.5 DONE IS MEASURED, Task A3 — the ledger store: distinct items a task touched, and the measure's readings.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { createWorkTable, seedTrackerTask } from './work-fixture.js';
import {
  recordTouched, ledgerTotals, ledgerNewItemsSince, ledgerWorkEntries, writeMeasured,
} from '../ledger-store.js';

const TASK = 'task-ledger-1';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  createWorkTable(mockDb.current);
  seedTrackerTask(mockDb.current, { id: TASK, agentId: 'agent-l', status: 'in_progress' });
  seedTrackerTask(mockDb.current, { id: 'other-task', agentId: 'agent-l', status: 'in_progress' });
});

describe('work_ledger', () => {
  it('counts distinct items; a re-touch updates last_at only', () => {
    expect(recordTouched(TASK, 'gmail_label', ['gmail:msg:a', 'gmail:msg:b'], 1000)).toBe(2);
    expect(recordTouched(TASK, 'gmail_label', ['gmail:msg:a'], 2000)).toBe(1);
    const t = ledgerTotals(TASK);
    expect(t.touched).toBe(2);
    expect(t.lastAt).toBe(2000);
    expect(t.byTool).toEqual([{ tool: 'gmail_label', n: 2 }]);
    const a = mockDb.current!.prepare('SELECT first_at, last_at FROM work_ledger WHERE work_id = ? AND item_key = ?').get(TASK, 'gmail:msg:a');
    expect(a).toEqual({ first_at: 1000, last_at: 2000 });
  });
  it('is per task, and an empty key list writes nothing', () => {
    recordTouched(TASK, 'gmail_label', ['gmail:msg:a'], 1000);
    expect(recordTouched('other-task', 'gmail_label', [], 1000)).toBe(0);
    expect(ledgerTotals('other-task')).toEqual({ touched: 0, commands: 0, lastAt: null, byTool: [] });
  });
  it('writeMeasured stores the reading, and null when it could not be read', () => {
    writeMeasured(TASK, 10412, 5000, 10551);
    let row = mockDb.current!.prepare('SELECT measure_initial, measure_remaining, measure_at FROM work WHERE id = ?').get(TASK);
    expect(row).toEqual({ measure_initial: 10551, measure_remaining: 10412, measure_at: 5000 });
    writeMeasured(TASK, null, 6000);
    row = mockDb.current!.prepare('SELECT measure_initial, measure_remaining, measure_at FROM work WHERE id = ?').get(TASK);
    expect(row).toEqual({ measure_initial: 10551, measure_remaining: null, measure_at: 6000 });
  });
});

describe('a touch is movement', () => {
  it('taskMovedAtSql reads the ledger, so a job touching items never reads as idle', async () => {
    const { taskMovedAtSql } = await import('../task-freshness.js');
    const movedAt = () => (mockDb.current!.prepare(`SELECT ${taskMovedAtSql('w')} AS t FROM work w WHERE w.id = ?`).get(TASK) as { t: number }).t;
    expect(movedAt()).toBe(1_700_000_000_000);   // the row's own clock
    recordTouched(TASK, 'gmail_label', ['gmail:msg:a'], 1_700_000_900_000);
    expect(movedAt()).toBe(1_700_000_900_000);
    // Another task's touch is not this task moving.
    recordTouched('other-task', 'gmail_label', ['gmail:msg:z'], 1_700_009_000_000);
    expect(movedAt()).toBe(1_700_000_900_000);
  });
});

// v3.5 FIELD FIX 3 (#6a): a command run is on the ledger as a RECORD of the work, not as an item.
// A command is often a read (`ls`, `cat`), so the measured-job momentum readers count items only:
// a chain of continuations that only ever runs new reads is still a job touching nothing.
describe('v3.5 field fix 3 (#6a): files and commands on the ledger', () => {
  it('a file written is an item; a command is counted apart and never as momentum', () => {
    recordTouched(TASK, 'file_write', ['file:/tmp/a.md'], 1000);
    recordTouched(TASK, 'exec', ['cmd:ls /tmp'], 1000, 'exit 0');
    recordTouched(TASK, 'shell', ['cmd:cat /tmp/a.md'], 2000, 'exit 1');
    const t = ledgerTotals(TASK);
    expect(t.touched).toBe(1);
    expect(t.commands).toBe(2);
    expect(t.byTool).toEqual([{ tool: 'file_write', n: 1 }]);
    expect(ledgerNewItemsSince(TASK, 500)).toBe(1);
  });
  it('lists the file and command entries with their status, oldest first; mailbox items are counted, not listed', () => {
    recordTouched(TASK, 'gmail_label', ['gmail:msg:a'], 500);
    recordTouched(TASK, 'file_write', ['file:/tmp/a.md'], 1000);
    recordTouched(TASK, 'exec', ['cmd:mkdir -p /tmp/x'], 900, 'exit 0');
    expect(ledgerWorkEntries(TASK)).toEqual([
      { kind: 'command', what: 'mkdir -p /tmp/x', tool: 'exec', status: 'exit 0' },
      { kind: 'file', what: '/tmp/a.md', tool: 'file_write', status: null },
    ]);
  });
});

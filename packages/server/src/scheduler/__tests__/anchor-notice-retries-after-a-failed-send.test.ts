// The one-time "these schedules may have shifted" notice must not be marked done
// until it has actually gone out. A failed send leaves the scan open so the next
// boot tries again.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => 'notice-id' }));
vi.mock('../../config/platform.js', () => ({ getPrimaryAgentId: () => 'primary' }));
vi.mock('../engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine.js')>()),
  getBoxTimeZone: () => 'America/Los_Angeles',
}));

import { runAnchorCompensationPass, SCAN_RECORD_KEY } from '../anchor-compensation.js';

const FAR_FUTURE = Date.parse('2099-01-01T00:00:00Z');

function seed(withSuspect: boolean): void {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE work (
      id TEXT PRIMARY KEY, title TEXT, anchor_local TEXT, scheduled_start INTEGER,
      next_run_at INTEGER, updated_at INTEGER, state TEXT, is_paused INTEGER,
      repeat_interval INTEGER, repeat_unit TEXT
    );
  `);
  if (withSuspect) {
    db.prepare('INSERT INTO work VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      'w1', 'daily brief', '2099-01-02T06:00:00.000Z', null, FAR_FUTURE,
      Date.parse('2026-08-04T02:00:00Z'), 'open', 0, 1, 'days',
    );
  }
  mockDb.current = db;
}
const recordRow = () =>
  mockDb.current!.prepare('SELECT value FROM config WHERE key = ?').get(SCAN_RECORD_KEY);

describe('the moved-schedule notice', () => {
  beforeEach(() => seed(true));

  it('a failed send leaves no record, and the next boot retries and then records', () => {
    const failing = vi.fn(() => { throw new Error('db busy'); });
    expect(runAnchorCompensationPass(failing)).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(recordRow()).toBeUndefined();

    const working = vi.fn();
    const result = runAnchorCompensationPass(working);
    expect(result).not.toBeNull();
    expect(working).toHaveBeenCalledTimes(1);
    expect(recordRow()).toBeDefined();
  });

  it('a working send records the scan and a second boot does not tell again', () => {
    const notify = vi.fn();
    expect(runAnchorCompensationPass(notify)).not.toBeNull();
    expect(recordRow()).toBeDefined();
    expect(runAnchorCompensationPass(notify)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('with no suspects the record is still written after the first scan', () => {
    seed(false);
    const notify = vi.fn();
    expect(runAnchorCompensationPass(notify)).not.toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(recordRow()).toBeDefined();
  });
});

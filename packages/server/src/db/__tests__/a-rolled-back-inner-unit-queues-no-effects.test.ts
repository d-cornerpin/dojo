// An inner unit that is rolled back and caught must not leave its effects behind.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { withUnit, afterCommit, inUnit } from '../unit.js';

beforeEach(() => {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE t (v TEXT)');
  mockDb.current = d;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('withUnit effect queue', () => {
  it('a caught, rolled-back inner unit queues no effects; the outer effect runs once', () => {
    const outerEffect = vi.fn();
    const innerEffect = vi.fn();
    withUnit(() => {
      mockDb.current!.prepare('INSERT INTO t VALUES (?)').run('outer');
      afterCommit(outerEffect);
      try {
        withUnit(() => {
          mockDb.current!.prepare('INSERT INTO t VALUES (?)').run('inner');
          afterCommit(innerEffect);
          throw new Error('x');
        });
      } catch { /* the outer carries on */ }
    });
    expect(outerEffect).toHaveBeenCalledTimes(1);
    expect(innerEffect).not.toHaveBeenCalled();
    expect(mockDb.current!.prepare('SELECT v FROM t').all()).toEqual([{ v: 'outer' }]);
    expect(inUnit()).toBe(false);
  });

  it('a deeper rolled-back unit drops only its own effects, not its parent\'s', () => {
    const kept = vi.fn();
    const dropped = vi.fn();
    withUnit(() => {
      withUnit(() => {
        afterCommit(kept);
        try {
          withUnit(() => { afterCommit(dropped); throw new Error('x'); });
        } catch { /* caught */ }
      });
    });
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('control: an inner unit that does not throw has its effect run once after the outer commit', () => {
    const innerEffect = vi.fn();
    let ranInside = false;
    withUnit(() => {
      withUnit(() => { afterCommit(innerEffect); });
      ranInside = innerEffect.mock.calls.length > 0;
    });
    expect(ranInside).toBe(false);
    expect(innerEffect).toHaveBeenCalledTimes(1);
  });
});

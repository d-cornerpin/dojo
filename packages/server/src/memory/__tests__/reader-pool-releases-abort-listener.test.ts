// ════════════════════════════════════════════════════════════════════════════════════════
// THE READER POOL RELEASES ITS ABORT LISTENER — t61.
//
// readerQuery registers a one-shot `abort` listener on the caller's signal with
// `{ once: true }`, but `once` only removes the listener after it FIRES. A query that
// finishes normally, fails, or hits its deadline leaves the listener parked on the
// signal forever — Node prints `MaxListenersExceededWarning` past 10, and each leftover
// closes over `pending`, `reject` and the timer. This file asserts the pool removes the
// listener exactly once no matter how the query ends, while abort behaviour itself is
// untouched.
//
// The fixture file-backs the database because the worker opens its OWN connection by
// path — an in-memory db would give the pool an empty universe and every clause would
// pass vacuously on zero rows (asserted against below: each query must MATCH).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';

const dbDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t61-pool-'));
const dbPath = path.join(dbDir, 'pool.db');

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    throw new Error('unused');
  },
  getDbPath: () => dbPath,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { readerQuery, warmReaderPool, terminateReaderPool } from '../reader-pool.js';

beforeAll(async () => {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2);');
  db.close();
  const warmed = await warmReaderPool();
  expect(warmed).toBe(true);
});

afterAll(async () => {
  await terminateReaderPool();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('the reader pool releases its abort listener exactly once per query', () => {
  it('12 successful queries leave zero abort listeners on the signal', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    for (let i = 0; i < 12; i += 1) {
      const rows = await readerQuery('q', 'SELECT x FROM t', [], { signal });
      expect(rows).toEqual([{ x: 1 }, { x: 2 }]);
    }
    expect(getEventListeners(signal, 'abort').length).toBe(0);
  });

  it('a failing query on the same signal also leaves zero abort listeners', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    for (let i = 0; i < 12; i += 1) {
      await readerQuery('q', 'SELECT x FROM t', [], { signal });
    }
    await expect(readerQuery('q', 'SELECT nope FROM t', [], { signal })).rejects.toThrow();
    expect(getEventListeners(signal, 'abort').length).toBe(0);
  });

  it('an abort still rejects with `aborted` and releases the listener', async () => {
    const controller = new AbortController();
    const p = readerQuery('q', 'SELECT x FROM t', [], { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toThrow('aborted');
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0);
  });

  it('an already-aborted signal rejects with `aborted before dispatch`', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readerQuery('q', 'SELECT x FROM t', [], { signal: controller.signal }))
      .rejects.toThrow('aborted before dispatch');
  });
});

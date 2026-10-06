// ════════════════════════════════════════════════════════════════════════════════════════
// THE WIRE UNDER CONCURRENT PRODUCTION CALLERS — t89 deliverable 1's last proof.
//
// The pool was measured alone (the offload file); this file proves it under the REAL
// retrieval path with two searches in flight at once. The failure mode worth asserting is
// MIS-ATTRIBUTION: the pool keys replies by id, so the bug that matters is caller A
// receiving caller B's rows — each search here carries a marker word the other must never
// return. The second clause is the fallback's twin: with the pool DOWN, the same two
// searches still answer correctly on the serving thread (the wire degrades, never breaks).
//
// The fixture file-backs the database because the worker opens its OWN connection by path —
// an in-memory db would give the pool an empty universe and every clause would pass
// vacuously on zero rows (asserted against below: each search must MATCH before it must
// not cross).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t89-wire-'));
const dbPath = path.join(dbDir, 'wire.db');
const handle = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!handle.current) throw new Error('test DB not initialized');
    return handle.current;
  },
  getDbPath: () => dbPath,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { memoryGrep } from '../retrieval.js';
import { warmReaderPool, readerPoolAvailable, terminateReaderPool } from '../reader-pool.js';

const AGENT = 'fixture-wire-agent';

beforeAll(async () => {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(content, content=messages, content_rowid=seq);
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
    END;
  `);
  const ins = db.prepare('INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)');
  const t0 = 1700000000000;
  db.transaction(() => {
    for (let i = 0; i < 4000; i += 1) {
      const word = i % 2 === 0 ? 'lighthouse' : 'orchard';
      ins.run(`fixture-${i}`, AGENT, i % 3 === 0 ? 'user' : 'assistant',
        `note ${i}: the ${word} ledger entry carries row ${i}`, t0 + i * 1000);
    }
  })();
  handle.current = db;
  await warmReaderPool();
});

afterAll(async () => {
  await terminateReaderPool();
  handle.current?.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('two searches in flight, each answered with its own rows', () => {
  it('pool UP: concurrent FTS searches never cross — and both actually match', async () => {
    expect(readerPoolAvailable()).toBe(true);
    const [a, b] = await Promise.all([
      memoryGrep(AGENT, { pattern: 'lighthouse', scope: 'messages' }),
      memoryGrep(AGENT, { pattern: 'orchard', scope: 'messages' }),
    ]);
    expect(a).toContain('lighthouse');
    expect(a).not.toContain('orchard');
    expect(b).toContain('orchard');
    expect(b).not.toContain('lighthouse');
  });

  it('pool DOWN: the same two searches answer on the serving thread — the fallback is the same truth', async () => {
    await terminateReaderPool();
    expect(readerPoolAvailable()).toBe(false);
    const [a, b] = await Promise.all([
      memoryGrep(AGENT, { pattern: 'lighthouse', scope: 'messages' }),
      memoryGrep(AGENT, { pattern: 'orchard', scope: 'messages' }),
    ]);
    expect(a).toContain('lighthouse');
    expect(a).not.toContain('orchard');
    expect(b).toContain('orchard');
    expect(b).not.toContain('lighthouse');
    await warmReaderPool();
  });

  it('the LIKE fallback path crosses the wire too: regex mode, concurrent, attributed', async () => {
    const [a, b] = await Promise.all([
      memoryGrep(AGENT, { pattern: 'lighthouse', mode: 'regex', scope: 'messages' }),
      memoryGrep(AGENT, { pattern: 'orchard', mode: 'regex', scope: 'messages' }),
    ]);
    expect(a).toContain('lighthouse');
    expect(a).not.toContain('orchard');
    expect(b).toContain('orchard');
    expect(b).not.toContain('lighthouse');
  });
});

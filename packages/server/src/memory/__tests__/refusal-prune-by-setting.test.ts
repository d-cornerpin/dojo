// ════════════════════════════════════════════════════════════════════════════════════════
// t269 fix round 3 (re-review 3) — PRUNING AN EARLIER SETTING'S REFUSALS, BY THE SETTING FIELD.
//
// Two code paths pruned "an earlier setting's refusals" with `DELETE ... key NOT LIKE '%|' || ? || '|%'`
// — matching the setting ANYWHERE in the pipe-delimited key instead of matching its SETTING FIELD
// (index 1). That keeps stale rows in two ways, both asserted below:
//   · a stale key whose WRITER field equals the current setting (`a1|m0|m1|h` kept when setting is `m1`);
//   · a `_`/`%` in the setting acting as a LIKE wildcard (`a1|mX1|id` kept when setting is `m_1`).
// The fix: prune by the setting field, `pruneRefusalsOtherThan`, and call it from both paths.
//
// All fixture text is invented filler; no real conversation, agent or person appears here.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t269-prune', 'dojo.db'),
  };
});
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { pruneRefusalsOtherThan } from '../refusal-prune.js';
import { recordRefusal } from '../unwritable-span.js';
import { recordRefusedSpan } from '../summary-check-ledger.js';

const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  db().pragma('foreign_keys = ON');
  db().exec(`CREATE TABLE healer_state (scope TEXT NOT NULL, key TEXT NOT NULL, at_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (scope, key))`);
  db().exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const keysOf = (scope: string): string[] =>
  (db().prepare('SELECT key FROM healer_state WHERE scope = ? ORDER BY key').all(scope) as Array<{ key: string }>).map((r) => r.key);

describe('t269 fix round 3 — pruning an earlier setting\'s refusals, by the setting field', () => {
  it('the helper: a stale key whose WRITER field equals the current setting is pruned (FAILS on v35)', () => {
    db().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run('S', 'a1|m0|m1|h', 1);
    db().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run('S', 'a1|m1|w|h2', 2);
    pruneRefusalsOtherThan(db(), 'S', 'm1');
    expect(keysOf('S')).toEqual(['a1|m1|w|h2']);
  });

  it('the helper: a row in ANOTHER scope with a stale setting is untouched', () => {
    db().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run('S', 'a1|m0|m1|h', 1);
    db().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run('T', 'a1|m0|m1|h', 2);
    pruneRefusalsOtherThan(db(), 'S', 'm1');
    expect(keysOf('T'), 'another scope is not touched').toEqual(['a1|m0|m1|h']);
  });

  it('the helper: a setting with a LIKE wildcard `_` prunes exactly its own field (FAILS on v35)', () => {
    db().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run('S', 'a1|mX1|id', 1);
    db().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run('S', 'a1|m_1|id', 2);
    pruneRefusalsOtherThan(db(), 'S', 'm_1');
    expect(keysOf('S')).toEqual(['a1|m_1|id']);
  });

  it('the helper: an empty setting prunes every key with a non-empty setting field', () => {
    db().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run('S', 'a1||w|h', 1);
    db().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run('S', 'a1|m0|w|h', 2);
    pruneRefusalsOtherThan(db(), 'S', '');
    expect(keysOf('S')).toEqual(['a1||w|h']);
  });

  it('recordRefusal: an earlier setting whose text equals a writer name is pruned (FAILS on v35)', () => {
    db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'm1')").run();
    db().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run('summary_unwritable', 'a1|m0|m1|h', 1);
    recordRefusal('a1', 'w', [{ id: 'r1', content: 'x' }]);
    expect(db().prepare('SELECT 1 FROM healer_state WHERE scope = ? AND key = ?').get('summary_unwritable', 'a1|m0|m1|h'),
      'the stale row is gone').toBeUndefined();
    const rows = db().prepare("SELECT key FROM healer_state WHERE scope = ? AND key LIKE 'a1|m1|w|%'").all('summary_unwritable') as Array<{ key: string }>;
    expect(rows.length, 'exactly one row for the current writer and setting').toBe(1);
    expect(rows[0].key.startsWith('a1|m1|w|')).toBe(true);
  });

  it('recordRefusedSpan: a stale row kept by a LIKE wildcard setting is pruned (FAILS on v35)', () => {
    db().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run('summary_span_refused', 'a1|mX1|id9', 1);
    recordRefusedSpan(['a1|m_1|id1']);
    expect(db().prepare('SELECT 1 FROM healer_state WHERE scope = ? AND key = ?').get('summary_span_refused', 'a1|mX1|id9'),
      'the stale row is gone').toBeUndefined();
    expect(db().prepare('SELECT 1 FROM healer_state WHERE scope = ? AND key = ?').get('summary_span_refused', 'a1|m_1|id1'),
      'the current row exists').toBeTruthy();
  });
});

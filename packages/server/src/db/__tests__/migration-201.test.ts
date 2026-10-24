// MIGRATION 201 (v3.5 B2) — THE DECISION SHADOW LOG. Additive: one new table and two indexes, so a
// body of any age applies it. Rehearsed on a fresh body, a pre-201 lived-in body, and a re-run.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-migration-201');
  return { homeDir: (): string => dir, dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs), isTestRun: (): boolean => true };
});
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-migration-201', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const FILE = '201_decision_shadow.sql';
const db = (): Database.Database => mockDb.current!;
const columns = (): string[] => (db().prepare('PRAGMA table_info(decision_shadow)').all() as Array<{ name: string }>).map((r) => r.name);
const indexes = (): string[] => (db().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'decision_shadow' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('migration 201', () => {
  it('a fresh body gets the table, its columns and both indexes, empty', () => {
    expect(columns()).toEqual(['id', 'purpose', 'question', 'agent_id', 'turn_id', 'rule_said', 'model_said', 'truth', 'truth_src', 'created_at', 'truth_at']);
    expect(indexes()).toEqual(['idx_decision_shadow_q', 'idx_decision_shadow_turn']);
    expect(db().prepare('SELECT COUNT(*) AS n FROM decision_shadow').get()).toEqual({ n: 0 });
    expect(db().prepare('SELECT COUNT(*) AS n FROM summary_checks').get()).toEqual({ n: 0 });
    expect((db().prepare('PRAGMA table_info(summary_checks)').all() as Array<{ name: string }>).map((r) => r.name))
      .toEqual(['id', 'agent_id', 'writer_model_id', 'outcome', 'invented', 'dropped', 'stated_current', 'created_at']);
    expect(db().prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(FILE)).toEqual({ n: 1 });
  });

  it('a pre-201 lived-in body applies it and keeps every row it had', () => {
    db().exec('DROP TABLE decision_shadow; DROP TABLE summary_checks;');
    db().prepare('DELETE FROM _migrations WHERE name = ?').run(FILE);
    db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'm-x')").run();
    db().prepare("INSERT INTO agents (id, name, status, config) VALUES ('agent-a', 'A', 'idle', '{}')").run();
    runMigrations(db());
    expect(columns()).toContain('truth_at');
    expect(db().prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get()).toEqual({ value: 'm-x' });
    expect(db().prepare("SELECT id FROM agents WHERE id = 'agent-a'").get()).toEqual({ id: 'agent-a' });
  });

  it('a second boot changes nothing', () => {
    db().prepare("INSERT INTO decision_shadow (purpose, question, rule_said, created_at) VALUES ('p', 'q', 'true', 1)").run();
    runMigrations(db());
    expect(db().prepare('SELECT COUNT(*) AS n FROM decision_shadow').get()).toEqual({ n: 1 });
  });
});

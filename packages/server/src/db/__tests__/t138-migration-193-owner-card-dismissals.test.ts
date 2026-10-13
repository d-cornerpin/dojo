// ════════════════════════════════════════════════════════════════════════════════════════
// t138 round 3 — MIGRATION 193: THE OWNER-CARD COLUMNS ARRIVE ON A LIVED-IN BOX, AND NOTHING ELSE MOVES.
//
// 193 adds six nullable columns (budgets.alert_words, budgets.alert_dismissed_at,
// error_loop_state.owner_card_closed_at; round 4: google_accounts.owner_notice,
// microsoft_accounts.owner_notice, agents.rate_limit_notice). G13: rehearsed on a VACUUM INTO copy of an adversarial
// body — latched and clean budgets, paused and error rows for paused, idle and terminated agents
// — with every pre-existing row compared before and after; then through the real
// `runMigrations()` with 193 pending, and a later boot that must not re-run it.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-migration-193');
const FILE = '193_owner_card_dismissals.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'migrations', FILE), 'utf-8');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-migration-193');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-migration-193', 'dojo.db'),
  };
});

const { transport } = vi.hoisted(() => ({ transport: [] as string[] }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => { transport.push(JSON.stringify(a)); return ''; };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

import { runMigrations } from '../migrations.js';

// Each clause boots the real module graph (the iMessage door pulls in the engine) and runs the
// full migration chain; that is an import cost, not a timing assertion, and on a box shared by
// many suites it can pass the 30 s default. Nothing here measures time.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  transport.length = 0;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

/** A box from before 193: the chain applied with 193 un-done and un-recorded, carrying rows. */
function agedBody(target: Database.Database): void {
  target.exec(`ALTER TABLE budgets DROP COLUMN alert_words;
               ALTER TABLE budgets DROP COLUMN alert_dismissed_at;
               ALTER TABLE error_loop_state DROP COLUMN owner_card_closed_at;
               ALTER TABLE google_accounts DROP COLUMN owner_notice;
               ALTER TABLE microsoft_accounts DROP COLUMN owner_notice;
               ALTER TABLE agents DROP COLUMN rate_limit_notice;`);
  target.prepare('DELETE FROM _migrations WHERE name = ?').run(FILE);
  target.prepare(`INSERT INTO agents (id, name, status) VALUES ('p1', 'Paused', 'paused'), ('i1', 'Idle', 'idle'),
                  ('t1', 'Gone', 'terminated')`).run();
  const b = target.prepare(`INSERT OR REPLACE INTO budgets (id, scope, limit_usd, period, alert_50_sent, alert_75_sent, alert_90_sent)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
  b.run('global_daily', 'global', 10, 'daily', 1_700_000_000, 0, 0);
  b.run('agent_a1', 'p1', 4, 'weekly', null, null, null);
  b.run('agent_a2', 'i1', 6, 'monthly', 0, 0, 0);
  const e = target.prepare('INSERT INTO error_loop_state (agent_id, kind, at_ms, detail) VALUES (?, ?, ?, ?)');
  e.run('p1', 'paused', 1_000, '{"errorCount":5}');
  e.run('p1', 'paused', 2_000, null);
  e.run('i1', 'paused', 3_000, '{}');
  e.run('t1', 'error', 4_000, null);
}

function freshMigrated(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  return d;
}

const rowsOf = (d: Database.Database) => ({
  budgets: d.prepare('SELECT id, scope, limit_usd, period, alert_50_sent, alert_75_sent, alert_90_sent FROM budgets ORDER BY id').all(),
  loops: d.prepare('SELECT id, agent_id, kind, at_ms, detail FROM error_loop_state ORDER BY id').all(),
});

describe('rehearsal on a VACUUM INTO copy, adversarial body', () => {
  it('193 adds six empty columns and changes no existing row', () => {
    const live = freshMigrated();
    agedBody(live);
    const copyPath = path.join(HOME, 'rehearsal.db');
    live.prepare('VACUUM INTO ?').run(copyPath);
    const copy = new Database(copyPath);
    const before = rowsOf(copy);
    const changes = SQL.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)
      .map((stmt) => copy.prepare(stmt).run().changes);
    expect(changes, 'an ALTER touches no row').toEqual([0, 0, 0, 0, 0, 0]);
    expect(rowsOf(copy)).toEqual(before);
    expect(before.budgets.length).toBe(3);
    expect(before.loops.length).toBe(4);
    expect(copy.prepare('SELECT COUNT(*) AS n FROM budgets WHERE alert_words IS NOT NULL OR alert_dismissed_at IS NOT NULL').get()).toEqual({ n: 0 });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM error_loop_state WHERE owner_card_closed_at IS NOT NULL').get()).toEqual({ n: 0 });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM agents WHERE rate_limit_notice IS NOT NULL').get()).toEqual({ n: 0 });
    copy.close();
  });
});

describe('the upgrade door', () => {
  it('193 applies on the next boot through the real runner, and a later boot does not re-run it', () => {
    const live = freshMigrated();
    agedBody(live);
    const before = rowsOf(live);
    runMigrations(); // the update's boot: 193 is the pending file
    expect(rowsOf(live)).toEqual(before);
    expect(live.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(FILE)).toEqual({ n: 1 });
    expect(() => runMigrations(), 'a later boot finds 193 recorded').not.toThrow();
    const cols = (live.prepare("SELECT name FROM pragma_table_info('budgets')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['alert_words', 'alert_dismissed_at']));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// t143 — MIGRATION 191: THE SILENT WINDOW AND THE TWO INCIDENT RECORDS ARRIVE ON A LIVED-IN BOX.
//
// 191 adds three nullable columns on `agents` (silent_window_minutes, silent_notice,
// broken_notice). G13: rehearsed on a VACUUM INTO copy of an ADVERSARIAL body — agents in every
// status (working, idle, paused, error with a Tier D last_error, rate_limited with a standing
// rate-limit notice, terminated), a duplicate display name, NULL model ids, an orphan model id —
// with every pre-existing row compared before and after and each statement's row count read; then
// through the real `runMigrations()` with 191 pending (it sorts BEFORE 193, which a box that took
// t138 has already applied), a later boot that must not re-run it, and the first sweep after the
// update, which must tell the owner nothing about an agent merely because it was already in error.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t143-migration-191');
const FILE = '191_agent_silent_window.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'migrations', FILE), 'utf-8');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t143-migration-191');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t143-migration-191', 'dojo.db'),
  };
});

const { transport } = vi.hoisted(() => ({ transport: [] as string[] }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: vi.fn(async () => undefined), notifyPrimaryOfInjury: vi.fn(async () => undefined) }),
}));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: vi.fn(async () => ({ delivered: true, threadId: 't' })),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => { transport.push(JSON.stringify(a)); return ''; };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

import { runMigrations } from '../migrations.js';

// Each clause runs the full migration chain; an import cost, not a timing assertion.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { sweepSilentAgents } from '../../tracker/liveness.js';

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

/** A box from before 191: the chain applied with 191 un-done and un-recorded, carrying rows. */
function agedBody(target: Database.Database): void {
  target.exec(`ALTER TABLE agents DROP COLUMN silent_window_minutes;
               ALTER TABLE agents DROP COLUMN silent_notice;
               ALTER TABLE agents DROP COLUMN broken_notice;`);
  target.prepare('DELETE FROM _migrations WHERE name = ?').run(FILE);
  // The orphan model id is a row an old box can carry (the chain ran with foreign keys off).
  target.pragma('foreign_keys = OFF');
  target.prepare(`INSERT INTO agents (id, name, status, model_id, last_error, rate_limit_notice) VALUES
    ('w1', 'Worker', 'working', NULL, NULL, NULL),
    ('i1', 'Worker', 'idle', 'model-gone', NULL, NULL),
    ('p1', 'Paused', 'paused', NULL, 'loop', NULL),
    ('e1', 'Broke', 'error', NULL, '[quota_exhausted] API error 402: Insufficient Balance', NULL),
    ('r1', 'Limited', 'rate_limited', NULL, NULL, '{"at":1,"words":"Limited is rate-limited for 5 hours."}'),
    ('t1', 'Gone', 'terminated', NULL, NULL, NULL)`).run();
  target.pragma('foreign_keys = ON');
}

function freshMigrated(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  return d;
}

const rowsOf = (d: Database.Database): unknown[] =>
  d.prepare('SELECT id, name, status, model_id, last_error, rate_limit_notice FROM agents ORDER BY id').all();

describe('rehearsal on a VACUUM INTO copy, adversarial body', () => {
  it('191 adds three empty columns and changes no existing row', () => {
    const live = freshMigrated();
    agedBody(live);
    const copyPath = path.join(HOME, 'rehearsal.db');
    live.prepare('VACUUM INTO ?').run(copyPath);
    const copy = new Database(copyPath);
    const before = rowsOf(copy);
    const changes = SQL.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)
      .map((stmt) => copy.prepare(stmt).run().changes);
    expect(changes, 'an ALTER touches no row').toEqual([0, 0, 0]);
    expect(rowsOf(copy)).toEqual(before);
    expect(before.length).toBe(6);
    expect(copy.prepare(`SELECT COUNT(*) AS n FROM agents
      WHERE silent_window_minutes IS NOT NULL OR silent_notice IS NOT NULL OR broken_notice IS NOT NULL`).get()).toEqual({ n: 0 });
    expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    copy.close();
  });
});

describe('the upgrade door', () => {
  it('191 applies on the next boot through the real runner (after 193), a later boot does not re-run it, and the first sweep tells nobody', () => {
    const live = freshMigrated();
    agedBody(live);
    expect(live.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = '193_owner_card_dismissals.sql'").get()).toEqual({ n: 1 });
    const before = rowsOf(live);
    runMigrations(); // the update's boot: 191 is the pending file
    expect(rowsOf(live)).toEqual(before);
    expect(live.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(FILE)).toEqual({ n: 1 });
    expect(() => runMigrations(), 'a later boot finds 191 recorded').not.toThrow();
    live.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
      .run(JSON.stringify([{ address: 'owner@example.test', name: 'Owner', is_primary: true }]));
    // The first liveness sweep on the upgraded body: the working agent has no movement on record,
    // but nothing was handed to it inside a window either — and the error/paused/rate-limited
    // agents belong to their own doors. No text.
    sweepSilentAgents();
    expect(transport.filter((t) => t.includes('"send"'))).toHaveLength(0);
  });
});

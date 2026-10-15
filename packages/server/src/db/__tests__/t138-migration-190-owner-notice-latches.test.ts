// ════════════════════════════════════════════════════════════════════════════════════════
// t138 — MIGRATION 190: a box upgraded with alert latches set while the alert was muted.
//
// Lifecycle shape from the plan: "box upgraded with latched *_threshold_alerted rows". At
// v3.3.2 every budget/balance alert was dropped before the phone but its latch was set, so the
// fixed code would read "already told" and stay silent. 190 clears those latches once; the
// first check after the update tells the owner the current state once, and never again.
//
// Two halves:
//   1. REHEARSAL (G13): an adversarial body — latched rows, NULL and stray latch values, clean
//      rows, neighbouring config keys that must survive — on a `VACUUM INTO` copy, each
//      statement's touched-row count asserted (a zero would mean that branch went untested).
//   2. THE UPGRADE DOOR: the real `runMigrations()` over a body where 190 is pending, then the
//      real cost door — one text at the highest level reached, then silence.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-migration-190');
const FILE = '190_owner_notice_latches.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'migrations', FILE), 'utf-8');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-migration-190');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-migration-190', 'dojo.db'),
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

/** The v3.3.2 body: the full chain applied, then 190 un-recorded — exactly a box whose next
 *  boot finds 190 pending — carrying the latches the muted alerts left behind. */
function agedBody(target: Database.Database): void {
  target.prepare("DELETE FROM _migrations WHERE name = ?").run(FILE);
  const cfg = target.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  cfg.run('openrouter_threshold_alerted', 'true');
  cfg.run('deepseek_threshold_alerted', 'true');
  cfg.run('openrouter_warning_threshold', '7');           // the owner's line: must survive
  cfg.run('deepseek_warning_threshold', '3');             // must survive
  cfg.run('some_other_threshold_alerted_like_key', 'x');  // a neighbour: must survive
  const b = target.prepare(`INSERT INTO budgets (id, scope, limit_usd, period, alert_50_sent, alert_75_sent, alert_90_sent)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id) DO UPDATE SET limit_usd = excluded.limit_usd,
                              alert_50_sent = excluded.alert_50_sent, alert_75_sent = excluded.alert_75_sent,
                              alert_90_sent = excluded.alert_90_sent`);
  b.run('global_daily', 'global', 10, 'daily', 1, 1, 1);         // latched by muted alerts
  b.run('agent_a1', 'agent', 4, 'weekly', 1, 0, 0);              // partly latched
  b.run('agent_a2', 'agent', 6, 'monthly', null, null, null);    // NULL latches: dead thresholds
  b.run('agent_a3', 'agent', 8, 'daily', 2, 0, 0);               // a stray value
  b.run('agent_a4', 'agent', 9, 'daily', 0, 0, 0);               // clean: untouched
}

function freshMigrated(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  return d;
}

describe('rehearsal on a VACUUM INTO copy, adversarial body, per-statement counts', () => {
  it('each statement touches exactly the rows it names, and nothing else moves', () => {
    const live = freshMigrated();
    agedBody(live);
    const copyPath = path.join(HOME, 'rehearsal.db');
    live.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`);
    const copy = new Database(copyPath);
    try {
      const before = copy.prepare("SELECT key, value FROM config WHERE key NOT LIKE '%\\_threshold\\_alerted' ESCAPE '\\' ORDER BY key").all();
      const limits = copy.prepare('SELECT id, limit_usd, period FROM budgets ORDER BY id').all();
      const statements = SQL.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
      expect(statements).toHaveLength(2);
      const touched = copy.transaction(() => statements.map((s) => copy.prepare(s).run().changes))();
      expect(touched, '[latch rows deleted, budget rows reset]').toEqual([2, 4]);

      expect(copy.prepare("SELECT COUNT(*) AS n FROM config WHERE key IN ('openrouter_threshold_alerted','deepseek_threshold_alerted')").get()).toEqual({ n: 0 });
      expect(copy.prepare("SELECT key, value FROM config WHERE key NOT LIKE '%\\_threshold\\_alerted' ESCAPE '\\' ORDER BY key").all()).toEqual(before);
      expect(copy.prepare("SELECT value FROM config WHERE key = 'some_other_threshold_alerted_like_key'").get()).toEqual({ value: 'x' });
      expect(copy.prepare('SELECT id, limit_usd, period FROM budgets ORDER BY id').all()).toEqual(limits);
      expect(copy.prepare(`SELECT COUNT(*) AS n FROM budgets
                           WHERE alert_50_sent IS NOT 0 OR alert_75_sent IS NOT 0 OR alert_90_sent IS NOT 0`).get()).toEqual({ n: 0 });

      // A second pass is a no-op: nothing left to touch.
      const again = statements.map((s) => copy.prepare(s).run().changes);
      expect(again).toEqual([0, 0]);
    } finally {
      copy.close();
    }
  });
});

describe('the upgrade door: a box arrives with muted latches set', () => {
  it('190 applies on the next boot; the first crossing check tells the owner once, at the highest level', async () => {
    const d = freshMigrated();
    agedBody(d);
    d.prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
      .run(JSON.stringify([{ address: 'owner@example.test', name: 'Owner', is_primary: true }]));
    d.prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
               VALUES ('prov', 'Prov', 'openai', 'api_key', 1, datetime('now'), datetime('now'))`).run();
    d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                                   max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled,
                                   created_at, updated_at)
               VALUES ('mdl', 'prov', 'Mdl', 'mdl-1', '["text"]', 65536, 8192, 1.0, 0, 1, datetime('now'), datetime('now'))`).run();
    // Spend already at 95% of the $10 day before the update; its 90% alert was dropped.
    d.prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
               VALUES ('c0', 'x', 'mdl', 'prov', 0, 0, 9.5, datetime('now', '-1 hour'))`).run();

    runMigrations(); // the update's boot: 190 is the one pending file
    expect(d.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(FILE)).toEqual({ n: 1 });

    const { recordCost } = await import('../../costs/tracker.js');
    const call = (): void => recordCost({ agentId: 'x', modelId: 'mdl', providerId: 'prov', inputTokens: 10_000, outputTokens: 0 });
    call();
    const sent = (): string[] => transport.filter((t) => !t.includes('--help') && !t.includes('which'));
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('95%');   // t167: the true share (the crossing was the 90% line)
    call();
    call();
    expect(sent(), 'told once; the new latch holds').toHaveLength(1);

    runMigrations(); // a later boot: 190 is recorded, nothing re-runs, nothing re-alerts
    call();
    expect(sent()).toHaveLength(1);
  });
});

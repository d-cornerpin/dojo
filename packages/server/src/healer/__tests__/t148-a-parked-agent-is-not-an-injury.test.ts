// t148 round 3 (ruling 1) — AN AGENT PARKED ON AN HONEST STOP IS NOT AN INJURY.
//
// An agent held by the spending limit (`[budget_stop]`) or by "no model fits" (`[no_model_fits]`)
// is `paused` with that tag at the head of `last_error` (agent/v2/honest-stop.ts). Nothing is broken
// and nothing the Healer can do changes it, so three Healer sweeps that treat `paused` as an injury
// must leave it alone: the restart rehydrate, the diagnostic, and the 30-minute auto-fix sweep (a
// clock is never evidence the condition cleared, t114). Release happens only through the real-event
// paths. Each is driven against a parked agent AND an ordinary error-loop `paused` control, so the
// exclusion is the tag, never the status.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t148-parked-test', 'dojo.db'),
  };
});
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ notifyPrimaryOfInjury: vi.fn(async () => undefined), handleMessage: vi.fn(async () => undefined) }),
}));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { rehydrateInjuredAgents } from '../injury-recovery.js';
import { runFrequentAutoFixes } from '../auto-fix.js';
import { compileDiagnosticReport } from '../diagnostic.js';
import { runHealerSelfWatchdog } from '../healer-agent.js';
import { lockTag } from '../../agent/v2/honest-stop-lock.js';
import fs from 'node:fs';
import path from 'node:path';

const HEALER = 'healer';
const PARKED = ['budget-parked', 'nofit-parked'] as const;
const LOOP = 'loop-paused';
const TAGS: Record<string, string> = {
  'budget-parked': '[budget_stop] Today\'s spending limit is reached.',
  'nofit-parked': '[no_model_fits] None of this agent\'s models can hold its instructions and tools.',
};

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  const ins = db.prepare(
    `INSERT INTO agents (id, name, status, last_error, last_error_at, recovery_attempts, updated_at)
     VALUES (?, ?, 'paused', ?, datetime('now', '-2 hours'), 3, datetime('now', '-2 hours'))`,
  );
  for (const id of PARKED) ins.run(id, id, TAGS[id]);
  ins.run(LOOP, 'Loop', 'repeated errors: boom');
  db.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Healer', 'idle')").run(HEALER);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', ?)").run(HEALER);
  db.prepare(`INSERT INTO messages (id, agent_id, role, content, created_at) VALUES ('m1', ?, 'user', 'hi', ?)`).run(LOOP, Date.now());
});
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

const statusOf = (id: string): string => (mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;
const attemptsOf = (id: string): number => (mockDb.current!.prepare('SELECT recovery_attempts AS n FROM agents WHERE id = ?').get(id) as { n: number }).n;

describe('t148 r3 — the three Healer sweeps leave a parked agent alone', () => {
  it('the restart rehydrate does not hand a parked agent to the Healer (control: an error-loop pause is still rehydrated)', () => {
    rehydrateInjuredAgents();
    for (const id of PARKED) expect(attemptsOf(id), `${id}: rehydrate replayed it as an injury`).toBe(3);
    expect(attemptsOf(LOOP), 'control: the error-loop pause was rehydrated').toBe(0);
  });

  it('the diagnostic does not report a parked agent as paused after repeated errors (control: the error-loop pause is reported)', () => {
    const paused = compileDiagnosticReport().items.filter((i) => i.code === 'AGENT_PAUSED').map((i) => i.agentId);
    expect(paused).toContain(LOOP);
    for (const id of PARKED) expect(paused).not.toContain(id);
  });

  it('the 30-minute auto-fix sweep does not resume a parked agent: a clock is not evidence the condition cleared (control: the error-loop pause resumes)', () => {
    runFrequentAutoFixes();
    expect(statusOf(LOOP), 'control').toBe('idle');
    for (const id of PARKED) expect(statusOf(id)).toBe('paused');
  });

  it('the three sweeps name the very tags the lock writes (the tag cannot drift from the exclusion)', () => {
    for (const f of ['injury-recovery.ts', 'diagnostic.ts', 'auto-fix.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      for (const kind of ['budget_stop', 'no_model_fits'] as const) {
        expect(src, `${f} excludes ${kind}`).toContain(`instr(COALESCE(last_error, ''), '${lockTag(kind)}') != 1`);
      }
    }
  });

  it('the Healer\'s own watchdog does not reset a PARKED Healer on a clock (control: an error-loop-paused Healer is reset)', () => {
    const db = mockDb.current!;
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('setup_completed', 'true')").run();
    for (const parked of ['[budget_stop] Today\'s spending limit is reached.', '[no_model_fits] None of this agent\'s models can hold it.']) {
      db.prepare("UPDATE agents SET status = 'paused', last_error = ?, updated_at = datetime('now', '-2 hours') WHERE id = ?").run(parked, HEALER);
      runHealerSelfWatchdog();
      expect(statusOf(HEALER), parked).toBe('paused');
    }
    db.prepare("UPDATE agents SET status = 'paused', last_error = 'repeated errors', updated_at = datetime('now', '-2 hours') WHERE id = ?").run(HEALER);
    runHealerSelfWatchdog();
    expect(statusOf(HEALER), 'control').toBe('idle');
  });
});

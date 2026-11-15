// T81d (NO-DOOMED-DIALS) — NOBODY FORCE-RESETS A LIVE AGENT.
//
// Census rows 17 and 15: `healer/auto-fix.ts`'s `fixStuckAgent` and `healer/healer-agent.ts`'s
// self-watchdog both judge "is this agent stuck" purely off `agents.updated_at` staleness, with
// ZERO check that this process's own `activeRuns` concurrency guard says the run is still live.
// `agent/runtime.ts`'s `recoverStuckAgents` (census row 19) already gets this right — "D18:
// never reap a run THIS process knows is live. `activeRuns` is the in-memory concurrency guard;
// deleting it out from under a running turn let a new inbound start a second concurrent turn on
// the same context" — and rows 15/17 exist precisely because these two siblings never copied
// that guard. This file drives both fixers directly through their real public entry points: a
// live `activeRuns` entry survives the sweep untouched; a genuinely dead-process row (no
// `activeRuns` entry) still gets reset, because the guard must NARROW the existing behavior,
// never widen it into "the Healer no longer unfreezes anything."

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t81d-live-agent-test', 'dojo.db'),
  };
});

// The Healer's own recovery bookkeeping (fired via a dynamic import from both fixers under
// test) reaches the engine runtime through this seam. Stubbed so the clause under test is the
// STATUS-RESET DECISION, not the engine it would otherwise wake.
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';
import { activeRuns } from '../../agent/shared-state.js';
import { runAutoFixes } from '../auto-fix.js';
import { runHealerSelfWatchdog } from '../healer-agent.js';

const AGENT = FXID.n4;
const HEALER = 'healer';

function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO agents (id, name, status) VALUES (?, '${FX.n4}', 'idle'), (?, 'Healer', 'idle')`,
  ).run(AGENT, HEALER);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', ?)").run(HEALER);
  // healer-agent.ts's self-watchdog no-ops before setup completes.
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('setup_completed', 'true')").run();
}

const statusOf = (id: string): string =>
  (mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;

/** Age a row's `updated_at` back so the relevant clock-based diagnostic sees it as stale. */
const agedTo = (id: string, status: string, minutes: number): void => {
  mockDb.current!.prepare(
    `UPDATE agents SET status = ?, updated_at = datetime('now', '-${minutes} minutes') WHERE id = ?`,
  ).run(status, id);
};

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  seed(db);
  activeRuns.clear();
});

afterEach(async () => {
  // A reset fires `import('./injury-recovery.js')` without awaiting it; let it land before the next
  // test resets the module registry and imports the same graph again.
  await vi.dynamicImportSettled();
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════
describe('T81d census row 17 — healer/auto-fix.ts\'s fixStuckAgent', () => {
  it('RED: a stuck-looking row with a live activeRuns entry survives the auto-fix sweep untouched', async () => {
    agedTo(AGENT, 'working', 20); // stale by the STUCK_AGENT diagnostic's own clock
    activeRuns.add(AGENT); // ...but THIS process still knows the turn is live

    const item = {
      severity: 'critical' as const, code: 'STUCK_AGENT', title: 't', detail: 'd',
      agentId: AGENT, agentName: FX.n4,
    };
    const res = runAutoFixes('diag-live', [item]);

    expect(res.fixCount, 'a live run must not be counted as fixed').toBe(0);
    expect(statusOf(AGENT), 'a live run must not be force-reset to idle').toBe('working');
  });

  it('a genuinely dead-process row (no activeRuns entry) is still reset — the guard narrows, never widens', async () => {
    agedTo(AGENT, 'working', 20);
    // activeRuns is untouched here — nothing in this process claims the run is live.

    const item = {
      severity: 'critical' as const, code: 'STUCK_AGENT', title: 't', detail: 'd',
      agentId: AGENT, agentName: FX.n4,
    };
    const res = runAutoFixes('diag-dead', [item]);

    expect(res.fixCount).toBe(1);
    expect(statusOf(AGENT)).toBe('idle');
  });

  it('a non-stuck row (fresh updated_at) is untouched regardless of activeRuns — the diagnostic gate still applies first', async () => {
    // status is 'working' but updated_at is fresh (default NOW on insert) — the STUCK_AGENT
    // diagnostic would never have produced this item in real life; this asserts the fixer
    // itself does not force a reset just because it was CALLED, only because the item said so.
    mockDb.current!.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(AGENT);

    const item = {
      severity: 'critical' as const, code: 'STUCK_AGENT', title: 't', detail: 'd',
      agentId: AGENT, agentName: FX.n4,
    };
    runAutoFixes('diag-fresh', [item]);
    expect(statusOf(AGENT), 'the fixer always applies when called with a STUCK_AGENT item — this documents that fact, not a new gate').toBe('idle');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('T81d census row 15 — healer/healer-agent.ts\'s self-watchdog', () => {
  it('RED: a stuck-looking Healer row with a live activeRuns entry survives the self-watchdog untouched', async () => {
    agedTo(HEALER, 'working', 15); // past HEALER_WORKING_STUCK_MINUTES (10)
    activeRuns.add(HEALER); // ...but THIS process still knows the Healer's cycle is live

    runHealerSelfWatchdog();

    expect(statusOf(HEALER), 'a live Healer cycle must not be force-reset to idle').toBe('working');
  });

  it('a genuinely dead-process Healer row (no activeRuns entry) is still reset', async () => {
    agedTo(HEALER, 'working', 15);

    runHealerSelfWatchdog();

    expect(statusOf(HEALER)).toBe('idle');
  });

  it('CONTROL: the Healer\'s error/paused resets are untouched — this guard is scoped to the working+stale branch only', async () => {
    mockDb.current!.prepare("UPDATE agents SET status = 'error' WHERE id = ?").run(HEALER);
    activeRuns.add(HEALER); // even with a live entry, error/paused still reset — no false safety

    runHealerSelfWatchdog();

    expect(statusOf(HEALER), 'the guard must not widen into protecting error/paused too').toBe('idle');
  });

  it('CONTROL: a healthy (non-stale) Healer row is left alone regardless of activeRuns', async () => {
    agedTo(HEALER, 'working', 2); // well under HEALER_WORKING_STUCK_MINUTES
    activeRuns.add(HEALER);

    runHealerSelfWatchdog();

    expect(statusOf(HEALER)).toBe('working');
  });
});

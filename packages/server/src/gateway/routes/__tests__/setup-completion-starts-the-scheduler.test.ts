import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

const logLines: Array<{ level: string; msg: string }> = [];
vi.mock('../../../logger.js', () => {
  const rec = (level: string) => (msg: string) => { logLines.push({ level, msg }); };
  return {
    createLogger: () => ({ debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }),
    setLogLevel: () => {}, setLogBroadcast: () => {}, readLogEntries: () => [],
  };
});
vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os'); const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('no test DB'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-setup-complete', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

// The password gate is not this file's subject; it is satisfied so the primary gate is reachable.
vi.mock('../../../config/loader.js', () => ({
  getDashboardPasswordHash: () => '$2b$12$fixture.hash.value.not.real',
  setDashboardPassword: () => {},
  getJwtSecret: () => 'fixture-jwt-secret-not-real',
}));

/** First-run state, driven per clause. */
const firstRun = { past: false, marked: 0 };
/** Swappable so an ordering clause can observe the world AT THE MOMENT the window shuts. */
const markSpy: { impl: (() => void) | null } = { impl: null };
vi.mock('../../../config/setup-state.js', () => ({
  isPastFirstRun: () => firstRun.past,
  markFirstRunComplete: () => {
    if (markSpy.impl) { markSpy.impl(); return; }
    firstRun.marked += 1; firstRun.past = true;
  },
}));

vi.mock('../../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary-1',
  clearPlatformConfigCache: () => {},
}));

/** Every resident's ensure function, counted — none of them may be reached without a primary. */
const ensured: string[] = [];
vi.mock('../../../tracker/pm-agent.js', () => ({ ensurePMAgentRunning: () => { ensured.push('pm'); } }));
vi.mock('../../../techniques/trainer-agent.js', () => ({ ensureTrainerAgentRunning: () => { ensured.push('trainer'); } }));
vi.mock('../../../healer/healer-agent.js', () => ({ ensureHealerAgentRunning: () => { ensured.push('healer'); } }));
vi.mock('../../../vault/maintenance.js', () => ({
  ensureDreamerAgentRunning: () => { ensured.push('dreamer'); },
  scheduleDreamingCycle: () => {},
  bootstrapOwnerProfile: () => {},
}));
vi.mock('../../../agent/groups.js', () => ({ ensureSystemGroup: () => {} }));

const scheduler = { started: 0 };
vi.mock('../../../scheduler/clock.js', () => ({ startScheduler: () => { scheduler.started += 1; } }));

import { setupRouter } from '../setup.js';

const complete = (): Promise<Response> =>
  setupRouter.request('/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });

const seedPrimary = (): void => {
  mockDb.current!.prepare(
    "INSERT INTO agents (id, name, status) VALUES ('primary-1', 'Primary', 'idle')",
  ).run();
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `);
  logLines.length = 0; ensured.length = 0; markSpy.impl = null;
  firstRun.past = false; firstRun.marked = 0;
  scheduler.started = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('setup completion starts the scheduler clock', () => {
  it('⚠ a fresh box that completes setup has a running clock, not one waiting for a restart', async () => {
    seedPrimary();
    const res = await complete();

    expect(res.status).toBe(200);
    // At boot the clock starts only when setup was already complete, so on a brand-new install
    // this route is the only place it can start. Without it every day-one reminder stays silent.
    expect(scheduler.started).toBe(1);
  });

  it('a refused completion starts nothing', async () => {
    const res = await complete();

    expect(res.status).toBe(400);
    expect(scheduler.started).toBe(0);
  });

  it('⚠ the already-complete refusal does not start a second clock', async () => {
    seedPrimary();
    await complete();
    const second = await complete();

    expect(second.status).toBe(403);
    expect(scheduler.started).toBe(1);
  });
});

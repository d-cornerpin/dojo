// T82 FIX WAVE — C1 (CRITICAL): A SERVER RESTART MUST NOT INFLATE THE RESET GUARD'S COUNT.
//
// `onAgentInjured` (`healer/injury-recovery.ts`) recorded a `declared_patience_honest_fail` row
// whenever `classifyError` PHRASE-matched the declared-patience class — but `rehydrateInjuredAgents`
// (called on EVERY server start) replays `onAgentInjured(agent.id, agent.last_error)` for every
// error/paused agent with NO CODE, and `agents.last_error` carries that same phrase for as long
// as the agent stays injured. One real failed chain + one restart therefore recorded TWO rows
// (the phrase matches on both the live failure and the rehydrate replay), so the reset guard's
// own "compact-and-redial already failed on >=2 distinct turns" criterion was satisfiable after a
// SINGLE genuine failed chain plus a routine restart — amnesia-first, reopened by routine
// restarts, exactly the class R2 exists to close.
//
// FIX: the honest-fail row is recorded ONLY when the `code` PARAMETER equals
// `DECLARED_PATIENCE_EXCEEDED_CODE` — the live path (`v2/recovery.ts`'s `recordInjury`) always
// passes it (see that file's own T81a comment); `rehydrateInjuredAgents` and the platform-error
// caller (`v2/recovery.ts`'s `tryPlatformErrorRecovery`) never do — both hold only a persisted
// STRING, and no code survives a restart. The auto-wake skip and grace-period selection are
// UNCHANGED — they still key on the phrase-matched `classifyError` result (T81a's own point),
// and stay provably alive in `a-declared-patience-injury-skips-the-blind-auto-wake.test.ts`.

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t82-fix-wave-c1-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { onAgentInjured, rehydrateInjuredAgents, countDeclaredPatienceHonestFails } from '../injury-recovery.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE } from '../../agent/stream-patience.js';

const AGENT = 'kevin';
const HEALER = 'healer';

// The literal `model.ts` throw-site phrase (copied, not imported — every fixture in this tree
// standing in for `agents.last_error` after a restart does the same, per `classifyError`'s own
// header: the reader holds a STRING and nothing else).
const PATIENCE_LAST_ERROR =
  'model first-chunk timeout: no data from provider for too long (elapsed 300123ms; ' +
  '~92000 estimated prompt tokens against a declared 300000ms first-chunk patience)';

function seed(db: Database.Database, opts: { status: 'error' | 'paused'; recoveryAttempts?: number }): void {
  db.prepare(
    "INSERT INTO agents (id, name, status, last_error, recovery_attempts) VALUES (?, 'Kevin', ?, ?, ?), (?, 'Healer', 'idle', NULL, 0)",
  ).run(AGENT, opts.status, PATIENCE_LAST_ERROR, opts.recoveryAttempts ?? 0, HEALER);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', ?)").run(HEALER);
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('C1 (T82 fix wave): a restart replay of a phrase-only injury must not inflate the honest-fail count', () => {
  it('RED: rehydrating an agent injured at declared-patience does NOT record a fresh honest-fail row', () => {
    seed(mockDb.current!, { status: 'error' });
    expect(countDeclaredPatienceHonestFails(AGENT)).toBe(0);

    rehydrateInjuredAgents();

    expect(countDeclaredPatienceHonestFails(AGENT)).toBe(0);
  });

  it('CONTROL: the live path (code passed explicitly) still records exactly one row per call', () => {
    seed(mockDb.current!, { status: 'error' });
    expect(countDeclaredPatienceHonestFails(AGENT)).toBe(0);

    onAgentInjured(AGENT, PATIENCE_LAST_ERROR, DECLARED_PATIENCE_EXCEEDED_CODE);

    expect(countDeclaredPatienceHonestFails(AGENT)).toBe(1);

    onAgentInjured(AGENT, PATIENCE_LAST_ERROR, DECLARED_PATIENCE_EXCEEDED_CODE);

    expect(countDeclaredPatienceHonestFails(AGENT)).toBe(2);
  });

  it('CONTROL: a rehydrate immediately AFTER a real live-path failure does not add a second row (the exact incident shape)', () => {
    seed(mockDb.current!, { status: 'error' });
    onAgentInjured(AGENT, PATIENCE_LAST_ERROR, DECLARED_PATIENCE_EXCEEDED_CODE);
    expect(countDeclaredPatienceHonestFails(AGENT)).toBe(1);

    // The server restarts: last_error still carries the phrase, recovery_attempts persisted.
    rehydrateInjuredAgents();

    expect(countDeclaredPatienceHonestFails(AGENT)).toBe(1); // NOT 2 — the incident this fixes
  });

  it('CONTROL: a paused (error-loop) agent rehydrated the same way is also unaffected', () => {
    seed(mockDb.current!, { status: 'paused', recoveryAttempts: 5 });
    expect(countDeclaredPatienceHonestFails(AGENT)).toBe(0);

    rehydrateInjuredAgents();

    expect(countDeclaredPatienceHonestFails(AGENT)).toBe(0);
  });
});

// t261 (F4) — THE FREQUENT SWEEP HONOURS DECLARED PATIENCE.
//
// `cooldownSweepMayRecover` keeps an agent whose last failure was a declared-patience refusal in
// front of the owner: a restart cannot fix it, so the honest `error` status and its error text stay
// visible instead of being cleared every 30 minutes. The two daily-cycle fixers consult it; the
// 5-minute `runFrequentAutoFixes` sweep's own loops did not, so an agent that sat in `error` or
// `paused` for 30 minutes was flipped to `idle` anyway and dialed the same doomed request again.
// This drives both loops against a declared-patience agent AND an ordinary control of each status.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t261-frequent-sweep-test', 'dojo.db'),
  };
});
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ notifyPrimaryOfInjury: vi.fn(async () => undefined), handleMessage: vi.fn(async () => undefined) }),
}));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { runFrequentAutoFixes } from '../auto-fix.js';

const PATIENCE_MSG = 'declared_patience_exceeded: the prompt cannot finish in time';
const PLAIN_ERROR = 'boom: network reset';
const PLAIN_PAUSED = 'repeated errors: boom';

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  const ins = db.prepare(
    `INSERT INTO agents (id, name, status, last_error, last_error_at, recovery_attempts, updated_at)
     VALUES (?, ?, ?, ?, datetime('now', '-2 hours'), 3, datetime('now', '-2 hours'))`,
  );
  ins.run('patience-error', 'PatienceError', 'error', PATIENCE_MSG);
  ins.run('patience-paused', 'PatiencePaused', 'paused', PATIENCE_MSG);
  ins.run('plain-error', 'PlainError', 'error', PLAIN_ERROR);
  ins.run('plain-paused', 'PlainPaused', 'paused', PLAIN_PAUSED);
});
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

const statusOf = (id: string): string => (mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;
const lastErrorOf = (id: string): string | null => (mockDb.current!.prepare('SELECT last_error FROM agents WHERE id = ?').get(id) as { last_error: string | null }).last_error;

describe('t261 — the frequent sweep honours a declared-patience refusal', () => {
  it('a declared-patience failure is left alone in BOTH loops (control: the ordinary agents reset)', () => {
    runFrequentAutoFixes();

    expect(statusOf('patience-error'), 'a declared-patience error is not cleared by a clock').toBe('error');
    expect(statusOf('patience-paused'), 'a declared-patience pause is not resumed by a clock').toBe('paused');
    expect(lastErrorOf('patience-error'), 'the honest error text stays in front of the owner')
      .toBe(PATIENCE_MSG);

    expect(statusOf('plain-error'), 'control: an ordinary error still resets').toBe('idle');
    expect(statusOf('plain-paused'), 'a paused agent waits for the owner, never a clock').toBe('paused');
  });
});

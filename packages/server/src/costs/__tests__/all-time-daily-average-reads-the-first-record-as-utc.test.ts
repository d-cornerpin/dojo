// ════════════════════════════════════════════════════════════════════════════════════════
// THE ALL-TIME DAILY AVERAGE READS ITS FIRST RECORD AS UTC, NOT THE BOX'S OWN ZONE.
//
// `cost_records.created_at` is written by SQLite's `datetime('now')` as zoneless text
// (`2026-10-30 11:00:00`, UTC, no zone marker). JavaScript reads such text as the machine's
// LOCAL time, so on a box behind UTC the first record looks LATER than it was and the day
// count for the all-time average comes out too small — a first record 25 hours back reads as
// one day, doubling the `dailyAvg`. This pins the read as UTC so the answer is zone-blind.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-costs-utc');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-costs-utc');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-costs-utc', 'dojo.db'),
  };
});

const { broadcasts, transport, transportFails } = vi.hoisted(() => ({
  broadcasts: [] as Array<{ type: string; data?: Record<string, unknown> }>,
  transport: [] as string[],
  transportFails: { on: false },
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: { type: string; data?: Record<string, unknown> }) => { broadcasts.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => {
    const line = JSON.stringify(a);
    transport.push(line);
    if (transportFails.on && !line.includes('--help')) throw new Error('transport down');
    return '';
  };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});
vi.mock('../../services/imessage-run.js', async (importOriginal) => {
  const cp = await import('node:child_process');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    runMessagesProgram: async (program: string, argv: readonly string[], opts: object) => String(cp.execFileSync(program, [...argv], opts)),
    wasCutByTheStop: () => false,
  };
});

import { getCostSummary } from '../tracker.js';

// The original zone, so afterAll can put the box back where it was.
const PREV_TZ = process.env.TZ;

beforeAll(() => {
  const d = new Database(':memory:');
  mockDb.current = d;
  // The summary joins cost_records to models and agents; empty join targets suffice.
  d.exec(`
    CREATE TABLE cost_records (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      model_id TEXT,
      provider_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      request_type TEXT,
      created_at TEXT
    );
    CREATE TABLE models (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
  `);
  // One first record, 25 hours before the fake now, written the way the writer writes it:
  // zoneless `datetime('now')` text in UTC.
  d.prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                                       cost_usd, request_type, created_at)
             VALUES ('cr-1', 'a1', 'mdl', 'prov', 0, 0, 10, NULL, '2026-10-30 11:00:00')`).run();

  // A box behind UTC: local time reads 8 hours behind, so the local-time parse of the first
  // record lands 17h back (one day) instead of the true 25h (two days).
  process.env.TZ = 'America/Los_Angeles';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
});

afterAll(() => {
  mockDb.current?.close();
  mockDb.current = null;
  vi.useRealTimers();
  process.env.TZ = PREV_TZ;
});

describe('the all-time daily average reads its first record as UTC', () => {
  it('counts the days between the first record and now in UTC, so 25h back is two days', () => {
    // 25 hours back over two days is a $5/day average; a local-time parse on this box behind
    // UTC would count one day and show $10.
    expect(getCostSummary('all').dailyAvg).toBe(5);
  });
});

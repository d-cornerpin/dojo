// A memory unused for 30+ days loses one tenth of its confidence, then waits another 30 days.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getDreamerAgentId: () => 'dreamer',
  getDreamerAgentName: () => 'Dreamer',
  isSetupCompleted: () => true,
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/spawner.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../../agent/v2/counterparty.js', () => ({ rehomeUnclaimedEngineEvents: vi.fn() }));

const store = vi.hoisted(() => ({
  getUnprocessedConversations: vi.fn(),
  getUnprocessedConversationMeta: vi.fn(),
  getUnprocessedConversationById: vi.fn(),
  getUnprocessedConversationCount: vi.fn(),
  getVaultStats: vi.fn(() => ({ totalEntries: 0, pinnedCount: 0, permanentCount: 0 })),
  createDreamReport: vi.fn(),
  getConversation: vi.fn(() => null),
  incrementArchiveAttempt: vi.fn(() => 1),
  markArchivePoisoned: vi.fn(),
  markConversationProcessed: vi.fn(),
  sqlUtcStamp: (d: Date) => d.toISOString().slice(0, 19).replace('T', ' '),
  restoreCleanupHidesOnce: vi.fn(),
}));
vi.mock('../store.js', () => store);

import { runEngineMaintenance } from '../maintenance.js';


const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-10-27T15:00:00Z');
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vault_entries (
      id TEXT PRIMARY KEY,
      confidence REAL,
      retrieval_count INTEGER DEFAULT 0,
      created_at TEXT,
      last_retrieved_at TEXT,
      updated_at TEXT,
      last_decayed_at TEXT,
      is_obsolete INTEGER DEFAULT 0,
      is_pinned INTEGER DEFAULT 0,
      is_permanent INTEGER DEFAULT 0
    );
  `);
  mockDb.current = db;
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

function addUnused(id: string, confidence: number, daysAgo: number): void {
  const t = stamp(new Date(START.getTime() - daysAgo * DAY));
  mockDb.current!.prepare(
    'INSERT INTO vault_entries (id, confidence, retrieval_count, created_at, last_retrieved_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)'
  ).run(id, confidence, t, t, t);
}
function conf(id: string): number | undefined {
  return (mockDb.current!.prepare('SELECT confidence FROM vault_entries WHERE id = ?').get(id) as { confidence: number } | undefined)?.confidence;
}
function nextNight(): void {
  vi.setSystemTime(new Date(Date.now() + DAY));
  runEngineMaintenance();
}

describe('engine maintenance fades a memory at most once per 30 unused days', () => {
  it('lowers an unused memory by one step, not a step every night', () => {
    addUnused('M', 0.8, 40);
    runEngineMaintenance();
    expect(conf('M')).toBeCloseTo(0.7);
    nextNight();
    nextNight();
    expect(conf('M')).toBeCloseTo(0.7);
  });

  it('steps again once 30 more days have passed', () => {
    addUnused('M', 0.8, 40);
    runEngineMaintenance();
    vi.setSystemTime(new Date(Date.now() + 31 * DAY));
    runEngineMaintenance();
    expect(conf('M')).toBeCloseTo(0.6);
  });

  it('deletes nothing within 60 nights that did not start low', () => {
    addUnused('M', 0.8, 40);
    addUnused('N', 0.6, 35);
    for (let i = 0; i < 60; i++) nextNight();
    expect(conf('M')).toBeDefined();
    expect(conf('N')).toBeDefined();
    expect(conf('M')!).toBeGreaterThanOrEqual(0.5);
  });

  it('retires a memory that started below the floor (marks it obsolete, keeps the row)', () => {
    addUnused('L', 0.05, 40);
    runEngineMaintenance();
    const row = mockDb.current!.prepare('SELECT is_obsolete FROM vault_entries WHERE id = ?').get('L') as { is_obsolete: number };
    expect(row.is_obsolete).toBe(1);
  });
});

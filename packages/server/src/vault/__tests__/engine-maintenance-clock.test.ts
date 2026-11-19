// ════════════════════════════════════════
// runEngineMaintenance age cut-offs: the vault's timestamps are UTC text in
// SQLite's datetime('now') shape ('YYYY-MM-DD HH:MM:SS'), so binding a JS
// toISOString() ('...T...Z') against them compares two clock shapes as plain
// text and every entry created ON the cut-off date already reads as past it,
// firing each clean-up rule up to a day before its stated window.
// ════════════════════════════════════════

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
  vi.setSystemTime(new Date('2026-10-27T15:00:00Z'));
});

afterEach(() => vi.useRealTimers());

function isObsolete(id: string): number {
  const row = mockDb.current!
    .prepare('SELECT is_obsolete FROM vault_entries WHERE id = ?')
    .get(id) as { is_obsolete: number };
  return row.is_obsolete;
}

describe('runEngineMaintenance 7-day cut-off (mixed clock text)', () => {
  it('keeps an entry that has not yet reached 7 days and marks one that has', () => {
    const ins = mockDb.current!.prepare(
      'INSERT INTO vault_entries (id, confidence, retrieval_count, created_at) VALUES (?, ?, ?, ?)'
    );
    ins.run('A', 0.3, 0, '2026-10-20 20:00:00'); // 6 days 19 hours old: not yet 7 days
    ins.run('B', 0.3, 0, '2026-10-20 10:00:00'); // 7 days 5 hours old
    runEngineMaintenance();
    expect(isObsolete('A')).toBe(0);
    expect(isObsolete('B')).toBe(1);
  });
});

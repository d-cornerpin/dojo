// P4: the nightly clean-up never deletes a memory; a very low-confidence one is marked obsolete (still searchable).
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


describe('the nightly clean-up never hard-deletes a memory', () => {
  it('a memory below 0.1 confidence is marked obsolete, and its row is still there', () => {
    addUnused('LOW', 0.05, 5);
    const r = runEngineMaintenance();
    const row = mockDb.current!.prepare('SELECT is_obsolete FROM vault_entries WHERE id = ?').get('LOW') as { is_obsolete: number } | undefined;
    expect(row, 'owner data is never lost').toBeDefined();
    expect(row!.is_obsolete).toBe(1);
    expect(r.pruned).toBe(1);
  });
  it('a pinned or permanent low-confidence memory is left alone', () => {
    addUnused('PIN', 0.05, 5);
    mockDb.current!.prepare('UPDATE vault_entries SET is_pinned = 1 WHERE id = ?').run('PIN');
    runEngineMaintenance();
    const row = mockDb.current!.prepare('SELECT is_obsolete FROM vault_entries WHERE id = ?').get('PIN') as { is_obsolete: number };
    expect(row.is_obsolete).toBe(0);
  });
});

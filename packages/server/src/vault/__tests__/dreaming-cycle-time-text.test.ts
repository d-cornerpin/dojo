// ════════════════════════════════════════
// Dreaming schedule: dreamTime text is NOT validated.
//
// `scheduleDreamingCycle` (maintenance.ts) reads config.dreamTime (default
// '03:00') and parses it with `split(':').map(Number)`. PUT /api/vault/dream/
// config stores body.dreamTime unchecked, so '' / '9am' / '3' / '24:00' / '7:75'
// / a non-string all slip through. The resulting delay is NaN and setTimeout
// fires after a few ms, so engine maintenance (disk reclaim + summary rebuild)
// and the dreaming cycle run back-to-back, forever — and unlike the healer the
// schedule runs even when dreaming is 'off', so every box is exposed.
//
// These tests pin the exact rules (from brief 79): accept only
// ^(\d{1,2}):(\d{2})$ with hours 0-23 and minutes 0-59; otherwise fall back to
// '03:00' and report usedFallback:true. The target is the next strictly-later
// local time (setHours, then setDate(+1) when already passed), and delayMs is
// always finite and > 0.
//
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { nextDailyRunDelayMs } from '../maintenance.js';

// Same hermetic mocks as dream-cycle-marker.test.ts so importing maintenance.js
// (which the GREEN version does for the helper) stays self-contained.
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
vi.mock('../store.js', () => ({
  getConversation: vi.fn(() => null),
  getUnprocessedConversations: vi.fn(),
  getVaultStats: vi.fn(() => ({ totalEntries: 0, pinnedCount: 0, permanentCount: 0 })),
  createDreamReport: vi.fn(),
}));

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  mockDb.current = db;
  vi.clearAllMocks();
});

describe('nextDailyRunDelayMs (dreamTime text validation)', () => {
  const now = new Date(2026, 0, 15, 10, 30, 0, 0);

  it('accepts a well-formed time and schedules the next strictly-later moment', () => {
    // 03:00 tomorrow = 16 h 30 m from 10:30.
    const { delayMs, usedFallback } = nextDailyRunDelayMs('03:00', '03:00', now);
    expect(delayMs).toBe(59_400_000);
    expect(usedFallback).toBe(false);
  });

  it('schedules a later time today', () => {
    const { delayMs, usedFallback } = nextDailyRunDelayMs('12:00', '03:00', now);
    expect(delayMs).toBe(5_400_000);
    expect(usedFallback).toBe(false);
  });

  it('moves an exactly-now target to tomorrow', () => {
    const { delayMs, usedFallback } = nextDailyRunDelayMs('10:30', '03:00', now);
    expect(delayMs).toBe(86_400_000);
    expect(usedFallback).toBe(false);
  });

  it('accepts a single-digit hour', () => {
    const { delayMs, usedFallback } = nextDailyRunDelayMs('3:07', '03:00', now);
    expect(delayMs).toBe(59_820_000);
    expect(usedFallback).toBe(false);
  });

  it('falls back to 03:00 for every bad text instead of scheduling NaN', () => {
    for (const bad of ['', '9am', '3', '24:00', '7:75', undefined, 3]) {
      const { delayMs, usedFallback } = nextDailyRunDelayMs(bad, '03:00', now);
      expect(usedFallback).toBe(true);
      expect(delayMs).toBe(59_400_000);
    }
  });

  it('always yields a finite, positive delay', () => {
    for (const text of ['03:00', '12:00', '10:30', '3:07', '', '9am', '3', '24:00', '7:75', undefined, 3]) {
      const { delayMs } = nextDailyRunDelayMs(text, '03:00', now);
      expect(Number.isFinite(delayMs)).toBe(true);
      expect(delayMs).toBeGreaterThan(0);
    }
  });
});

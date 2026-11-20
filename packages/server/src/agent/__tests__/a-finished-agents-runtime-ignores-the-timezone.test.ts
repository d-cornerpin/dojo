// ════════════════════════════════════════
// Completed-agent runtime - the zone bug, unit-tested on the real helper.
//
// SQLite writes created_at via datetime('now'): UTC wall-clock text with no
// zone. Bare `new Date(text)` reads that as LOCAL time, so every consumer of
// durationSeconds was off by the box's UTC offset (negative runtime in the US).
// runtimeSecondsSince must read the stamp as UTC regardless of the box zone.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: () => false,
  getPrimaryAgentId: () => 'primary',
}));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: vi.fn() }) }));
vi.mock('../agent-notice.js', () => ({ postAgentNotice: vi.fn() }));
vi.mock('../permissions.js', () => ({ getAgentPermissions: vi.fn(), checkPermission: vi.fn(() => ({ allowed: true })) }));
vi.mock('../../memory/retrieval.js', () => ({ memoryGrep: vi.fn(() => 'No results found') }));
vi.mock('../../services/resource-monitor.js', () => ({ canSpawnAgent: () => ({ allowed: true }) }));
vi.mock('../../vault/archive.js', () => ({ archiveAgentConversation: vi.fn() }));

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT DEFAULT 'idle',
      classification TEXT,
      created_by TEXT,
      parent_agent TEXT,
      task_id TEXT,
      timeout_at TEXT,
      max_runtime INTEGER,
      timeout_decision_pending INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  mockDb.current = db;
});

const originalTZ = process.env.TZ;

afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

import { runtimeSecondsSince } from '../spawner.js';

// Five minutes after the 2026-10-26 10:00:00 UTC stamp.
const NOW_MS = Date.UTC(2026, 9, 26, 10, 5, 0);

describe('runtimeSecondsSince - SQLite UTC stamps are not local time', () => {
  it('reads a zone-less UTC stamp as UTC in America/New_York', () => {
    process.env.TZ = 'America/New_York';
    expect(runtimeSecondsSince('2026-10-26 10:00:00', NOW_MS)).toBe(300);
  });

  it('reads a zone-less UTC stamp as UTC in Asia/Kolkata', () => {
    process.env.TZ = 'Asia/Kolkata';
    expect(runtimeSecondsSince('2026-10-26 10:00:00', NOW_MS)).toBe(300);
  });

  it('reads a zone-less UTC stamp as UTC in UTC', () => {
    process.env.TZ = 'UTC';
    expect(runtimeSecondsSince('2026-10-26 10:00:00', NOW_MS)).toBe(300);
  });

  it('honors an instant that already carries a zone', () => {
    process.env.TZ = 'America/New_York';
    expect(runtimeSecondsSince('2026-10-26T10:00:00Z', NOW_MS)).toBe(300);
    expect(runtimeSecondsSince('2026-10-26T06:00:00-04:00', NOW_MS)).toBe(300);
  });

  it('returns 0 for text that does not parse', () => {
    process.env.TZ = 'America/New_York';
    expect(runtimeSecondsSince('not a time', NOW_MS)).toBe(0);
    expect(runtimeSecondsSince('', NOW_MS)).toBe(0);
  });
});

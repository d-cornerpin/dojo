// ════════════════════════════════════════════════════════════════════════════════════════
// recall_recent_thread's `since` must READ the zone an agent passes, not drop it.
//
// `memory/recall.ts` `normalizeTimestampForSqlite` took an ISO-8601 instant WITH an
// explicit offset and DELETED the offset, leaving the clock time, which `unixepoch(?)`
// then read as UTC — so "09:00:00-07:00" (16:00 UTC) became "09:00" UTC, a 7h shift.
// The fix reads the zone as an instant and normalizes the UTC clock time. The DB cases
// pin the boundary on both sides of the shift; the pure block pins the shape.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: () => { /* not exercised */ },
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { recallRecentThread, normalizeTimestampForSqlite } from '../recall.js';

const A = 'agent-since';
let image: Buffer | null = null;

beforeEach(() => {
  if (!image) { const s = new Database(':memory:'); mockDb.current = s; runMigrations(); image = s.serialize(); s.close(); }
  mockDb.current = new Database(image);
  const db = mockDb.current;
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, 'A', 'idle', datetime('now'))`).run(A);
  const alpha = insertMessage({ agentId: A, role: 'user', lane: 'owner', senderId: 'owner', content: 'alpha-first', turnNumber: 1 });
  const bravo = insertMessage({ agentId: A, role: 'user', lane: 'owner', senderId: 'owner', content: 'bravo-second', turnNumber: 2 });
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.parse('2026-10-01T12:00:00Z'), alpha.id);
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.parse('2026-10-01T17:00:00Z'), bravo.id);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

function recall(since: string): string {
  return recallRecentThread(A, { turnCount: 20, includeToolCalls: false, scope: 'all', since });
}

describe('recall `since` reads the zone, not a dropped offset', () => {
  it('a -07:00 since is 16:00 UTC: the 17:00 row is kept, the 12:00 row dropped', () => {
    const out = recall('2026-10-01T09:00:00-07:00');
    expect(out).toContain('bravo-second');
    expect(out).not.toContain('alpha-first');
  });

  it('a +02:00 since of 19:00 is 17:00 UTC: the >= boundary keeps the 17:00 row', () => {
    const out = recall('2026-10-01T19:00:00+02:00');
    expect(out).toContain('bravo-second');
  });

  it('a +02:00 since of 09:00 is 07:00 UTC: keeps both rows (control)', () => {
    const out = recall('2026-10-01T09:00:00+02:00');
    expect(out).toContain('alpha-first');
    expect(out).toContain('bravo-second');
  });

  it('a Z since of 12:00 UTC: keeps both rows (control)', () => {
    const out = recall('2026-10-01T12:00:00Z');
    expect(out).toContain('alpha-first');
    expect(out).toContain('bravo-second');
  });
});

describe('normalizeTimestampForSqlite reads the zone as an instant', () => {
  it('a negative offset shifts the clock to UTC', () => {
    expect(normalizeTimestampForSqlite('2026-10-01T09:00:00-07:00')).toBe('2026-10-01 16:00:00');
  });
  it('a colonless +hhmm offset is read', () => {
    expect(normalizeTimestampForSqlite('2026-10-01T09:00:00+0200')).toBe('2026-10-01 07:00:00');
  });
  it('fractional seconds are dropped with a Z', () => {
    expect(normalizeTimestampForSqlite('2026-10-01T09:00:00.123Z')).toBe('2026-10-01 09:00:00');
  });
  it('a bare date is unchanged', () => {
    expect(normalizeTimestampForSqlite('2026-10-01')).toBe('2026-10-01');
  });
  it('a space-separated no-zone time is unchanged', () => {
    expect(normalizeTimestampForSqlite('2026-10-01 09:00:00')).toBe('2026-10-01 09:00:00');
  });
  it('a T-separated no-zone time keeps its space and no seconds', () => {
    expect(normalizeTimestampForSqlite('2026-10-01T09:00')).toBe('2026-10-01 09:00');
  });
});

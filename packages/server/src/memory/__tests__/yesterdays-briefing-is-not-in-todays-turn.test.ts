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
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../agent/model.js', () => ({ callModel: vi.fn() }));
vi.mock('../../work/obligations.js', () => ({ buildAgedWorkBriefSection: () => null }));

import { runMigrations } from '../../db/migrations.js';
import { todaysBriefing } from '../briefing.js';

const AGENT = 'agent-todays-briefing';
const PREV_TZ = process.env.TZ;
const seedBriefing = (generatedAt: string): void => {
  mockDb.current!.prepare(
    "INSERT INTO briefings (id, agent_id, content, token_count, generated_at) VALUES ('b-1', ?, 'The porch light job is open.', 8, ?)",
  ).run(AGENT, generatedAt);
};

beforeEach(() => {
  process.env.TZ = 'UTC';
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES (?, 'Briefing Desk', 'idle', '{}')").run(AGENT);
});
afterEach(() => {
  if (PREV_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PREV_TZ;
  mockDb.current?.close();
  mockDb.current = null;
});

describe("yesterday's briefing is not in today's turn", () => {
  it('a briefing made today is shown', () => {
    seedBriefing('2026-08-30 06:00:00');
    expect(todaysBriefing(AGENT, Date.parse('2026-08-30T20:00:00Z'))).toEqual({
      content: 'The porch light job is open.',
      day: '2026-08-30',
    });
  });

  it("yesterday's briefing is not", () => {
    seedBriefing('2026-08-30 06:00:00');
    expect(todaysBriefing(AGENT, Date.parse('2026-08-31T00:30:00Z'))).toBeNull();
  });

  it('today is the local day, not the UTC day', () => {
    process.env.TZ = 'America/Chicago';
    seedBriefing('2026-08-31 02:00:00');
    expect(todaysBriefing(AGENT, Date.parse('2026-08-31T04:00:00Z'))).toEqual({
      content: 'The porch light job is open.',
      day: '2026-08-30',
    });
  });
});

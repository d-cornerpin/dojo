// RC-5.3: proactive-send budget tests.
//
// A persistent per-agent streak counts consecutive proactive (settled-context) user-
// facing deliveries; it resets on any authorized owner inbound. At the threshold the
// loop demotes the outbound to a quiet notices-lane row instead of pinging.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import {
  getProactiveSendStreak,
  bumpProactiveSendStreak,
  resetProactiveSendStreak,
  PROACTIVE_SEND_DEMOTE_THRESHOLD,
} from '../proactive-budget.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);`);
  mockDb.current = db;
});

describe('RC-5.3 proactive-send streak', () => {
  it('starts at 0 for a fresh agent', () => {
    expect(getProactiveSendStreak('a1')).toBe(0);
  });

  it('increments and persists', () => {
    expect(bumpProactiveSendStreak('a1')).toBe(1);
    expect(bumpProactiveSendStreak('a1')).toBe(2);
    expect(getProactiveSendStreak('a1')).toBe(2);
  });

  it('reset clears the streak (owner inbound arrived)', () => {
    bumpProactiveSendStreak('a1');
    bumpProactiveSendStreak('a1');
    resetProactiveSendStreak('a1');
    expect(getProactiveSendStreak('a1')).toBe(0);
  });

  it('is scoped per agent', () => {
    bumpProactiveSendStreak('a1');
    bumpProactiveSendStreak('a1');
    expect(getProactiveSendStreak('a2')).toBe(0);
  });

  it('reaches the demote threshold after that many proactive deliveries', () => {
    for (let i = 0; i < PROACTIVE_SEND_DEMOTE_THRESHOLD; i++) bumpProactiveSendStreak('a1');
    expect(getProactiveSendStreak('a1')).toBeGreaterThanOrEqual(PROACTIVE_SEND_DEMOTE_THRESHOLD);
  });
});

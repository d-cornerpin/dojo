// Every config write goes through setConfigValue: one row per key, the value replaced, the time stamped.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
}));

import { setConfigValue } from '../config-value.js';
import { setPlatformConfig, getPrimaryAgentName } from '../platform.js';

const rows = (key: string) => mockDb.current!.prepare('SELECT value, updated_at FROM config WHERE key = ?').all(key) as Array<{ value: string; updated_at: string | null }>;

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  mockDb.current.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
});

describe('setConfigValue', () => {
  it('creates the row with its value and a time stamp', () => {
    setConfigValue('some_key', 'one');
    const got = rows('some_key');
    expect(got.length).toBe(1);
    expect(got[0].value).toBe('one');
    expect(got[0].updated_at).not.toBeNull();
  });

  it('replaces the value of a key that already exists and keeps one row', () => {
    setConfigValue('some_key', 'one');
    setConfigValue('some_key', 'two');
    const got = rows('some_key');
    expect(got.length).toBe(1);
    expect(got[0].value).toBe('two');
  });

  it('setPlatformConfig writes through it and the cached name is read fresh', () => {
    expect(getPrimaryAgentName()).toBe('Agent');
    setPlatformConfig('primary_agent_name', 'Atlas');
    expect(rows('primary_agent_name')[0].value).toBe('Atlas');
    expect(getPrimaryAgentName()).toBe('Atlas');
  });
});

// One person per Dojo: the household is the main agent and the Dreamer, not a stored config list.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] };
});
// A different vector per call, so the duplicate check never merges two test facts.
vi.mock('../../memory/embeddings.js', () => {
  let n = 0;
  return {
    generateEmbedding: async () => { const v = new Float32Array(8); v[n++ % 8] = 1; return v; },
    queueEmbedding: () => undefined,
    storeEmbedding: async () => undefined,
    refreshEmbedding: () => undefined,
    getEmbeddingStatus: () => ({}),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { clearPlatformConfigCache, getHouseholdAgentIds } from '../platform.js';
import { resolveRecallScope } from '../../vault/store.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const put = mockDb.current.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  put.run('primary_agent_id', 'main-agent');
  put.run('dreamer_agent_id', 'dreamer');
  put.run('household_agent_ids', JSON.stringify(['main-agent', 'second-agent']));
  clearPlatformConfigCache();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  clearPlatformConfigCache();
});

describe('the household is the main agent and the Dreamer', () => {
  it('the household is the main agent and the Dreamer, whatever an old config row says', () => {
    expect(getHouseholdAgentIds()).toEqual(['main-agent', 'dreamer']);
  });

  it("an agent named only in the old config row does not recall the main agent's memories", () => {
    expect(resolveRecallScope('second-agent')).not.toContain('main-agent');
  });

  it("the main agent recalls the Dreamer's memories", () => {
    expect(resolveRecallScope('main-agent')).toEqual(expect.arrayContaining(['main-agent', 'dreamer', 'manual']));
  });
});

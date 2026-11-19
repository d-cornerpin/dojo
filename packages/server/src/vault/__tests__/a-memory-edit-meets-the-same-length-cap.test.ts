// A memory edit meets the same per-type length cap as a new memory: one function holds the check.

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
import { createEntry, getEntry } from '../store.js';
import { executeVaultUpdate, executeVaultRemember } from '../tools.js';

async function seed(isPinned = false): Promise<string> {
  const e = await createEntry({ agentId: 'main-agent', agentName: 'Main', type: 'fact', content: 'the spare key is in the blue binder', tags: [], isPinned, isPermanent: false, source: 'agent' });
  return e.id;
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current!
    .prepare("INSERT INTO agents (id, name, status, classification) VALUES ('main-agent', 'Main', 'idle', 'sensei')")
    .run();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('a memory edit meets the same length cap', () => {
  it('an edit longer than the kind allows is refused and changes nothing', async () => {
    const id = await seed();
    const out = await executeVaultUpdate('main-agent', { entry_id: id, new_content: 'x'.repeat(400), reason: 'test' });
    expect(out.startsWith('Too long for a [fact] vault entry: 400 chars, cap is 150.')).toBe(true);
    expect(out).toContain('then call vault_update again.');
    expect(getEntry(id)!.content).toBe('the spare key is in the blue binder');
  });

  it('a short edit with a date stamp is saved', async () => {
    const id = await seed();
    const out = await executeVaultUpdate('main-agent', { entry_id: id, new_content: '[2026-11-01] the spare key is in the red binder', reason: 'it moved' });
    expect(out.startsWith('Updated [fact] entry')).toBe(true);
  });

  it('a pinned entry keeps its length', async () => {
    const id = await seed(true);
    const out = await executeVaultUpdate('main-agent', { entry_id: id, new_content: 'y'.repeat(400), reason: 'test' });
    expect(out.startsWith('Updated [fact] entry')).toBe(true);
  });

  it('vault_remember still refuses a long fact with the same words', async () => {
    const out = await executeVaultRemember('main-agent', { content: 'z'.repeat(400), type: 'fact' });
    expect(out.startsWith('Too long for a [fact] vault entry: 400 chars, cap is 150.')).toBe(true);
    expect(out.endsWith('Do not report this as saved or stored; nothing was written.')).toBe(true);
  });
});

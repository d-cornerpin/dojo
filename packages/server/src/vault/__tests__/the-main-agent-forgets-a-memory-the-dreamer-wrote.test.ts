// The main agent may correct or forget any household memory; helpers stay limited to their own entries.

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
import { clearPlatformConfigCache } from '../../config/platform.js';
import { createEntry, getEntry } from '../store.js';
import { executeVaultUpdate, executeVaultForget } from '../tools.js';

async function seed(agentId: string, content: string): Promise<string> {
  const e = await createEntry({ agentId, agentName: agentId, type: 'fact', content, tags: [], isPinned: false, isPermanent: false, source: 'agent' });
  return e.id;
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const db = mockDb.current;
  const put = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  put.run('primary_agent_id', 'main-agent');
  put.run('dreamer_agent_id', 'dreamer');
  db.prepare("INSERT INTO agents (id, name, status, classification) VALUES ('main-agent', 'Main', 'idle', 'sensei'), ('dreamer', 'Dreamer', 'idle', 'sensei'), ('helper-one', 'Helper One', 'idle', 'ronin')").run();
  clearPlatformConfigCache();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  clearPlatformConfigCache();
});

describe('the main agent forgets a memory the Dreamer wrote', () => {
  it('the main agent forgets a memory the Dreamer wrote', async () => {
    const id = await seed('dreamer', 'the spare key is in the blue binder');
    const out = executeVaultForget('main-agent', { entry_id: id, reason: 'out of date' });
    expect(out.startsWith('Marked as obsolete')).toBe(true);
    expect(getEntry(id)!.isObsolete).toBe(true);
  });

  it('the main agent corrects a memory the Dreamer wrote', async () => {
    const id = await seed('dreamer', 'the spare key is in the blue binder');
    const out = await executeVaultUpdate('main-agent', { entry_id: id, new_content: 'the spare key is in the red binder', reason: 'it moved' });
    expect(out.startsWith('Updated [fact] entry')).toBe(true);
    expect(getEntry(id)!.content).toBe('the spare key is in the red binder');
  });

  it('a helper still cannot edit a memory the Dreamer wrote', async () => {
    const id = await seed('dreamer', 'the spare key is in the blue binder');
    const out = await executeVaultUpdate('helper-one', { entry_id: id, new_content: 'changed', reason: 'test' });
    expect(out).toBe(`Error: Vault entry "${id}" not found.`);
    expect(getEntry(id)!.content).toBe('the spare key is in the blue binder');
  });
});

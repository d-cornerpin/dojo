// "This is different" keeps BOTH facts: a save the agent marks distinct is never folded into a
// near-identical older entry (owner answer 6).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('no db'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] };
});
// Every text gets the SAME vector: similarity 1.0, so the >=0.92 supersede path is the one in play.
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: async () => { const v = new Float32Array(8); v[0] = 1; return v; },
  queueEmbedding: () => undefined, storeEmbedding: async () => undefined,
  refreshEmbedding: () => undefined, getEmbeddingStatus: () => ({}), setEmbeddingConfig: () => undefined,
}));

import { runMigrations } from '../../db/migrations.js';
import { createEntry } from '../store.js';

const db = (): Database.Database => mockDb.current!;
const live = (): number => (db().prepare('SELECT COUNT(*) AS n FROM vault_entries WHERE is_obsolete = 0').get() as { n: number }).n;
const base = { agentId: 'a1', agentName: 'A', type: 'fact', tags: [], isPinned: false, isPermanent: false, source: 'agent' } as const;

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a fact marked distinct keeps both entries', () => {
  it('without distinct, a different-wording near-copy still supersedes (a correction wins)', async () => {
    await createEntry({ ...base, content: 'The spare key is in the blue binder' });
    await createEntry({ ...base, content: 'The spare key is in the red binder' });
    expect(live()).toBe(1);
  });
  it('with distinct, both stay live', async () => {
    await createEntry({ ...base, content: 'The spare key is in the blue binder' });
    await createEntry({ ...base, content: 'The spare key is in the red binder', distinct: true });
    expect(live()).toBe(2);
  });
});

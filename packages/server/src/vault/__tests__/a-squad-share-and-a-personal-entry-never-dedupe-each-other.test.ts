import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  // t98: the vault's reads route through the reader pool, which asks the connection module WHERE
  // the database is. These clauses run against ':memory:', which no second connection can reach,
  // so the pool declines itself and every read runs on this connection — the honest answer.
  getDbPath: () => ':memory:',
}));

// Embeddings would otherwise hit the real model API.
vi.mock('../../memory/embeddings.js', () => ({
  // The SAME vector every time, so any two entries count as duplicates of each other.
  generateEmbedding: vi.fn(async () => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])),
  queueEmbedding: vi.fn(),
}));

// Avoid the real semantic-dup short-circuit so each insert lands as a new row.
vi.mock('../store.js', async () => {
  const actual = await vi.importActual<typeof import('../store.js')>('../store.js');
  return actual;
});

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      group_id TEXT
    );
    CREATE TABLE vault_entries (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      type TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      context TEXT,
      confidence REAL DEFAULT 1.0,
      is_permanent INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      is_pinned INTEGER DEFAULT 0,
      is_obsolete INTEGER DEFAULT 0,
      superseded_by TEXT,
      retrieval_count INTEGER DEFAULT 0,
      last_retrieved_at TEXT,
      source_conversation_id TEXT,
      source TEXT DEFAULT 'extraction',
      citation TEXT,
      embedding BLOB,
      namespace TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // Two squads, one solo agent.
  db.prepare("INSERT INTO agents (id, name, group_id) VALUES ('alpha-1', 'AlphaOne', 'alpha')").run();
  db.prepare("INSERT INTO agents (id, name, group_id) VALUES ('alpha-2', 'AlphaTwo', 'alpha')").run();
  db.prepare("INSERT INTO agents (id, name, group_id) VALUES ('bravo-1', 'BravoOne', 'bravo')").run();
  db.prepare("INSERT INTO agents (id, name, group_id) VALUES ('solo', 'Solo', NULL)").run();
  mockDb.current = db;
});

import { vaultRememberInNamespace } from '../namespaces.js';
import { createEntry } from '../store.js';

const PERSONAL_TEXT = 'The customer prefers calls before 5pm PT.';

function rows(): Array<{ id: string; namespace: string | null; is_obsolete: number; superseded_by: string | null }> {
  return mockDb.current!.prepare('SELECT id, namespace, is_obsolete, superseded_by FROM vault_entries ORDER BY rowid').all() as never;
}

describe('a squad share and a personal entry never dedupe each other', () => {
  it('an identical squad share is written, not swallowed by the personal row', async () => {
    const personal = await createEntry({ agentId: 'alpha-1', type: 'fact', content: PERSONAL_TEXT });
    const shared = await vaultRememberInNamespace({ agentId: 'alpha-1', namespace: 'squad:alpha', content: PERSONAL_TEXT });
    expect(shared.namespace).toBe('squad:alpha');
    expect(shared.id).not.toBe(personal.id);
    const all = rows();
    expect(all.filter((r) => r.namespace === 'squad:alpha')).toHaveLength(1);
    expect(all.find((r) => r.id === personal.id)!.is_obsolete).toBe(0);
  });

  it('a slightly different squad share does not supersede the personal row', async () => {
    const personal = await createEntry({ agentId: 'alpha-1', type: 'fact', content: PERSONAL_TEXT });
    await vaultRememberInNamespace({ agentId: 'alpha-1', namespace: 'squad:alpha', content: 'The customer prefers calls before 5pm Pacific.' });
    const row = rows().find((r) => r.id === personal.id)!;
    expect(row.is_obsolete).toBe(0);
    expect(row.superseded_by).toBeNull();
  });

  it('a personal entry does not supersede the squad row (reverse order)', async () => {
    const shared = await vaultRememberInNamespace({ agentId: 'alpha-1', namespace: 'squad:alpha', content: PERSONAL_TEXT });
    await createEntry({ agentId: 'alpha-1', type: 'fact', content: 'The customer prefers calls before 5pm Pacific.' });
    const row = rows().find((r) => r.id === shared.id)!;
    expect(row.is_obsolete).toBe(0);
    expect(row.superseded_by).toBeNull();
  });

  it('two personal entries with the same text still dedupe', async () => {
    const first = await createEntry({ agentId: 'alpha-1', type: 'fact', content: PERSONAL_TEXT });
    const second = await createEntry({ agentId: 'alpha-1', type: 'fact', content: PERSONAL_TEXT });
    expect(second.id).toBe(first.id);
    expect(rows().filter((r) => r.is_obsolete === 0)).toHaveLength(1);
  });
});

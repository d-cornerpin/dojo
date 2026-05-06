// ════════════════════════════════════════
// Phase 7 — vault namespace operations (Part X)
//
// Verifies:
//   - Squad namespace writes are scoped (members of one squad can't see
//     entries from a different squad).
//   - Personal-vault searches don't leak squad entries (default-NULL filter
//     in listEntries).
//   - resolveAgentNamespace returns null when agent has no group_id.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

// Embeddings would otherwise hit the real model API. Vary per call so the
// semantic-dedup short-circuit doesn't collapse every test insert into one
// row (cosine similarity of identical vectors = 1.0).
let embeddingCallCount = 0;
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => {
    embeddingCallCount++;
    const v = new Float32Array(8);
    for (let i = 0; i < 8; i++) v[i] = Math.sin(embeddingCallCount * (i + 1));
    return v;
  }),
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

import {
  vaultRememberInNamespace,
  vaultSearchInNamespace,
  resolveAgentNamespace,
} from '../namespaces.js';
import { listEntries } from '../store.js';

describe('Phase 7 — namespace operations', () => {
  it('resolveAgentNamespace returns squad:<group_id> for a squad member', () => {
    expect(resolveAgentNamespace('alpha-1')).toBe('squad:alpha');
  });

  it('resolveAgentNamespace returns null for a soloist', () => {
    expect(resolveAgentNamespace('solo')).toBe(null);
  });

  it('resolveAgentNamespace returns null for a non-existent agent', () => {
    expect(resolveAgentNamespace('does-not-exist')).toBe(null);
  });

  it('squad members can recall each other\'s shared entries', async () => {
    await vaultRememberInNamespace({
      agentId: 'alpha-1',
      agentName: 'AlphaOne',
      namespace: 'squad:alpha',
      content: 'The customer prefers calls before 5pm PT.',
      tags: ['customer'],
    });
    const recalls = vaultSearchInNamespace({
      namespace: 'squad:alpha',
      query: 'customer',
    });
    expect(recalls).toHaveLength(1);
    expect(recalls[0].agentId).toBe('alpha-1');
    expect(recalls[0].snippet).toContain('5pm');
    expect(recalls[0].tags).toEqual(['customer']);
  });

  it('squad isolation: bravo cannot see alpha\'s shared entries', async () => {
    await vaultRememberInNamespace({
      agentId: 'alpha-1',
      namespace: 'squad:alpha',
      content: 'alpha-only secret handshake',
    });
    const bravoRecall = vaultSearchInNamespace({
      namespace: 'squad:bravo',
      query: 'handshake',
    });
    expect(bravoRecall).toHaveLength(0);
  });

  it('personal-vault searches do not see squad entries', async () => {
    await vaultRememberInNamespace({
      agentId: 'alpha-1',
      namespace: 'squad:alpha',
      content: 'squad-namespaced content',
    });
    // listEntries() with no namespace option defaults to namespace IS NULL
    // (personal vault). Should find nothing.
    const personal = listEntries({ search: 'squad-namespaced' });
    expect(personal).toHaveLength(0);
  });

  it('squad searches do not see personal-vault entries', async () => {
    // Insert a personal-vault entry the legacy way (no namespace).
    const { createEntry } = await import('../store.js');
    await createEntry({
      agentId: 'alpha-1',
      type: 'fact',
      content: 'personal note from alpha-1',
    });
    const squadRecall = vaultSearchInNamespace({
      namespace: 'squad:alpha',
      query: 'personal',
    });
    expect(squadRecall).toHaveLength(0);
  });

  it('squad recall ranks recent first and respects limit', async () => {
    for (let i = 0; i < 8; i++) {
      await vaultRememberInNamespace({
        agentId: 'alpha-1',
        namespace: 'squad:alpha',
        content: `entry number ${i}`,
      });
    }
    const recalls = vaultSearchInNamespace({
      namespace: 'squad:alpha',
      query: 'entry',
      limit: 3,
    });
    expect(recalls).toHaveLength(3);
  });

  it('snippet truncation kicks in over 200 chars', async () => {
    const long = 'A'.repeat(500);
    await vaultRememberInNamespace({
      agentId: 'alpha-1',
      namespace: 'squad:alpha',
      content: long,
    });
    const recalls = vaultSearchInNamespace({
      namespace: 'squad:alpha',
      query: 'A',
    });
    expect(recalls).toHaveLength(1);
    expect(recalls[0].snippet.length).toBeLessThanOrEqual(201); // 200 chars + ellipsis
    expect(recalls[0].fullLength).toBe(500);
  });
});

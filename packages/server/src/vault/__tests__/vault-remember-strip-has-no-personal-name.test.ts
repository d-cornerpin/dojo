// ════════════════════════════════════════
// Vault bloat-strip: nothing that ships may name a person.
// "The user told <the remembering agent's own name> (that)" is filler the
// same as "told me", but the name must come from the database at call
// time — never from a fixed name written into the pattern list.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

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

// Content-keyed embeddings so we can drive a controlled cosine similarity.
//   SEED     -> a = [1, 0, ...]
//   NEARDUP  -> b = [0.85, 0.52678, ...]  (cosine(a, b) = 0.85, inside the band)
//   FARAWAY  -> orthogonal to a (cosine 0, well below the band)
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => {
    const v = new Float32Array(8);
    if (text.includes('NEARDUP')) {
      v[0] = 0.85;
      v[1] = 0.52678;
    } else if (text.includes('SEED')) {
      v[0] = 1;
    } else if (text.includes('FARAWAY')) {
      v[7] = 1;
    } else {
      v[3] = 1;
    }
    return v;
  }),
  queueEmbedding: vi.fn(),
}));

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      classification TEXT,
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
      source TEXT DEFAULT 'agent',
      citation TEXT,
      embedding BLOB,
      namespace TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO agents (id, name, classification, group_id) VALUES ('test-agent', 'Tester', 'sensei', NULL)").run();
  mockDb.current = db;
});

import { executeVaultRemember } from '../tools.js';

const AGENT = 'test-agent';

describe('vault_remember bloat strip names no person', () => {
  it('strips "the user told <own name> (that)" like any other filler', async () => {
    const saved = await executeVaultRemember(AGENT, {
      content: 'The user told Tester that the office printer is on floor three.',
      type: 'fact',
    });
    expect(saved).toMatch(/^Remembered \[fact\]/);
    expect(saved).toContain('Engine stripped');
    expect(saved).not.toContain('told Tester');
  });

  it('still strips "the user told me that"', async () => {
    const saved = await executeVaultRemember(AGENT, {
      content: 'The user told me that the guest wifi name rotates monthly.',
      type: 'fact',
    });
    expect(saved).toContain('Engine stripped');
    expect(saved).not.toContain('told me');
  });

  it('still strips "the user told us that"', async () => {
    const saved = await executeVaultRemember(AGENT, {
      content: 'The user told us that the garage code changes in May.',
      type: 'fact',
    });
    expect(saved).toContain('Engine stripped');
    expect(saved).not.toContain('told us');
  });

  it("leaves another person's name in as content, not filler", async () => {
    const saved = await executeVaultRemember(AGENT, {
      content: 'The user told Anna that the office printer is on floor three.',
      type: 'fact',
    });
    expect(saved).toContain('told Anna that the office printer');
    expect(saved).not.toContain('Engine stripped');
  });

  it('the shipped source contains no personal name', () => {
    const text = readFileSync(new URL('../tools.ts', import.meta.url), 'utf-8');
    expect(/evin/i.test(text)).toBe(false);
  });
});

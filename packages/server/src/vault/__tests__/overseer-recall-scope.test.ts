// ════════════════════════════════════════
// RC-15: overseer vault read scope (PM + Healer, owner ruled 2026-07-16)
//
// Verifies resolveRecallScope end to end through listEntries against a real
// (in-memory) DB: the PM and the Healer can READ household-authored entries
// for validation/diagnosis, a spawned worker still cannot (the W3-4 exclusion),
// and a household member's own scope never gains the overseers.
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

vi.mock('../../config/platform.js', () => ({
  getHouseholdAgentIds: () => ['primary-agent', 'dreamer'],
  isPMAgent: (id: string) => id === 'pm-agent',
  isHealerAgent: (id: string) => id === 'healer-agent',
}));

// The store imports embeddings at module load; recall scope never embeds.
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(8)),
  queueEmbedding: vi.fn(),
}));

import { resolveRecallScope, listEntries } from '../store.js';

function seedEntry(db: Database.Database, id: string, agentId: string, content: string): void {
  db.prepare(
    `INSERT INTO vault_entries (id, agent_id, type, content, created_at, updated_at)
     VALUES (?, ?, 'fact', ?, datetime('now'), datetime('now'))`,
  ).run(id, agentId, content);
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vault_entries (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      type TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      context TEXT,
      confidence REAL,
      is_permanent INTEGER DEFAULT 0,
      tags TEXT,
      is_pinned INTEGER DEFAULT 0,
      is_obsolete INTEGER DEFAULT 0,
      superseded_by TEXT,
      retrieval_count INTEGER DEFAULT 0,
      last_retrieved_at TEXT,
      source_conversation_id TEXT,
      source TEXT,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      namespace TEXT,
      citation TEXT
    );
  `);
  seedEntry(db, 'e-dreamer', 'dreamer', 'dreamer-distilled household fact');
  seedEntry(db, 'e-primary', 'primary-agent', 'primary-authored fact');
  seedEntry(db, 'e-owner', 'manual', 'owner-authored fact');
  seedEntry(db, 'e-worker', 'worker-1', 'worker private note');
  mockDb.current = db;
});

describe('resolveRecallScope overseer extension', () => {
  it('PM scope covers the household plus owner, read-for-validation', () => {
    const scope = resolveRecallScope('pm-agent');
    expect(scope).toEqual(expect.arrayContaining(['pm-agent', 'primary-agent', 'dreamer', 'manual']));
  });

  it('Healer scope covers the household plus owner (owner ruling 2026-07-16)', () => {
    const scope = resolveRecallScope('healer-agent');
    expect(scope).toEqual(expect.arrayContaining(['healer-agent', 'primary-agent', 'dreamer', 'manual']));
  });

  it('a spawned worker keeps the W3-4 exclusion: self plus owner only', () => {
    const scope = resolveRecallScope('worker-1');
    expect(scope.sort()).toEqual(['manual', 'worker-1'].sort());
  });

  it('a household member does not gain the overseers in its own scope', () => {
    const scope = resolveRecallScope('primary-agent');
    expect(scope).not.toContain('pm-agent');
    expect(scope).not.toContain('healer-agent');
  });
});

describe('listEntries honors the overseer scope end to end', () => {
  it('Healer reads Dreamer/household/owner entries but not a worker private note', () => {
    const rows = listEntries({ agentId: 'healer-agent', includeOwnerScope: true });
    const ids = rows.map(r => r.id);
    expect(ids).toEqual(expect.arrayContaining(['e-dreamer', 'e-primary', 'e-owner']));
    expect(ids).not.toContain('e-worker');
  });

  it('a worker sees only its own entry plus owner scope', () => {
    const rows = listEntries({ agentId: 'worker-1', includeOwnerScope: true });
    const ids = rows.map(r => r.id);
    expect(ids).toEqual(expect.arrayContaining(['e-worker', 'e-owner']));
    expect(ids).not.toContain('e-dreamer');
    expect(ids).not.toContain('e-primary');
  });
});

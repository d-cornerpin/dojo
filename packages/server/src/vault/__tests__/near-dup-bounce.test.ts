// ════════════════════════════════════════
// RC-7: pre-save near-duplicate bounce (vault_remember tool path)
//
// Verifies that executeVaultRemember refuses to save an entry that lands in the
// 0.78-0.92 similarity band against one of the caller's OWN entries, steering
// the model to vault_update or distinct:true instead of accumulating a
// near-duplicate. Exemptions (verbatim / distinct) still save. The bounce string
// must also read as a tool ERROR to the RC-13 isError predicate.
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

function countLiveEntries(): number {
  const row = mockDb.current!
    .prepare('SELECT COUNT(*) AS n FROM vault_entries WHERE is_obsolete = 0')
    .get() as { n: number };
  return row.n;
}

// The RC-13 dispatch predicate: a bounced save must read as a tool error.
const RC13_IS_ERROR = /^(Error|Too long|Reads like narrative prose|Refused|Near-duplicate)/;

describe('RC-7: pre-save near-duplicate bounce', () => {
  it('bounces a near-duplicate save without writing, naming the existing entry', async () => {
    const first = await executeVaultRemember(AGENT, {
      content: 'Tunnel provider chosen: Cloudflare SEED.',
      type: 'fact',
    });
    expect(first).toMatch(/^Remembered/);
    expect(countLiveEntries()).toBe(1);

    const bounce = await executeVaultRemember(AGENT, {
      content: 'Tunnel service selected: Cloudflare NEARDUP.',
      type: 'fact',
    });
    // Nothing new was written.
    expect(countLiveEntries()).toBe(1);
    // Bounce shape: named the entry, steered to vault_update + distinct.
    expect(bounce).toMatch(/^Near-duplicate:/);
    expect(bounce).toContain('vault_update(entry_id=');
    expect(bounce).toContain('distinct: true');
    expect(bounce).toContain('Do not report this as saved or stored; nothing was written.');
    // Cross-check: the bounce reads as a tool error to the RC-13 predicate.
    expect(RC13_IS_ERROR.test(bounce)).toBe(true);
  });

  it('distinct:true overrides the bounce and saves a second entry', async () => {
    await executeVaultRemember(AGENT, { content: 'Tunnel provider chosen: Cloudflare SEED.', type: 'fact' });
    const saved = await executeVaultRemember(AGENT, {
      content: 'Tunnel service selected: Cloudflare NEARDUP.',
      type: 'fact',
      distinct: true,
    });
    expect(saved).toMatch(/^Remembered/);
    expect(countLiveEntries()).toBe(2);
  });

  it('verbatim:true is exempt from the near-duplicate bounce', async () => {
    await executeVaultRemember(AGENT, { content: 'Tunnel provider chosen: Cloudflare SEED.', type: 'fact' });
    const saved = await executeVaultRemember(AGENT, {
      content: 'Tunnel service selected: Cloudflare NEARDUP.',
      type: 'fact',
      verbatim: true,
    });
    expect(saved).toMatch(/^Remembered/);
    expect(countLiveEntries()).toBe(2);
  });

  it('unrelated content saves normally (no false bounce)', async () => {
    await executeVaultRemember(AGENT, { content: 'Tunnel provider chosen: Cloudflare SEED.', type: 'fact' });
    const saved = await executeVaultRemember(AGENT, {
      content: 'Coffee order: oat flat white FARAWAY.',
      type: 'fact',
    });
    expect(saved).toMatch(/^Remembered/);
    expect(countLiveEntries()).toBe(2);
  });
});

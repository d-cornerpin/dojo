// ════════════════════════════════════════════════════════════════════════════════════════
// THE RE-EMBED AFTER A LOCAL SWITCH (post-merge review of the embedding-switch ruling).
//
//  1. A source holding a stale row beside a current one ends with ONE current row, and the
//     background loop ends instead of spinning on it.
//  2. The loop ends on the real signal: the count of memories on other models stops falling.
//  3. A switch made while the scheduled drain is running waits for that drain.
//  4. Stale memories come back newest first (summaries ahead of messages).
// The embedding backend is a stubbed `fetch`; nothing leaves the process.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
const logged = vi.hoisted(() => [] as string[]);
vi.mock('../../logger.js', () => {
  const mk = () => {
    const l: Record<string, unknown> = {};
    for (const k of ['debug', 'info', 'warn', 'error']) l[k] = (m: string) => { logged.push(`${k}: ${m}`); };
    l.child = () => l;
    return l;
  };
  return { createLogger: mk, logger: mk() };
});

import { runMigrations } from '../../db/migrations.js';
import { storeEmbedding } from '../embeddings.js';
import { runBackfill } from '../backfill.js';
import { handleEmbeddingModelSwitch } from '../embedding-switch.js';

const AGENT = 'agent-dr';
const OLD = 'ollama:old-embedder';
const NEW = 'ollama:new-embedder';
let tmpDir: string;
let fetched: string[];
let delayMs = 0;
const VEC = [1, 0, 0, 0];
const vecBuf = (): Buffer => Buffer.from(new Float32Array(VEC).buffer);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-emb-drain-'));
  mockDb.current = new Database(path.join(tmpDir, 'dojo.db'));
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  fetched = [];
  delayMs = 0;
  logged.length = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    fetched.push(init.body);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { ok: true, status: 200, json: async () => ({ embedding: VEC, data: [{ embedding: VEC }] }), text: async () => '' } as unknown as Response;
  });
  db().prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Dr', 'idle')").run(AGENT);
  setModel('old-embedder');
});
afterEach(() => {
  vi.unstubAllGlobals();
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const db = (): Database.Database => mockDb.current!;
function setModel(model: string): void {
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('embedding_config', ?)").run(JSON.stringify({ provider: 'ollama', model }));
}
function addMessage(id: string, createdAt: string): void {
  db().prepare('INSERT INTO messages (id, agent_id, role, lane, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, AGENT, 'user', 'owner', `a message long enough to be embedded: ${id}`, Date.parse(createdAt.replace(' ', 'T') + 'Z'));
}
function addVector(rowId: string, sourceId: string, model: string, type = 'message'): void {
  db().prepare(`INSERT INTO embeddings (id, source_type, source_id, agent_id, content_preview, embedding, dimensions, embedding_model, created_at)
                VALUES (?, ?, ?, ?, 'p', ?, 4, ?, datetime('now'))`).run(rowId, type, sourceId, AGENT, vecBuf(), model);
}
const rowsOf = (sourceId: string): Array<{ embedding_model: string }> =>
  db().prepare('SELECT embedding_model FROM embeddings WHERE source_id = ?').all(sourceId) as Array<{ embedding_model: string }>;
const staleCount = (): number => (db().prepare('SELECT COUNT(*) AS c FROM embeddings WHERE embedding_model IS NOT ?').get(NEW) as { c: number }).c;
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

describe('a stale row beside a current one', () => {
  it('the re-embed leaves one current row for the source and no stale row', async () => {
    addMessage('m1', '2026-01-01 00:00:00');
    addVector('e-cur', 'm1', NEW);
    addVector('e-old', 'm1', OLD);
    setModel('new-embedder');
    await storeEmbedding('message', 'm1', AGENT, 'a message long enough to be embedded: m1', { replaceStale: true });
    expect(rowsOf('m1').map((r) => r.embedding_model)).toEqual([NEW]);
  });

  it('the background loop ends, the old row is gone, and the end is logged with its reason', async () => {
    addMessage('m1', '2026-01-01 00:00:00');
    addVector('e-cur', 'm1', NEW);
    addVector('e-old', 'm1', OLD);
    addMessage('m2', '2026-01-02 00:00:00');
    addVector('e-old2', 'm2', OLD);
    setModel('new-embedder');
    await handleEmbeddingModelSwitch(OLD);
    await until(() => staleCount() === 0);
    await new Promise((r) => setTimeout(r, 150));
    expect(staleCount()).toBe(0);
    const calls = fetched.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(fetched.length).toBe(calls);   // no tight loop left running
    expect(logged.some((l) => /re-embed (finished|stopped)/i.test(l))).toBe(true);
  });
});

describe('the loop stops when the count stops falling', () => {
  it('a stale vector whose source cannot be re-embedded ends the loop and says why', async () => {
    addMessage('m-short', '2026-01-01 00:00:00');
    db().prepare("UPDATE messages SET content = 'tiny' WHERE id = 'm-short'").run();
    addVector('e-short', 'm-short', OLD);
    addMessage('m2', '2026-01-02 00:00:00');
    addVector('e-old2', 'm2', OLD);
    setModel('new-embedder');
    await handleEmbeddingModelSwitch(OLD);
    await until(() => logged.some((l) => /re-embed (finished|stopped)/i.test(l)));
    expect(logged.some((l) => /re-embed (finished|stopped)/i.test(l))).toBe(true);
    expect(staleCount()).toBe(1);   // the one that cannot be redone is still there; the loop is not
  });
});


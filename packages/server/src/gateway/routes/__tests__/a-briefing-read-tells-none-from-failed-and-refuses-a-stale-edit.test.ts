// The briefing read answers "none yet" as a successful empty answer (so a page can tell it apart from
// a failure), says whether the owner edited the text, and an edit built on an older briefing is refused.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { memoryRouter } from '../memory.js';

const db = (): Database.Database => mockDb.current!;
const call = (method: string, path: string, body?: unknown): Promise<Response> =>
  memoryRouter.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }) as Promise<Response>;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  db().prepare(`INSERT INTO agents (id, name, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES ('a1', 'a1', 'idle', '{}', 0, 'owner', datetime('now'), datetime('now'))`).run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the briefing routes', () => {
  it('no briefing yet is a successful empty answer', async () => {
    const res = await call('GET', '/a1/briefing');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: null });
  });

  it('a briefing the owner edited says so', async () => {
    db().prepare(`INSERT INTO briefings (id, agent_id, content, token_count) VALUES ('b1','a1','text',1)`).run();
    expect(((await (await call('GET', '/a1/briefing')).json()) as { data: { editedByOwner: boolean } }).data.editedByOwner).toBe(false);
    await call('PUT', '/a1/briefing', { content: 'my words', baseId: 'b1' });
    expect(((await (await call('GET', '/a1/briefing')).json()) as { data: { editedByOwner: boolean } }).data.editedByOwner).toBe(true);
  });

  it('an edit built on an older briefing is refused and changes nothing', async () => {
    db().prepare(`INSERT INTO briefings (id, agent_id, content, token_count, generated_at) VALUES ('b1','a1','old',1,'2026-01-01T00:00:00Z')`).run();
    db().prepare(`INSERT INTO briefings (id, agent_id, content, token_count, generated_at) VALUES ('b2','a1','new',1,'2026-02-01T00:00:00Z')`).run();
    const res = await call('PUT', '/a1/briefing', { content: 'edit of old', baseId: 'b1' });
    expect(res.status).toBe(409);
    expect((db().prepare(`SELECT content FROM briefings WHERE id='b2'`).get() as { content: string }).content).toBe('new');
  });
});

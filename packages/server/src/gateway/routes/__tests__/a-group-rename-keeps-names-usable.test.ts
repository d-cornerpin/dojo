// A group's name is how agents and the owner pick it. Creating a group refuses a blank name and
// reuses a group that already has the name; renaming must be held to the same two rules.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import { groupsRouter } from '../groups.js';
import { createGroup } from '../../../agent/groups.js';

const storedName = (id: string): string =>
  (mockDb.current!.prepare('SELECT name FROM agent_groups WHERE id = ?').get(id) as { name: string }).name;

const put = (id: string, body: unknown) =>
  groupsRouter.request(`/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (body: unknown) =>
  groupsRouter.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let first: string;
let second: string;

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_by TEXT, color TEXT, dreamer_ignore INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, group_id TEXT, status TEXT, name TEXT, classification TEXT);`);
  mockDb.current = db;
  first = createGroup('Alpha Crew', null, 'test').id;
  second = createGroup('Beta Crew', null, 'test').id;
});

describe('renaming a group', () => {
  it('refuses an empty name', async () => {
    const res = await put(first, { name: '' });
    expect(res.status).toBe(400);
    expect(storedName(first)).toBe('Alpha Crew');
  });
  it('refuses a name of only spaces', async () => {
    const res = await put(first, { name: '   ' });
    expect(res.status).toBe(400);
    expect(storedName(first)).toBe('Alpha Crew');
  });
  it('refuses the name another group has', async () => {
    const res = await put(first, { name: 'Beta Crew' });
    expect(res.status).toBe(409);
    expect(storedName(first)).toBe('Alpha Crew');
  });
  it('lets a group keep its own name', async () => {
    const res = await put(first, { name: 'Alpha Crew' });
    expect(res.status).toBe(200);
  });
  it('stores a new name trimmed', async () => {
    const res = await put(first, { name: '  Gamma Crew  ' });
    expect(res.status).toBe(200);
    expect(storedName(first)).toBe('Gamma Crew');
    expect(storedName(second)).toBe('Beta Crew');
  });
});

describe('creating a group', () => {
  it('refuses a name of only spaces', async () => {
    const res = await post({ name: '  ' });
    expect(res.status).toBe(400);
  });
});

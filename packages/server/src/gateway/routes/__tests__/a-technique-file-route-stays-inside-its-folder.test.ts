// The dashboard's technique file routes read and write only inside the technique's folder: a link in the
// folder that points outside it is refused for both.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({ getDb: () => mockDb.current, closeDb: () => undefined, getDbPath: () => ':memory:' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../memory/embeddings.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), refreshEmbedding: vi.fn() }));
vi.mock('../../../config/loader.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/loader.js')>()),
  getJwtSecret: () => 'test-secret',
}));

import { runMigrations } from '../../../db/migrations.js';
import { createTechnique } from '../../../techniques/store.js';
import { createServer } from '../../server.js';

const app = createServer().app;
const auth = { authorization: `Bearer ${jwt.sign({ userId: 'owner' }, 'test-secret')}`, 'content-type': 'application/json' };
const outside = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'outside-technique-'));
let id = '';

beforeAll(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const t = createTechnique({ name: 'linked', displayName: 'linked', description: 'd', instructions: '# T\nx', tags: [] });
  id = t.id;
  fs.writeFileSync(path.join(outside, 'private.txt'), 'private');
  fs.symlinkSync(outside, path.join(t.directoryPath, 'elsewhere'));
});
afterAll(() => { mockDb.current?.close(); fs.rmSync(outside, { recursive: true, force: true }); });

describe('a technique file route stays inside its folder', () => {
  it('reads a file in the folder, and refuses one through a link out of it', async () => {
    expect((await app.request(`/api/techniques/${id}/files/TECHNIQUE.md`, { headers: auth })).status).toBe(200);
    const res = await app.request(`/api/techniques/${id}/files/elsewhere/private.txt`, { headers: auth });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('File path is outside the technique folder');
  });

  it('refuses a write through a link out of the folder, and writes nothing there', async () => {
    const res = await app.request(`/api/techniques/${id}/files/elsewhere/new.txt`, { method: 'PUT', headers: auth, body: JSON.stringify({ content: 'x' }) });
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });
});

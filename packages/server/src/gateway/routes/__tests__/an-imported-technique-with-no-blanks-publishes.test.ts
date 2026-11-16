// An imported technique with no blanks left publishes, from the dashboard and by the tool. One with a blank
// still unfilled is refused on both doors, in plain words on the dashboard.

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { clearPlatformConfigCache } from '../../../config/platform.js';
import { createTechnique, getTechnique } from '../../../techniques/store.js';
import { executePublishTechnique } from '../../../techniques/tools.js';
import { createServer } from '../../server.js';

const app = createServer().app;
const auth = { authorization: `Bearer ${jwt.sign({ userId: 'owner' }, 'test-secret')}` };
const publish = (id: string) => app.request(`/api/techniques/${id}/publish`, { method: 'POST', headers: auth });

/** A draft shaped as the import leaves it: its manifest stays beside it, with or without a blank. */
function imported(name: string, blank: boolean): string {
  const t = createTechnique({ name, displayName: name, description: 'd', instructions: blank ? '# T\nSend to {{NEEDS_FROM_USER:EMAIL}}' : '# T\nSend it.', tags: [] });
  const placeholders = blank ? [{ label: 'EMAIL', hint: 'where', files: ['TECHNIQUE.md'] }] : [];
  fs.writeFileSync(path.join(t.directoryPath, 'IMPORT_MANIFEST.json'), JSON.stringify({ placeholders }));
  return t.id;
}

describe('an imported technique with no blanks publishes', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    mockDb.current.prepare("INSERT INTO agents (id, name, status, classification) VALUES ('main-1', 'main', 'idle', 'sensei')").run();
    mockDb.current.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', 'main-1')").run();
    clearPlatformConfigCache();
  });
  afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

  it('publishes from the dashboard', async () => {
    const id = imported('no-blanks-route', false);
    expect((await publish(id)).status).toBe(200);
    expect(getTechnique(id)?.state).toBe('published');
  });

  it('publishes by the tool', () => {
    const id = imported('no-blanks-tool', false);
    expect(executePublishTechnique('main-1', 'sensei', { name: id })).not.toMatch(/^Refused/);
    expect(getTechnique(id)?.state).toBe('published');
  });

  it('a blank still unfilled is refused on both doors, plainly on the dashboard', async () => {
    const id = imported('one-blank', true);
    const res = await publish(id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('This technique still has blanks to fill in before it can be published.');
    expect(executePublishTechnique('main-1', 'sensei', { name: id })).toMatch(/^Refused: .*technique_set_placeholder/);
    expect(getTechnique(id)?.state).toBe('draft');
  });
});

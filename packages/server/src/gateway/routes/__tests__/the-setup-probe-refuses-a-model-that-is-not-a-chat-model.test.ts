// The setup steps' model probe refuses a model that is not a chat model and accepts a chat model.
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

import { runMigrations } from '../../../db/migrations.js';
import { setupDepsRouter } from '../setup-deps.js';

const ask = async (id: string): Promise<string | null> =>
  ((await (await setupDepsRouter.request(`/model-fit/${id}`)).json()) as { data: { refused: string | null } }).data.refused;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  for (const [id, caps] of [['m-chat', '["chat","tools"]'], ['m-video', '["video_generation"]']] as const) {
    db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
      VALUES (?, 'cloud', ?, ?, ?, 128000, 1)`).run(id, id, id, caps);
  }
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the setup probe', () => {
  it('refuses a model that is not a chat model', async () => {
    expect(await ask('m-video')).toMatch(/m-video is not a chat model/);
  });
  it('accepts a chat model', async () => {
    expect(await ask('m-chat')).toBeNull();
  });
});

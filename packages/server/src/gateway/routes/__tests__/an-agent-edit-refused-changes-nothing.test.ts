// ════════════════════════════════════════════════════════════════════════════════════════
// AN EDIT THAT IS REFUSED CHANGES NOTHING — 246.
//
// The agent edit form (PUT /agents/:id) used to run `renameAgent` and
// `writeAgentPromptSurface` BEFORE every check that can answer 400 — a Save carrying a new
// name or soul together with a model that was disabled meanwhile, a grants object the
// resolver refuses, or an invalid `silentWindowMinutes` came back 400 with half the edit
// applied. The owner reloads and finds the name/soul changed, and re-saving changes them
// again. These cases pin the rule: a refusal writes nothing.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t246-refused', 'dojo.db'),
  };
});
const broadcastSpy = vi.fn();
vi.mock('../../ws.js', () => ({
  broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])),
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../../config/platform.js', () => ({
  isPrimaryAgent: () => false,
  isPMAgent: () => false,
  isTrainerAgent: () => false,
  isHealerAgent: () => false,
  getPrimaryAgentId: () => 'primary-not-under-test',
  getHealerAgentId: () => null,
  getDreamerAgentId: () => null,
  getPMAgentId: () => null,
  getTrainerAgentId: () => null,
}));

import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';
import { readAgentPromptSurface } from '../../../prompt/agent-prompt-surface.js';

const db = (): Database.Database => mockDb.current!;

const seedModel = (id: string, window: number | null, over: { numCtxOverride?: number } = {}): void => {
  db().prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, num_ctx_override, is_enabled, created_at, updated_at)
    VALUES (?, 'local', ?, ?, '["text"]', ?, 1024, ?, 1, datetime('now'), datetime('now'))
  `).run(id, `Model ${id}`, id, window, over.numCtxOverride ?? null);
};

const seedAgent = (id: string, modelId: string): void => {
  db().prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'idle', '{}', 0, 'owner', datetime('now'), datetime('now'))
  `).run(id, id, modelId);
};

const seedAgentNamed = (id: string, modelId: string, name: string): void => {
  seedAgent(id, modelId);
  db().prepare('UPDATE agents SET name = ? WHERE id = ?').run(name, id);
};

const nameOf = (id: string): string | null =>
  (db().prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string | null } | undefined)?.name ?? null;

const modelOf = (id: string): string | null =>
  (db().prepare('SELECT model_id FROM agents WHERE id = ?').get(id) as { model_id: string | null } | undefined)?.model_id ?? null;

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  broadcastSpy.mockClear();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local', 'Local', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1,
            datetime('now'), datetime('now'))
  `).run();
  seedModel('m-ok', 128_000);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('PUT /agents/:id — a refused edit changes nothing', () => {
  it('a model that does not exist refuses AFTER nothing is written — the name stays', async () => {
    seedAgentNamed('a1', 'm-ok', 'Old Name');
    const res = await agentsRouter.request('/a1', json('PUT', { name: 'New Name', modelId: 'does-not-exist' }));
    expect(res.status).toBe(400);
    expect(nameOf('a1')).toBe('Old Name');
  });

  it('an invalid silentWindowMinutes refuses and leaves the name alone', async () => {
    seedAgentNamed('a1', 'm-ok', 'Old Name');
    const res = await agentsRouter.request('/a1', json('PUT', { name: 'New Name', silentWindowMinutes: -5 }));
    expect(res.status).toBe(400);
    expect(nameOf('a1')).toBe('Old Name');
  });

  it('grants the resolver refuses leave the name alone', async () => {
    seedAgentNamed('a1', 'm-ok', 'Old Name');
    const res = await agentsRouter.request('/a1', json('PUT', { name: 'New Name', grants: 'not-an-object' }));
    expect(res.status).toBe(400);
    expect(nameOf('a1')).toBe('Old Name');
  });

  it('a model that does not exist refuses and leaves the soul alone', async () => {
    seedAgentNamed('a1', 'm-ok', 'Old Name');
    const before = readAgentPromptSurface('a1');
    const res = await agentsRouter.request('/a1', json('PUT', { systemPrompt: 'new soul', modelId: 'does-not-exist' }));
    expect(res.status).toBe(400);
    expect(readAgentPromptSurface('a1')).toBe(before);
  });

  it('a plain name edit is applied', async () => {
    seedAgentNamed('a1', 'm-ok', 'Old Name');
    const res = await agentsRouter.request('/a1', json('PUT', { name: 'New Name' }));
    expect(res.status).toBe(200);
    expect(nameOf('a1')).toBe('New Name');
  });

  it('a name edit alongside a valid model is applied', async () => {
    seedAgentNamed('a1', 'm-ok', 'Old Name');
    const res = await agentsRouter.request('/a1', json('PUT', { name: 'New Name', modelId: 'm-ok' }));
    expect(res.status).toBe(200);
    expect(nameOf('a1')).toBe('New Name');
    expect(modelOf('a1')).toBe('m-ok');
  });
});

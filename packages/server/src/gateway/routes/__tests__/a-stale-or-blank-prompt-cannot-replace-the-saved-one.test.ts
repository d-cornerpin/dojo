// An agent's system prompt (for the primary agent, SOUL.md) is saved whole. A save built on a
// prompt the client did not read most recently, or a blank one nobody asked for, is refused with
// a plain message and writes nothing. A failed read of the prompt is an error, never a blank.

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
  isImaginerAgent: () => false,
  getPrimaryAgentId: () => 'primary-not-under-test',
  getHealerAgentId: () => null,
  getDreamerAgentId: () => null,
  getImaginerAgentId: () => null,
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

const put = (id: string, body: unknown) => agentsRouter.request(`/${id}`, json('PUT', body));

describe('PUT /agents/:id — the prompt save', () => {
  it('refuses a save built on an older prompt and keeps the saved one', async () => {
    seedAgent('a1', 'm-ok');
    expect((await put('a1', { systemPrompt: 'first', systemPromptBase: '' })).status).toBe(200);
    const res = await put('a1', { systemPrompt: 'second', systemPromptBase: '' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/changed/i);
    expect(readAgentPromptSurface('a1')).toBe('first');
  });

  it('accepts a save built on the stored prompt', async () => {
    seedAgent('a1', 'm-ok');
    await put('a1', { systemPrompt: 'first', systemPromptBase: '' });
    expect((await put('a1', { systemPrompt: 'second', systemPromptBase: 'first' })).status).toBe(200);
    expect(readAgentPromptSurface('a1')).toBe('second');
  });

  it('refuses a blank prompt over a saved one when it names no base', async () => {
    seedAgent('a1', 'm-ok');
    await put('a1', { systemPrompt: 'first' });
    expect((await put('a1', { systemPrompt: '' })).status).toBe(400);
    expect(readAgentPromptSurface('a1')).toBe('first');
  });

  it('lets the owner clear it on purpose, from the prompt he loaded', async () => {
    seedAgent('a1', 'm-ok');
    await put('a1', { systemPrompt: 'first' });
    expect((await put('a1', { systemPrompt: '', systemPromptBase: 'first' })).status).toBe(200);
    expect(readAgentPromptSurface('a1')).toBe('');
  });

  it('a refused prompt save writes nothing else (the name stays)', async () => {
    seedAgentNamed('a1', 'm-ok', 'Old Name');
    await put('a1', { systemPrompt: 'first' });
    expect((await put('a1', { name: 'New Name', systemPrompt: 'x', systemPromptBase: 'stale' })).status).toBe(409);
    expect(nameOf('a1')).toBe('Old Name');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// t209 — the 32K main-model floor (owner decision 13) at the doors t202 left open:
// the update_agent and spawn tools, and the healer, vault (dreamer), PM, trainer and imaginer
// model setters. Each must refuse a model under 32K as an agent's MAIN model, in plain words,
// before writing anything. Re-saving the model an agent is already on is never refused, and a
// helper-only dial (a model with no window, auto) stays allowed.
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t209-doors', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({
  enforceModelCapabilities: vi.fn(),
  injectAttachmentBlocks: vi.fn(),
  getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }),
}));

import { runMigrations } from '../../../db/migrations.js';
import { healerRouter } from '../healer.js';
import { vaultRouter } from '../vault.js';
import { configRouter } from '../config.js';

const db = (): Database.Database => mockDb.current!;

const seedModel = (id: string, window: number | null): void => {
  db().prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, is_enabled, created_at, updated_at)
    VALUES (?, 'local', ?, ?, '["text"]', ?, 1024, 1, datetime('now'), datetime('now'))
  `).run(id, `Model ${id}`, id, window);
};
const seedAgent = (id: string, modelId: string, parent: string | null = null): void => {
  db().prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, parent_agent, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'idle', '{}', 0, ?, 'owner', datetime('now'), datetime('now'))
  `).run(id, id, modelId, parent);
};
const setConfig = (k: string, v: string): void => {
  db().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
};
const getConfig = (k: string): string | undefined =>
  (db().prepare('SELECT value FROM config WHERE key = ?').get(k) as { value: string } | undefined)?.value;
const modelOf = (id: string): string | null =>
  (db().prepare('SELECT model_id FROM agents WHERE id = ?').get(id) as { model_id: string | null } | undefined)?.model_id ?? null;
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(async () => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local', 'Local', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1, datetime('now'), datetime('now'))
  `).run();
  seedModel('big', 128_000);
  seedModel('tiny', 8_192);
  seedModel('unknown', null);
  setConfig('primary_agent_id', 'main-agent');
  setConfig('healer_agent_id', 'healer-agent');
  setConfig('dreamer_agent_id', 'dreamer-agent');
  setConfig('imaginer_agent_id', 'imaginer-agent');
  seedAgent('main-agent', 'big');
  seedAgent('healer-agent', 'big');
  seedAgent('dreamer-agent', 'big');
  seedAgent('imaginer-agent', 'big');
  (await import('../../../config/platform.js')).clearPlatformConfigCache();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const PLAIN = /32K/;

describe('the service-agent model setters refuse a model under 32K', () => {
  it('healer route: refused, nothing written', async () => {
    const res = await healerRouter.request('/config', json('POST', { modelId: 'tiny' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(PLAIN);
    expect(getConfig('healer_model_id')).toBeUndefined();
    expect(modelOf('healer-agent')).toBe('big');
  });

  it('healer route: a big model and the same small model it is already on are allowed', async () => {
    expect((await healerRouter.request('/config', json('POST', { modelId: 'big' }))).status).toBe(200);
    expect(getConfig('healer_model_id')).toBe('big');
    db().prepare("UPDATE agents SET model_id = 'tiny' WHERE id = 'healer-agent'").run();
    expect((await healerRouter.request('/config', json('POST', { modelId: 'tiny' }))).status).toBe(200);
  });

  it('vault route (dreamer): refused, nothing written', async () => {
    const res = await vaultRouter.request('/dream/config', json('PUT', { modelId: 'tiny' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(PLAIN);
    expect(getConfig('dreaming_model_id')).toBeUndefined();
    expect(modelOf('dreamer-agent')).toBe('big');
  });

  for (const key of ['healer_model_id', 'dreaming_model_id', 'pm_agent_model', 'trainer_agent_model', 'imaginer_brain_model']) {
    it(`settings route: ${key} refuses a small model and accepts a big one or none-declared`, async () => {
      const res = await configRouter.request(`/settings/${key}`, json('PUT', { value: 'tiny' }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(PLAIN);
      expect(getConfig(key)).toBeUndefined();
      for (const ok of ['big', 'unknown', 'auto']) {
        expect((await configRouter.request(`/settings/${key}`, json('PUT', { value: ok }))).status, ok).toBe(200);
      }
    });
  }

  it('settings route: an unrelated key is untouched by the floor', async () => {
    expect((await configRouter.request('/settings/some_other_key', json('PUT', { value: 'tiny' }))).status).toBe(200);
  });
});

describe('the update_agent tool refuses a model under 32K', () => {
  it('refused before the rename; the agent keeps its model and its name', async () => {
    seedAgent('worker', 'big', 'main-agent');
    const { agentsHandlers } = await import('../../../agent/tools/cat/agents.js');
    const out = await agentsHandlers['update_agent']!({
      agentId: 'main-agent', args: { agent_id: 'worker', name: 'Renamed', model_id: 'tiny' },
    } as never);
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(PLAIN);
    expect(modelOf('worker')).toBe('big');
    expect((db().prepare('SELECT name FROM agents WHERE id = ?').get('worker') as { name: string }).name).toBe('worker');
  });

  it('allowed: a big model, and the small model the agent is already on', async () => {
    seedAgent('worker', 'tiny', 'main-agent');
    const { agentsHandlers } = await import('../../../agent/tools/cat/agents.js');
    const same = await agentsHandlers['update_agent']!({ agentId: 'main-agent', args: { agent_id: 'worker', model_id: 'tiny' } } as never);
    expect(same.isError).toBeFalsy();
    const up = await agentsHandlers['update_agent']!({ agentId: 'main-agent', args: { agent_id: 'worker', model_id: 'big' } } as never);
    expect(up.isError).toBeFalsy();
    expect(modelOf('worker')).toBe('big');
  });
});

describe('the spawn door refuses a model under 32K', () => {
  it('an explicit small model is refused and no agent row is made', async () => {
    const { spawnAgent } = await import('../../../agent/spawner.js');
    await expect(spawnAgent({
      parentId: 'main-agent', name: 'kid', systemPrompt: 'x', modelId: 'tiny', timeout: 600,
    } as never)).rejects.toThrow(PLAIN);
    expect(db().prepare("SELECT id FROM agents WHERE name = 'kid'").get()).toBeUndefined();
  });
});

describe('a model deleted from under agents is replaced by one that passes the floor', () => {
  it('the cheapest replacement is skipped when it is under 32K', async () => {
    db().prepare("UPDATE models SET input_cost_per_m = 0 WHERE id = 'tiny'").run();
    db().prepare("UPDATE models SET input_cost_per_m = 5 WHERE id = 'big'").run();
    db().prepare("UPDATE models SET input_cost_per_m = 99 WHERE id = 'unknown'").run();
    seedModel('gone', 128_000);
    db().prepare("UPDATE models SET input_cost_per_m = 9 WHERE id = 'gone'").run();
    seedAgent('stranded', 'gone');
    const res = await configRouter.request('/models/disable', json('POST', { modelIds: ['gone'] }));
    expect(res.status).toBe(200);
    expect(modelOf('stranded')).toBe('big');
  });
});

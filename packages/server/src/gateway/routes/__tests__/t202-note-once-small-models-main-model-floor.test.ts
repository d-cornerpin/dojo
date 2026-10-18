// ════════════════════════════════════════════════════════════════════════════════════════
// t202 D10 — A MODEL UNDER 32K TOKENS IS NOT AN AGENT'S MAIN MODEL.
//
// Owner ruling (v3.4 decision 13): refuse a model whose memory window is under 32K tokens as
// an agent's MAIN model, with a plain explanation. It is the owner's own exception to the
// no-hard-limits rule. Helper jobs (titles, summaries, utility dials) are not agents' main
// models and are untouched; this file drives only the doors that set an agent's main model:
// agent create, agent edit (both routes), and the setup wizard's provisioning call.
//
// ── WHAT MUST NOT BREAK ──
// An agent that is ALREADY on such a model keeps working: re-saving the same model, or editing
// anything else about the agent, is not a refusal. And a model that declared no window at all
// (NULL / 0) is unknown, not small, so it is allowed — refusing it would turn a missing number
// into a verdict.
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t202-floor', 'dojo.db'),
  };
});
const broadcastSpy = vi.fn();
vi.mock('../../ws.js', () => ({
  broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])),
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../../config/platform.js', () => ({
  isPrimaryAgent: () => false,
  getPrimaryAgentId: () => 'primary-not-under-test',
  getHealerAgentId: () => null,
  getDreamerAgentId: () => null,
  getImaginerAgentId: () => null,
  isTrainerAgent: () => false,
}));

import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';
import { setupDepsRouter } from '../setup-deps.js';

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
  seedModel('big', 128_000);
  seedModel('edge', 32_000);
  seedModel('tiny', 8_192);
  seedModel('unknown', null);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const PLAIN = /32K/;

describe('PATCH /agents/:id/model — the model picker on the agent card', () => {
  it('refuses a 8K model, in plain words, and leaves the agent on its model', async () => {
    seedAgent('a1', 'big');
    const res = await agentsRouter.request('/a1/model', json('PATCH', { modelId: 'tiny' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(PLAIN);
    expect(body.error).toMatch(/Model tiny/);
    expect(modelOf('a1')).toBe('big');
  });

  it('allows exactly 32K, a larger window and a model that declared no window', async () => {
    seedAgent('a1', 'big');
    for (const m of ['edge', 'big', 'unknown']) {
      const res = await agentsRouter.request('/a1/model', json('PATCH', { modelId: m }));
      expect(res.status, m).toBe(200);
      expect(modelOf('a1')).toBe(m);
    }
  });

  it('judges the window the engine really budgets against: a big model squeezed to 8K by its num_ctx is refused', async () => {
    seedModel('squeezed', 128_000, { numCtxOverride: 8_192 });
    seedAgent('a1', 'big');
    const res = await agentsRouter.request('/a1/model', json('PATCH', { modelId: 'squeezed' }));
    expect(res.status).toBe(400);
    expect(modelOf('a1')).toBe('big');
  });

  it('an agent ALREADY on a small model is not broken by saving the same model again', async () => {
    seedAgent('a1', 'tiny');
    const res = await agentsRouter.request('/a1/model', json('PATCH', { modelId: 'tiny' }));
    expect(res.status).toBe(200);
    expect(modelOf('a1')).toBe('tiny');
  });

  it('the auto-router is not a model with a window and is allowed', async () => {
    seedAgent('a1', 'big');
    const res = await agentsRouter.request('/a1/model', json('PATCH', { modelId: 'auto' }));
    expect(res.status).toBe(200);
  });
});

describe('PATCH /agents/:id — the agent edit form', () => {
  it('refuses a small model chosen in the edit form', async () => {
    seedAgent('a1', 'big');
    const res = await agentsRouter.request('/a1', json('PATCH', { modelId: 'tiny' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(PLAIN);
    expect(modelOf('a1')).toBe('big');
  });

  it('an agent already on a small model can still be edited, model field and all', async () => {
    seedAgent('a1', 'tiny');
    const res = await agentsRouter.request('/a1', json('PATCH', { modelId: 'tiny', classification: 'ronin' }));
    expect(res.status).toBe(200);
    expect(modelOf('a1')).toBe('tiny');
  });
});

describe('POST /agents — recruiting a new agent', () => {
  it('refuses a small model and creates NO agent', async () => {
    const before = (db().prepare('SELECT COUNT(*) n FROM agents').get() as { n: number }).n;
    const res = await agentsRouter.request('/', json('POST', { name: 'New', systemPrompt: 'hi', modelId: 'tiny' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(PLAIN);
    expect((db().prepare('SELECT COUNT(*) n FROM agents').get() as { n: number }).n).toBe(before);
  });
});

describe('POST /setup/provision-agent — the setup wizard', () => {
  it('refuses a small model for the first agent, and writes nothing', async () => {
    const res = await setupDepsRouter.request('/provision-agent',
      json('POST', { id: 'first', name: 'First', modelId: 'tiny' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(PLAIN);
    expect(modelOf('first')).toBeNull();
  });

  it('refuses switching an existing agent to a small model, but re-running setup on its current small model is fine', async () => {
    seedAgent('first', 'big');
    const refused = await setupDepsRouter.request('/provision-agent',
      json('POST', { id: 'first', name: 'First', modelId: 'tiny' }));
    expect(refused.status).toBe(400);
    expect(modelOf('first')).toBe('big');

    seedAgent('legacy', 'tiny');
    const kept = await setupDepsRouter.request('/provision-agent',
      json('POST', { id: 'legacy', name: 'Legacy', modelId: 'tiny' }));
    expect(kept.status).toBe(200);
  });
});

describe('an existing agent on a small model gets the existing notice, once', () => {
  it('opening the agent shows one chat:error warning, not one per open, and nothing is changed', async () => {
    seedAgent('legacy', 'tiny');
    await agentsRouter.request('/legacy', { method: 'GET' });
    await agentsRouter.request('/legacy', { method: 'GET' });
    const frames = broadcastSpy.mock.calls.map((c) => c[0] as { type?: string; code?: string; severity?: string; agentId?: string })
      .filter((f) => f.type === 'chat:error' && f.code === 'MAIN_MODEL_SMALL');
    expect(frames).toHaveLength(1);
    expect(frames[0].severity).toBe('warning');
    expect(frames[0].agentId).toBe('legacy');
    expect(modelOf('legacy')).toBe('tiny');
  });

  it('an agent on an ordinary model gets no notice', async () => {
    seedAgent('fine', 'big');
    await agentsRouter.request('/fine', { method: 'GET' });
    expect(broadcastSpy.mock.calls.map((c) => (c[0] as { code?: string }).code)).not.toContain('MAIN_MODEL_SMALL');
  });
});

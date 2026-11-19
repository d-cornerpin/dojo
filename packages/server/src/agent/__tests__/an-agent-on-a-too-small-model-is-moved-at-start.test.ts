// At start every live agent on a model known to be under the 32K floor moves to the cheapest big-enough model that is
// switched on, and the owner gets ONE card naming them; with no such model nothing moves and the card says who is stuck.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));
const frames: Array<{ error?: string; cardKey?: string; cardClass?: string }> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (f: { type: string; error?: string; cardKey?: string; cardClass?: string }) => { if (f.type === 'chat:error') frames.push(f); },
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../db/migrations.js';
import { tellOwner } from '../../healer/owner-notices.js';
import { moveAgentsOffSmallModels } from '../main-model-floor.js';
import { standingOwnerNotices } from '../../healer/owner-notice-kinds.js';
import * as honestStopLock from '../v2/honest-stop-lock.js';

const db = (): Database.Database => mockDb.current!;
const seedModel = (id: string, window: number | null, enabled = 1, cost = 1): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, 'p', ?, ?, '["text","tools"]', ?, 1024, ?, ?, datetime('now'), datetime('now'))`).run(id, `Model ${id}`, id, window, cost, enabled);
};
const seedAgent = (id: string, modelId: string, status = 'idle'): void => {
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, '{}', 0, 'owner', datetime('now'), datetime('now'))`).run(id, id, modelId, status);
};
const modelOf = (id: string): string => (db().prepare('SELECT model_id FROM agents WHERE id = ?').get(id) as { model_id: string }).model_id;

beforeEach(() => {
  frames.length = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at) VALUES ('p', 'P', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1, datetime('now'), datetime('now'))").run();
  seedModel('tiny', 8_192);
  seedModel('unknown', null, 0);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('an agent on a too-small model, at start', () => {
  it('a helper and the main agent are moved to the cheapest big-enough model, and one card names both', async () => {
    seedModel('pricey', 128_000, 1, 9);
    seedModel('cheap', 64_000, 1, 2);
    seedModel('off', 64_000, 0, 0.1);
    seedAgent('main', 'tiny');
    seedAgent('helper', 'tiny');
    seedAgent('fine', 'pricey');
    seedAgent('gone', 'tiny', 'terminated');
    await moveAgentsOffSmallModels();
    expect([modelOf('main'), modelOf('helper'), modelOf('fine'), modelOf('gone')]).toEqual(['cheap', 'cheap', 'pricey', 'tiny']);
    expect(frames).toHaveLength(1);
    expect(frames[0].error).toMatch(/helper \(from Model tiny\), main \(from Model tiny\) to Model cheap/);
    expect(frames[0].cardClass).toBe('informational');
  });

  it('with no bigger model switched on nothing moves, and the card says who needs a pick', async () => {
    seedAgent('main', 'tiny');
    await moveAgentsOffSmallModels();
    expect(modelOf('main')).toBe('tiny');
    expect(frames).toHaveLength(1);
    expect(frames[0].error).toMatch(/main \(Model tiny\) is on a model whose memory window is too small/);
    expect(frames[0].cardClass).toBe('action');
  });

  it('a second start changes nothing and files no second card', async () => {
    seedModel('cheap', 64_000);
    seedAgent('main', 'tiny');
    await moveAgentsOffSmallModels();
    await moveAgentsOffSmallModels();
    expect(frames).toHaveLength(1);
    expect(modelOf('main')).toBe('cheap');
  });

  it('a stuck agent is told once across starts, and the card ends when a bigger model is switched on', async () => {
    seedAgent('main', 'tiny');
    await moveAgentsOffSmallModels();
    await moveAgentsOffSmallModels();
    expect(frames).toHaveLength(1);
    seedModel('cheap', 64_000);
    expect(db().prepare("SELECT 1 FROM healer_state WHERE key = 'smallmodel:stuck'").all()).toHaveLength(1);   // told
    await moveAgentsOffSmallModels();
    expect(modelOf('main')).toBe('cheap');
    expect(frames.filter((f) => f.cardKey === 'smallmodel:moved')).toHaveLength(1);
    expect(db().prepare("SELECT 1 FROM healer_state WHERE key = 'smallmodel:stuck'").all()).toEqual([]);
  });

  it('an agent on a model of unknown size is left alone and no card is filed', async () => {
    seedModel('cheap', 64_000);
    seedAgent('main', 'unknown');
    await moveAgentsOffSmallModels();
    expect(modelOf('main')).toBe('unknown');
    expect(frames).toHaveLength(0);
  });

  it('an agent parked because its small model could not hold it is moved and no longer parked', async () => {
    seedModel('cheap', 64_000);
    seedAgent('main', 'tiny', 'paused');
    db().prepare("UPDATE agents SET last_error = '[no_model_fits] none of its models can hold it' WHERE id = 'main'").run();
    tellOwner('nofit:main', 'main cannot run');
    await moveAgentsOffSmallModels();
    await vi.waitFor(() => expect((db().prepare("SELECT status FROM agents WHERE id = 'main'").get() as { status: string }).status).not.toBe('paused'));
    expect(standingOwnerNotices().map((n) => n.cardKey)).not.toContain('nofit:main');
  });

  it('the moved card says when the new model is a paid one', async () => {
    seedModel('paid', 64_000, 1, 3);
    seedAgent('main', 'tiny');
    await moveAgentsOffSmallModels();
    expect(frames[0].error).toContain('to Model paid, which is a paid model, because');
  });

  it('the router sentinel is never the pick, and a service setting follows its agent', async () => {
    seedModel('cheap', 64_000);
    expect(db().prepare("SELECT is_enabled, input_cost_per_m FROM models WHERE id = 'auto'").get(), 'non-vacuity: the free, enabled, large sentinel row is there to be skipped').toEqual({ is_enabled: 1, input_cost_per_m: 0 });
    db().prepare("INSERT INTO config (key, value) VALUES ('healer_model_id', 'tiny')").run();
    seedAgent('main', 'tiny');
    await moveAgentsOffSmallModels();
    expect(modelOf('main')).toBe('cheap');
    expect((db().prepare("SELECT value FROM config WHERE key = 'healer_model_id'").get() as { value: string }).value).toBe('cheap');
  });

  it('a failed look at the parked agent after the move does not escape', async () => {
    const looked = vi.spyOn(honestStopLock, 'noteModelsChanged').mockRejectedValue(new Error('look failed'));
    seedModel('cheap', 64_000);
    seedAgent('main', 'tiny');
    await moveAgentsOffSmallModels();
    await vi.waitFor(() => expect(looked).toHaveBeenCalledWith('main'));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(modelOf('main')).toBe('cheap');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 N42 (GitHub #25, the owner's design) — THE ONE ROUTER WINDOW.
//
// `router/router-window.ts` answers three questions on the real migration chain and the real window
// resolver (`getContextWindow`, which applies a local model's num_ctx):
//   · the floor — the smallest window among the models assigned to light, standard and heavy;
//   · the router window — the owner's `router.context_window`, or the floor, never above the floor;
//   · an agent turn's window — the router window for an auto-routed agent, the model's own otherwise.
// And the Router tab's report: the slider's top (the floor and its model) and its measured low end
// (the largest instructions-plus-tools among the agents set to automatic, and which agent that is).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
const tools = vi.hoisted(() => ({ byAgent: {} as Record<string, number>, throwsFor: new Set<string>() }));
vi.mock('../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../tools/tool-docs.js')>('../../tools/tool-docs.js');
  return { ...actual, measureAgentToolPayloadTokens: async (agentId: string) => {
    if (tools.throwsFor.has(agentId)) throw new Error('the tool surface could not be read');
    return tools.byAgent[agentId] ?? 0;
  } };
});

import { runMigrations } from '../../db/migrations.js';
import { getContextWindow } from '../../agent/model.js';
import { routerWindowFloor, routerWindowTokens, agentTurnWindow, routerWindowReport } from '../router-window.js';
import { Hono } from 'hono';
import { routerRouter } from '../../gateway/routes/router.js';
import { contextWindowPolicy, estimateTokens } from '../../memory/budget.js';
import { buildAssemblyContext, assembleSystemFromRegistry } from '../../prompt/registry/assembler.js';

const db = (): Database.Database => mockDb.current!;

function model(id: string, name: string, window: number, providerId = 'prov'): void {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, '["text","tools"]', ?, 4096, 1, datetime('now'), datetime('now'))`).run(id, providerId, name, id, window);
}
const assign = (tier: string, modelId: string, priority = 0): void => {
  db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, ?)').run(tier, modelId, priority);
};
const agent = (id: string, name: string, modelId: string): void => {
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES (?, ?, ?, 'idle', '{}', datetime('now'), datetime('now'))`).run(id, name, modelId);
};
const setting = (value: string): void => {
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('router.context_window', ?)").run(value);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  tools.byAgent = {};
  tools.throwsFor = new Set();
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
    VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now')),
           ('prov-down', 'Down', 'openai-compatible', 'api_key', 0, datetime('now'), datetime('now'))`).run();
  model('m-light', 'Light 32K', 32_000);
  model('m-standard', 'Standard 128K', 128_000);
  model('m-heavy', 'Heavy 200K', 200_000);
  assign('light', 'm-light');
  assign('standard', 'm-standard');
  assign('heavy', 'm-heavy');
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the floor', () => {
  it('is the smallest window among the light, standard and heavy models, with that model\'s name', () => {
    expect(routerWindowFloor()).toMatchObject({ tokens: 32_000, modelName: 'Light 32K' });
  });

  it('the system tier is not counted: it dials titles and classifiers, never an agent\'s conversation', () => {
    model('m-system', 'System 8K', 8_000);
    assign('system', 'm-system');
    expect(routerWindowFloor()?.tokens).toBe(32_000);
  });

  it('every assigned model counts, a provider that is down included, so the figure does not jump when one trips', () => {
    model('m-down', 'Down 24K', 24_000, 'prov-down');
    assign('standard', 'm-down', 1);
    expect(routerWindowFloor()).toMatchObject({ tokens: 24_000, modelName: 'Down 24K' });
  });

  it('fix round 1: a model the owner DISABLED on a tier is never dialled, so it does not set the floor', () => {
    model('m-off', 'Disabled 8K', 8_000);
    db().prepare('UPDATE models SET is_enabled = 0 WHERE id = ?').run('m-off');
    assign('light', 'm-off', 1);
    expect(routerWindowFloor()).toMatchObject({ tokens: 32_000, modelName: 'Light 32K' });
  });

  it('with no model on the three tiers there is no floor', () => {
    db().prepare('DELETE FROM router_tier_models').run();
    expect(routerWindowFloor()).toBeNull();
    expect(routerWindowTokens()).toBeNull();
  });
});

describe('the router window', () => {
  it('unset: the floor', () => {
    expect(routerWindowTokens()).toBe(32_000);
  });
  it('set below the floor: the setting', () => {
    setting('20000');
    expect(routerWindowTokens()).toBe(20_000);
  });
  it('set above the floor: the floor (the slider\'s own top)', () => {
    setting('500000');
    expect(routerWindowTokens()).toBe(32_000);
  });
  it('a smaller model joins a tier: the window follows the new floor', () => {
    setting('30000');
    model('m-tiny', 'Tiny 16K', 16_000);
    assign('light', 'm-tiny', 1);
    expect(routerWindowTokens()).toBe(16_000);
  });
  it('a setting that is not a positive whole number is not a setting', () => {
    for (const bad of ['', 'abc', '-5', '0', '12.5']) {
      setting(bad);
      expect(routerWindowTokens(), bad).toBe(32_000);
    }
  });
  it('the auto row\'s window (what the dashboard and the opening turn report) IS the router window', () => {
    setting('20000');
    expect(getContextWindow('__auto__')).toBe(20_000);
    expect(getContextWindow('auto')).toBe(20_000);
  });
});

describe('an agent turn\'s window', () => {
  it('auto-routed: the router window, whichever tier model was picked', () => {
    agent('a-auto', 'Dock Desk', 'auto');
    expect(['m-light', 'm-standard', 'm-heavy', '__auto__'].map((m) => agentTurnWindow('a-auto', m))).toEqual([32_000, 32_000, 32_000, 32_000]);
  });
  it('auto-routed, dialed on a model smaller than the router window (one the router reaches outside its tiers): that model\'s own window', () => {
    agent('a-auto', 'Dock Desk', 'auto');
    model('m-free', 'Free 8K', 8_000);
    expect(agentTurnWindow('a-auto', 'm-free')).toBe(8_000);
  });
  it('CONTROL: a fixed-model agent gets its model\'s own window, byte for byte, whatever the router says', () => {
    agent('a-fixed', 'Ledger', 'm-heavy');
    setting('20000');
    for (const m of ['m-light', 'm-standard', 'm-heavy']) expect(agentTurnWindow('a-fixed', m)).toBe(getContextWindow(m));
  });
});

describe('the Router tab\'s report', () => {
  it('the top is the floor and its model; the low end is the largest instructions-plus-tools among auto agents, named', async () => {
    agent('a-small', 'Dock Desk', 'auto');
    agent('a-big', 'Yard Planner', 'auto');
    agent('a-fixed', 'Ledger', 'm-heavy');
    tools.byAgent = { 'a-small': 1_000, 'a-big': 9_000, 'a-fixed': 50_000 };
    setting('24000');
    const r = await routerWindowReport();
    expect(r).toMatchObject({ tokens: 24_000, floorTokens: 32_000, floorModelName: 'Light 32K', minAgentName: 'Yard Planner' });
    expect(r!.minTokens, 'instructions plus the 9K tool payload').toBeGreaterThan(9_000);
    expect(r!.minTokens, 'a fixed-model agent does not set the low end').toBeLessThan(50_000);
  });
  it('fix round 1: the low end is the smallest window the agent can run in — instructions, tools AND the output reserve, over the fill line', async () => {
    agent('a-big', 'Yard Planner', 'auto');
    tools.byAgent = { 'a-big': 9_000 };
    const r = await routerWindowReport();
    // At the low end the agent fits; one thousand tokens below, it does not.
    const fitsAt = (w: number, sys: number): boolean => contextWindowPolicy(w, { toolPayloadTokens: 9_000, maxOutputTokens: 4096 }).assemblyBudgetTokens >= sys;
    const sys = r!.minTokens;   // stands in for the bound check below
    expect(sys).toBeGreaterThan(9_000 + 4096);
    const prompt = estimateTokens(assembleSystemFromRegistry(buildAssemblyContext('a-big', '__auto__')).text);
    expect(fitsAt(r!.minTokens, prompt), 'it runs at the low end').toBe(true);
    expect(fitsAt(r!.minTokens - 1_000, prompt), 'and not below it').toBe(false);
  });

  it('fix round 1: one agent that cannot be measured does not take the Router tab down; it is named as not measured', async () => {
    agent('a-small', 'Dock Desk', 'auto');
    agent('a-broken', 'Yard Planner', 'auto');
    tools.byAgent = { 'a-small': 1_000 };
    tools.throwsFor = new Set(['a-broken']);
    const r = await routerWindowReport();
    expect(r).toMatchObject({ minAgentName: 'Dock Desk', unmeasuredAgentNames: ['Yard Planner'] });
  });

  it('no model on the three tiers: no report (the section says so and shows no slider)', async () => {
    db().prepare('DELETE FROM router_tier_models').run();
    expect(await routerWindowReport()).toBeNull();
  });
});

describe('GET /router/config', () => {
  it('carries the window beside the tiers, for the Router tab', async () => {
    agent('a-auto', 'Dock Desk', 'auto');
    const res = await new Hono().route('/router', routerRouter).request('/router/config');
    const body = await res.json() as { ok: boolean; data: { tiers: unknown[]; window: Record<string, unknown> | null } };
    expect(body.ok).toBe(true);
    expect(body.data.tiers.length).toBeGreaterThan(0);
    expect(body.data.window).toMatchObject({ tokens: 32_000, floorTokens: 32_000, floorModelName: 'Light 32K', minAgentName: 'Dock Desk' });
  });
});

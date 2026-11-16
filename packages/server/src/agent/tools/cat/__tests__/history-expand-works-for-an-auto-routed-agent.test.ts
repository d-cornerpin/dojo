// An auto-routed agent's history_expand is answered by a real model (its router's standard-tier pick), never sent
// to the "auto" pointer, which no provider can answer. The model call is scripted.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const dialled = vi.hoisted(() => [] as string[]);
vi.mock('../../../model.js', () => ({
  callModel: async (p: { modelId: string }) => {
    dialled.push(p.modelId);
    return { content: `The fence is cedar (answered by ${p.modelId}).`, toolCalls: [], usage: {} };
  },
  getContextWindow: () => 32_000, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
  effectiveContextWindow: (d: number) => d, resolveNumCtx: () => ({ effective: null }),
}));

const AGENT = 'agent-auto';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'expand-auto-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../../db/connection.js');
const migrations = await import('../../../../db/migrations.js');
const { executeTool, toolResultOf } = await import('../../index.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification, model_id) VALUES (?, 'helper', 'idle', '{}', 'apprentice', 'auto')").run(AGENT);
  db.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'openai-compatible', 'https://example.invalid/v1', 'api_key', 1)").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled)
    VALUES ('std-tier', 'cloud', 'std-tier', 'std', '["chat","tools"]', 32768, 1, 1)`).run();
  db.prepare("DELETE FROM router_tier_models WHERE tier_id = 'standard'").run();
  db.prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('standard', 'std-tier', 0)").run();
  db.prepare(`INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at)
    VALUES ('sum_fence', ?, 0, 'leaf', 'The owner chose a cedar fence for the back yard.', 12, '2026-06-01T10:00:00Z', '2026-06-01T11:00:00Z')`).run(AGENT);
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('history_expand for an auto-routed agent', () => {
  it('is answered by the router pick, not refused as the auto pointer', async () => {
    const outcome = await executeTool(AGENT, {
      id: 'call-expand', name: 'history_expand', arguments: { summary_ids: ['sum_fence'], prompt: 'What fence did we pick?' },
    });
    expect(dialled).toEqual(['std-tier']);
    expect(toolResultOf(outcome).content).toBe('The fence is cedar (answered by std-tier).');
  });
});

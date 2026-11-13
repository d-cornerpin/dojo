// When every tier model is under the 32K floor, an auto agent's turn is not run and the owner reads the true
// reason (too small, add a bigger model to the router), never "pick a model on the Agents page".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const cards = vi.hoisted(() => [] as Array<{ type?: string; code?: string; error?: string }>);
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (e: { type?: string }) => { cards.push(e); }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../../tools/tool-docs.js', async (orig) => ({ ...(await orig<typeof import('../../../../../tools/tool-docs.js')>()), measureAgentToolPayloadTokens: async () => 1_000 }));
vi.mock('../../../../../router/decide.js', () => ({
  decideTier: async () => ({ tier: 'light', method: 'semantic', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 1, headVersion: null, queryPreview: '' }),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { advance, initState } from '../../../state.js';
import { selectModel } from '../model-selection.js';
import { CALL_LLM_PHASE } from '../index.js';
import '../../../../../router/router-window.js';

const AGENT = 'agent-small-router';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1)").run();
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
    VALUES ('m-small', 'prov', 'Small', 'small', '["text","tools"]', 8192, 4096, 1)`).run();
  for (const t of ['light', 'standard', 'heavy']) mockDb.current.prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, 'm-small', 0)").run(t);
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'Desk', 'auto', 'idle', '{}')").run(AGENT);
  cards.length = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a router of only small models tells the owner why', () => {
  it('the turn is not run and the owner reads the too-small reason', async () => {
    const out = await selectModel(advance(initState(AGENT, 'auto'), { phase: CALL_LLM_PHASE, loopCount: 1 }), {
      agentId: AGENT, isAutoRouted: true, configuredModelId: 'auto', lastUserMessageContent: 'Is the dock open?',
      conversationId: null, turnNumber: 2, turnContext: undefined as never, revertTriggerStampOnAbort: () => {},
    });
    expect(out.said).toMatch(/memory window under 32K, too small for an agent\. Add a bigger model to the router/);
    expect(cards.filter((c) => c.type === 'chat:error').map((c) => c.error)).toEqual([out.said]);
  });
});

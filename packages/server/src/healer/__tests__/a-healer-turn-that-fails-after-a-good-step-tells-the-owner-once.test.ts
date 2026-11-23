// Round four, sequence H: every Healer turn ran one good tool batch, then its next model call failed.
// The good batch ended "Healer broken" and the failure told the owner again, once per turn. Driven
// through the real turn (`runV2Turn`): "Healer broken" is told once and ends only on a turn that ends
// healthy. The same Healer is offered `reset_session`, the tool its injury instructions name.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const callModelSpy = vi.fn();
const told = vi.hoisted(() => [] as string[]);   // each time the owner is told "Healer broken" (its card and its text go together)

vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../../agent/model.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/model.js')>('../../agent/model.js');
  return { ...actual, callModel: (...a: unknown[]) => callModelSpy(...a), getContextWindow: () => 200000 };
});
vi.mock('../../agent/tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/tools/index.js')>('../../agent/tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../../agent/tool-outcome.js')>('../../agent/tool-outcome.js');
  return { ...actual, executeTool: async (_a: string, tc: { id: string; name: string }) => classifyToolResult({ toolCallId: tc.id, name: tc.name, content: 'ok', isError: false }) };
});
vi.mock('../../agent/runtime.js', () => ({
  injectAttachmentBlocks: vi.fn(), enforceModelCapabilities: () => ({ useTools: true }),
  getAgentRuntime: () => ({ handleMessage: async () => undefined, notifyPrimaryOfInjury: async () => undefined }), clearConsumedOneShotFlags: vi.fn(),
}));
vi.mock('../../memory/assembler.js', () => ({
  assembleContext: async () => ({ systemPrompt: '<system prompt>', messages: [{ role: 'user', content: 'hello' }] }),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: { cardKey?: string; severity?: string }) => { if (e.cardKey === 'healer-broken' && e.severity === 'error') told.push(e.cardKey); }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../costs/tracker.js', async () => ({ ...(await vi.importActual<typeof import('../../costs/tracker.js')>('../../costs/tracker.js')), recordCost: vi.fn() }));
vi.mock('../../router/scorer.js', () => ({ scoreQuery: () => ({ tier: 'standard', scores: [], rawScore: 0, confidence: 0.5, latencyMs: 0 }) }));
vi.mock('../../router/selector.js', () => ({ selectModel: vi.fn(), logRouterDecision: vi.fn(), getSystemModel: () => null }));

import { runV2Turn } from '../../agent/v2/loop.js';
import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { AgentError } from '../../agent/errors.js';
import { getFilteredTools } from '../../agent/tools/surface.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { ownerToldOf } from '../owner-notices.js';

const HEALER = 'healer-h';
let n = 0;

/** One Healer turn woken by an injury question: a good tool batch, then the next call fails (or answers). */
async function healerTurn(fails: boolean): Promise<void> {
  mockDb.current!.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(HEALER);
  insertMessage({ id: `q-${++n}`, agentId: HEALER, role: 'user', content: 'Tally is injured: look into it.', turnNumber: n });
  let pass = 0;
  callModelSpy.mockImplementation(async () => {
    if (++pass === 1) return { content: 'Looking.', toolCalls: [{ id: `c-${n}`, name: 'file_read', arguments: { path: '/tmp/x' } }], inputTokens: 1, outputTokens: 1, stopReason: 'tool_use' };
    if (fails) throw new AgentError("attempted to call tool 'reset_session' which was not in request.tools", HEALER);
    return { content: 'Done.', toolCalls: [], inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
  });
  await runV2Turn(HEALER);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m', 'p', 'M', 'm-1', '[\"tools\"]', 200000, 1)").run();
  for (const id of [HEALER, 'main', 'helper']) db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, ?, 'm', 'idle', '{}', 'sensei')").run(id, id);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', 'main'), ('healer_agent_id', ?)").run(HEALER);
  clearPlatformConfigCache();
  told.length = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a Healer turn that fails after a good step tells the owner once', () => {
  it('two failing turns: one "Healer broken" text; a turn that ends healthy ends it', async () => {
    await healerTurn(true);
    await healerTurn(true);
    expect(told).toHaveLength(1);
    expect(ownerToldOf('healer-broken')).toBe(true);
    await healerTurn(false);
    expect(ownerToldOf('healer-broken')).toBe(false);
  });

  it('the Healer and the main agent are offered reset_session; a helper is not', () => {
    const offered = (id: string): boolean => getFilteredTools(id).some((t) => t.name === 'reset_session');
    expect([offered(HEALER), offered('main'), offered('helper')]).toEqual([true, true, false]);
  });
});

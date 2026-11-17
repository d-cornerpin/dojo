// ════════════════════════════════════════════════════════════════════════════════════════
// t283 — A UTILITY CALL IS CHARGED THE OUTPUT IT CAN EMIT, NOT THE AGENT'S 4,096 (BACKLOG
// 2026-10-13: the ticket-title helper on a small local model, "232 tokens against 0").
//
// t140 stopped charging a toolless dial the agent's tool list. The OTHER half of the reserve was
// left: `toolAndOutputReserve` still set aside min(4096, model max) tokens of OUTPUT, and a title
// emits at most 64. On a 4K window floor(0.96 x 4096) = 3,932 < 4,096, so the budget is 0 before a
// single message is counted (`memory/budget.ts` contextWindowPolicy; the call site is
// `agent/model.ts` -> `memory/assembly-validation.ts:589`). The reserve must come from what the call
// sends: the dial's own output cap (`agent/utility-dial.ts`). Every dial shares the root.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

/** An agent with a real-sized tool surface: larger than what a 16K window has left once the
 *  output allowance is set aside. The summariser sends NONE of it. */
const TOOL_PAYLOAD_TOKENS = 14_000;
vi.mock('../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../tools/tool-docs.js')>('../../tools/tool-docs.js');
  return {
    ...actual,
    measureAgentToolPayloadTokens: async () => TOOL_PAYLOAD_TOKENS,
    filterToolsForApiCall: () => [],
    getAgentAlwaysLoadedTools: () => [],
  };
});

const provider = vi.hoisted(() => ({
  requests: [] as Array<{ prompt: string; options: Record<string, unknown> }>,
}));
// THE SCRIPTED PROVIDER, one level above the external SDK package: `callAnthropicViaSdk` (the
// in-tree transport `callModel` dials for an agent-sdk provider) records what it was handed and
// answers. Fix round 1: scripting the external package itself was measured to leak — under
// concurrent dynamic imports, one importer received the REAL Agent SDK, which launched the real
// CLI ("Not logged in"; nothing was sent). An in-tree module mock does not have that path.
vi.mock('../../providers/anthropic-sdk.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callAnthropicViaSdk: async (params: { systemPrompt: string; messages: unknown[] }) => {
    const req = { prompt: '', options: { systemPrompt: `${params.systemPrompt}\n${JSON.stringify(params.messages)}` } as Record<string, unknown> };
    provider.requests.push(req);
    if ((provider as { failNext?: number }).failNext) {
      (provider as { failNext: number }).failNext--;
      throw new Error('socket hang up');
    }
    return { content: 'The crew counted the north dock and logged the damaged lids.', toolCalls: [], inputTokens: 40, outputTokens: 12, stopReason: 'end_turn' };
  },
}));
// The external package needs no per-file net: `vitest.setup.ts` mocks it suite-wide to throw.

import { runMigrations } from '../../db/migrations.js';
import { callModel } from '../../agent/model.js';
import { __resetAssemblyValidationCounters } from '../assembly-validation.js';
import type { UtilityPurpose } from '../../agent/utility-dial.js';

const AGENT = 'agent-t283-helper';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  provider.requests.length = 0;
  __resetAssemblyValidationCounters();
  db().prepare(
    `INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
     VALUES ('prov-sdk', 'SDK', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`,
  ).run();
  const model = db().prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
     VALUES (?, 'prov-sdk', ?, 'sonnet', '["text"]', ?, ?, 1, datetime('now'), datetime('now'))`,
  );
  model.run('m-4k', 'Small 4K', 4_096, 4_096);
  model.run('m-4k-blank', 'Small 4K blank max', 4_096, 0);
  model.run('m-8k', 'Small 8K', 8_192, 4_096);
  db().prepare(
    `INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
     VALUES (?, 'Helper', 'm-4k', 'idle', '{}', datetime('now'), datetime('now'))`,
  ).run(AGENT);
});

afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const PURPOSES: UtilityPurpose[] = [
  'ask_title', 'continuity_brief',
  'vision_caption', 'page_summary', 'memory_summarize',
];

describe('t283 — a toolless utility call on a small window is charged only the output its dial caps', () => {
  for (const modelId of ['m-4k', 'm-4k-blank', 'm-8k']) {
    for (const purpose of PURPOSES) {
      it(`RED at 37383b81: ${purpose} on ${modelId} is refused for a budget of zero`, async () => {
        const r = await callModel({
          agentId: AGENT, modelId, systemPrompt: '',
          messages: [{ role: 'user', content: 'Name this ticket: the north dock crate count is wrong again.' }],
          tools: false, purpose, utilityTargetTokens: purpose === 'memory_summarize' ? 500 : undefined, bestEffort: true,
        });
        expect(r.content.length).toBeGreaterThan(0);
        expect(provider.requests.length, 'the call must reach its provider').toBe(1);
      });
    }
  }

  it('an agent turn (no purpose) on a 4K window is still charged the full output reserve', async () => {
    await expect(callModel({
      agentId: AGENT, modelId: 'm-4k', systemPrompt: '',
      messages: [{ role: 'user', content: 'hello' }], tools: false,
    })).rejects.toThrow();
  });
});

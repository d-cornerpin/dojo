// ════════════════════════════════════════════════════════════════════════════════════════
// t140 — THE PROVIDER BOUNDARY CHARGES WHAT THE DIAL ACTUALLY SENDS (tracker #13, "a budget of
// zero").
//
// ── THE WITNESS ─────────────────────────────────────────────────────────────────────────
// The boundary validator (`validateAtProviderBoundary`, run inside every `callModel`) priced
// EVERY dial as if it carried the agent's whole tool payload — including the summariser, which
// dials with `tools: false` and sends no tools at all. On a small window that charge alone
// clamps the boundary budget to zero:
//
//     budget = max(0, floor(0.96 · W) − (agent tool payload + min(4096, cap)) − system prompt)
//
// and a message array can never cost zero tokens, so the dial is refused ("STILL over budget
// … against 0") and the summary is never written. The same zero arrives a second way: a model
// row whose `context_window` is 0, which `row.context_window ?? 200000` passed straight
// through because `??` only replaces null.
//
// ── THE DOORS ───────────────────────────────────────────────────────────────────────────
// The summariser's real entry (`generateSummary`) → the real `callModel` → the real boundary,
// against real migrations; only the transport at the bottom is scripted, and it records every
// request it receives. "The summary was written" is read off the summariser's own result, and
// "the dial happened" off the scripted provider.
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
// A second net, never expected to be reached: the external package stays mocked too.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => { throw new Error('t140 test: the real Agent SDK must never be reached'); },
}));

import { runMigrations } from '../../db/migrations.js';
import { generateSummary } from '../summarize.js';
import { getContextWindow } from '../../agent/model.js';
import { __resetAssemblyValidationCounters } from '../assembly-validation.js';

const AGENT = 'agent-t140-summariser';
const SMALL = 'm-small-16k';
const ZERO = 'm-window-zero';

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
     VALUES (?, 'prov-sdk', ?, 'sonnet', '["text"]', ?, 4096, 1, datetime('now'), datetime('now'))`,
  );
  model.run(SMALL, 'Small 16K', 16_384);
  model.run(ZERO, 'Window Zero', 0);
  db().prepare(
    `INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
     VALUES (?, 'Note Writer', ?, 'idle', '{}', datetime('now'), datetime('now'))`,
  ).run(AGENT, SMALL);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const CHUNK = '[USER] How many crates are on the north dock?\n\n---\n\n'
  + '[ASSISTANT] Forty-two, and three of them have damaged lids set aside for repair.';

describe('t140 W3 — a toolless dial on a small window is not charged tools it never sends', () => {
  it('RED at 00a2b34d: the summariser on a 16K model computes a boundary budget of zero and writes nothing', async () => {
    const r = await generateSummary({ content: CHUNK, depth: 0, targetTokens: 500, agentId: AGENT, modelId: SMALL });
    expect(r.ok, `the summary must be written (got: ${r.ok ? 'ok' : r.reason})`).toBe(true);
    expect(provider.requests.length, 'the summariser must actually reach its provider').toBe(1);
  });
});

describe('t140 — a model row declaring context_window = 0 resolves to the documented default, never 0', () => {
  it('RED at 00a2b34d: the engine budgets against a window of 0', () => {
    expect(getContextWindow(ZERO)).toBe(200_000);
  });

  it('RED at 00a2b34d: a summariser dial on that row is refused at the boundary for a budget of zero', async () => {
    const r = await generateSummary({ content: CHUNK, depth: 0, targetTokens: 500, agentId: AGENT, modelId: ZERO });
    expect(r.ok, `the summary must be written (got: ${r.ok ? 'ok' : r.reason})`).toBe(true);
    expect(provider.requests.length).toBe(1);
  });
});

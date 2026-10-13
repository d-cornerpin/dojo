// ════════════════════════════════════════════════════════════════════════════════════════
// t140 — THE MODEL ACTUALLY DIALED KEEPS THE LIVE CONVERSATION (tracker #13, the "45K family").
//
// ── THE WITNESS ─────────────────────────────────────────────────────────────────────────
// An auto-routed agent's turn was assembled for a 200,000-token stand-in (`'__auto__'` has no
// model row, so the window resolver fell back to 200K). The router then dialed a model whose
// declared window was far smaller. `reassembleForFitIfNeeded` only re-sized for a model that
// declared a provider CEILING, so for every ordinary routed pick the 200K-sized array went to
// the provider boundary unchanged — and the boundary's lane repair dropped whole lanes, lowest
// priority first, ending with `lane.fresh-tail`: the agent's ENTIRE live conversation. The call
// then went out holding the system prompt and almost nothing else. On the reporting box that
// is the run of calls whose prompt sat flat at ~45K while the model redid steps it could no
// longer see.
//
// ── THE DOORS THIS DRIVES (no inner function is called on its own) ──────────────────────
// The three calls the engine's `callLLM` step makes, in its order, against REAL migrations, a
// REAL assembler, the REAL window resolver, the REAL re-assemble helper and the REAL
// `callModel` with its provider-boundary validator. Only the transport at the very bottom is
// scripted (the Agent SDK's `query()`), so what this file reads is the exact request a provider
// would have received.
//   1. `assembleContext(agentId, '__auto__')`   — what `assemble` runs for an auto-routed turn
//   2. `reassembleForFitIfNeeded({ modelId })`  — what `callLLM` runs once the router has picked
//   3. `callModel({ modelId, messages })`        — the dial, through the boundary validator
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

vi.mock('../../../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));

vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: () => { /* not exercised */ },
  stampPersistedRow: (e: unknown) => e,
}));

/** The agent's tool payload, as the budget measures it. A fixed number so the arithmetic in
 *  this file is derivable by hand; `filterToolsForApiCall` is the transport's own list. */
const TOOL_PAYLOAD_TOKENS = 2_000;
vi.mock('../../../../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../tools/tool-docs.js')>('../../../../../tools/tool-docs.js');
  return {
    ...actual,
    measureAgentToolPayloadTokens: async () => TOOL_PAYLOAD_TOKENS,
    filterToolsForApiCall: () => [],
    getAgentAlwaysLoadedTools: () => [],
  };
});

/** THE SCRIPTED PROVIDER. Every request it receives is recorded verbatim. */
const provider = vi.hoisted(() => ({
  requests: [] as Array<{ prompt: string; options: Record<string, unknown> }>,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    provider.requests.push(args);
    return (async function* answer() {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Noted.' }], usage: { input_tokens: 3, output_tokens: 2 } },
      };
    })();
  },
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { assembleContext } from '../../../../../memory/assembler.js';
import { reassembleForFitIfNeeded } from '../reassemble-for-fit.js';
import { callModel, getContextWindow } from '../../../../model.js';
import { __resetAssemblyValidationCounters } from '../../../../../memory/assembly-validation.js';
import type { PromptTurnContext } from '../../../../../prompt/assembler.js';
import { SystemPromptTooLargeError } from '../../../../../memory/budget.js';

const AGENT = 'agent-t140-routed';
/** Two routed models, both far below the 200K stand-in — the reporting box's shape. */
const HEAVY = 'm-routed-heavy';
const LIGHT = 'm-routed-light';
const HEAVY_WINDOW = 32_768;
/** Small enough that an array sized for the heavy pick cannot reach it unchanged:
 *  floor(0.96 × 16,384) − (2,000 tools + 4,096 output) leaves ~9.6K for a ~6K system prompt. */
const LIGHT_WINDOW = 16_384;

/** Fictional bodies (G1). Each row carries a marker so a request can be searched for it. */
const ASK = 'Please keep counting the crates on the north dock and tell me the running total.';
const REPLY = 'Counted another stack on the north dock; the running total is written on the board '
  + 'beside the ramp, and the damaged lids are set aside for the repair bench this afternoon. '
  + 'Nothing else has moved since the last count, and the pallets by the door are still sealed.';

/** A model that cannot hold this agent's system prompt and tools at all (not in a tier: a
 *  fallback pick or a mis-set override can still name it). */
const TINY = 'm-too-small';
const TINY_WINDOW = 8_192;

const db = (): Database.Database => mockDb.current!;

function seedRoutedBox(): void {
  db().prepare(
    `INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
     VALUES ('prov-routed', 'Routed', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`,
  ).run();
  const model = db().prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
     VALUES (?, 'prov-routed', ?, 'sonnet', '["text","tools"]', ?, 4096, 1, datetime('now'), datetime('now'))`,
  );
  model.run(HEAVY, 'Routed Heavy', HEAVY_WINDOW);
  model.run(LIGHT, 'Routed Light', LIGHT_WINDOW);
  model.run(TINY, 'Too Small', TINY_WINDOW);
  const tier = db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)');
  tier.run('heavy', HEAVY);
  tier.run('standard', HEAVY);
  tier.run('light', LIGHT);
  db().prepare(
    `INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
     VALUES (?, 'Dock Counter', 'auto', 'idle', '{}', datetime('now'), datetime('now'))`,
  ).run(AGENT);
}

/** A long live conversation with no compaction ever: every row is in the live view. */
function seedConversation(turns: number): void {
  for (let t = 1; t <= turns; t++) {
    db().prepare(
      `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
       VALUES (?, ?, 'user', datetime('now'), datetime('now'), 'answered', 1)`,
    ).run(AGENT, t);
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${t}] ${ASK}`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[reply ${t}] ${REPLY}`, turnNumber: t });
  }
}

/** Everything the provider was shown, as one string: the packed history and the prompt. */
function shown(req: { prompt: string; options: Record<string, unknown> }): string {
  return `${String(req.options.systemPrompt ?? '')}\n${req.prompt}`;
}

/** The engine's own three doors, in `callLLM`'s order, for one routed pick. */
async function dialAsRouted(pick: string): Promise<{ prompt: string; options: Record<string, unknown> }> {
  const assembled = await assembleContext(AGENT, '__auto__');
  const turnCtx = undefined as unknown as PromptTurnContext;
  const re = await reassembleForFitIfNeeded({
    agentId: AGENT, modelId: pick, messages: assembled.messages as never,
    systemPrompt: assembled.systemPrompt, volatileFrom: assembled.messages.length,
    assemblyTurnContext: turnCtx,
  });
  const messages = (re?.messages ?? assembled.messages) as never;
  const systemPrompt = re?.systemPrompt ?? assembled.systemPrompt;
  const before = provider.requests.length;
  await callModel({ agentId: AGENT, modelId: pick, messages, systemPrompt, tools: true });
  expect(provider.requests.length, 'the scripted provider must have been dialed exactly once').toBe(before + 1);
  return provider.requests[provider.requests.length - 1];
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  provider.requests.length = 0;
  __resetAssemblyValidationCounters();
  seedRoutedBox();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 W1 — a routed pick below the 200K stand-in still receives the live conversation', () => {
  it('RED at 00a2b34d: the heavy pick is dialed WITHOUT the conversation (lane.fresh-tail dropped at the boundary)', async () => {
    seedConversation(250);
    const req = await dialAsRouted(HEAVY);
    const text = shown(req);
    // The newest ask is the one the model is answering; a mid-conversation reply is the
    // agent's own earlier work. Both live in `lane.fresh-tail` and nowhere else.
    // `includes` rather than `toContain`: a failure must not dump the whole system prompt.
    expect(text.includes('[ask 250]'), 'the newest ask must reach the dialed model').toBe(true);
    expect(text.includes('[reply 249]'), 'the agent\'s own recent work must reach the dialed model').toBe(true);
  });

  it('the light pick, smaller still, keeps the newest exchange too', async () => {
    seedConversation(250);
    const req = await dialAsRouted(LIGHT);
    const text = shown(req);
    expect(text.includes('[ask 250]'), 'the newest ask must reach the dialed model').toBe(true);
    expect(text.includes('[reply 249]'), 'the agent\'s own recent work must reach the dialed model').toBe(true);
  });

  it('the auto-routed window is a REAL routed window, never the 200K stand-in', () => {
    // The largest window any routed pick declares: every pick can be sized DOWN to its own
    // window before dial (reassemble-for-fit); none can be sized up.
    expect(getContextWindow('__auto__')).toBe(HEAVY_WINDOW);
  });

  it('a pick whose window cannot hold the system prompt and tools FAILS LOUD with a named defect, and nothing is dialed', async () => {
    // floor(0.96 × 8,192) − (2,000 tools + 4,096 output) = 1,768 tokens for a ~6K system
    // prompt. No array can be right for this model, so the honest answer is the named refusal
    // the assembler already owns (`SystemPromptTooLargeError`, which also cards the person),
    // never a dial with the conversation cut out of it.
    seedConversation(40);
    const assembled = await assembleContext(AGENT, '__auto__');
    await expect(reassembleForFitIfNeeded({
      agentId: AGENT, modelId: TINY, messages: assembled.messages as never,
      systemPrompt: assembled.systemPrompt, volatileFrom: assembled.messages.length,
      assemblyTurnContext: undefined as unknown as PromptTurnContext,
    })).rejects.toBeInstanceOf(SystemPromptTooLargeError);
    expect(provider.requests.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 5 — THE "CANNOT HOLD A CONVERSATION" CARD IS SHOWN ONLY WHEN IT IS TRUE.
//
// The card says: this agent's model's memory window is too small for its own instructions and
// tools, and the agent will not work again until its tool list or its model changes. Two things
// left over from rounds 2–3 could show it when that was false:
//   (a) THE FIT PRE-CHECK MEASURED THE WRONG PROMPT. `reassembleForFitIfNeeded` refuses a pick
//       that cannot hold the system prompt BEFORE assembling for it — but it measured the prompt
//       already in hand (built for another model), while the assembler measures the prompt it
//       builds for THIS pick (its runtime section names the pick). A pick within a few tokens of
//       the line passed the pre-check and then carded from inside `assembleContext` — on a
//       fallback candidate, where round 2 had promised no card.
//   (b) TWO PATHS CARDED UNCONDITIONALLY: the router's own pick, and the budget redirect's free
//       model. Either can be too small while the agent's own model (or another model the router
//       opens on) holds it fine — the agent is not broken, that one pick is.
//
// ── THE DOOR ────────────────────────────────────────────────────────────────────────────
// `reassembleForFitIfNeeded`, exactly as its three callers call it (the call step for the
// router's pick; the fallback ladder with `anotherPickMayFollow`; the budget redirect's
// `refitFor`), on real migrations, the real assembler, the real window resolver and the real
// card (`window-starvation-card.ts`), whose broadcasts are recorded.
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

const owner = vi.hoisted(() => ({ cards: [] as Array<{ type?: string; code?: string }> }));
vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (e: { type?: string; code?: string }) => { owner.cards.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

const assembledFor = vi.hoisted(() => [] as string[]);
vi.mock('../../../../../memory/assembler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../memory/assembler.js')>();
  return {
    ...actual,
    assembleContext: (agentId: string, modelId: string, ...rest: unknown[]) => {
      assembledFor.push(modelId);
      return (actual.assembleContext as (...a: unknown[]) => unknown)(agentId, modelId, ...rest);
    },
  };
});

const TOOL_PAYLOAD_TOKENS = 2_000;
vi.mock('../../../../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../tools/tool-docs.js')>('../../../../../tools/tool-docs.js');
  return { ...actual, measureAgentToolPayloadTokens: async () => TOOL_PAYLOAD_TOKENS, filterToolsForApiCall: () => [], getAgentAlwaysLoadedTools: () => [] };
});

/** The summariser's text is not the subject (a re-fit that does assemble may fold what it cut). */
vi.mock('../../../../../memory/summarize.js', () => ({
  generateSummary: async () => ({ ok: true, text: 'Earlier the crew counted the north dock.', tokenCount: 8 }),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { assembleContext } from '../../../../../memory/assembler.js';
import { contextWindowPolicy, estimateTokens, SystemPromptTooLargeError } from '../../../../../memory/budget.js';
import { buildAssemblyContext, assembleSystemFromRegistry } from '../../../../../prompt/registry/assembler.js';
import { getModelOutputCap } from '../../../../model.js';
import { backgroundDrains } from '../../../../shared-state.js';
import { reassembleForFitIfNeeded } from '../reassemble-for-fit.js';
import type { PromptTurnContext } from '../../../../../prompt/assembler.js';

const ROOMY = 'm-roomy-200k';
const TINY = 'm-tiny-8k';
const TINY_WINDOW = 8_192;
/** A long identifier: the runtime section of a prompt built for it is several tokens longer than one
 *  built for `'__auto__'` — the few tokens round 3's pre-check could not see. */
const EDGE = `m-edge-${'northdock'.repeat(12)}`;

const db = (): Database.Database => mockDb.current!;
const turnCtx = undefined as unknown as PromptTurnContext;
const starvedCards = (): number => owner.cards.filter((c) => c.code === 'WINDOW_TOO_SMALL').length;

function seedProvider(): void {
  db().prepare(
    `INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
     VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`,
  ).run();
}
function seedModel(id: string, window: number, costIn = 1, costOut = 2): void {
  db().prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m, created_at, updated_at)
     VALUES (?, 'prov', ?, ?, '["text","tools"]', ?, 4096, 1, ?, ?, datetime('now'), datetime('now'))`,
  ).run(id, id, id, window, costIn, costOut);
}
function seedAgent(agentId: string, modelId: string): void {
  db().prepare(
    `INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
     VALUES (?, 'Dock Counter', ?, 'idle', '{}', datetime('now'), datetime('now'))`,
  ).run(agentId, modelId);
}
function seedConversation(agentId: string, exchanges: number): void {
  for (let t = 1; t <= exchanges; t++) {
    insertMessage({ agentId, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${t}] How many crates are left on the north dock?`, turnNumber: t });
    insertMessage({ agentId, role: 'assistant', lane: 'owner', content: `[reply ${t}] ${'Counted another stack beside the ramp; the board has the total. '.repeat(20)}`, turnNumber: t });
  }
}
/** The prompt the assembler builds for `modelId`, by the assembler's own two functions. */
function systemTokensFor(agentId: string, modelId: string): number {
  return estimateTokens(assembleSystemFromRegistry(buildAssemblyContext(agentId, modelId, turnCtx)).text);
}
function budgetOn(window: number, modelId: string): number {
  return contextWindowPolicy(window, { toolPayloadTokens: TOOL_PAYLOAD_TOKENS, maxOutputTokens: getModelOutputCap(modelId) }).assemblyBudgetTokens;
}

async function refit(agentId: string, modelId: string, anotherPickMayFollow?: boolean): Promise<unknown> {
  const assembled = await assembleContext(agentId, '__auto__', turnCtx);
  assembledFor.length = 0;
  try {
    await reassembleForFitIfNeeded({
      agentId, modelId, messages: assembled.messages as never, systemPrompt: assembled.systemPrompt,
      volatileFrom: assembled.messages.length, assemblyTurnContext: turnCtx, ...(anotherPickMayFollow ? { anotherPickMayFollow } : {}),
    });
    return null;
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  owner.cards.length = 0;
  assembledFor.length = 0;
  seedProvider();
  seedModel(ROOMY, 200_000);
  seedModel(TINY, TINY_WINDOW, 0, 0);
  db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)').run('standard', ROOMY);
  db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)').run('heavy', ROOMY);
});

afterEach(async () => {
  for (let i = 0; i < 400 && backgroundDrains.size > 0; i++) await new Promise((r) => setTimeout(r, 5));
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 round 5 (a) — the fit pre-check measures the prompt the assembler will build for the pick', () => {
  it.fails('a fallback candidate a few tokens short is refused BEFORE assembling, with no card', async () => {
    const AGENT = 'agent-edge';
    seedAgent(AGENT, 'auto');
    seedConversation(AGENT, 40);
    seedModel(EDGE, 32_000);
    // Find a window for EDGE whose budget holds the '__auto__' prompt but not EDGE's own prompt.
    const inHand = estimateTokens((await assembleContext(AGENT, '__auto__', turnCtx)).systemPrompt);
    const own = systemTokensFor(AGENT, EDGE);
    expect(own, 'precondition: the prompt built for the pick is longer than the one in hand').toBeGreaterThan(inHand);
    let window = Math.ceil((inHand + TOOL_PAYLOAD_TOKENS + 4096) / 0.96);
    while (budgetOn(window, EDGE) < inHand) window++;
    db().prepare('UPDATE models SET context_window = ? WHERE id = ?').run(window, EDGE);
    expect(budgetOn(window, EDGE), 'precondition: the in-hand prompt fits the pick').toBeGreaterThanOrEqual(inHand);
    expect(systemTokensFor(AGENT, EDGE), 'precondition: the pick\'s own prompt does not').toBeGreaterThan(budgetOn(window, EDGE));

    const err = await refit(AGENT, EDGE, true);
    expect(err, 'refused by name').toBeInstanceOf(SystemPromptTooLargeError);
    expect(starvedCards(), 'no "cannot hold a conversation" card for a fallback candidate').toBe(0);
    expect(assembledFor, 'and nothing was assembled for it').not.toContain(EDGE);
  });
});

describe('t140 round 5 (b) — the card is shown only when the agent itself cannot hold a conversation', () => {
  it.fails('the ROUTER\'S OWN pick is too small, but another model the router opens on holds the agent: refused by name, no card', async () => {
    const AGENT = 'agent-routed-tiny';
    seedAgent(AGENT, 'auto');
    seedConversation(AGENT, 40);
    db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)').run('light', TINY);
    const err = await refit(AGENT, TINY);
    expect(err).toBeInstanceOf(SystemPromptTooLargeError);
    expect(starvedCards(), 'the agent can hold a conversation on its other routed picks').toBe(0);
  });

  it.fails('the BUDGET REDIRECT\'S free model is too small, but the agent\'s own model holds it: refused by name, no card', async () => {
    const AGENT = 'agent-fixed-redirect';
    seedAgent(AGENT, ROOMY);
    seedConversation(AGENT, 40);
    // `model-call.ts`'s `refitFor` calls the door with exactly these arguments (no fallback flag).
    const err = await refit(AGENT, TINY);
    expect(err).toBeInstanceOf(SystemPromptTooLargeError);
    expect(starvedCards(), 'the agent\'s own model holds it; only the stand-in is too small').toBe(0);
  });

  it('CONTROL — the agent\'s OWN model cannot hold it: the card is true, and it is shown', async () => {
    const AGENT = 'agent-fixed-tiny';
    seedAgent(AGENT, TINY);
    seedConversation(AGENT, 40);
    const err = await refit(AGENT, TINY);
    expect(err).toBeInstanceOf(SystemPromptTooLargeError);
    expect(starvedCards(), 'the agent cannot hold a conversation until its model or tools change').toBe(1);
  });

  it('CONTROL — an auto-routed agent none of whose opening picks can hold it: the turn\'s own assembly refuses, and the card is shown', async () => {
    const AGENT = 'agent-routed-all-tiny';
    seedAgent(AGENT, 'auto');
    seedConversation(AGENT, 40);
    db().prepare('DELETE FROM router_tier_models').run();
    db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)').run('light', TINY);
    await expect(assembleContext(AGENT, '__auto__', turnCtx)).rejects.toBeInstanceOf(SystemPromptTooLargeError);
    expect(starvedCards()).toBe(1);
  });
});

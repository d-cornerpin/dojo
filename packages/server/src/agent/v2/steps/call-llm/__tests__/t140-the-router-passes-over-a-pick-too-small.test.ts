// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 6 (H2, ruling R-V333-15) — A ROUTER PICK TOO SMALL FOR THE AGENT IS PASSED OVER, LIKE
// A FALLBACK; WHAT THE OWNER SEES IS THE ANSWER, OR ONE HONEST REFUSAL.
//
// Round 5 stopped the "cannot hold a conversation" card from showing when only the router's own
// pick was too small (the card was false: other routed models hold the agent). But nothing passed
// that pick over: the call step refused it by name and the turn failed — every ask routed to that
// tier failed. A fallback candidate that is too small has been passed over since round 2; the
// router's own pick now is too: the next model the router would offer is dialled, no card.
// When nothing the router can reach right now holds the agent, the turn ends with the true cause told
// to the owner (round 7) — and the card only if it is true (the agent's own models cannot hold it).
//
// THE DOOR: `runCallLLM`, the engine's call step, on a migrated DB with the real router selector,
// the real assembler and re-fit; scripted: the tier decision and the provider call.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

const dialed = vi.hoisted(() => [] as string[]);
vi.mock('../../../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../model.js')>()),
  callModel: async (p: { modelId: string }) => {
    dialed.push(p.modelId);
    return { content: 'The dock is open.', toolCalls: [], inputTokens: 10, outputTokens: 4, stopReason: 'end_turn' };
  },
}));
const owner = vi.hoisted(() => ({ cards: [] as Array<{ type?: string; code?: string }> }));
vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (e: { type?: string; code?: string }) => { owner.cards.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {},
}));
vi.mock('../../../../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../tools/tool-docs.js')>('../../../../../tools/tool-docs.js');
  return { ...actual, measureAgentToolPayloadTokens: async () => 2_000, filterToolsForApiCall: () => [], getAgentAlwaysLoadedTools: () => [] };
});
vi.mock('../../../outbound-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../outbound-ledger.js')>()),
  getRecentOutbound: () => [],
}));
vi.mock('../../../../../memory/deliveries-lane.js', () => ({ renderDeliveriesLaneMessage: () => null }));
vi.mock('../../../../../work/obligations.js', () => ({ buildOpenWorkInjection: () => null }));
vi.mock('../../../receipt.js', () => ({ writeContextReceipt: () => undefined }));
vi.mock('../../../../runtime.js', () => ({ enforceModelCapabilities: async () => ({ useTools: true }) }));
vi.mock('../../../../../router/decide.js', () => ({
  decideTier: async () => ({ tier: 'light', method: 'semantic', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 1, headVersion: null, queryPreview: '' }),
}));
vi.mock('../../../../../router/probe.js', () => ({ maybeProbe: () => undefined }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { assembleContext } from '../../../../../memory/assembler.js';
import { advance, initState } from '../../../state.js';
import { runCallLLM, CALL_LLM_PHASE, type CallLLMContext } from '../index.js';
import type { PromptTurnContext } from '../../../../../prompt/assembler.js';

const AGENT = 'agent-t140-tiny-light';
const TINY = 'm-tiny-8k';
const ROOMY = 'm-roomy-200k';
const db = (): Database.Database => mockDb.current!;
const starvedCards = (): number => owner.cards.filter((c) => c.code === 'WINDOW_TOO_SMALL').length;

function seed(roomyOverBudget: boolean): void {
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
                VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`).run();
  const model = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m, created_at, updated_at)
    VALUES (?, 'prov', ?, ?, '["text","tools"]', ?, 4096, 1, ?, ?, datetime('now'), datetime('now'))`);
  model.run(TINY, 'Tiny', 'tiny', 8_192, 0, 0);
  model.run(ROOMY, 'Roomy', 'roomy', 200_000, 3, 15);
  const tier = db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)');
  tier.run('light', TINY);
  tier.run('standard', ROOMY);
  tier.run('heavy', ROOMY);
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
                VALUES (?, 'Dock Desk', 'auto', 'idle', '{}', datetime('now'), datetime('now'))`).run(AGENT);
  if (roomyOverBudget) {
    // Today's spend is past the owner's daily limit, so the router passes over the priced model;
    // the free tiny one is all it can reach right now.
    db().prepare("INSERT OR REPLACE INTO budgets (id, scope, limit_usd, period) VALUES ('global_daily', 'global', 0.000001, 'daily')").run();
  }
  for (let t = 1; t <= 20; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${t}] Is the north dock open?`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[reply ${t}] ${'Yes, the dock is open and the crates are counted. '.repeat(12)}`, turnNumber: t });
  }
}

async function callStep(): Promise<Awaited<ReturnType<typeof runCallLLM>>> {
  const turnCtx = undefined as unknown as PromptTurnContext;
  const assembled = await assembleContext(AGENT, '__auto__', turnCtx);
  const ctx: CallLLMContext = {
    agentId: AGENT,
    turnCtx: { agentId: AGENT, conversationId: null } as unknown as CallLLMContext['turnCtx'],
    turnNumber: 21, db: db(),
    counterparty: { kind: 'user', name: 'the owner', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null } as unknown as CallLLMContext['counterparty'],
    isA2ATurn: false, isAutoRouted: true, configuredModelId: 'auto', lastUserMessageContent: 'Is the north dock open?',
    messages: assembled.messages as CallLLMContext['messages'], systemPrompt: assembled.systemPrompt, assembled,
    modelContext: {} as CallLLMContext['modelContext'], volatileFrom: assembled.messages.length, steerAwaitingConfirm: null,
    assemblyTurnContext: turnCtx, revertTriggerStampOnAbort: () => {},
  };
  return runCallLLM(advance(initState(AGENT, 'auto'), { phase: CALL_LLM_PHASE, loopCount: 1 }), ctx);
}

beforeEach(async () => {
  (await import('../../../../../router/rate-limits.js')).clearRateLimits();
  mockDb.current = new Database(':memory:');
  runMigrations();
  dialed.length = 0;
  owner.cards.length = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t140 round 6 — the router\'s own pick, too small for the agent', () => {
  it('is passed over like a fallback: the next model the router offers answers, and the owner sees the answer, no card', async () => {
    seed(false);
    const out = await callStep();
    expect(out.directive, 'the turn went on').toBe('proceed');
    expect(dialed, 'the roomy model answered; the tiny one was never dialled').toEqual([ROOMY]);
    expect((out as { result: { content: string } }).result.content).toBe('The dock is open.');
    expect(starvedCards(), 'the agent can hold a conversation; no card').toBe(0);
  });

  it('when nothing the router can reach right now holds the agent (the roomy model is over budget): the turn ends with one notice to the owner, and no false card', async () => {
    seed(true);
    // Round 7 (re-review H2'): judged by what the OWNER is sent, not by a thrown error's text.
    // t148: the limit alone is an honest stop. The call step throws it to the platform's lock (the ask
    // re-armed, nothing handed back), and the lock tells the owner once.
    const { recoverFromError } = await import('../../../recovery.js');
    const thrown = await callStep().then(() => null, (err: unknown) => err);
    expect(thrown, 'the call step hands the honest stop to the lock').toMatchObject({ code: 'BUDGET_STOP' });
    await recoverFromError(advance(initState({ agentId: AGENT, contextWindow: 200_000, isAutoRouted: true, configuredModelId: 'auto', turnNumber: 21 }), { phase: CALL_LLM_PHASE, loopCount: 1 }), thrown, { isUserFacingTurn: true });
    expect((db().prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status).toBe('paused');
    const notices = owner.cards.filter((c) => c.type === 'chat:error');
    // t167: the stop is also told to the owner ONCE through the owner-notice door (the budget's window had
    // only a warning, if anything): that is the second chat:error, the platform's own card; the agent's
    // line is still the one.
    const agentNotices = notices.filter((c) => c.code === 'NO_MODEL');
    expect(agentNotices.length, 'one notice to the owner about the agent\'s turn').toBe(1);
    expect(notices.filter((c) => c.code !== 'NO_MODEL').map((c) => (c as { error?: string }).error), 'and the limit-reached card, once')
      .toEqual([expect.stringMatching(/spending limit is reached/i)]);
    expect(dialed, 'nothing that cannot hold the agent was dialled').toEqual([]);
    expect(starvedCards(), 'the card would be false: the agent holds a conversation on its own roomy model once the budget allows').toBe(0);
  });
});

// ── round 7 (round-6 re-review H2') ────────────────────────────────────────────────────────
// Round 6 threw the by-name refusal when nothing reachable could hold the agent, and its witness read
// the thrown error. What the OWNER saw, driven through the real turn-error path, was "Agent hit an
// error and the Healer is looking into it", the agent marked errored and handed to the Healer — for
// a daily budget that was simply spent. The owner must see the true cause in plain words, and a
// budget stop is not an injury.
describe('t140 round 7 — when no router pick fits, what the owner sees is the true cause', () => {
  it('the roomy model is skipped for budget: the owner is told, in plain words, that today\'s spending limit is reached — and the agent is not errored or handed to the Healer', async () => {
    seed(true);
    const { recoverFromError } = await import('../../../recovery.js');
    let outcome: unknown = null;
    try {
      outcome = await callStep();
    } catch (err) {
      // The turn's teardown does exactly this with an error the call step throws.
      await recoverFromError(advance(initState({ agentId: AGENT, contextWindow: 200_000, isAutoRouted: true, configuredModelId: 'auto', turnNumber: 21 }), { phase: CALL_LLM_PHASE, loopCount: 1 }), err, { isUserFacingTurn: true });
    }
    const said = owner.cards.map((c) => `${(c as { error?: string }).error ?? ''} ${JSON.stringify((c as { message?: { content?: string } }).message?.content ?? '')}`).join('\n');
    expect(said, `what the owner was shown:\n${said}`).toMatch(/spending limit/i);
    expect(said, 'not the generic error that hands it to the Healer').not.toMatch(/Healer/);
    const status = (db().prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status;
    expect(status, 'a budget stop is not an injury').not.toBe('error');
    expect(dialed, 'nothing that cannot hold the agent was dialled').toEqual([]);
    expect((outcome as { directive?: string } | null)?.directive ?? 'threw', 't148: the honest stop is thrown to the lock, not ended as a turn that chose silence').toBe('threw');
  });

  // The roomy model is turned away for a reason that passes (a rate limit): the turn must still be
  // BUILT for it, so the call step can say so. Building for the small pick alone failed the assembly
  // with the "cannot hold a conversation" card — false — and the generic Healer error.
  it('the roomy model is rate-limited right now: the owner is told so in plain words — no false card, no Healer, not errored', async () => {
    seed(false);
    const { updateRateLimits } = await import('../../../../../router/rate-limits.js');
    updateRateLimits(ROOMY, { 'x-ratelimit-remaining': '0', 'retry-after': '600' });
    const { recoverFromError } = await import('../../../recovery.js');
    try {
      await callStep();
    } catch (err) {
      await recoverFromError(advance(initState({ agentId: AGENT, contextWindow: 200_000, isAutoRouted: true, configuredModelId: 'auto', turnNumber: 21 }), { phase: CALL_LLM_PHASE, loopCount: 1 }), err, { isUserFacingTurn: true });
    }
    const said = owner.cards.map((c) => `${(c as { error?: string }).error ?? ''} ${JSON.stringify((c as { message?: { content?: string } }).message?.content ?? '')}`).join('\n');
    expect(said, `what the owner was shown:\n${said}`).toMatch(/rate-limited/);
    expect(said).not.toMatch(/Healer/);
    expect(starvedCards(), 'the agent can hold a conversation once the limit lifts').toBe(0);
    expect((db().prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status).not.toBe('error');
    expect(dialed).toEqual([]);
  });

  // Round 7 (re-review I1') made a model's provider answering a turn's call one of the changes that re-arm a
  // summary writer on that provider that had failed. t207 (D9) reverses it: only a SUMMARY answer, a person's
  // fresh message or the Settings writer changing does. A chat answer says nothing about summaries.
  it('t207: the turn\'s call answers: a summary writer on that provider that had failed is STILL passed over', async () => {
    seed(false);
    const health = await import('../../../../../memory/summary-writer-health.js');
    health.__resetSummaryWriterHealthForTests();
    health.noteSummaryWriterOutcome(ROOMY, false);                     // a summary call on its provider failed
    expect(health.eligibleSummaryWriters(ROOMY), 'precondition: passed over').not.toContain(ROOMY);
    const out = await callStep();
    expect(out.directive).toBe('proceed');
    expect(dialed).toEqual([ROOMY]);
    expect(health.eligibleSummaryWriters(ROOMY), 'a chat answer does not re-arm a summary writer').not.toContain(ROOMY);
  });
});

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
// THE DOOR: the routing (`selectModel`, which the `assemble` step runs before it builds; t212 moved the
// pass-over there, ahead of the build), the one assembly for the pick, then `runCallLLM`, on a migrated
// DB with the real router selector, the real assembler and re-fit; scripted: the tier decision and the
// provider call.
//
// v3.5 N42 (GitHub #25, the owner's design): every automatic pick runs at ONE router window, topped at
// the smallest model on the light, standard and heavy tiers. A tier model too small for the agent
// therefore makes that one window too small for EVERY pick: nothing is passed over, the agent is
// stopped honestly (no model fits, the card), and the fix is the owner's — raise the smallest model or
// take it off the router. The round-6 clause below states that; the round-7 cause clauses keep their
// subject (the true cause when nothing reachable can be dialled) on a router whose smallest model
// holds the agent (`seed`'s `tinyOnRouter: false`), where a budget or a rate limit IS the cause.
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
import { selectModel } from '../model-selection.js';
import type { PromptTurnContext } from '../../../../../prompt/assembler.js';

const AGENT = 'agent-t140-tiny-light';
const TINY = 'm-tiny-8k';
const ROOMY = 'm-roomy-200k';
const db = (): Database.Database => mockDb.current!;
const starvedCards = (): number => owner.cards.filter((c) => c.code === 'WINDOW_TOO_SMALL').length;

function seed(roomyOverBudget: boolean, opts: { tinyOnRouter?: boolean } = {}): void {
  const tinyOnRouter = opts.tinyOnRouter ?? true;
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
                VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`).run();
  const model = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m, created_at, updated_at)
    VALUES (?, 'prov', ?, ?, '["text","tools"]', ?, 4096, 1, ?, ?, datetime('now'), datetime('now'))`);
  model.run(TINY, 'Tiny', 'tiny', 8_192, 0, 0);
  model.run(ROOMY, 'Roomy', 'roomy', 200_000, 3, 15);
  const tier = db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)');
  tier.run('light', tinyOnRouter ? TINY : ROOMY);
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
  const routed = await selectModel(advance(initState(AGENT, 'auto'), { phase: CALL_LLM_PHASE, loopCount: 1 }), {
    agentId: AGENT, isAutoRouted: true, configuredModelId: 'auto', lastUserMessageContent: 'Is the north dock open?',
    conversationId: null, turnNumber: 21, turnContext: turnCtx, revertTriggerStampOnAbort: () => {},
  });
  if (routed.said !== undefined) return { directive: 'exit', state: routed.state, reason: routed.said };
  const assembled = await assembleContext(AGENT, routed.selection.modelId, turnCtx);
  const ctx: CallLLMContext = {
    agentId: AGENT,
    turnCtx: { agentId: AGENT, conversationId: null } as unknown as CallLLMContext['turnCtx'],
    turnNumber: 21, db: db(),
    counterparty: { kind: 'user', name: 'the owner', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null } as unknown as CallLLMContext['counterparty'],
    isA2ATurn: false, isAutoRouted: true, lastUserMessageContent: 'Is the north dock open?', selection: routed.selection,
    messages: assembled.messages as CallLLMContext['messages'], systemPrompt: assembled.systemPrompt, assembled,
    modelContext: {} as CallLLMContext['modelContext'], volatileFrom: assembled.messages.length, steerAwaitingConfirm: null,
    assemblyTurnContext: turnCtx, revertTriggerStampOnAbort: () => {},
  };
  return runCallLLM(routed.state, ctx);
}

beforeEach(async () => {
  (await import('../../../../../router/rate-limits.js')).clearRateLimits();
  mockDb.current = new Database(':memory:');
  runMigrations();
  dialed.length = 0;
  owner.cards.length = 0;
  (await import('../../../../../memory/window-starvation-card.js')).__resetStarvedWindowsForTests();   // N42: clauses card now
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t140 round 6 — the router\'s own pick, too small for the agent', () => {
  it('v3.5 N42: the smallest router model too small for the agent makes the one router window too small for every pick: an honest stop, the card, nothing dialled', async () => {
    seed(false);
    const thrown = await callStep().then(() => null, (err: unknown) => err);
    expect(thrown, 'the call step hands the honest stop to the lock').toMatchObject({ code: 'NO_MODEL_FITS' });
    expect(dialed, 'nothing was dialled at a window that cannot hold the agent').toEqual([]);
    expect(starvedCards(), 'the card is true now: at the router window the agent cannot hold a conversation').toBe(1);
  });

  it('when nothing the router can reach right now holds the agent (the roomy model is over budget): the turn ends with one notice to the owner, and no false card', async () => {
    seed(true, { tinyOnRouter: false });
    // Round 7 (re-review H2'): judged by what the OWNER is sent, not by a thrown error's text.
    // t148: the limit alone is an honest stop. The call step throws it to the platform's lock (the ask
    // re-armed, nothing handed back), and the lock tells the owner once.
    const { recoverFromError } = await import('../../../recovery.js');
    const thrown = await callStep().then(() => null, (err: unknown) => err);
    // N42: on this router (its smallest model holds the agent) the limit leaves the router no model at all.
    expect(thrown, 'the router hands the stop on: no model within the limit').toMatchObject({ code: 'NO_MODEL' });
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
    seed(true, { tinyOnRouter: false });
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
  // v3.5 N42: with the tiny model on the router the one window cannot hold the agent whatever the rate
  // limit does, so the TRUE cause is that: the owner reads the no-fit words and the card, never the Healer.
  it('v3.5 N42: the roomy model is rate-limited, but the tiny router model is the true cause: the owner is told that — no Healer, not errored', async () => {
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
    expect(said, `what the owner was shown:\n${said}`).toMatch(/router's smallest model, Tiny/);   // N42 fix round 1: the owner's words name it
    expect(said).not.toMatch(/Healer/);
    expect(starvedCards(), 'the card is true: at the router window it cannot hold one').toBe(1);
    expect((db().prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status).not.toBe('error');
    expect(dialed).toEqual([]);
  });

  // Round 7 (re-review I1') made a model's provider answering a turn's call one of the changes that re-arm a
  // summary writer on that provider that had failed. t207 (D9) reverses it: only a SUMMARY answer, a person's
  // fresh message or the Settings writer changing does. A chat answer says nothing about summaries.
  it('t207: the turn\'s call answers: a summary writer on that provider that had failed is STILL passed over', async () => {
    seed(false, { tinyOnRouter: false });
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

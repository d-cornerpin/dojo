// ════════════════════════════════════════════════════════════════════════════════════════
// t195 (D2) — THE CALL STEP READS THE ESCALATION.
//
// `state.outputTokensEscalated` was written and never read. The step now hands it to the
// model call as an ask for room, and clears it once a call comes back clean so the NEXT
// call of the turn is back at the everyday budget (extra room is for the one retry).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { stoppedAgents, preemptedAgents, stopFencedRuns, activeRuns } from '../../../../shared-state.js';
import { runCallLLM, CALL_LLM_PHASE, type CallLLMContext } from '../index.js';

const AGENT = 'test-agent';
const callModelSpy = vi.fn();
vi.mock('../../../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../model.js')>()),
  callModel: (...a: unknown[]) => callModelSpy(...(a as [])),
  getProviderCeilingTokens: () => null,
  getContextWindow: () => 200_000,
  getModelOutputCap: () => 64_000,
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => ({ prepare: () => emptyStmt }) }));
vi.mock('../../../outbound-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../outbound-ledger.js')>()),
  getRecentOutbound: () => [],
}));
vi.mock('../../../../../memory/deliveries-lane.js', () => ({ renderDeliveriesLaneMessage: () => null }));
vi.mock('../../../../../work/obligations.js', () => ({ buildOpenWorkInjection: () => null }));
vi.mock('../../../receipt.js', () => ({ writeContextReceipt: () => undefined }));
vi.mock('../../../../runtime.js', () => ({ enforceModelCapabilities: async () => ({ useTools: true }) }));
vi.mock('../../../../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 0 }));
vi.mock('../../../../../router/decide.js', () => ({
  decideTier: () => ({ tier: 'standard', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 0 }),
}));
vi.mock('../../../../../router/selector.js', () => ({
  selectModel: () => ({ modelId: 'test-model', tier: 'standard' }),
  logRouterDecision: () => undefined,
}));
vi.mock('../../../../../router/probe.js', () => ({ maybeProbe: () => undefined }));
vi.mock('../../../../../memory/assembler.js', () => ({
  assembleContext: vi.fn().mockResolvedValue({
    systemPrompt: 'you are an agent', messages: [{ role: 'user', content: 'hello' }],
    systemVolatile: '', reserveTokens: 0,
  }),
}));

function ctxFor(): CallLLMContext {
  return {
    agentId: AGENT,
    turnCtx: { agentId: AGENT, conversationId: 'conv-1' } as CallLLMContext['turnCtx'],
    turnNumber: 1, db: null as unknown as CallLLMContext['db'],
    counterparty: { kind: 'user', id: 'owner', displayName: 'Owner' } as unknown as CallLLMContext['counterparty'],
    isA2ATurn: false, isAutoRouted: false, selection: { modelId: 'test-model', routerTier: null, routerConfidence: 0, routerFreshDecision: false, excludedModels: [] },   // t212: chosen in `assemble`
    lastUserMessageContent: 'go',
    messages: [{ role: 'user', content: 'go' }] as unknown as CallLLMContext['messages'],
    systemPrompt: 'you are an agent',
    assembled: { systemEntryIds: [], messageEntryIds: [], allocation: null, freshTailDropped: 0, systemVolatile: '', reserveTokens: 0 } as unknown as CallLLMContext['assembled'],
    modelContext: {} as unknown as CallLLMContext['modelContext'],
    volatileFrom: undefined, steerAwaitingConfirm: null,
    assemblyTurnContext: { latestUserSource: null },
    revertTriggerStampOnAbort: () => undefined,
  };
}
const stateWith = (escalated: number): AgentTurnState =>
  advance(initState(AGENT, 'test-model'), { phase: CALL_LLM_PHASE, loopCount: 1, outputTokensEscalated: escalated });

const CLEAN = { content: 'done', toolCalls: [], inputTokens: 10, outputTokens: 3, stopReason: 'end_turn' };
const CUT = { content: '', toolCalls: [], inputTokens: 10, outputTokens: 32_768, stopReason: 'length' };

beforeEach(() => {
  vi.clearAllMocks();
  stoppedAgents.clear(); preemptedAgents.clear(); stopFencedRuns.clear(); activeRuns.clear();
});

describe('t195 — the step passes the escalation to the model call', () => {
  it('an escalated turn dials with an ask for that much room', async () => {
    callModelSpy.mockResolvedValue(CLEAN);
    await runCallLLM(stateWith(32_768), ctxFor());
    expect(callModelSpy.mock.calls[0][0]).toMatchObject({ outputRoomAsk: 32_768 });
  });

  it('an ordinary turn asks for nothing extra', async () => {
    callModelSpy.mockResolvedValue(CLEAN);
    await runCallLLM(stateWith(0), ctxFor());
    const p = callModelSpy.mock.calls[0][0] as { outputRoomAsk?: number };
    expect(p.outputRoomAsk ?? 0).toBe(0);
  });

  it('a clean answer spends the extra room: the next call is back at the everyday budget', async () => {
    callModelSpy.mockResolvedValue(CLEAN);
    const out = await runCallLLM(stateWith(32_768), ctxFor());
    if (out.directive !== 'proceed') throw new Error(`unexpected ${out.directive}`);
    expect(out.state.outputTokensEscalated).toBe(0);
  });

  it('a call that was cut AGAIN keeps the mark, so the ladder knows the extra room was spent', async () => {
    callModelSpy.mockResolvedValue(CUT);
    const out = await runCallLLM(stateWith(32_768), ctxFor());
    if (out.directive !== 'proceed') throw new Error(`unexpected ${out.directive}`);
    expect(out.state.outputTokensEscalated).toBe(32_768);
  });
});

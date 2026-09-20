// ════════════════════════════════════════════════════════════════════════════════════════
// T82a FIX WAVE — THE ROUTER'S PICK RE-CHECKS THE BUDGET IT WAS ASSEMBLED WITHOUT.
//
// THE CRITICAL FINDING (review round): auto-routed turns assemble under the `'__auto__'`
// sentinel — `decideTier` reads the ASSEMBLED messages to pick a model, so the model cannot
// be known before the assembly it would size. `getProviderCeilingTokens('__auto__')` is
// `null` (no such model row exists), indistinguishable from "no ceiling declared", so the
// admission-budget fix T82a's first commit landed never engaged on this path — the router
// then dials the oversized array through a model whose declared 600s/180tps patience covers
// only 51,300 tokens, unchanged.
//
// THE FIX (ruling, shape b): once `selectModel` names the REAL model, re-derive the exact
// admission budget `memory/budget.ts` already computes for it; if the array this iteration
// already built exceeds it, ask the ONE assembler (`assembleContext`) to build it again,
// against the truth. No new trimming code — this file drives the SEAM, not a second budget.
//
// R-FIXTURE (never a code constant): 600s declared patience, 180 tok/s declared prefill
// throughput -> `resolveDoomCeiling(600_000, 180) === 102_600` (T81b/T82a's own pin) -> a
// 60K-token assembly must re-assemble to <= 51,300.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { stoppedAgents, preemptedAgents } from '../../../../shared-state.js';
import {
  runCallLLM,
  CALL_LLM_PHASE,
  type CallLLMContext,
} from '../index.js';

// ── The step's outside world ──
const callModelSpy = vi.fn();
const providerCeiling = { value: null as number | null };
const contextWindowValue = { value: 200_000 };
const modelOutputCap = { value: 64_000 as number | undefined };
vi.mock('../../../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../model.js')>()),
  callModel: (...a: unknown[]) => callModelSpy(...(a as [])),
  getProviderCeilingTokens: () => providerCeiling.value,
  getContextWindow: () => contextWindowValue.value,
  getModelOutputCap: () => modelOutputCap.value,
}));

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => undefined }));
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

// The router is a DOOR: the auto-routed arms exist to prove THIS file's re-check, not to
// re-test tier selection, so the picked model is whatever the test sets it to.
const routerPick = { modelId: 'test-model' };
vi.mock('../../../../../router/decide.js', () => ({ decideTier: () => ({ tier: 'standard', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 0 }) }));
vi.mock('../../../../../router/selector.js', () => ({
  selectModel: () => ({ modelId: routerPick.modelId, tier: 'standard' }),
  logRouterDecision: () => undefined,
}));
vi.mock('../../../../../router/probe.js', () => ({ maybeProbe: () => undefined }));

// The ONE assembler this fix reuses. A spy, never a second trimmer: every assertion below is
// either "it was never called again" (the short-circuit controls) or "it was called with the
// real model and its answer is what reached the dial" (the RED-then-GREEN case).
const assembleContextSpy = vi.fn();
vi.mock('../../../../../memory/assembler.js', () => ({
  assembleContext: (...a: unknown[]) => assembleContextSpy(...(a as [])),
}));

const setAgentStatusSpy = vi.fn();
const revertTriggerStampOnAbortSpy = vi.fn();

// R-FIXTURE: a single message this large estimates (via the platform's own /4 divisor) to
// ~60,000 tokens — the incident's own number, never a code constant.
const SIXTY_K_TOKEN_BLOB = 'x'.repeat(240_000);
const TAIL_MESSAGE = { role: 'user' as const, content: '[System: a loop-appended tail entry, e.g. a technique hint]' };

function ctxFor(overrides: Partial<CallLLMContext> = {}): CallLLMContext {
  return {
    agentId: 'kevin',
    turnCtx: { agentId: 'kevin', conversationId: 'conv-1' } as CallLLMContext['turnCtx'],
    turnNumber: 7,
    db: null as unknown as CallLLMContext['db'],
    counterparty: { kind: 'user', id: 'owner', displayName: 'Owner' } as unknown as CallLLMContext['counterparty'],
    isA2ATurn: false,
    isAutoRouted: false,
    configuredModelId: 'test-model',
    lastUserMessageContent: 'hello',
    messages: [{ role: 'user', content: 'hello' }] as unknown as CallLLMContext['messages'],
    systemPrompt: 'you are kevin',
    assembled: {
      systemEntryIds: [], messageEntryIds: [], allocation: null, freshTailDropped: 0,
      systemVolatile: '', reserveTokens: 0,
    } as unknown as CallLLMContext['assembled'],
    modelContext: {} as unknown as CallLLMContext['modelContext'],
    volatileFrom: undefined,
    steerAwaitingConfirm: null,
    assemblyTurnContext: { latestUserSource: null },
    revertTriggerStampOnAbort: revertTriggerStampOnAbortSpy,
    setAgentStatus: setAgentStatusSpy,
    ...overrides,
  };
}

function freshState(): AgentTurnState {
  return advance(initState('kevin', 'test-model'), { phase: CALL_LLM_PHASE, loopCount: 1 });
}

const OK_RESULT = {
  content: 'here you go', toolCalls: [], inputTokens: 10, outputTokens: 3, stopReason: 'end_turn',
};

beforeEach(() => {
  vi.clearAllMocks();
  stoppedAgents.clear();
  preemptedAgents.clear();
  callModelSpy.mockResolvedValue(OK_RESULT);
  providerCeiling.value = null;
  contextWindowValue.value = 200_000;
  modelOutputCap.value = 64_000;
  routerPick.modelId = 'test-model';
});

describe('T82a fix wave — the router\'s pick re-checks the budget it was assembled without', () => {
  it('RED: an auto-routed turn on a declared 600s/180tps model re-assembles a 60K array to <= 51,300 tokens, and the dial carries the trimmed array', async () => {
    routerPick.modelId = 'slow-box-model';
    providerCeiling.value = 102_600; // resolveDoomCeiling(600_000, 180) — the fixture's own pin
    assembleContextSpy.mockResolvedValue({
      systemPrompt: 'you are kevin (re-assembled, trimmed)',
      messages: [{ role: 'user', content: 'trimmed to fit' }],
      systemVolatile: '', reserveTokens: 0,
    });

    await runCallLLM(freshState(), ctxFor({
      isAutoRouted: true,
      messages: [{ role: 'user', content: SIXTY_K_TOKEN_BLOB }, TAIL_MESSAGE] as unknown as CallLLMContext['messages'],
      systemPrompt: 'you are kevin',
      volatileFrom: 1, // TAIL_MESSAGE is the loop-appended tail; the blob is the whole prefix
    }));

    // The ONE assembler was asked, once, for the REAL model — not a second trimmer.
    expect(assembleContextSpy).toHaveBeenCalledTimes(1);
    expect(assembleContextSpy).toHaveBeenCalledWith('kevin', 'slow-box-model', { latestUserSource: null });

    // The dial carries the re-assembled, trimmed array — the giant blob never reaches it.
    expect(callModelSpy).toHaveBeenCalledTimes(1);
    const dialed = callModelSpy.mock.calls[0][0] as { messages: Array<{ content: unknown }>; systemPrompt: string };
    expect(dialed.systemPrompt).toBe('you are kevin (re-assembled, trimmed)');
    const dialedContents = dialed.messages.map((m) => m.content);
    expect(dialedContents).not.toContain(SIXTY_K_TOKEN_BLOB);
    expect(dialedContents).toContain('trimmed to fit');
    // The loop's own tail injection survives the re-assembly verbatim — it is spliced
    // back on, never re-derived (re-deriving it would double-fire its side effects).
    expect(dialedContents).toContain(TAIL_MESSAGE.content);
  });

  it('CONTROL (short-circuit): a NULL-ceiling auto-pick (the cloud/fast case) never re-assembles, at any size', async () => {
    routerPick.modelId = 'cloud-fast-model';
    providerCeiling.value = null;

    await runCallLLM(freshState(), ctxFor({
      isAutoRouted: true,
      messages: [{ role: 'user', content: SIXTY_K_TOKEN_BLOB }] as unknown as CallLLMContext['messages'],
      volatileFrom: 1,
    }));

    expect(assembleContextSpy).not.toHaveBeenCalled();
    expect(callModelSpy).toHaveBeenCalledTimes(1);
    const dialed = callModelSpy.mock.calls[0][0] as { messages: Array<{ content: unknown }> };
    expect(dialed.messages.map((m) => m.content)).toContain(SIXTY_K_TOKEN_BLOB);
  });

  it('CONTROL (pinned path, byte-unchanged): a declared ceiling that the assembly already fits never re-assembles', async () => {
    // The pinned path was already APPROVED: `assemble` ran against the REAL model from the
    // start, so its budget was already provider-aware and the array already fits. This proves
    // the re-check is a true no-op there, not merely one this suite forgot to exercise.
    providerCeiling.value = 102_600;

    const out = await runCallLLM(freshState(), ctxFor({
      isAutoRouted: false,
      configuredModelId: 'pinned-model',
      messages: [{ role: 'user', content: 'hi' }] as unknown as CallLLMContext['messages'],
      volatileFrom: 1,
    }));

    expect(out.directive).toBe('proceed');
    expect(assembleContextSpy).not.toHaveBeenCalled();
    expect(callModelSpy).toHaveBeenCalledTimes(1);
    // "Byte-unchanged" means the ORIGINAL row survives untouched, not that nothing else
    // was ever appended — `injectAndRecord`'s own tail injections (e.g. `msg.current-time`)
    // fire on every call regardless of this fix and are out of its scope.
    const dialed = callModelSpy.mock.calls[0][0] as { messages: Array<{ content: unknown }> };
    expect(dialed.messages[0].content).toBe('hi');
  });

  it('CONTROL (NULL rows unchanged): a pinned agent on a provider that declared nothing is untouched', async () => {
    providerCeiling.value = null;

    await runCallLLM(freshState(), ctxFor({
      isAutoRouted: false,
      configuredModelId: 'pinned-model',
      messages: [{ role: 'user', content: 'hi' }] as unknown as CallLLMContext['messages'],
      volatileFrom: 1,
    }));

    expect(assembleContextSpy).not.toHaveBeenCalled();
    const dialed = callModelSpy.mock.calls[0][0] as { messages: Array<{ content: unknown }> };
    expect(dialed.messages[0].content).toBe('hi');
  });
});

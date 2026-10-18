// t207 (owner decision 34) — SETTING OLD MESSAGES ASIDE IS ROUTINE AND SAYS NOTHING TO THE OWNER.
//
// When the assembly fits the window by setting the oldest live messages aside, nothing is lost: the
// rows are saved and folded into a summary. The assemble step used to broadcast a warning toast
// ("Agent's memory is full, so it set aside its N oldest recent messages") for it, the same family as
// the "memory is getting full" warning that was already removed. It now broadcasts nothing; the
// operator-facing log line stays.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runAssemble, ASSEMBLE_PHASE, type AssembleContext } from '../index.js';

const assembleContextSpy = vi.fn();
vi.mock('../../../../../memory/assembler.js', () => ({
  assembleContext: (...a: unknown[]) => assembleContextSpy(...(a as [])),
}));
vi.mock('../../../../runtime.js', () => ({
  clearConsumedOneShotFlags: () => undefined,
  injectAttachmentBlocks: () => [],
}));
const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));
const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeDb = { prepare: () => emptyStmt } as unknown as AssembleContext['db'];
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));
vi.mock('../../../../../techniques/store.js', () => ({
  listTechniques: () => [], getTechniqueDetail: () => null, recordTechniqueUsage: () => undefined,
}));
vi.mock('../../../../../memory/embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../memory/embeddings.js')>()),
  semanticTechniqueMatches: async () => [],
}));
vi.mock('../../../../../prompt/registry/assembler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../prompt/registry/assembler.js')>()),
  injectRegistryMessage: (id: string, messages: unknown[]) => {
    (messages as Array<Record<string, unknown>>).push({ role: 'user', content: `<${id}>` });
    return true;
  },
}));

function turnCtxFor(): AssembleContext['turnCtx'] {
  return {
    agentId: 'zargo', conversationId: 'conv-1', lastAssembledAtIso: null, 
    freshTailDropWarned: false, startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
    startAckSteersInjected: 0, startAckSteerInjectedAtLoop: 0, inboundClassifiedAsWork: false,
  } as unknown as AssembleContext['turnCtx'];
}
function ctxFor(): AssembleContext {
  return {
    agentId: 'zargo', turnCtx: turnCtxFor(), turnNumber: 7, db: fakeDb, contextModelId: 'test-model',
    contextWindow: 200000,
    counterparty: { kind: 'user', id: 'owner', displayName: 'Owner' } as unknown as AssembleContext['counterparty'],
    counterpartyIsAgentSender: false, chosenConvKey: 'ck-1', hasUnansweredUser: true, isA2ATurn: false,
    isEngineTurn: false, isNotificationTurn: false, lastUserMessageContent: 'hello', latestTtsEngine: null,
    latestUserSource: 'dashboard', mostRecentIsA2A: false, pendingEngineEvent: null, waitingConvs: [],
    engineStartAckDeliveredThisTurn: false, startAckRepliedNow: () => false,
  };
}
const state = (): AgentTurnState => advance(initState('zargo', 'test-model'), { phase: ASSEMBLE_PHASE, loopCount: 2 });

beforeEach(() => {
  vi.clearAllMocks();
  assembleContextSpy.mockResolvedValue({
    systemPrompt: 'you are zargo', messages: [{ role: 'user', content: 'hello' }], consumedOneShotFlags: [],
    freshTailDropped: 5, reserveTokens: 100, systemEntryIds: [], messageEntryIds: [], allocation: null,
  });
});

describe('t207 dec 34 — no toast for setting the oldest messages aside', () => {
  it('an assembly that set 5 messages aside broadcasts no chat:error at all', async () => {
    await runAssemble(state(), ctxFor());
    const toasts = broadcastSpy.mock.calls.map((c) => c[0] as { type?: string; code?: string })
      .filter((e) => e.type === 'chat:error' || e.code === 'CONTEXT_HIGH');
    expect(toasts).toEqual([]);
  });
});

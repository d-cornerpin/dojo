// ════════════════════════════════════════════════════════════════════════════════════════
// THE OPEN WORK BLOCK REACHES THE MODEL — PHASE-6 T13.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
// `promise-survives-the-turn` failed its `inFrontOfModel` clause on the kit sitting's run:
// the commitment was recorded, was still owed after turn 2, and turn 2's model calls
// carried its id ONLY as the turn-1 `tool_result` echo. The kit deliberately left that red
// unacknowledged and handed it here as a real engine signal about the OPEN WORK injection.
//
// The engine-side coverage gap is exact and it is why nothing caught this: the RENDERER has
// clauses (`work/__tests__/commitment-lifecycle.test.ts` walks the block property by
// property), and the step's own contract test MOCKS `buildOpenWorkInjection` to return
// `null`. Between the two, NOTHING asserted that a rendered block actually reaches the
// array the provider is handed.
//
// ── THE STRUCTURAL DEFECT THESE CLAUSES PIN ─────────────────────────────────────────────
// The OPEN WORK injection sits INSIDE the same `try` as two best-effort renderers above it
// — the RC-12 recent-outbound facts and the deliveries lane — under one `catch` that logs
// at DEBUG and swallows. So a throw in either neighbour silently takes "what you still owe"
// off the model's desk, and the only trace is a debug line nobody reads.
//
// That is not equivalence of concerns: recent-outbound and the deliveries quote are
// enrichments, while OPEN WORK is the mechanism a promise survives a turn BY. Whether that
// swallow is what fired on the scenario's attempt 3 is NOT established here and is not
// claimed — the catch logged at debug, so no record exists either way (#15: the absence is
// a question). What IS established is that the injection had no independent failure path,
// which is a defect on its own terms and is what these clauses close.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { injectAndRecord, type PreCallInjectionInputs } from '../pre-call-injections.js';

const OPEN_WORK = 'OPEN WORK (still owed; close each one when it is delivered):\n1. [cmt:abc123] you promised: send the summary (Owner, just now)';

// ── The step's outside world. Every mock stands in for a door the span already went
// through; only the two the clauses move are ever changed.
const recentOutboundImpl = vi.fn(() => [] as unknown[]);
const deliveriesImpl = vi.fn(() => null as string | null);
const openWorkImpl = vi.fn(() => OPEN_WORK as string | null);

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => undefined }));
const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => ({ prepare: () => emptyStmt }) }));
vi.mock('../../../outbound-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../outbound-ledger.js')>()),
  getRecentOutbound: (...a: unknown[]) => recentOutboundImpl(...(a as [])),
}));
vi.mock('../../../../../memory/deliveries-lane.js', () => ({
  renderDeliveriesLaneMessage: (...a: unknown[]) => deliveriesImpl(...(a as [])),
}));
vi.mock('../../../../../work/obligations.js', () => ({
  buildOpenWorkInjection: (...a: unknown[]) => openWorkImpl(...(a as [])),
}));
vi.mock('../../../receipt.js', () => ({ writeContextReceipt: () => undefined }));
vi.mock('../../../../runtime.js', () => ({ enforceModelCapabilities: async () => ({ useTools: true }) }));
// The registry's own injections are a separate door; this file is about ONE of them.
vi.mock('../../../../../prompt/registry/assembler.js', () => ({ injectRegistryMessage: () => false }));

type Msg = { role: 'user' | 'assistant'; content: string };

function inputsFor(messages: Msg[]): PreCallInjectionInputs {
  return {
    agentId: 'kevin',
    turnNumber: 2,
    modelId: 'test-model',
    messages: messages as unknown as PreCallInjectionInputs['messages'],
    systemPrompt: 'you are kevin',
    ctx: {} as PreCallInjectionInputs['ctx'],
    mctx: {} as PreCallInjectionInputs['mctx'],
    volatileFrom: 1,
    counterparty: { kind: 'user', id: 'owner', name: 'Owner', senderId: 'owner' } as unknown as PreCallInjectionInputs['counterparty'],
    steerAwaitingConfirm: null,
    turnCtx: { agentId: 'kevin', conversationId: 'conv-1', root: { conversationId: 'conv-1' } } as unknown as PreCallInjectionInputs['turnCtx'],
    db: null as unknown as PreCallInjectionInputs['db'],
  };
}

const freshState = (): AgentTurnState => advance(initState('kevin', 'test-model'), { loopCount: 1 });

/** The injected texts, in array order. */
const texts = (messages: Msg[]): string[] => messages.map((m) => String(m.content));

describe('the OPEN WORK block reaches the array the provider is handed', () => {
  beforeEach(() => {
    recentOutboundImpl.mockReset().mockReturnValue([]);
    deliveriesImpl.mockReset().mockReturnValue(null);
    openWorkImpl.mockReset().mockReturnValue(OPEN_WORK);
  });

  it('BASELINE: a rendered block is injected, naming the promise the model still owes', async () => {
    const messages: Msg[] = [{ role: 'user', content: 'hello' }];
    await injectAndRecord(freshState(), inputsFor(messages));
    expect(texts(messages).some((t) => t.includes('[cmt:abc123] you promised:'))).toBe(true);
  });

  it('THE DEFECT: a throw in the RECENT OUTBOUND renderer must not take the promise with it', async () => {
    recentOutboundImpl.mockImplementation(() => { throw new Error('outbound ledger unavailable'); });
    const messages: Msg[] = [{ role: 'user', content: 'hello' }];
    await injectAndRecord(freshState(), inputsFor(messages));
    expect(openWorkImpl).toHaveBeenCalled();
    expect(texts(messages).some((t) => t.includes('[cmt:abc123] you promised:'))).toBe(true);
  });

  it('THE DEFECT: a throw in the DELIVERIES lane renderer must not take the promise with it', async () => {
    deliveriesImpl.mockImplementation(() => { throw new Error('deliveries render failed'); });
    const messages: Msg[] = [{ role: 'user', content: 'hello' }];
    await injectAndRecord(freshState(), inputsFor(messages));
    expect(openWorkImpl).toHaveBeenCalled();
    expect(texts(messages).some((t) => t.includes('[cmt:abc123] you promised:'))).toBe(true);
  });

  it('and when the OPEN WORK render ITSELF throws, the turn survives it — loudly, never silently', async () => {
    openWorkImpl.mockImplementation(() => { throw new Error('spine read failed'); });
    const messages: Msg[] = [{ role: 'user', content: 'hello' }];
    await expect(injectAndRecord(freshState(), inputsFor(messages))).resolves.toBeTruthy();
    expect(texts(messages).some((t) => t.includes('you promised:'))).toBe(false);
  });

  it('NEGATIVE CONTROL: nothing owed injects nothing — this does not fire on an empty spine', async () => {
    openWorkImpl.mockReturnValue(null);
    const messages: Msg[] = [{ role: 'user', content: 'hello' }];
    await injectAndRecord(freshState(), inputsFor(messages));
    expect(texts(messages).some((t) => t.includes('OPEN WORK'))).toBe(false);
  });

  it('NEGATIVE CONTROL: an agent-to-agent turn is not a person waiting on a promise', async () => {
    const messages: Msg[] = [{ role: 'user', content: 'hello' }];
    const input = { ...inputsFor(messages), counterparty: { kind: 'agent', id: 'peer' } as unknown as PreCallInjectionInputs['counterparty'] };
    await injectAndRecord(freshState(), input);
    expect(openWorkImpl).not.toHaveBeenCalled();
  });
});

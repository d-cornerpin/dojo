// ════════════════════════════════════════
// PHASE-6 T4 — THE `assemble` STEP'S CONTRACT (one contract test per STEP,
// RULING P6-R1). CUT 6 in the ordinal order (RULING P6-R3(3)), and the cut whose
// close is T12's SECOND ORDINAL CHECKPOINT.
//
// The shared shape, unchanged from CUT 1–5 and reusing `steps/step-outcome.ts`:
//
//   INPUTS      `(state, ctx)` — the turn's state, and everything else the span
//               read from the driver. Measured, not guessed: after this tranche's
//               three carrier commits, 22 declarations of `runV2TurnBody` cross
//               into the span and THREE are mutable — `state`, which the contract
//               carries, and `engineStartAckDeliveredThisTurn` / `latestTtsEngine`,
//               which ride by value on positive evidence (one and two write sites,
//               all straight-line, none in a timer or a callback).
//   OUTPUT      a step outcome — the advanced state, ONE directive, and (on the
//               proceed arm ONLY) the SIX values the span declares and the rest of
//               the turn reads.
//   TRANSITION  the driver advances `phase` INTO the step; the step never writes it.
//   EXIT        the exit-request channel: the step ASKS by returning.
//
// ── WHAT IS THIS STEP'S ALONE, AND IT IS TWO THINGS ──
//
// 1. IT DECLARES THE MOST OUTPUTS OF ANY TRANCHE — six against CUT 5's two, and
//    they are the whole of what the model call consumes: the assembled context,
//    its message array, its system prompt, the volatile boundary, the injection
//    context and the steer awaiting confirmation. `callLLM`'s own context comment
//    already said so before this cut existed ("five of its inputs … are produced
//    by `assemble`, inside this same iteration"), so the outputs are not a new
//    surface — they are the seam that was already written down.
//
// 2. IT IS THE CACHE-PREFIX LAW'S OWN SPAN (OR7 / roadmap non-negotiable #10).
//    `volatileFrom` is recorded HERE, at the instant the allocator's work ends and
//    before the loop appends anything, and every engine injection in this span
//    lands at or after that index. A pure reorder with byte-identical content is
//    INVISIBLE to the release-gate prefix check, which reads only system prompt and
//    tools — so the property gets a clause of its own rather than resting on the
//    golden gates alone.
// ════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { emptySteerQueue, enqueueSteer } from '../../../steer-queue.js';
import {
  runAssemble,
  ASSEMBLE_PHASE,
  type AssembleContext,
} from '../index.js';

// ── The step's outside world ──
// Each mock stands in for a DOOR the span already went through; none of them
// changes a decision.
const assembleContextSpy = vi.fn();
vi.mock('../../../../../memory/assembler.js', () => ({
  assembleContext: (...a: unknown[]) => assembleContextSpy(...(a as [])),
}));
const clearConsumedOneShotFlagsSpy = vi.fn();
const injectAttachmentBlocksSpy = vi.fn(() => []);
vi.mock('../../../../runtime.js', () => ({
  clearConsumedOneShotFlags: (...a: unknown[]) => clearConsumedOneShotFlagsSpy(...(a as [])),
  injectAttachmentBlocks: (...a: unknown[]) => injectAttachmentBlocksSpy(...(a as [])),
}));
const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));
// A unit test must not open the dev database. Every DB reader in this span is a
// door it already went through inside the loop; the stub keeps them honest by
// answering nothing.
const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeDb = { prepare: () => emptyStmt } as unknown as AssembleContext['db'];
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));
vi.mock('../../../../../techniques/store.js', () => ({
  listTechniques: () => [],
  getTechniqueDetail: () => null,
  recordTechniqueUsage: () => undefined,
}));
vi.mock('../../../../../memory/embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../memory/embeddings.js')>()),
  semanticTechniqueMatches: async () => [],
}));
// The registry is a DOOR: whether a given entry renders is the registry's business,
// not this step's. The spy records WHAT was asked for and in WHICH order, which is
// the only thing the contract is about.
const injectRegistryMessageSpy = vi.fn((id: string, messages: unknown[]) => {
  (messages as Array<Record<string, unknown>>).push({ role: 'user', content: `<${id}>` });
  return true;
});
vi.mock('../../../../../prompt/registry/assembler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../prompt/registry/assembler.js')>()),
  injectRegistryMessage: (...a: unknown[]) => injectRegistryMessageSpy(...(a as [string, unknown[]])),
}));

const setAgentStatusSpy = vi.fn();
const startAckRepliedNowSpy = vi.fn(() => false);

function turnCtxFor(): AssembleContext['turnCtx'] {
  return {
    agentId: 'kevin',
    conversationId: 'conv-1',
    lastAssembledAtIso: null,
    assemblerOverheadTokens: 0,
    freshTailDropWarned: false,
    startAckSteerRequested: false,
    startAckSteerArmedThisTurn: false,
    startAckSteersInjected: 0,
    startAckSteerInjectedAtLoop: 0,
    inboundClassifiedAsWork: false,
  } as unknown as AssembleContext['turnCtx'];
}

function ctxFor(overrides: Partial<AssembleContext> = {}): AssembleContext {
  return {
    agentId: 'kevin',
    turnCtx: turnCtxFor(),
    turnNumber: 7,
    db: fakeDb,
    contextModelId: 'test-model',
    contextWindow: 200000,
    counterparty: { kind: 'user', id: 'owner', displayName: 'Owner' } as unknown as AssembleContext['counterparty'],
    counterpartyIsAgentSender: false,
    chosenConvKey: 'ck-1',
    hasUnansweredUser: true,
    isA2ATurn: false,
    isEngineTurn: false,
    isNotificationTurn: false,
    lastUserMessageContent: 'hello',
    latestTtsEngine: null,
    latestUserSource: 'dashboard',
    mostRecentIsA2A: false,
    pendingEngineEvent: null,
    waitingConvs: [],
    engineStartAckDeliveredThisTurn: false,
    startAckRepliedNow: startAckRepliedNowSpy,
    setAgentStatus: setAgentStatusSpy,
    ...overrides,
  };
}

/** Loop 2 by default: the three first-iteration blocks (technique matcher,
 *  context-gap, multistep) are gated on `loopCount === 1`, and a clause that wants
 *  them says so. */
function freshState(loopCount = 2): AgentTurnState {
  return advance(initState('kevin', 'test-model'), { phase: ASSEMBLE_PHASE, loopCount });
}

const ASSEMBLED = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  systemPrompt: 'you are kevin',
  messages: [{ role: 'user', content: 'hello' }],
  consumedOneShotFlags: [],
  freshTailDropped: 0,
  reserveTokens: 100,
  systemEntryIds: [],
  messageEntryIds: [],
  allocation: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  startAckRepliedNowSpy.mockReturnValue(false);
  injectRegistryMessageSpy.mockImplementation((id: string, messages: unknown[]) => {
    (messages as Array<Record<string, unknown>>).push({ role: 'user', content: `<${id}>` });
    return true;
  });
  assembleContextSpy.mockResolvedValue(ASSEMBLED());
});

// ── The step package's own source, for the clauses that are about SHAPE ──
const STEP_DIR = path.resolve(__dirname, '..');
function stepFiles(dir: string = STEP_DIR): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...stepFiles(path.join(dir, e.name))); }
    else if (e.name.endsWith('.ts')) out.push(path.join(dir, e.name));
  }
  return out;
}
const stepText = (): string => stepFiles().map((f) => readFileSync(f, 'utf8')).join('\n');

describe('PHASE-6 CUT 6: the `assemble` step\'s contract', () => {
  it('INPUTS (state, ctx) → ONE outcome, and the SIX values the span declares come back as OUTPUTS', async () => {
    const out = await runAssemble(freshState(), ctxFor());

    expect(out.directive).toBe('proceed');
    if (out.directive !== 'proceed') throw new Error('unreachable');
    // The six the rest of the turn reads. `callLLM`'s own context named five of them
    // as "produced by assemble, inside this same iteration" before this cut existed.
    expect(out.assembled).toBeDefined();
    expect(out.messages).toBe(out.assembled.messages);   // the array, not a copy: the injections appended to it
    expect(out.systemPrompt).toBe('you are kevin');
    expect(typeof out.volatileFrom).toBe('number');
    expect(out.modelContext).toBeDefined();
    expect(out.steerAwaitingConfirm).toBeNull();          // nothing queued on this turn
    // The state came back advanced — the driver assigns it before honouring anything.
    expect(out.state).toBeDefined();
  });

  it('THE STEP NEVER WRITES `phase` — on the proceed arm, on the exit arm, and nowhere in its source', async () => {
    const proceed = await runAssemble(freshState(), ctxFor());
    expect(proceed.state.phase).toBe(ASSEMBLE_PHASE);

    assembleContextSpy.mockResolvedValue(ASSEMBLED({ messages: [] }));
    const exited = await runAssemble(freshState(), ctxFor());
    expect(exited.directive).toBe('exit');
    expect(exited.state.phase).toBe(ASSEMBLE_PHASE);

    // And no `phase:` write exists in the package's own source at all.
    expect(stepText()).not.toMatch(/phase\s*:/);
  });

  it('THE DRIVER ADVANCES INTO IT, at the call site and ahead of the step', () => {
    // `validate()` runs on the transition by construction, because the advance is an
    // `advance` and it is the DRIVER's statement, not the step's.
    const driver = readFileSync(path.resolve(__dirname, '../../../loop.ts'), 'utf8');
    const advanceAt = driver.indexOf("advance(turnCtx.state!, { phase: 'assemble' })");
    const callAt = driver.indexOf('runAssemble(turnCtx.state!,');
    expect(advanceAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(-1);
    expect(advanceAt).toBeLessThan(callAt);
  });

  it('THE EXIT-REQUEST CHANNEL, as a CENSUS WITH A DENOMINATOR: two directives, ONE exit site', () => {
    // A new silent way out of this step cannot appear without failing here. The walk
    // is over the package's own AST, so a directive smuggled in as a string literal in
    // a comment does not count and a real call does.
    const directives = new Set<string>();
    let exitSites = 0;
    for (const f of stepFiles()) {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.ESNext, true);
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          const name = n.expression.text;
          if (name === 'proceed') directives.add('proceed');
          if (name === 'continueLoop') directives.add('continue');
          if (name === 'requestExit') { directives.add('exit'); exitSites += 1; }
          if (name === 'abandonTurn') directives.add('abandon');
        }
        ts.forEachChild(n, walk);
      };
      walk(sf);
    }
    expect([...directives].sort()).toEqual(['exit', 'proceed']);
    // ONE: the empty-assembled-context clean exit, preserved from v1
    // (`runtime.ts:1014-1020`). It is this span's only loop exit and always was.
    expect(exitSites).toBe(1);
  });

  it('A STEP THAT ASKS TO EXIT STOPS — and the exit carries a reason, by construction', async () => {
    assembleContextSpy.mockResolvedValue(ASSEMBLED({ messages: [] }));

    const out = await runAssemble(freshState(), ctxFor());

    expect(out.directive).toBe('exit');
    if (out.directive !== 'exit') throw new Error('unreachable');
    expect(out.reason).toBeTruthy();
    // The turn is put down where it stood, exactly as the driver's `break` arm did.
    expect(setAgentStatusSpy).toHaveBeenCalledWith('kevin', 'idle');
    // And the outputs are UNREACHABLE on this arm — the caller cannot accidentally
    // hand a zero-message context to a provider, because the type does not carry it.
    expect('messages' in out).toBe(false);
    expect('assembled' in out).toBe(false);
  });

  it('OR7: the VOLATILE BOUNDARY is recorded before a single engine injection, and everything appended lands past it', async () => {
    // The cache-prefix law in this span's own words: everything the ALLOCATOR
    // produced is the cacheable region; everything the LOOP appends is the tail.
    // Two assembler messages in, so the boundary is a number a mistake could get
    // wrong rather than 0 or 1.
    assembleContextSpy.mockResolvedValue(ASSEMBLED({
      messages: [{ role: 'user', content: 'older' }, { role: 'assistant', content: 'reply' }],
    }));
    // Something to append: a queued steer rides the tail on this iteration.
    const state = advance(freshState(), {
      steerQueue: enqueueSteer(emptySteerQueue(), { floor: 'start-ack', content: 'say something', atLoop: 1 }),
    });

    const out = await runAssemble(state, ctxFor());
    if (out.directive !== 'proceed') throw new Error('the step did not proceed');

    expect(out.volatileFrom).toBe(2);
    expect(out.messages.length).toBeGreaterThan(2);       // the loop really did append
    // Nothing the loop appended sits AHEAD of the boundary: the two the assembler
    // produced are still exactly the first two, in order.
    expect(out.messages[0]).toMatchObject({ content: 'older' });
    expect(out.messages[1]).toMatchObject({ content: 'reply' });
    expect(injectRegistryMessageSpy).toHaveBeenCalled();
  });

  it('S3: the one-shot markers the assembly reported consuming are cleared by the TURN, once per assembly', async () => {
    assembleContextSpy.mockResolvedValue(ASSEMBLED({ consumedOneShotFlags: ['a2aPreempt'] }));

    await runAssemble(freshState(), ctxFor());

    expect(clearConsumedOneShotFlagsSpy).toHaveBeenCalledTimes(1);
    expect(clearConsumedOneShotFlagsSpy).toHaveBeenCalledWith('kevin', ['a2aPreempt']);
  });

  it('FA-M1: the overhead and the eviction latch are written to the TURN\'S BAG, not to the step', async () => {
    // Both are read outside this step — the overhead by the NEXT iteration's pre-call
    // gate, the latch by this step on a later round. A step that kept them would hand
    // the gate iteration one's picture forever, and would re-warn every round.
    const ctx = ctxFor();
    assembleContextSpy.mockResolvedValue(ASSEMBLED({ freshTailDropped: 4 }));

    await runAssemble(freshState(), ctx);

    expect(ctx.turnCtx.assemblerOverheadTokens).toBeGreaterThan(0);
    expect(ctx.turnCtx.freshTailDropWarned).toBe(true);
    expect(ctx.turnCtx.lastAssembledAtIso).toBeTruthy();
    // Second round, same bag: the banner does NOT fire again.
    broadcastSpy.mockClear();
    await runAssemble(freshState(3), ctx);
    const banners = broadcastSpy.mock.calls
      .map((c) => c[0] as { code?: string })
      .filter((e) => e.code === 'CONTEXT_HIGH');
    expect(banners).toHaveLength(0);
  });

  it('F10: the start-ack checkpoint ARMS a requested steer loop-synchronously, and records which loop it rode', async () => {
    const ctx = ctxFor();
    ctx.turnCtx.startAckSteerRequested = true;

    const out = await runAssemble(freshState(4), ctx);
    if (out.directive !== 'proceed') throw new Error('the step did not proceed');

    expect(ctx.turnCtx.startAckSteerArmedThisTurn).toBe(true);
    expect(ctx.turnCtx.startAckSteersInjected).toBe(1);
    expect(ctx.turnCtx.startAckSteerInjectedAtLoop).toBe(4);
    expect(out.state.steerQueue.fired.some((e) => e.floor === 'start-ack')).toBe(true);
  });

  it('F10: a reply that landed in flight quietly DISARMS the request — the model is not told to say hello twice', async () => {
    // The checkpoint re-checks `startAckRepliedNow()` at the safe boundary; the
    // clause a tree that armed unconditionally fails.
    const ctx = ctxFor();
    ctx.turnCtx.startAckSteerRequested = true;
    startAckRepliedNowSpy.mockReturnValue(true);

    const out = await runAssemble(freshState(4), ctx);
    if (out.directive !== 'proceed') throw new Error('the step did not proceed');

    expect(ctx.turnCtx.startAckSteerArmedThisTurn).toBe(false);
    expect(ctx.turnCtx.startAckSteersInjected).toBe(0);
    expect(out.state.steerQueue.fired.some((e) => e.floor === 'start-ack')).toBe(false);
  });

  it('the steer drain is ONE entry per iteration, and a refused push COUNTS the attempt instead of losing it', async () => {
    // PHASE-4 T3: highest declared precedence first, the rest wait rather than being
    // overwritten; PUSHED is not DELIVERED, so the entry leaves the queue at the receipt.
    const twoQueued = advance(freshState(), {
      steerQueue: enqueueSteer(
        enqueueSteer(emptySteerQueue(), { floor: 'start-ack', content: 'first', atLoop: 1 }),
        { floor: 'promise-floor', content: 'second', atLoop: 1 },
      ),
    });

    const delivered = await runAssemble(twoQueued, ctxFor());
    if (delivered.directive !== 'proceed') throw new Error('the step did not proceed');
    expect(delivered.steerAwaitingConfirm).not.toBeNull();
    // Exactly one nudge entry was asked for, not two.
    const nudges = injectRegistryMessageSpy.mock.calls.filter((c) => c[0] === 'msg.pending-nudge');
    expect(nudges).toHaveLength(1);

    // The dedup net refuses the push: the entry stays queued with its attempt counted.
    injectRegistryMessageSpy.mockImplementation((id: string, messages: unknown[]) => {
      if (id === 'msg.pending-nudge') return false;
      (messages as Array<Record<string, unknown>>).push({ role: 'user', content: `<${id}>` });
      return true;
    });
    const refused = await runAssemble(twoQueued, ctxFor());
    if (refused.directive !== 'proceed') throw new Error('the step did not proceed');
    expect(refused.steerAwaitingConfirm).toBeNull();
    expect(refused.state.steerQueue.pending).toHaveLength(2);      // not lost
    expect(refused.state.steerQueue.pending.some((e) => e.attempts > 0)).toBe(true);
  });
});

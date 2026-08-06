// ════════════════════════════════════════
// PHASE-6 T9 (CUT 4) — THE `finalize` STEP'S CONTRACT
//
// One contract test per STEP (RULING P6-R1), reusing `steps/step-outcome.ts`
// unchanged for the THIRD time — CUT 1's amortisation, arriving again.
//
// Beyond the shared shape this file holds the two things that are this step's alone:
//
//   1. IT CAN NEVER ASK TO EXIT. `finalize` is the last statement of the turn's main
//      `try`. There is no iteration left to continue and no loop left to break, so
//      every path returns `proceed` — including the paths whose own work threw, since
//      each block carries its own best-effort `catch` and a turn that has produced its
//      answer must still reach its teardown.
//
//   2. EVERY `break` PATH STAMPS — as a CENSUS WITH A DENOMINATOR, not a list of arms.
//      The tranche note asks to "assert every `break` path stamps". The honest form of
//      that is structural: every `break` in the driver's `while` body is lexically
//      inside the `try` whose LAST statement is this step, so the language guarantees
//      the turn reaches the stamping however it stopped. The clause counts them, and
//      it counts the exits that genuinely DO bypass finalize — the two mid-call
//      `return`s (stopped, preempted) — pinning them at exactly two so a third cannot
//      appear silently. That number is the interesting half: it is the only way a turn
//      can end without its finalize block running, and it is deliberate (both write
//      `idle` themselves and both still run the `finally` that finalizes the record).
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { engineText } from '../../../__tests__/engine-sources.js';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

const { runFinalize, FINALIZE_PHASE } = await import('../index.js');
const { initState, advance } = await import('../../../state.js');
const { openTurnContext, endTurnContext } = await import('../../../../turn-context.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.resolve(HERE, '..', '..', '..', 'loop.ts');

const AGENT = 'kevin';

function ctxFor(overrides: Record<string, unknown> = {}): Parameters<typeof runFinalize>[1] {
  const turnCtx = openTurnContext(AGENT);
  turnCtx.turnNumber = 7;
  return {
    agentId: AGENT,
    turnCtx,
    turnNumber: 7,
    db: mockDb.current!,
    counterparty: { kind: 'user', relation: 'owner', name: 'Owner', channel: 'dashboard', senderId: null } as never,
    counterpartyIsAgentSender: false,
    chosenConvKey: null,
    turnStartedAt: new Date().toISOString(),
    settledContextWakeTurn: false,
    isA2ATurn: false,
    isEngineTurn: false,
    broadcast: () => {},
    noteTerminalAnswer: () => {},
    persistRoutingMarker: () => {},
    stopStatusHeartbeat: () => {},
    setAgentStatus: () => {},
    ...overrides,
  } as Parameters<typeof runFinalize>[1];
}

/** The state the driver hands in: already advanced INTO the finalize phase. */
function freshState(): ReturnType<typeof initState> {
  return advance(initState({
    agentId: AGENT,
    contextWindow: 200000,
    isAutoRouted: false,
    configuredModelId: 'm',
    turnNumber: 7,
    triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    lastUserMessageContent: null,
    lastUserMessageId: null,
    inboundChannel: 'dashboard',
    inboundContext: null,
    pendingTechniqueAck: null,
  }), { phase: FINALIZE_PHASE });
}

beforeEach(() => {
  endTurnContext(AGENT);
  mockDb.current?.close();
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT, recovery_attempts INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, agent_id TEXT, role TEXT, content TEXT,
      turn_number INTEGER, created_at INTEGER, lane TEXT, origin_intent TEXT, attachments TEXT);
    CREATE TABLE work (id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT, state TEXT, title TEXT,
      result TEXT, opened_at INTEGER, closed_at INTEGER, repeat_interval TEXT,
      source_message_id TEXT, root_kind TEXT);
  `);
  db.prepare("INSERT INTO agents VALUES ('kevin', 'working', 0)").run();
  mockDb.current = db;
});

describe('PHASE-6 CUT 4: the finalize step\'s contract', () => {
  it('SHAPE: it takes (state, ctx) and hands back the state it advanced', async () => {
    const out = await runFinalize(freshState(), ctxFor());
    expect(out.state).toBeDefined();
    expect(out.state.agentId).toBe(AGENT);
  });

  it('IT CAN NEVER ASK TO EXIT — every path it returns from proceeds', async () => {
    for (const overrides of [
      {},
      { isA2ATurn: true },
      { counterparty: { kind: 'agent', name: 'peer', channel: 'dashboard', senderId: null } as never },
    ]) {
      const out = await runFinalize(freshState(), ctxFor(overrides));
      expect(out.directive).toBe('proceed');
      expect('reason' in out).toBe(false);
    }
  });

  it('AND IT IS NOT A must-not-throw BLOCK — a measured difference from `teardown`, kept', async () => {
    // Worth stating explicitly, because the neighbouring step's contract asserts the
    // OPPOSITE and copying it here would have been a behaviour change dressed as
    // consistency. `teardown` runs in the `finally` and must never throw — a throw
    // there would replace the error the turn was already handling. `finalize` runs
    // INSIDE the main `try`, so a throw is caught by the driver's own `catch` and the
    // recovery cascade owns it, exactly as it did while this code was a lexical block.
    // The five inner blocks keep their own best-effort `catch`es; what is NOT wrapped
    // is the tail's status read, and that is preserved rather than "improved".
    const broken = new Database(':memory:');
    broken.close();
    await expect(runFinalize(freshState(), ctxFor({ db: broken }))).rejects.toThrow();
  });

  it('IT NEVER WRITES `phase` — the driver owns the transition INTO it', async () => {
    for (const overrides of [{}, { isA2ATurn: true }]) {
      const out = await runFinalize(freshState(), ctxFor(overrides));
      expect(out.state.phase).toBe(FINALIZE_PHASE);
    }
  });

  it('THE DRIVER ADVANCES INTO IT AT THE CALL SITE, so validate() runs on the transition', () => {
    // The advance must be the statement immediately before the call: that is what makes
    // `validate()` run on this transition, and it is why the step may not write `phase`.
    const src = readFileSync(DRIVER, 'utf8');
    const callAt = src.indexOf('runFinalize(turnCtx.state!, finalizeContext())');
    expect(callAt).toBeGreaterThan(0);
    const before = src.slice(0, callAt);
    const advanceAt = before.lastIndexOf("advance(turnCtx.state!, { phase: 'finalize' })");
    expect(advanceAt).toBeGreaterThan(0);
    // Nothing but the call site's own line between them.
    expect(before.slice(advanceAt).split('\n').length).toBeLessThanOrEqual(2);
  });

  it('EVERY `break` PATH REACHES THE STAMPING — a census with a denominator', () => {
    const src = readFileSync(DRIVER, 'utf8');
    const sf = ts.createSourceFile(DRIVER, src, ts.ScriptTarget.ES2022, true);
    let body: ts.FunctionDeclaration | null = null;
    const find = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'runV2TurnBody') body = n;
      ts.forEachChild(n, find);
    };
    find(sf);
    if (!body) throw new Error('runV2TurnBody not found — the driver moved; fix this guard, do not delete it');
    const decl: ts.FunctionDeclaration = body;

    const tryStmt = decl.body!.statements.filter(ts.isTryStatement).pop();
    if (!tryStmt) throw new Error("the turn's main try is gone");

    // (a) THIS STEP IS THE LAST STATEMENT OF THAT `try`. Everything the loop can do
    //     ends up here, because there is nothing after it.
    const last = tryStmt.tryBlock.statements[tryStmt.tryBlock.statements.length - 1];
    expect(last.getText(sf)).toContain('runFinalize(turnCtx.state!, finalizeContext())');

    // (b) EVERY `break` OF THE LOOP IS INSIDE THAT `try` — the language, not a habit.
    let whileStmt: ts.WhileStatement | null = null;
    const findWhile = (n: ts.Node): void => {
      if (ts.isWhileStatement(n) && !whileStmt) whileStmt = n;
      ts.forEachChild(n, findWhile);
    };
    findWhile(tryStmt);
    if (!whileStmt) throw new Error('the tool loop is gone');

    const breaks: number[] = [];
    const returns: number[] = [];
    const walk = (n: ts.Node, inFn: boolean): void => {
      const nested = inFn || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
      if (!nested && ts.isBreakStatement(n)) breaks.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
      if (!nested && ts.isReturnStatement(n)) returns.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
      ts.forEachChild(n, (c) => walk(c, nested));
    };
    walk((whileStmt as ts.WhileStatement).statement, false);

    // The DENOMINATOR, and it is now read in TWO halves because PHASE-6 is draining
    // the driver into step packages. A new exit shape changes one of these numbers,
    // which is the point: it must be looked at rather than discovered later.
    //
    // ⚠ PHASE-6 CUT 7 MOVED SIX OF THEM AND THE HALF THAT REPLACED THEM IS PINNED
    // BELOW, not dropped. The `execute` span held five `break`s and one `break outer`;
    // in the step they are `requestExit(...)` calls, and the driver honours all five
    // with ONE `break` at the call site. So the driver's own count falls 19 → 13 while
    // the number of ways the loop can stop is unchanged — and the step-side half is
    // counted over the ENGINE so it cannot go quiet as the remaining tranches move.
    //
    // ⚠ PHASE-6 CUT 8 MOVED SEVEN MORE, THE BIGGEST SINGLE SHIFT IN THE PHASE. The
    // `postCallClassify` span held seven `break`s of this loop; in the step they are
    // `requestExit(...)` calls and the driver honours all seven with ONE `break` at the
    // call site, so the driver's own count falls 13 → 6 while the number of ways the
    // loop can stop is unchanged. RE-DERIVED IN BOTH HALVES, NEVER LOWERED: 6 + 23 = 29,
    // against CUT 7's 13 + 16 = 29. The total is the invariant this census is actually
    // about, and it did not move.
    expect(breaks.length).toBe(6);
    // The step-side half: every `requestExit` in every step package. Each one is a way
    // out of the loop that the driver honours with one of the `break`s above, and each
    // one still lands in this step.
    const stepExitSites = [...engineText().matchAll(/requestExit\(state,/g)].length;
    // ⚠ RE-DERIVED, NOT LOWERED (SWEEP-A TB8 JOB 1): 23 -> 24. The +1 is the grind rung's
    // give-up arm in `post-call-classify/empty-response.ts`, and the `breaks.length` half
    // below is UNCHANGED at 6 — the arithmetic that proves an exit was ADDED rather than a
    // driver break quietly converted into one.
    expect(stepExitSites).toBe(24);
    // THE INVARIANT UNDERNEATH BOTH HALVES, stated as its own clause so a future cut
    // that moves N exits and adds N+1 cannot pass by moving the two numbers in step.
    expect(breaks.length + stepExitSites).toBe(30);
    const tryStart = sf.getLineAndCharacterOfPosition(tryStmt.getStart(sf)).line + 1;
    const tryEnd = sf.getLineAndCharacterOfPosition(tryStmt.tryBlock.getEnd()).line + 1;
    for (const b of breaks) {
      expect(b).toBeGreaterThan(tryStart);
      expect(b).toBeLessThan(tryEnd);
    }

    // (c) AND THE EXITS THAT GENUINELY BYPASS IT, STILL PINNED AT EXACTLY TWO so a
    //     third cannot appear silently: the stopped and the preempted mid-call exits.
    //     Both write `idle` themselves and both still run the `finally`, so the turn
    //     record is still finalized — but the finalize span does NOT run for them.
    //
    //     ⚠ PHASE-6 CUT 5 CHANGED HOW THEY ARE SPELLED, NOT HOW MANY THERE ARE. They
    //     lived in the `callLLM` span, which is now a step, and a module cannot
    //     `return` from its caller: each is an `abandonTurn(...)` in the step and the
    //     driver honours BOTH with ONE `return` at the call site. So the census is
    //     read over the ENGINE — one bypassing `return` in the driver, two abandon
    //     sites in the steps — and the number of ways past this step is still two.
    //     Lowering the pin to "one return" would have been the loosening this clause
    //     exists to refuse.
    expect(returns.length).toBe(1);
    const honoursAbandon = src.split('\n').slice(returns[0] - 2, returns[0]).join('\n');
    expect(honoursAbandon).toMatch(/directive === 'abandon'/);
    // `abandonTurn(state,` matches the CALLS and not the shared contract's own
    // declaration (`abandonTurn(state: AgentTurnState`) nor any prose about it.
    const abandonSites = [...engineText().matchAll(/abandonTurn\(state,/g)].length;
    expect(abandonSites).toBe(2);
  });

  it('THE ORDER IS THE CONTRACT — reordering would change what gets routed', () => {
    // Two of the six blocks can produce the turn's reply text (the G-SUP-2 recovery and
    // the stranded-file safety net) and the router sits BETWEEN them: the recovered text
    // routes to the person's channel, the surfaced files deliberately do not (the net
    // sends them itself, which is why its own comment says so). A reordering is
    // therefore a behaviour change that no test of the individual blocks would catch.
    const entry = readFileSync(path.join(HERE, '..', 'index.ts'), 'utf8');
    const order = [
      'recoverDeferredReply(state, ctx)',
      'runCompletionAck(state, ctx)',
      'routeTerminalReply(state, ctx',
      'surfaceStrandedAttachments(state, ctx)',
      'scheduleCompletionReport(ctx)',
    ].map((needle) => {
      const at = entry.indexOf(needle);
      expect(at, `${needle} is not called by the step's entry point`).toBeGreaterThan(0);
      return at;
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('THE STEP OWNS ITS PHASE VALUE, and it is the one the union already had', () => {
    expect(FINALIZE_PHASE).toBe('finalize');
  });
});

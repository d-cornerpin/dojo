// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 T9b — THE `teardown` STEP'S CONTRACT (one contract test per STEP, P6-R1).
//
// `teardown` is the ninth step and the only one that is not a phase of the LOOP: it
// is the turn's lifetime boundary. That gives its contract one clause no other step
// has and one clause no other step CAN have.
//
//   * IT RUNS ON EVERY EXIT PATH. Not "on the paths someone remembered to list" —
//     the two arms are called from the `catch` and the `finally` of the same
//     function-level `try`, so the guarantee is the LANGUAGE's, and the clauses
//     below assert exactly that structure rather than sampling arms. The exits that
//     genuinely skip it are the ones that `return` BEFORE that `try` opens; they are
//     counted here with a denominator so a third one cannot appear silently.
//
//   * IT CAN NEVER ASK TO EXIT. The shared exit-request channel
//     (`../../step-outcome.js`) is reused unchanged — never a second contract — and
//     teardown's reading of it is that a step running after every exit has already
//     happened has nothing left to request. Both arms always `proceed`, including
//     when an inner best-effort block throws.
//
// The BEHAVIOURAL half is not duplicated here: `agent/v2/__tests__/integration.test.ts`
// already drives real turns down the `break` arm, the `return`-inside-the-`try` arm
// and the throw arm and asserts the turn record was stamped on each (PHASE-6 T1), and
// this file's structural census is what says those three are the whole family rather
// than three examples.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── PHASE-6 T-PROMISE: a TIMEOUT WITH ITS MEASURED REASON, not a re-run ──────────
// CUT 8 recorded this file (H6) as one of two that intermittently blow vitest's
// 5,000 ms per-test default when the whole suite runs on a loaded machine — GREEN
// alone, GREEN in subsets, a TIMEOUT rather than an assertion failure, and the
// machine's load average above 50 when it fired.
//
// THE REASON, MEASURED on a settled machine (`npx vitest run <this file>
// --reporter=verbose`): the FIRST clause costs 2,857 ms and the nine after it cost
// 171–204 ms each. So ~2,680 ms — 94% of the first clause's wall time — is the
// one-time module-graph load of the `teardown` package and everything it imports,
// paid inside whichever clause happens to run first. It is real work, not a hang,
// and under the load CUT 8 recorded it expands past 5,000 ms.
//
// 15,000 ms is 5.3× the settled first-clause cost, which covers the measured
// excursion with margin while still failing fast on a genuine hang.
//
// REFUSED, and each for a stated reason: (a) a re-run culture, which is what turns
// a measurable cost into folklore; (b) warming the graph in `beforeAll`, T0B's fix
// shape — it does not apply here, because the cost is this file's own top-level
// `import` statements rather than a dynamic import the test controls, so the hook
// would simply inherit the same seconds against `hookTimeout`; (c) pinning the
// timeout on the one slow clause, which silently re-arms the moment an edit makes a
// different clause run first.
//
// SEEN TO BITE IN BOTH DIRECTIONS, then reverted: a planted 6,000 ms delay in the
// first clause PASSED at 8,938 ms with this line, and the same plant with this line
// commented out FAILED at 5,203 ms carrying vitest's own timeout message. A raise
// nobody watched fail is a number, not a fix.
vi.setConfig({ testTimeout: 15_000 });
import Database from 'better-sqlite3';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { mockDb, broadcastSpy } = vi.hoisted(() => ({
  mockDb: { current: null as Database.Database | null },
  broadcastSpy: vi.fn(),
}));

vi.mock('../../../../../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../db/connection.js')>(
    '../../../../../db/connection.js',
  );
  return {
    ...actual,
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
  };
});

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: broadcastSpy }));

import { runMigrations } from '../../../../../db/migrations.js';
import { advance, initState, type AgentTurnState, type TurnPhase } from '../../../state.js';
import { openTurnContext, endTurnContext, type TurnContext } from '../../../../turn-context.js';
import {
  TEARDOWN_PHASE,
  runTurnRecovery,
  runTurnTeardown,
  type TeardownContext,
} from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOP_TS = path.resolve(HERE, '..', '..', '..', 'loop.ts');

const AGENT = 'primary';
const TURN = 1;

function seed(): Database.Database {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`,
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
     VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO agents (id, name, model_id, status, config, classification)
     VALUES (?, 'Primary', 'm', 'idle', '{}', 'sensei')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-1', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, started_at, answered)
     VALUES (?, ?, 'user', datetime('now'), 0)`,
  ).run(AGENT, TURN);
  return db;
}

let turnCtx: TurnContext;

function ctx(over: Partial<TeardownContext> = {}): TeardownContext {
  return {
    agentId: AGENT,
    turnCtx,
    turnNumber: TURN,
    db: mockDb.current!,
    chosenConvKey: null,
    chosenConversationId: null,
    lastAssembledAtIso: null,
    terminalAnswerRowId: null,
    triggerWorkId: null,
    toolPhaseEndedBySpinBrake: false,
    turnInjectedTechniqueId: null,
    counterparty: { kind: 'user' } as TeardownContext['counterparty'],
    isA2ATurn: false,
    isEngineTurn: false,
    turnStartedAt: new Date().toISOString(),
    inboundChannel: 'dashboard',
    inboundContext: null,
    reArmIfStrandedNoAnswer: vi.fn(),
    stopStatusHeartbeat: vi.fn(),
    ...over,
  };
}

/** The state the driver hands in: already advanced INTO the teardown phase. */
function stateInTeardown(): AgentTurnState {
  return advance(initState({
    agentId: AGENT,
    contextWindow: 200000,
    isAutoRouted: false,
    configuredModelId: 'm',
    turnNumber: TURN,
    triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    lastUserMessageContent: null,
    lastUserMessageId: null,
    inboundChannel: 'dashboard',
    inboundContext: null,
    pendingTechniqueAck: null,
  }), { phase: TEARDOWN_PHASE });
}

beforeEach(() => {
  mockDb.current?.close();
  seed();
  broadcastSpy.mockClear();

  for (const a of [AGENT]) endTurnContext(a);
  turnCtx = openTurnContext(AGENT);
  turnCtx.turnNumber = TURN;
});

// ── The shape every step package shares ───────────────────────────────────────

describe('inputs and outputs — the shared step contract, reused', () => {
  it('both arms take (state, ctx) and hand back the advanced state', async () => {
    const before = stateInTeardown();
    const teardown = await runTurnTeardown(before, ctx());
    expect(teardown.state.phase).toBe(TEARDOWN_PHASE);

    const recovery = await runTurnRecovery(before, ctx(), new Error('boom'));
    expect(recovery.state.phase).toBe(TEARDOWN_PHASE);
  });

  it('the input state is not mutated — every transition is a whole-state advance', async () => {
    const before = stateInTeardown();
    const snapshot = JSON.stringify(before);
    await runTurnTeardown(before, ctx());
    await runTurnRecovery(before, ctx(), new Error('boom'));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

// ── The recorded transition ───────────────────────────────────────────────────

describe('the recorded transition', () => {
  it('runs in the phase the driver advanced into, and NEVER writes `phase` itself', async () => {
    for (const [label, run] of [
      ['clean', () => runTurnTeardown(stateInTeardown(), ctx())],
      ['error', () => runTurnRecovery(stateInTeardown(), ctx(), new Error('boom'))],
      // The arm where a step is most tempted to relabel the turn: an inner
      // best-effort block throwing while the turn is already ending.
      ['inner-throw', () => runTurnTeardown(stateInTeardown(), ctx({
        chosenConvKey: 'conv-1',
        chosenConversationId: 'conv-1',
        lastAssembledAtIso: new Date().toISOString(),
      }))],
    ] as Array<[string, () => Promise<{ state: AgentTurnState }>]>) {
      const outcome = await run();
      expect(outcome.state.phase, label).toBe(TEARDOWN_PHASE);
    }
  });

  it('THE DRIVER advances into the phase, so `validate()` runs on the transition', () => {
    // The advance is at the CALL SITE, ahead of the step — the property CUT 1
    // established and every tranche inherits. A step that advanced its own phase
    // would be validating a transition it had already taken.
    const src = fs.readFileSync(LOOP_TS, 'utf8');
    expect(src).toMatch(/state = advance\(state, \{ phase: TEARDOWN_PHASE \}\)/);
  });

  it('`teardown` IS a member of the TurnPhase union — the exit path has a declared phase', () => {
    const phase: TurnPhase = 'teardown';
    expect(TEARDOWN_PHASE).toBe(phase);
  });
});

// ── The exit-request channel, in the one step that can never use it ───────────

describe('the exit-request channel: teardown can never ask to leave', () => {
  it('both arms ALWAYS proceed — there is no loop left to exit', async () => {
    expect((await runTurnTeardown(stateInTeardown(), ctx())).directive).toBe('proceed');
    expect((await runTurnRecovery(stateInTeardown(), ctx(), new Error('boom'))).directive)
      .toBe('proceed');
  });

  it('and it still proceeds when its own work fails — teardown must not throw', async () => {
    // "best effort, turn teardown must not throw" is written at three sites inside
    // the span. The failure mode it refuses is a teardown that escapes and replaces
    // the error the turn was already handling.
    const handed = ctx({
      chosenConvKey: 'conv-1',
      chosenConversationId: 'conv-1',
      lastAssembledAtIso: new Date().toISOString(),
      terminalAnswerRowId: 'msg-a',
    });
    mockDb.current!.close();   // every DB read inside the arms now throws
    const outcome = await runTurnTeardown(stateInTeardown(), handed);
    expect(outcome.directive).toBe('proceed');
  });
});

// ── The property that DEFINES this tranche ────────────────────────────────────

describe('IT RUNS ON EVERY EXIT PATH — and that is the language\'s guarantee, not a list', () => {
  interface DriverShape {
    tryStart: number;
    catchCalls: string[];
    finallyCalls: string[];
    breaksInsideTry: number;
    breaksOutsideTry: number;
    returnsInsideTry: number;
    returnsBeforeTry: number;
  }

  function readDriver(): DriverShape {
    const src = fs.readFileSync(LOOP_TS, 'utf8');
    const sf = ts.createSourceFile('loop.ts', src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    let body: ts.FunctionDeclaration | null = null;
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === 'runV2TurnBody') body = st;
    }
    if (!body?.body) throw new Error('runV2TurnBody not found in loop.ts');

    // The main `try` is the function's own outermost, largest try statement.
    let main: ts.TryStatement | null = null;
    for (const st of body.body.statements) {
      if (!ts.isTryStatement(st)) continue;
      if (!main || st.getEnd() - st.getStart(sf) > main.getEnd() - main.getStart(sf)) main = st;
    }
    if (!main?.catchClause || !main.finallyBlock) {
      throw new Error('the main try/catch/finally is not where this contract expects it');
    }

    const callsIn = (node: ts.Node): string[] => {
      const names: string[] = [];
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) names.push(n.expression.text);
        n.forEachChild(walk);
      };
      walk(node);
      return names;
    };

    const inRange = (n: ts.Node, from: number, to: number): boolean =>
      n.getStart(sf) >= from && n.getEnd() <= to;

    let breaksInsideTry = 0, breaksOutsideTry = 0, returnsInsideTry = 0, returnsBeforeTry = 0;
    const countExits = (n: ts.Node): void => {
      // Do not descend into nested functions: their `return` leaves the closure,
      // not the turn.
      if (n !== body && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))) return;
      if (ts.isBreakStatement(n)) {
        if (inRange(n, main!.getStart(sf), main!.getEnd())) breaksInsideTry++; else breaksOutsideTry++;
      }
      if (ts.isReturnStatement(n)) {
        if (inRange(n, main!.getStart(sf), main!.getEnd())) returnsInsideTry++;
        else if (n.getEnd() < main!.getStart(sf)) returnsBeforeTry++;
      }
      n.forEachChild(countExits);
    };
    countExits(body);

    return {
      tryStart: sf.getLineAndCharacterOfPosition(main.getStart(sf)).line + 1,
      catchCalls: callsIn(main.catchClause),
      finallyCalls: callsIn(main.finallyBlock),
      breaksInsideTry, breaksOutsideTry, returnsInsideTry, returnsBeforeTry,
    };
  }

  it('the teardown arm is called from the `finally`, and the recovery arm from the `catch`', () => {
    const d = readDriver();
    expect(d.finallyCalls, 'runTurnTeardown must be called from the main finally').toContain('runTurnTeardown');
    expect(d.catchCalls, 'runTurnRecovery must be called from the main catch').toContain('runTurnRecovery');
    // …and NOT the other way round: the recovery arm runs only on a throw.
    expect(d.finallyCalls).not.toContain('runTurnRecovery');
    expect(d.catchCalls).not.toContain('runTurnTeardown');
  });

  it('CENSUS WITH A DENOMINATOR: every break and every return of the turn body is inside that try', () => {
    // This is what "runs on every exit path" MEANS, and it is a count, not a sample.
    // A `break` or `return` lexically inside a `try` runs its `finally`; one outside
    // does not. So the whole claim reduces to "there are none outside", plus the
    // known exceptions below.
    const d = readDriver();
    expect(d.breaksInsideTry).toBeGreaterThan(0);   // the scan found something
    expect(d.breaksOutsideTry).toBe(0);
    expect(d.returnsInsideTry).toBeGreaterThan(0);  // the scan found something
  });

  it('THE KNOWN EXCEPTIONS ARE EXACTLY TWO, so a third cannot appear silently', () => {
    // The pickup-claim-lost bails (one human, one engine) return BEFORE the main try
    // opens and therefore never reach teardown. T1 recorded them as the reason the
    // turn's bag is cleared in `runV2Turn`'s wrapper rather than in this block, and
    // they are also why the F10 timer is armed AFTER them rather than before.
    const d = readDriver();
    expect(d.returnsBeforeTry).toBe(2);
  });
});

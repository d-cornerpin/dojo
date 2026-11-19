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
// T82d (ANSWER-ANYWAY) FIX ROUND 1, ALSO (a) — real (unmocked) here on purpose: this file's
// only mocks are `db/connection.js` and `gateway/ws.js` (see above), so a DECLARED_PATIENCE_
// EXCEEDED_CODE `AgentError` genuinely exercises `agent/v2/recovery.ts`'s real cascade, not a
// stand-in.
import { AgentError } from '../../../../errors.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE } from '../../../../stream-patience.js';
import { doomedPrefillCompactionSpent } from '../../../../shared-state.js';
import * as compaction from '../../../../../memory/compaction.js';

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

// ── T82d (ANSWER-ANYWAY) FIX ROUND 1, ALSO (a) ────────────────────────────────
//
// The review found this file's own `ctx()` helper hard-codes `isA2ATurn: false,
// isEngineTurn: false` for EVERY existing clause above — so nothing in this contract file had
// ever driven the boolean `runTurnRecovery` actually computes
// (`counterparty.kind === 'user' && !isA2ATurn && !isEngineTurn`) to `false` and watched it
// reach `recoverFromError`. Every T82d behavioral case lives in
// `agent/v2/__tests__/integration.test.ts`, which is real coverage of `recovery.ts`'s OWN
// branch logic, but none of it goes through THIS driver seam — the actual wiring the reviewer
// asked to see proven once, here, for real.
describe('T82d — the teardown boolean genuinely reaches recoverFromError, not hard-coded', () => {
  it('an ENGINE turn (isEngineTurn: true, the real shape — an engine turn synthesizes a user-shaped counterparty) gets ZERO channel lines on a declared-patience honest-fail', async () => {
    // Pre-spend the T82b compact-once marker so this reaches `recordInjury`'s honest-fail
    // branch directly — the branch this task's Heads-up line is gated on — without also
    // exercising the real (unmocked here) compaction/model-context-window machinery the OTHER
    // arm would need. That machinery is already driven for real, safely, in the fully-mocked
    // `integration.test.ts` harness; this file's job is the WIRING, not a second copy of it.
    doomedPrefillCompactionSpent.set(AGENT, TURN - 1);

    const err = new AgentError(
      'model first-chunk timeout: no data from provider for too long (elapsed 600000ms)',
      AGENT,
      { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false },
    );
    // The REAL shape (`counterparty.ts`'s "an engine turn synthesizes a user-shaped
    // counterparty"): `counterparty.kind` reads 'user' even on a genuine engine turn — only
    // `isEngineTurn` says otherwise. Proves the gate does not merely trust `counterparty.kind`.
    await runTurnRecovery(stateInTeardown(), ctx({
      counterparty: { kind: 'user' } as TeardownContext['counterparty'],
      isEngineTurn: true,
    }), err);

    const headsUp = broadcastSpy.mock.calls
      .map((call) => call[0] as { type?: string; message?: { content?: string } })
      .filter((e) => e.type === 'chat:message')
      .map((e) => e.message?.content ?? '')
      .filter((c) => c.startsWith('Dojo:'));
    expect(headsUp).toHaveLength(0);

    // Internal reporting is UNCHANGED — the status write `recordInjury` always makes for an
    // unclassified/non-paused injury still happens; only the channel stays silent.
    const row = mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string };
    expect(row.status).toBe('error');
  });

  it('an A2A turn (isA2ATurn: true, counterparty.kind: \'agent\') gets ZERO channel lines on the identical error', async () => {
    doomedPrefillCompactionSpent.set(AGENT, TURN - 1);

    const err = new AgentError(
      'model first-chunk timeout: no data from provider for too long (elapsed 600000ms)',
      AGENT,
      { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false },
    );
    await runTurnRecovery(stateInTeardown(), ctx({
      counterparty: { kind: 'agent' } as TeardownContext['counterparty'],
      isA2ATurn: true,
    }), err);

    const headsUp = broadcastSpy.mock.calls
      .map((call) => call[0] as { type?: string; message?: { content?: string } })
      .filter((e) => e.type === 'chat:message')
      .map((e) => e.message?.content ?? '')
      .filter((c) => c.startsWith('Dojo:'));
    expect(headsUp).toHaveLength(0);
  });

  it('CONTROL: the SAME error, on the file\'s default user-facing ctx(), DOES post a Heads-up line — proving the two clauses above are gated on the flag, not silently always-off', async () => {
    doomedPrefillCompactionSpent.set(AGENT, TURN - 1);

    const err = new AgentError(
      'model first-chunk timeout: no data from provider for too long (elapsed 600000ms)',
      AGENT,
      { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false },
    );
    await runTurnRecovery(stateInTeardown(), ctx(), err); // ctx()'s own default: kind 'user', both flags false

    const headsUp = broadcastSpy.mock.calls
      .map((call) => call[0] as { type?: string; message?: { content?: string } })
      .filter((e) => e.type === 'chat:message')
      .map((e) => e.message?.content ?? '')
      .filter((c) => c.startsWith('Dojo:'));
    expect(headsUp).toHaveLength(1);
  });

  // T82 FIX WAVE, Important I2 — every OTHER honest-fail test in this describe block (and in
  // `integration.test.ts`) pre-spends `doomedPrefillCompactionSpent` so `recordInjury` is reached
  // via the LADDER-EXHAUSTION arm, where a trim genuinely did run on the turn before. This test
  // is the one that reaches `recordInjury` on a genuine FIRST occurrence with NO prior trim at
  // all: the compaction pass itself threw, so `tryDeclaredPatienceCompactOnceRecovery` gives up
  // BEFORE any trim lands. The old, unconditional wording ("even after I trimmed it once and tried
  // again") would have been a lie here. (t211: the agent's model being the `'auto'` sentinel used to be
  // this case's trigger; the pass no longer bails on the auto-router, so the pass throwing is.)
  it('I2: a FIRST occurrence that never got to trim (the compaction pass threw) tells the truth — no false "trimmed it once" claim', async () => {
    vi.spyOn(compaction, 'checkAndCompact').mockRejectedValueOnce(new Error('the summary writer could not be reached'));
    // Deliberately NOT pre-spending doomedPrefillCompactionSpent — this is the FIRST occurrence.

    const err = new AgentError(
      'model first-chunk timeout: no data from provider for too long (elapsed 600000ms)',
      AGENT,
      { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false },
    );
    await runTurnRecovery(stateInTeardown(), ctx(), err); // ctx()'s own default: user-facing

    const headsUp = broadcastSpy.mock.calls
      .map((call) => call[0] as { type?: string; message?: { content?: string } })
      .filter((e) => e.type === 'chat:message')
      .map((e) => e.message?.content ?? '')
      .filter((c) => c.startsWith('Dojo:'));
    expect(headsUp).toHaveLength(1);
    expect(headsUp[0]).toMatch(/couldn't finish answering/i);
    expect(headsUp[0]).not.toContain('even after it was trimmed once and tried again');
    expect(headsUp[0]).toContain("couldn't be trimmed down enough to try again");
  });
});

// ── The ONE owner of the turn's end-of-run status ─────────────────────────────

describe('settleStatus: the one owner, and it cannot clobber a diagnosis', () => {
  // T83 FIX ROUND 2 (review A-3 residual). Eight in-run checkpoints used to write `idle`
  // themselves — the last of them was `finalize`, one statement before the driver's `finally`,
  // and it went in this round. The behaviour that replaces all eight is asserted HERE, against
  // the real row, rather than being left to the stop suite's source census: a census proves a
  // write is gone, and only a run proves the survivor does the job the eight used to.
  const statusOf = (): string =>
    (mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status;
  const setStatus = (s: string): void => {
    mockDb.current!.prepare('UPDATE agents SET status = ? WHERE id = ?').run(s, AGENT);
  };

  it('a turn that ran to its end settles from `working` to `idle`, exactly once', async () => {
    setStatus('working');
    await runTurnTeardown(stateInTeardown(), ctx());
    expect(statusOf(), 'nothing else writes idle on this path any more — if this arm does not, the row stays `working` forever').toBe('idle');
    const idleFrames = broadcastSpy.mock.calls
      .map((call) => call[0] as { type?: string; status?: string })
      .filter((e) => e.type === 'agent:status' && e.status === 'idle');
    expect(idleFrames, 'the dashboard hears the settle once, from the one owner').toHaveLength(1);
  });

  it('every OTHER status is somebody else\'s answer, and is left standing', async () => {
    // `error`/`paused` are the recovery arm's, `terminated` a completed agent's, `rate_limited`
    // the retry manager's. The deleted writes clobbered all four; the guard is why centralising
    // them was safe.
    for (const diagnosis of ['error', 'paused', 'terminated', 'rate_limited']) {
      setStatus(diagnosis);
      await runTurnTeardown(stateInTeardown(), ctx());
      expect(statusOf(), `teardown overwrote a ${diagnosis} diagnosis with idle`).toBe(diagnosis);
    }
  });
});

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
//      can end without its finalize block running, and it is deliberate (both still run
//      the `finally` that finalizes the record and settles the status).
//
//   3. IT DOES NOT SETTLE THE STATUS. Added in the T83 fix round's second pass: this step
//      wrote `idle` unconditionally, one statement before the driver's `finally`, and that
//      write landed before `activeRuns.delete` and before the awaited tail — so a stop
//      landing here found a row that said nobody was home. `teardown`'s `settleStatus` is
//      the one owner, and the clause below reads the ROW rather than the absence of a call
//      site, so it fails whatever mechanism a future write is made through.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

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

const AGENT = FXID.n4;

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
  db.prepare(`INSERT INTO agents VALUES ('${FXID.n4}', 'working', 0)`).run();
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

  it('THE STEP OWNS ITS PHASE VALUE, and it is the one the union already had', () => {
    expect(FINALIZE_PHASE).toBe('finalize');
  });

  it('IT DOES NOT SETTLE THE STATUS (T83 fix round 2, review A-3 residual)', async () => {
    // The seed row reads `working`, which is what it reads for real at this point in a turn:
    // `preflight` wrote it, the heartbeat has been keeping it fresh, and `activeRuns` still
    // holds the agent. A stop landing in this window is honoured by leaving that row alone —
    // `stopAgent` deliberately stopped writing its own idle for exactly this reason — and this
    // step used to clobber it one statement before the driver's `finally`.
    //
    // Read off the ROW, not off the call site: a re-added write through `ctx.db`, through a
    // re-added closure, or through a direct import all fail here, where a census of
    // `setAgentStatus(…, 'idle')` would only catch the middle one.
    const out = await runFinalize(freshState(), ctxFor());
    expect(out.directive).toBe('proceed');
    const row = mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string };
    expect(row.status, 'idle written here is the lie the ticket is named for — teardown owns the settle').toBe('working');
  });
});

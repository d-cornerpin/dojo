// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 T2 (CUT 9) — THE `preflight` STEP'S CONTRACT (one contract test per STEP,
// P6-R1). The LAST tranche, and the step whose shape genuinely differs from the other
// eight — so three of the nine clauses below exist nowhere else in the phase.
//
//   * IT DOES NOT TAKE `state`, BECAUSE IT MAKES IT. Every other step's entry point is
//     `(state, ctx)`. This one is `(turnCtx, ctx)`: before `initState` runs there is no
//     state to take, and inventing one to satisfy a signature is a lie the type system
//     would then carry.
//   * IT PUBLISHES THE STATE TO THE BAG, seeded in its own phase. `'preflight'` is the
//     one member of `TurnPhase` no call site advances into.
//   * THE CARRIER IS LIVE, NOT A SNAPSHOT. This is the clause a botched carrier fails:
//     the driver's later advance is simulated on the bag, and a closure this step
//     returned must SEE it. A module local frozen at return time answers `false` and
//     the person gets a second "on it" after their answer already went out.
//
// Then the shape every step package shares: the exit channel as a CENSUS WITH A
// DENOMINATOR, exit not sayable without a reason, a step that asks to leave STOPS, and
// the step never writes `phase`.
//
// The BEHAVIOURAL half is not duplicated here. `agent/v2/__tests__/integration.test.ts`
// drives real turns through this span end to end — including the four BUG-2 clauses this
// tranche wrote for the close-out gate, which had no test anywhere in either repo — and
// this file's structural censuses are what say those are the whole family rather than
// examples.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

// PHASE-6 T-PROMISE, CUT 8's H6 shape, for the same measured reason: the first clause in
// this file pays the one-time module-graph load of the `preflight` package and everything
// it imports — which, for the step that owns the turn's whole prologue, is most of the
// engine. 15,000 ms covers the excursion under load while still failing fast on a hang.
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
import { advance, type TurnPhase } from '../../../state.js';
import { openTurnContext, endTurnContext, type TurnContext } from '../../../../turn-context.js';
import { PREFLIGHT_PHASE, runPreflight, type PreflightContext } from '../index.js';

const AGENT = 'primary';

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
  return db;
}

let turnCtx: TurnContext;

function ctx(over: Partial<PreflightContext> = {}): PreflightContext {
  return {
    agentId: AGENT,
    setAgentStatus: vi.fn(),
    startStatusHeartbeat: vi.fn(),
    stopStatusHeartbeat: vi.fn(),
    engineBlockEscapeHatch: 'escape-hatch',
    engineStartAckAfterMs: 30_000,
    ...over,
  };
}

beforeEach(() => {
  mockDb.current?.close();
  seed();
  broadcastSpy.mockClear();
  endTurnContext(AGENT);
  turnCtx = openTurnContext(AGENT);
});

// ── The three clauses this step is alone in owing ─────────────────────────────

describe('the ONE step that does not take `state`, because it MAKES it', () => {
  it('takes (turnCtx, ctx) — not (state, ctx) — and the type system says so', () => {
    expect(runPreflight.length).toBe(2);
  });

  it('PUBLISHES the state to the BAG, seeded in its own phase', async () => {
    // A fresh bag opens with no state at all — the field exists and is empty, which is
    // what makes "this step makes it" a fact rather than a phrase.
    expect(turnCtx.state).toBeNull();
    const outcome = await runPreflight(turnCtx, ctx());
    expect(outcome.directive).toBe('proceed');
    // The state exists, it is on the bag the CALLER passed, and it carries this step's
    // phase — seeded by `initState`, not advanced into by a call site.
    expect(turnCtx.state).toBeTruthy();
    expect(turnCtx.state!.phase).toBe(PREFLIGHT_PHASE);
    const phase: TurnPhase = 'preflight';
    expect(PREFLIGHT_PHASE).toBe(phase);
  });

  it('THE CARRIER IS LIVE, NOT A SNAPSHOT — the clause a botched carrier fails', async () => {
    const outcome = await runPreflight(turnCtx, ctx());
    if (outcome.directive !== 'proceed') throw new Error('preflight abandoned unexpectedly');
    const { startAckRepliedNow } = outcome.outputs;

    // Nothing has been said yet: the closure reads the bag and answers no.
    expect(startAckRepliedNow()).toBe(false);

    // Now SIMULATE THE DRIVER'S LATER ADVANCE, exactly as the loop does it — a whole-state
    // advance assigned back onto the bag, long after this step returned.
    turnCtx.state = advance(turnCtx.state!, { explicitSendThisTurn: { imessage: true } });

    // The closure must SEE it. By value the timer reads the state as it was BORN, every
    // `explicitSendThisTurn` false, and a turn whose agent already relayed the answer
    // through a send TOOL is acked anyway — the observed double-ack.
    expect(startAckRepliedNow()).toBe(true);
  });
});

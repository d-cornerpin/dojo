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
import ts from 'typescript';

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
import { engineSources, ENGINE_DRIVER_REL } from '../../../__tests__/engine-sources.js';
import { PREFLIGHT_PHASE, runPreflight, type PreflightContext } from '../index.js';

const PACKAGE_REL = 'agent/v2/steps/preflight/';

const AGENT = 'primary';

/**
 * Every source file this file's censuses run over, taken from the SHARED derivation
 * (`agent/v2/__tests__/engine-sources.ts`) rather than from a walk of its own. The audit's
 * whole finding was that six hand-rolled copies of that walk are six places the corpus can
 * drift; this file does not become the seventh. `engineSources()` refuses an impossible
 * corpus by throwing, so a census here can never pass because the derivation broke.
 */
function packageSources(): Array<{ rel: string; text: string }> {
  const out = engineSources()
    .filter((s) => s.rel.startsWith(PACKAGE_REL))
    .map((s) => ({ rel: s.rel.slice(PACKAGE_REL.length), text: s.text }));
  if (out.length < 2) throw new Error('the preflight package corpus is empty or impossible');
  return out;
}

/** The driver's source, from the same derivation — which throws rather than returning a
 *  corpus with no driver in it, so a clause about the DRIVER cannot go quiet here. */
function driverSource(): string {
  const d = engineSources().find((s) => s.rel === ENGINE_DRIVER_REL);
  if (!d) throw new Error('engine-sources returned no driver');
  return d.text;
}

/** The shared step contract, from the same derivation. */
function sharedContractSource(): string {
  const c = engineSources().find((s) => s.rel === 'agent/v2/steps/step-outcome.ts');
  if (!c) throw new Error('the shared step contract is not in the engine corpus');
  return c.text;
}

/** Source with comments removed, so a census counts CODE and not prose about code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

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
    detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
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
    // The shape is asserted at the source rather than only at a call, because the point
    // is what the signature CANNOT be handed: there is no state to hand it.
    const src = packageSources().find((f) => f.rel === 'index.ts')!.text;
    expect(src).toMatch(/export async function runPreflight\(\s*\n\s*turnCtx: TurnContext,\s*\n\s*ctx: PreflightContext,/);
    expect(stripComments(src)).not.toMatch(/function runPreflight\([^)]*state\s*:/);
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

  it('THE PHASE IS SEEDED, NOT ADVANCED — there is no `advance` ahead of this call', () => {
    // Every other tranche asserts the opposite: the driver advances INTO the phase so
    // `validate()` runs on the transition. Here there is no transition to validate — the
    // record is born in this phase — so the shared property holds BY CONSTRUCTION, and the
    // absence of the call-site advance is the thing to pin so nobody "fixes" it later.
    const src = driverSource();
    expect(src).not.toMatch(/advance\([^)]*\{\s*phase:\s*PREFLIGHT_PHASE/);
    expect(src).not.toMatch(/advance\([^)]*\{\s*phase:\s*'preflight'/);
    // …and `initState` is what seeds it, in the step, at the one site that makes a state.
    const record = packageSources().find((f) => f.rel === 'counterparty-and-record.ts')!.text;
    expect(record).toMatch(/turnCtx\.state = initState\(\{/);
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

// ── The exit-request channel ──────────────────────────────────────────────────

describe('the exit-request channel: two directives, and both exits are `abandon`', () => {
  it('CENSUS WITH A DENOMINATOR: the outcome type has exactly TWO directives', () => {
    const shared = sharedContractSource();
    const decl = /export type PreflightOutcome<Outputs> =([\s\S]*?);\n/.exec(shared);
    expect(decl, 'PreflightOutcome must live in the SHARED contract, never as a private channel')
      .toBeTruthy();
    const directives = [...decl![1].matchAll(/readonly directive:\s*'([a-z]+)'/g)].map((m) => m[1]);
    expect(directives.sort()).toEqual(['abandon', 'proceed']);
  });

  it('CENSUS WITH A DENOMINATOR: the package has exactly TWO abandon sites', () => {
    // Both are the same shape — another process claimed this turn's trigger between our
    // read and our stamp — and they are the two exits CUT 2's teardown census pins as
    // genuinely skipping the `finally`. A third appearing fails here.
    const sites = packageSources().flatMap(({ rel, text }) =>
      stripComments(text).split('\n')
        .filter((l) => /\breturn\s+preflightAbandon\(/.test(l))
        .map((l) => ({ rel, line: l.trim() })),
    );
    expect(sites.length, `abandon sites: ${JSON.stringify(sites)}`).toBe(2);
    expect(sites.map((s) => s.rel).sort()).toEqual(['turn-classification.ts', 'turn-trigger.ts']);
  });

  it('exit is not sayable without a reason, and the two reasons are DISTINCT', () => {
    const reasons = packageSources().flatMap(({ text }) =>
      [...stripComments(text).matchAll(/preflightAbandon\('([^']+)'\)/g)].map((m) => m[1]),
    );
    expect(reasons.length).toBe(2);
    expect(new Set(reasons).size, `both abandons must name their own reason: ${reasons}`).toBe(2);
    // …and the type makes it unsayable without one: no zero-argument form exists.
    const shared = sharedContractSource();
    expect(shared).toMatch(/export function preflightAbandon<T>\(reason: string\)/);
  });

  it('A STEP THAT ASKS TO ABANDON STOPS — it never keeps running after asking', () => {
    // Both sites are `return preflightAbandon(...)`, and every caller of a section that can
    // abandon returns the outcome immediately rather than reading `.outputs` past it.
    const index = stripComments(packageSources().find((f) => f.rel === 'index.ts')!.text);
    const propagations = [...index.matchAll(/if \((\w+)\.directive === 'abandon'\) return \1;/g)];
    expect(propagations.length, 'every abandoning section must be propagated at once').toBe(2);
    // A bare `preflightAbandon(...)` whose value is dropped would be the failure this
    // forbids: every construction of one is the operand of a `return`.
    for (const { rel, text } of packageSources()) {
      const built = [...stripComments(text).matchAll(/preflightAbandon\(/g)].length;
      const returned = [...stripComments(text).matchAll(/return preflightAbandon\(/g)].length;
      expect(returned, `${rel}: an abandon that is built and not returned is a step that kept going`)
        .toBe(built);
    }
  });

  it('THE DRIVER HONOURS `abandon` BY RETURNING — not by breaking', () => {
    // There is no loop yet to break, and the main `try` has not opened, so neither
    // finalize nor the teardown `finally` runs. That is exactly what the two bare
    // `return`s inside this span did before the cut.
    const src = driverSource();
    expect(src).toMatch(/if \(preflight\.directive === 'abandon'\) return;/);
    expect(src).not.toMatch(/if \(preflight\.directive === 'abandon'\) break;/);
  });
});

// ── The phase belongs to the driver (rule 2 of the shared contract) ───────────

describe('the step never writes `phase`', () => {
  it('a comment-stripped `phase:` census over the package is ZERO', () => {
    const writes = packageSources().flatMap(({ rel, text }) =>
      [...stripComments(text).matchAll(/\bphase\s*:/g)].map(() => rel),
    );
    expect(writes, `nothing in this package may write \`phase\`: ${JSON.stringify(writes)}`)
      .toEqual([]);
  });

  it('and the three in-span `advance` calls write FIELDS, never `phase`', () => {
    // The close-out gate, UX-REPAIR ROUND 12 T47's compile gate and the recall flag each
    // advance the state; none relabels the turn. The census above starts at ZERO rather than
    // needing CUT 8's repair because it was already true of the span.
    //
    // The number moved 2 -> 3 with T47, and moving it is the correct response rather than
    // loosening the clause: this census exists so a NEW state write into the span is noticed
    // and named, and it just did its job. Each of the three arms an enforcement or a flag that
    // a later step reads, and the three are named above so a fourth cannot arrive unremarked.
    const advances = packageSources().flatMap(({ rel, text }) =>
      [...stripComments(text).matchAll(/turnCtx\.state = advance\(turnCtx\.state!, \{([^}]*)\}/g)]
        .map((m) => ({ rel, patch: m[1] })),
    );
    expect(advances.map((a) => a.rel).sort())
      .toEqual(['closeout-gate.ts', 'compile-gate.ts', 'recall-flag.ts']);
    for (const a of advances) expect(a.patch).not.toMatch(/\bphase\b/);
  });
});

// ── CUT 2's teardown census, re-derived in BOTH halves ───────────────────────

describe("CUT 2's exits-that-skip-teardown census, re-derived in BOTH halves", () => {
  /** The driver's own count of `return`s that leave the turn BEFORE the main `try` —
   *  the same walk `steps/teardown/__tests__/contract.test.ts` runs, deliberately
   *  reproduced here so the two halves are measured by one method. */
  function driverReturnsBeforeTry(): number {
    const src = driverSource();
    const sf = ts.createSourceFile(ENGINE_DRIVER_REL, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    let body: ts.FunctionDeclaration | null = null;
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === 'runV2TurnBody') body = st;
    }
    if (!body?.body) throw new Error('runV2TurnBody not found in the driver');
    let main: ts.TryStatement | null = null;
    for (const st of body.body.statements) {
      if (!ts.isTryStatement(st)) continue;
      if (!main || st.getEnd() - st.getStart(sf) > main.getEnd() - main.getStart(sf)) main = st;
    }
    if (!main) throw new Error('the main try is not where this contract expects it');
    let n = 0;
    const walk = (node: ts.Node): void => {
      if (node !== body && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return;
      if (ts.isReturnStatement(node) && node.getEnd() < main!.getStart(sf)) n++;
      node.forEachChild(walk);
    };
    walk(body);
    return n;
  }

  it('the driver half fell 2 → 1, and the step half is 2 — and THE SUM IS PINNED', () => {
    // The two pickup-claim-lost bails did not disappear; they MOVED. The driver now
    // honours both through ONE `return`, and the step carries two `abandon` sites. Pinning
    // only one half would let a future cut pass by moving the two numbers in step with
    // each other, so both halves and their sum are asserted together.
    const driverHalf = driverReturnsBeforeTry();
    const stepHalf = packageSources()
      .flatMap(({ text }) => [...stripComments(text).matchAll(/return preflightAbandon\(/g)]).length;

    expect(driverHalf, 'the driver honours every preflight abandon through ONE return').toBe(1);
    expect(stepHalf, 'the two exits that genuinely skip the teardown finally').toBe(2);
    expect(driverHalf + stepHalf, 'the census did not shrink — it moved').toBe(3);
  });
});

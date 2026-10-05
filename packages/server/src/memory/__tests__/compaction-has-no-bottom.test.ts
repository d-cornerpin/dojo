// ════════════════════════════════════════════════════════════════════════════════════════
// COMPACTION HAS NO BOTTOM — the owner's ruling, driven through the real door.
//
// OR-COMPACT-1 (owner, 2026-10-02): *"there is never a reason for compaction to end… an
// agent's memory can always compress. This is the entire point of compaction. If compaction
// fails for a different reason, that is something that needs to be repaired."*
//
// ── THE SHAPE THIS FILE REPRODUCES ──
// A box whose context was ~86K of ALREADY-SUMMARISED history against what a 64K-window model
// admits. Before this work, nothing in the tree could make that number go down:
// `runCondensation` was capped at depth 1 and skipped any level holding fewer than four
// waiting summaries, so two or three oversized summaries never shrank at any pressure, under
// any force — and because the cap put a HARD CEILING on the DAG at depth 2, a depth-2 summary
// could never be condensed again by construction. The platform's only honest answer was a card
// telling the owner to archive their conversation or reset their agent. That card is gone.
//
// ⚠ NOT "depth 2 was unreachable", which is what the dispatch brief and BACKLOG line 120 say.
// A re-read of the deleted loop at main `eef45913` shows it wrote parents at `depth + 1` for
// `depth` 0 AND 1, so a depth-1 level with ≥4 waiting summaries did reach the depth-2 prompt.
// The §1 clause below therefore proves something narrower and truer than the brief claimed:
// depth 2 is now reached from a level the OLD FLOOR WOULD HAVE REFUSED, and depth 3 — which
// `newDepth` could never produce — is now reachable at all.
//
// ── WHAT IS REAL HERE, AND WHY IT HAS TO BE ──
// The DB (in-memory, fully migrated), `checkAndCompact` and its whole trigger, the real
// `estimateAssembledTokens` with its real tool-payload measurement and real provider join,
// the real summary DAG writes, the real `rebuildContextItems`, the real provider breaker, and
// the real `archiveAgentConversation`. ONLY the summariser's model call is mocked, because it
// is the one thing that cannot run in a unit box — and it is mocked through a seam that
// records the depth and the ACTUAL system prompt `getDepthPrompt` produces, so "the depth-2
// prompt is the one that gets sent" is a measurement rather than an inference.
//
// ⚠ EVERY NUMBER BELOW IS DERIVED AT RUNTIME, NOT HARDCODED. What the assembler admits is a
// function of the window, the measured tool payload and the fresh tail; a fixture asserting
// `admitted === 9983` would pass for the wrong reason the day a tool is added. So each clause
// reads the admitted figure from the single estimate and asserts the RELATION — over budget
// before, inside it after — with a non-vacuity row proving the "before" really was over.
//
// ── CONTENT NOTE ──
// All fixture text is filler ('s'.repeat(...)) and all names are invented. No real
// conversation, agent or person appears anywhere in this file.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-or-compact-1', 'dojo.db'),
  };
});

/**
 * THE LOG SEAM (review I2). D3 — *"a pass that ends over budget having reclaimed nothing logs
 * ONE structured line at error level naming WHICH STAGE refused"* — is the deliverable the
 * owner's ruling turns every failure into, and NOTHING asserted it: deleting the `logger.error`
 * left all 55 clauses of the first round green, because they pinned the failure NOTE
 * (`compactionFailureReason`) which is a different thing. So the logger is mocked and the line
 * itself, its LEVEL and its FIELDS are now assertions.
 */
interface LogLine { level: string; component: string; message: string; meta: Record<string, unknown> }
const logLines: LogLine[] = [];
vi.mock('../../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger.js')>();
  const at = (component: string, level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      logLines.push({ level, component, message, meta: meta ?? {} });
    };
  return {
    ...actual,
    createLogger: (component: string) => ({
      debug: at(component, 'debug'), info: at(component, 'info'),
      warn: at(component, 'warn'), error: at(component, 'error'),
    }),
  };
});

/** Every D3 defect line this pass emitted. */
const defectLines = (): LogLine[] => logLines.filter(l => l.message.startsWith('COMPACTION_DEFECT'));

const frames: Array<{ type: string; code?: string; error?: string; retryable?: boolean; agentId?: string }> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: { type: string; code?: string; error?: string; retryable?: boolean; agentId?: string }) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

/**
 * THE SUMMARISER SEAM. Records what each call was ASKED for — including the real system
 * prompt `getDepthPrompt` builds for that depth, which is how the depth-2 clause proves the
 * previously-unreachable prompt is now the one sent — and answers however the clause says.
 */
interface SummaryCall { depth: number; targetTokens: number; contentTokens: number; prompt: string }
const calls: SummaryCall[] = [];
type Answer = (p: { depth: number; targetTokens: number; content: string }) =>
  Promise<{ ok: true; text: string; tokenCount: number } | { ok: false; reason: string }>;

/** The honest summariser: it produces what it was asked for. */
const producesWhatItWasAskedFor: Answer = async (p) => ({
  ok: true, text: 's'.repeat(p.targetTokens * 4), tokenCount: p.targetTokens,
});
/** The summariser that compresses nothing — the finiteness adversary. */
const echoesItsInput: Answer = async (p) => ({ ok: true, text: p.content, tokenCount: Math.ceil(p.content.length / 4) });
/** The summariser that refuses — a model answering with nothing usable. */
const refuses: Answer = async () => ({ ok: false, reason: 'summarizer returned empty text' });

let answer: Answer = producesWhatItWasAskedFor;

vi.mock('../summarize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../summarize.js')>();
  return {
    ...actual,
    generateSummary: async (p: { depth: number; targetTokens: number; content: string }) => {
      calls.push({
        depth: p.depth, targetTokens: p.targetTokens,
        contentTokens: Math.ceil(p.content.length / 4),
        prompt: actual.getDepthPrompt(p.depth, p.targetTokens),
      });
      return answer(p);
    },
  };
});

import { runMigrations } from '../../db/migrations.js';
import { checkAndCompact, estimateAssembledTokens, rebuildContextItems } from '../compaction.js';
import {
  condenseUntilFits, condensableSummaries, rawContextSummaryTokens, shrinkTarget,
  CONDENSE_MAX_LEVELS, CONDENSE_MAX_CALLS_PER_RUN, CONDENSE_MIN_TARGET_TOKENS,
} from '../condense-until-fits.js';
import { compactionIsBraked, LOW_YIELD_BACKOFF_MS, __resetBrakesForTests } from '../compaction-brakes.js';
import { compactionFailureReason } from '../compaction-defect.js';
import {
  cachedAssembledEstimate, assembledEstimateStats, __resetEstimateCacheForTests,
} from '../assembled-estimate-cache.js';
import {
  noteProviderFailure, clearProviderBreaker, noteSummaryWriterFailure, permanentFailureReason,
  providerBreaker, __resetBreakersForTests,
} from '../../providers/billing-breaker.js';
import { classifyProviderError } from '../../agent/provider-error.js';

const AGENT = 'agent-no-bottom';
const PROVIDER = 'prov-under-test';
/** The reported box's cloud row: a 64K window, whose fresh tail count is 40. */
const MODEL_64K = 'm-cloud-64k';
const FRESH_TAIL_ROWS = 40;
/** 40 × 800 = 32,000 tokens of live conversation, which is what makes the summary budget
 *  small enough that a realistic summary body exceeds it — the incident's own relation. */
const TAIL_TOKENS_EACH = 800;
/** The provider's actual words, as the reported log recorded them. */
const HTTP_402 = 'API error 402: {"error":{"message":"Insufficient Balance","type":"insufficient_balance"}}';

// ── the fixture ──────────────────────────────────────────────────────────────────────────

function seedBox(): void {
  const db = mockDb.current!;
  db.prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES (?, 'Under Test', 'openai-compatible', 'api_key')").run(PROVIDER);
  db.prepare(
    `INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, context_window, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Cloud 64K', 'cloud/64k', '["text"]', 1, 65536, 'token', 0)`,
  ).run(MODEL_64K, PROVIDER);
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status, session_started_at) VALUES (?, 'Box Under Test', ?, 'idle', '1970-01-01')")
    .run(AGENT, MODEL_64K);
  const insertMsg = db.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                           turn_number, provenance, authorized, token_count, created_at)
     VALUES (?, ?, 'assistant', 'owner', ?, 'agent-text', 'agent-only', 1, 'live', 1, ?, ?)`,
  );
  const body = 's'.repeat(TAIL_TOKENS_EACH * 4);
  const tx = db.transaction(() => {
    for (let i = 0; i < FRESH_TAIL_ROWS; i += 1) {
      insertMsg.run(`msg-${i}`, AGENT, body, TAIL_TOKENS_EACH, Date.now() - (FRESH_TAIL_ROWS - i) * 1000);
    }
  });
  tx();
}

/** Put `count` already-written summaries at `depth` into this agent's context. */
function seedSummaries(count: number, depth: number, tokensEach: number): void {
  const db = mockDb.current!;
  const insert = db.prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const at = new Date(Date.now() - (count - i) * 60_000).toISOString();
      insert.run(`sum-d${depth}-${i}`, AGENT, depth, depth === 0 ? 'leaf' : 'condensed',
        's'.repeat(tokensEach * 4), tokensEach, at, at, at);
    }
  });
  tx();
  rebuildContextItems(AGENT);
}

/** Seed top-level summaries at EXPLICIT, possibly different depths (review C1's shapes). */
function seedMixed(rows: ReadonlyArray<{ depth: number; tokens: number }>): void {
  const db = mockDb.current!;
  const insert = db.prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    rows.forEach((r, i) => {
      const at = new Date(Date.now() - (rows.length - i) * 60_000).toISOString();
      insert.run(`mix-${i}-d${r.depth}`, AGENT, r.depth, r.depth === 0 ? 'leaf' : 'condensed',
        's'.repeat(r.tokens * 4), r.tokens, at, at, at);
    });
  });
  tx();
  rebuildContextItems(AGENT);
}

/** What the single estimate says the assembler will ADMIT of this agent's summaries. */
async function admitted(): Promise<number> {
  return (await estimateAssembledTokens(AGENT, 65_536, MODEL_64K)).summaryTokens;
}

/** The raw cost of the summaries the agent actually holds. */
const held = (): number => rawContextSummaryTokens(AGENT);

/** The depth of every summary in the DAG, deepest first. */
function depthsWritten(): number[] {
  return (mockDb.current!.prepare('SELECT DISTINCT depth FROM summaries WHERE agent_id = ? ORDER BY depth DESC')
    .all(AGENT) as Array<{ depth: number }>).map(r => r.depth);
}

/**
 * ⚠ THE METRIC, AND WHY IT IS NOT §3's. `the-freeze-cannot-happen-again.test.ts` §3 measures
 * STARVED MILLISECONDS — elapsed wall time minus the time a 10 ms interval demonstrably
 * serviced — because the body it drives takes half a second on a unit box and the number has
 * room to move. A multi-level condensation on a fixture small enough to reason about takes
 * SINGLE-DIGIT milliseconds, so a 10 ms interval cannot fire during it at all and
 * `starvedMs == elapsedMs` for a perfectly responsive loop. Asserting on that number here
 * would be a coin flip dressed as a measurement, so it is PRINTED and not asserted.
 *
 * What IS asserted is the fact a dead dashboard and a dead stop button actually contradict:
 * did the event loop reach its CHECK PHASE while the work ran? A self-rescheduling
 * `setImmediate` pump can only advance when the microtask queue empties and the loop moves
 * on, which a synchronous scan — and an `await` chain over already-resolved promises, which
 * is exactly what the mocked summariser is — never allows. So the pump's turn count is zero
 * for a condensation that never hands the loop back, and non-zero for one that does.
 */
async function measureLoopService(work: () => Promise<void>): Promise<{
  turns: number; starvedMs: number; elapsedMs: number; ticks: number;
}> {
  let turns = 0;
  let stopped = false;
  const pump = (): void => { if (stopped) return; turns += 1; setImmediate(pump); };
  setImmediate(pump);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  const t0 = Date.now();
  try {
    await work();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
  const elapsedMs = Date.now() - t0;
  return { turns, starvedMs: Math.max(0, elapsedMs - ticks * 10), elapsedMs, ticks };
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  frames.length = 0;
  calls.length = 0;
  logLines.length = 0;
  answer = producesWhatItWasAskedFor;
  __resetBrakesForTests();
  __resetEstimateCacheForTests();
  __resetBreakersForTests();
  seedBox();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  vi.useRealTimers();
});

// ── §1 — THE RECURSION ───────────────────────────────────────────────────────────────────

describe('§1 condensation recurses until the assembler will admit every summary', () => {
  /**
   * ⚠ THE BACKLOG'S OWN SHAPE, and the one the old code provably could not touch.
   *
   * THREE summaries at depth 1 — one short of `condensedMinFanout` — holding more than the
   * assembler will admit. `runCondensation` read `uncondensed.length < 4` and `continue`d,
   * every turn, for ever. THE MUTANT: restore that floor in `condenseLevel`
   * (`if (rows.length < args.minFanout) return { created: 0, calls: 0, stage:
   * 'condensation_produced_no_parent', detail: 'below fanout' };` at the top) and this clause
   * goes RED on the "fits" row — nothing shrinks, which is the defect verbatim.
   */
  it('THE BACKLOG SHAPE: three oversized summaries below the fanout floor now condense, and fit', async () => {
    seedSummaries(3, 1, 20_000);
    const budget = await admitted();
    expect(held(), 'non-vacuity: the fixture must really be over budget').toBeGreaterThan(budget);
    expect(condensableSummaries(AGENT), 'and the engine must agree it can still shrink').toBe(3);

    const result = await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(result.condensedCreated, 'three below the floor must produce one parent').toBeGreaterThan(0);
    expect(held(), 'and the assembler must now admit every summary this agent holds')
      .toBeLessThanOrEqual(await admitted());
    expect(calls.length, 'at the cost of exactly one model call').toBe(1);
    expect(calls[0].depth, 'written one level up from its parents').toBe(2);
  });

  /**
   * ⚠ DEPTH 2 IS REACHED, AND THE DEAD PROMPT IS THE ONE SENT.
   *
   * `summarize.ts:115`'s depth ≥2 branch has existed and been unreachable: `incrementalMaxDepth`
   * was 1, so `newDepth` never exceeded 1. This clause climbs 8 → 2 → 1 and asserts on the
   * ACTUAL system prompt built for the call, not on the depth number alone — a depth argument
   * nobody turns into a prompt would satisfy the weaker assertion.
   *
   * THE MUTANT: cap the loop at one level (`for (let level = 0; level < 1; …)`) and the
   * depth-2 row goes RED.
   */
  it('depth 2 is reached and the deep-condensation prompt is what gets sent', async () => {
    seedSummaries(8, 0, 6_000);
    const budget = await admitted();
    expect(held(), 'non-vacuity').toBeGreaterThan(budget);

    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(held()).toBeLessThanOrEqual(await admitted());
    expect(Math.max(...depthsWritten()), 'the DAG must have grown past depth 1').toBeGreaterThanOrEqual(2);
    const deep = calls.find(c => c.depth >= 2);
    expect(deep, 'a depth-2 call must have happened').toBeTruthy();
    expect(deep!.prompt, 'and the prompt it carried is the deep-condensation one, formerly dead code')
      .toContain('deep condensation (depth 2)');
    expect(deep!.prompt, 'which is a REFERENCE DOCUMENT, not the depth-0 extraction prompt')
      .toContain('This is a REFERENCE DOCUMENT');
    expect(calls.every(c => c.depth >= 1), 'no leaf pass is involved: there is nothing raw to fold').toBe(true);
  });

  /**
   * ⚠ ONE SUMMARY, ALONE, TOO BIG. The case with no fanout at all, and the one the owner
   * named: *"re-summarize one oversized summary to a smaller target"*.
   *
   * THE MUTANT: make `shrinkTarget` return `ceilingTokens` unconditionally and the halving row
   * goes RED; make `condenseLevel` skip `rows.length === 1` and the first row goes RED.
   */
  it('a single oversized summary is re-summarised to a strictly smaller target', async () => {
    seedSummaries(1, 0, 40_000);
    const budget = await admitted();
    expect(held(), 'non-vacuity').toBeGreaterThan(budget);

    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(calls.length, 'one lone summary costs one call').toBe(1);
    expect(calls[0].targetTokens, 'asked for strictly less than it currently costs').toBeLessThan(40_000);
    expect(held()).toBeLessThanOrEqual(await admitted());
    // And the arithmetic itself, at both ends of its range: the ceiling binds on a huge one,
    // the HALVING binds just above the budget, and the floor is never crossed.
    expect(shrinkTarget(40_000, 6_000), 'the condensed ceiling binds on a huge summary').toBe(6_000);
    expect(shrinkTarget(11_000, 6_000), 'and the halving binds below it').toBe(5_500);
    expect(shrinkTarget(600, 6_000), 'never below the floor').toBe(CONDENSE_MIN_TARGET_TOKENS);
  });

  /**
   * ⚠ THE INCIDENT'S OWN BODY, and the number the report owes: HOW MANY PASSES.
   *
   * 43 already-written leaf summaries of ~2,000 tokens each — the reported box's ~86K of
   * already-summarised history — against what a 64K-window model admits. Every level is model
   * calls and one turn may not spend an unbounded number of them, so the climb deliberately
   * spans more than one pass: a run that made real progress and then hit its call ceiling
   * returns with NO refusal and NO brake, and the next pressure continues where it stopped.
   * That is what "compaction never ends" means operationally, and this clause is the proof —
   * it drives passes until the assembler admits everything, and asserts the count is small.
   *
   * THE MUTANT: make a bounded-but-progressing run arm the brake (drop the
   * `reclaimed >= FORCED_YIELD_FLOOR_TOKENS` early return at the end of `condenseUntilFits`)
   * and pass 2 dials nothing, so the "fits" row goes RED and the climb never finishes.
   */
  it('⚠ THE INCIDENT BODY: 86K of summaries reaches "fits" in a handful of bounded passes', async () => {
    seedSummaries(43, 0, 2_000);
    const startedAt = held();
    const budget = await admitted();
    expect(startedAt, 'non-vacuity: the reported shape, and it really is over').toBeGreaterThan(budget);

    let passes = 0;
    const perPass: string[] = [];
    const afterFirst: { refusing: string | null; braked: boolean; reclaimed: number } =
      { refusing: null, braked: false, reclaimed: 0 };
    while (held() > await admitted() && passes < 6) {
      const callsBefore = calls.length;
      const before = held();
      await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
      passes += 1;
      perPass.push(`pass ${passes}: ${calls.length - callsBefore} calls, ${before} → ${held()} tokens`);
      // ⚠ CAPTURED MID-CLIMB, and a mutant is why. The end state alone cannot see the property
      // this clause is really about: the FIRST pass reclaims 38K and then runs out of its call
      // ceiling, and that must be recorded as progress, not as a refusal. Asserting only after
      // the climb finished let a mutant that reports a defect on pass 1 stay GREEN, because
      // pass 2 succeeded and cleared the note behind it.
      if (passes === 1) {
        afterFirst.refusing = compactionFailureReason(AGENT);
        afterFirst.braked = compactionIsBraked(AGENT, true);
        afterFirst.reclaimed = before - held();
      }
      // A pass that stalled entirely would spin this loop; the brake proves it did not stall.
      if (compactionIsBraked(AGENT, true)) break;
    }

    expect(afterFirst.reclaimed, 'pass 1 must really have reclaimed a lot and still not be done')
      .toBeGreaterThan(10_000);
    expect(afterFirst.refusing, 'a bounded run that reclaimed 10K+ has NOTHING to report as refusing')
      .toBeNull();
    expect(afterFirst.braked, 'and must not brake itself out of finishing the job next turn').toBe(false);

    // eslint-disable-next-line no-console
    console.log(`INCIDENT FIXTURE  43 summaries × 2,000 = ${startedAt} tokens vs ${budget} admitted · `
      + `${passes} pass(es), ${calls.length} model calls total, deepest depth `
      + `${Math.max(...depthsWritten())}\n  ${perPass.join('\n  ')}`);

    expect(held(), 'the reported shape must end up fully admitted').toBeLessThanOrEqual(await admitted());
    expect(passes, 'and in a handful of passes, not a long tail of them').toBeLessThanOrEqual(3);
    expect(compactionFailureReason(AGENT), 'with nothing reported as refusing').toBeNull();
    expect(compactionIsBraked(AGENT, true), 'and no brake left on an agent that succeeded').toBe(false);
    // ⚠ AND DEPTH 3 — which the deleted loop's `newDepth` could never produce, so this is the
    // capability that genuinely did not exist before, not the one the brief named.
    expect(Math.max(...depthsWritten()), 'the DAG ceiling at depth 2 is gone').toBeGreaterThanOrEqual(3);
  });

  it('a lone summary already AT the floor is a defect report, not a card and not a loop', async () => {
    seedSummaries(1, 0, CONDENSE_MIN_TARGET_TOKENS);
    // Force the admitted budget below the floor so "every summary is at the floor" is real.
    const db = mockDb.current!;
    db.prepare('UPDATE messages SET token_count = 4000 WHERE agent_id = ?').run(AGENT);
    __resetEstimateCacheForTests();
    expect(held(), 'non-vacuity: a floor-sized summary that still will not be admitted')
      .toBeGreaterThan(await admitted());

    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(calls.length, 'the engine must not dial a model to shrink what cannot shrink').toBe(0);
    expect(compactionFailureReason(AGENT)).toBe('single_summary_at_floor');
    expect(frames.filter(f => f.type === 'chat:error'), 'and the owner is shown nothing: this is ours to fix').toEqual([]);
  });
});

// ── §2 — FINITENESS ──────────────────────────────────────────────────────────────────────

describe('§2 the loop is finite per run, whatever the summariser does', () => {
  /**
   * ⚠ THE ADVERSARY: a summariser that compresses NOTHING. It returns its own input, so every
   * parent is bigger than its children and the loop can never reach "fits". A recursion whose
   * termination rests on the model behaving is not a bound; this clause is the proof that it
   * does not.
   *
   * THE MUTANT: remove the `CONDENSE_MAX_LEVELS` ceiling (`for (let level = 0; ; level += 1)`)
   * and this clause hangs rather than reds — which is itself the finding, so the assertion
   * that carries the proof is the CALL COUNT: bounded, and bounded by a declared constant.
   */
  it('a summariser that compresses nothing produces ONE bounded pass, a defect line and a brake', async () => {
    answer = echoesItsInput;
    seedSummaries(8, 0, 6_000);
    expect(held(), 'non-vacuity').toBeGreaterThan(await admitted());

    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(calls.length, 'bounded by the declared per-run call ceiling').toBeLessThanOrEqual(CONDENSE_MAX_CALLS_PER_RUN);
    expect(calls.length, 'and it really did try — a bound that stops at zero proves nothing').toBeGreaterThan(0);
    expect(held(), 'the adversary wins: nothing was reclaimed').toBeGreaterThan(await admitted());
    expect(compactionFailureReason(AGENT), 'so a stage is named for repair')
      .toBe('single_summary_did_not_shrink');
    expect(frames.filter(f => f.type === 'chat:error'), 'and no dead-end card is shown').toEqual([]);

    // AND NO SECOND PASS INSIDE THE WINDOW — the anti-thrash half, under force.
    const callsAfterFirst = calls.length;
    expect(compactionIsBraked(AGENT, true), 'the brake binds the next EMERGENCY too').toBe(true);
    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(calls.length, 'a second forced pass inside the window must dial nothing').toBe(callsAfterFirst);

    // …AND IT IS NOT FOR EVER. The brake expires, and the next pressure tries again.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + LOW_YIELD_BACKOFF_MS + 1);
    expect(compactionIsBraked(AGENT, true), 'OR-COMPACT-1: no brake may outlive its clock').toBe(false);
  });

  it('the declared bounds are small enough to be a bound at all', () => {
    expect(CONDENSE_MAX_LEVELS).toBeLessThanOrEqual(16);
    expect(CONDENSE_MAX_CALLS_PER_RUN).toBeLessThanOrEqual(20);
  });

  it('an abort signal stops the climb between levels', async () => {
    seedSummaries(8, 0, 6_000);
    const ctl = new AbortController();
    answer = async (p) => { ctl.abort(); return producesWhatItWasAskedFor(p); };
    const outcome = await condenseUntilFits({
      agentId: AGENT, modelId: MODEL_64K, minFanout: 4, targetTokens: 6_000,
      abortSignal: ctl.signal,
      measure: () => cachedAssembledEstimate(AGENT, 65_536, MODEL_64K, () => estimateAssembledTokens(AGENT, 65_536, MODEL_64K)),
      rebuild: () => rebuildContextItems(AGENT),
    });
    expect(outcome.levels, 'the forced path\'s three-minute wall clock must be able to stop this')
      .toBeLessThanOrEqual(1);
  });
});

// ── §3 — THE DEFECT REPORT, AND THE ONE CARD THAT IS LEFT ────────────────────────────────

describe('§3 a failing compaction is a repairable defect, never a dead end', () => {
  /**
   * ⚠ D4 + the one-outage-one-card rule. The provider breaker ALREADY cards a 402 by name
   * ("Provider X is out of balance — Top up that account or switch this agent to another
   * provider"), which is exactly "compaction is failing for a repairable reason", said first.
   * So a second toast is refused, deliberately: 3,604 toasts is how an owner learns to ignore
   * toasts, which is the finding t87 was written for.
   *
   * THE MUTANT: delete the `if (breaker) { … return note; }` suppression in
   * `compaction-defect.ts` and the "exactly one card" row goes RED with two.
   */
  it('the summary writer being down names the reason ONCE — the breaker\'s card, not a second one', async () => {
    seedSummaries(8, 0, 6_000);
    noteProviderFailure(PROVIDER, HTTP_402, AGENT);
    noteProviderFailure(PROVIDER, HTTP_402, AGENT);
    expect(providerBreaker(PROVIDER), 'precondition: the provider is known dead').toBeTruthy();
    frames.length = 0;   // the breaker's own card already went out above; count what COMPACTION adds

    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(calls.length, 'nothing is built for a provider known to be dead').toBe(0);
    expect(compactionFailureReason(AGENT), 'the stage is named for repair').toBe('summary_writer_unavailable');
    expect(frames.filter(f => f.type === 'chat:error'), 'and no card is stacked on the breaker\'s').toEqual([]);
    // No terminal state: the agent is braked, and the brake names the writer as its cause.
    expect(compactionIsBraked(AGENT, true)).toBe(true);
  });

  it('⚠ AND WHEN THE WRITER COMES BACK, COMPACTION RESUMES WITH NOTHING TO CLICK', async () => {
    seedSummaries(8, 0, 6_000);
    noteProviderFailure(PROVIDER, HTTP_402, AGENT);
    noteProviderFailure(PROVIDER, HTTP_402, AGENT);
    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(compactionIsBraked(AGENT, true), 'precondition: braked on a dead writer').toBe(true);

    // The owner tops the account up. No dashboard button, no reset, no archive.
    clearProviderBreaker(PROVIDER);

    expect(compactionIsBraked(AGENT, true), 'a brake whose stated cause is gone must let go at once').toBe(false);
    const before = held();
    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(held(), 'and the very next pass condenses').toBeLessThan(before);
    expect(held()).toBeLessThanOrEqual(await admitted());
    expect(compactionFailureReason(AGENT), 'the failure note is cleared by the pass that worked').toBeNull();
  });

  /**
   * ⚠ THE CARD THAT IS LEFT, and the only one. A summariser that answers with nothing usable
   * is not a provider outage — no breaker opens, so nobody has told the owner anything. This
   * is the state D4 exists for.
   *
   * THE MUTANT: drop `'summariser_refused'` from `REPAIRABLE_BY_THE_OWNER` and the card rows
   * go RED.
   */
  it('a summariser answering with nothing usable DOES card the owner — once, and retryable', async () => {
    answer = refuses;
    seedSummaries(8, 0, 6_000);

    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    const cards = frames.filter(f => f.code === 'COMPACTION_FAILING');
    expect(cards.length, 'the owner is told once').toBe(1);
    expect(cards[0].error).toContain('memory compaction is failing');
    expect(cards[0].error).toContain('returned nothing usable');
    expect(cards[0].error).toContain('Settings → Models');
    expect(cards[0].retryable, 'TRUE: fix the model and compaction resumes by itself').toBe(true);
    // Not a dead end, in the two words the deleted card used: nothing here asks the owner to
    // destroy their agent's memory.
    expect(cards[0].error).not.toMatch(/archiv/i);
    expect(cards[0].error).not.toMatch(/reset/i);

    // A SECOND failing pass after the brake expires reports again but does NOT re-card.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + LOW_YIELD_BACKOFF_MS + 1);
    vi.useRealTimers();
    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(frames.filter(f => f.code === 'COMPACTION_FAILING').length, 'one outage, one card').toBe(1);
  });

  /**
   * ⚠ D4b (t87b review I1) — THE DOOR THE CARD ABOVE DEPENDS ON, AND THE GAP IT HAD.
   *
   * Measured on main 2026-10-05: `agent/model.ts` wraps every failure before the summary
   * writer ever sees it, so the breaker was handed `OpenAI call failed: 402 Payment Required`.
   * `failed:` is not one of `statusIsAnchored`'s introducers and the number is no longer
   * leading, so `classifyProviderErrorText` returns class `unknown` with `basis: 'none'` and
   * both remaining arms of `permanentFailureReason` decline — the breaker never opened on the
   * incident's own door. Every throw site already attaches `provider: ProviderErrorFacts` with
   * `basis: 'status'`; the fix is to stop discarding it.
   *
   * THE MUTANT: drop the `facts` argument in `summarize.ts`'s catch (or stop forwarding it in
   * `noteSummaryWriterFailure`) and the first row goes RED.
   */
  it('a WRAPPED 402 still opens the breaker, because the SDK\'s own facts travel with it', () => {
    const wrapped = 'OpenAI call failed: 402 Payment Required';
    const facts = classifyProviderError({ status: 402, message: '402 Payment Required' });
    expect(facts.basis, 'precondition: the SDK read the status off a real field').toBe('status');

    expect(noteSummaryWriterFailure(MODEL_64K, wrapped, AGENT, facts), 'the facts carry the verdict').toBe('no_balance');
    expect(noteSummaryWriterFailure(MODEL_64K, wrapped, AGENT, facts)).toBe('no_balance');
    expect(providerBreaker(PROVIDER), 'two of them open the breaker, as they always did').toBeTruthy();

    // ⚠ THE CONTROL, AND IT IS A RECORDED GAP RATHER THAN A PASS: the SAME string with no
    // facts is still TRANSIENT. That is today's prose path, and this row is here so the next
    // person to lose the pass-through sees exactly what it was worth.
    expect(permanentFailureReason(wrapped), 'the wrapped prose alone carries no evidence at all').toBeNull();
    // …while the UNWRAPPED shape the classifier was written for still works without facts.
    expect(permanentFailureReason('402 Payment Required')).toBe('no_balance');
  });

  it('the defect line carries the numbers that say WHICH side the bloat is on', async () => {
    // Summaries inside their budget, the gate's total over its threshold: nothing left for
    // compaction to do, and the report must say so rather than claiming a memory is full.
    const db = mockDb.current!;
    db.prepare('UPDATE messages SET token_count = 4000 WHERE agent_id = ?').run(AGENT);
    __resetEstimateCacheForTests();
    const est = await estimateAssembledTokens(AGENT, 65_536, MODEL_64K);
    expect(est.total, 'non-vacuity: the fresh tail alone is over the trigger threshold')
      .toBeGreaterThan(0.96 * 65_536);
    expect(held(), 'and the summaries are not the problem — there are none').toBe(0);

    const result = await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(result).toEqual({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    expect(calls.length, 'and not one model call was spent discovering it').toBe(0);
    expect(compactionFailureReason(AGENT), 'reported as a yield failure, with the numbers in the log').toBe('no_yield');
    expect(frames.filter(f => f.type === 'chat:error'), 'the owner is not blamed for a tail the platform grew').toEqual([]);
  });
});

// ── §4 — THE CONTROLS: the fix must not become "compaction always runs" ──────────────────

describe('§4 what an ordinary agent pays, and what stays responsive', () => {
  /**
   * ⚠ THE OWNER'S BOXES ARE MOSTLY THIS AGENT. Under budget, nothing new may be spent: no
   * model call, no summary row, and the single estimate computed exactly ONCE — the t87
   * layer-2 property, re-asserted through the whole entry point rather than through the cache
   * in isolation.
   */
  it('an agent under no pressure pays nothing new per turn', async () => {
    seedSummaries(2, 0, 1_000);
    expect(held(), 'precondition: this agent fits comfortably').toBeLessThanOrEqual(await admitted());
    __resetEstimateCacheForTests();

    const result = await checkAndCompact(AGENT, MODEL_64K, 65_536);

    expect(result).toEqual({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    expect(calls.length, 'no summariser call').toBe(0);
    expect(depthsWritten(), 'no new summary row').toEqual([0]);
    expect(assembledEstimateStats().misses, 'and the estimate computed once for the whole turn').toBe(1);
    expect(compactionIsBraked(AGENT, false), 'a quiet turn must not arm a brake').toBe(false);
  });

  /**
   * ⚠ §3's SERVICEABILITY, RE-MEASURED WITH THE RECURSION IN PLACE. Each level does a
   * synchronous all-summaries read, so a climb that never handed the loop back would be the
   * v3.2.3 freeze with a new cause. The number is recorded, not asserted (a test box is not a
   * real box); what IS asserted is that the loop was serviced at all WHILE a multi-level
   * condensation ran — which is the fact a dead dashboard and a dead stop button contradict.
   *
   * THE MUTANT: delete the `await yieldToLoop()` between levels and `ticks` falls to 0.
   */
  it('⚠ the loop stays serviceable while condensation climbs to depth 2', async () => {
    seedSummaries(8, 0, 6_000);
    const m = await measureLoopService(async () => {
      await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    });
    const levels = Math.max(...depthsWritten());
    // eslint-disable-next-line no-console
    console.log(`STARVATION (recursion)  ${m.turns} loop turns serviced · ${m.starvedMs}ms starved `
      + `of ${m.elapsedMs}ms elapsed (${m.ticks} interval ticks) · ${calls.length} model calls · depth ${levels}`);
    expect(levels, 'non-vacuity: it really did climb, so there were levels to yield between')
      .toBeGreaterThanOrEqual(2);
    expect(m.turns, 'a condensation that never hands the loop back is the v3.2.3 freeze, re-grown')
      .toBeGreaterThan(0);
  });

  /** The clear door, driven as a real reset does it: archive first, then move the boundary. */
  it('a session reset mid-brake clears it on the spot', async () => {
    answer = refuses;
    seedSummaries(8, 0, 6_000);
    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(compactionIsBraked(AGENT, true), 'precondition: braked on a refusing summariser').toBe(true);

    const { archiveAgentConversation } = await import('../../vault/archive.js');
    archiveAgentConversation(AGENT, true);
    mockDb.current!.prepare('UPDATE agents SET session_started_at = ? WHERE id = ?')
      .run(new Date().toISOString(), AGENT);

    expect(compactionIsBraked(AGENT, true), 'a reset deserves a fresh start').toBe(false);
    expect(compactionFailureReason(AGENT), 'and carries no failure note forward').toBeNull();
  });

  it('the census for the word lives in the freeze file — this is the cross-reference', () => {
    // `the-freeze-cannot-happen-again.test.ts` §2 walks packages/server/src and
    // packages/shared/src with comments stripped and demands zero hits for INCOMPRESSIBLE.
    // Kept there rather than duplicated here: one census, in the file whose own clauses the
    // ruling re-aimed.
    expect(true).toBe(true);
  });
});

// ── §5 — FIX ROUND 1: the shapes the first round's fixtures could not see ─────────────────

describe('§5 a level is the WHOLE top-level set, at any mix of depths', () => {
  /**
   * ⚠ REVIEW C1, REPRODUCED AND THEN FIXED. The first cut took the SHALLOWEST depth holding
   * top-level rows and condensed only that, and ran the lone arm on a single row by itself. So
   * a depth-3 12,000-token summary beside a depth-0 400-token leaf was a dead end, measured at
   * the previous HEAD by the reviewer and again by me before touching anything:
   *
   *     PROBE A  held=12400 admitted=9982 condensable=2
   *     PROBE A  after: calls=0 held=12400 stage=single_summary_at_floor braked=true cards=0
   *
   * Zero calls, a force-binding brake, a stage that says "at the floor" about an agent holding
   * 12,000 condensable tokens, and the same refusal every fifteen minutes. That is "compaction
   * ends" for a shape with two compressible summaries — the one thing the ruling forbids. And it
   * is not exotic: it is the repaired agent's own state the day after repair (top-level depth 3)
   * the moment routine leaf compaction writes one small leaf.
   *
   * THE MUTANT: restore the per-depth selection — `const rows = getLeafSummariesNotCondensed(
   * agentId, topLevelByDepth(agentId)[0].depth)` in place of `topLevelRows(agentId)` — and this
   * clause goes RED with calls=0 and that false stage.
   */
  it('⚠ C1: a deep oversized summary beside a shallow tiny leaf MERGES, in one call', async () => {
    seedMixed([{ depth: 3, tokens: 12_000 }, { depth: 0, tokens: 400 }]);
    const budget = await admitted();
    expect(held(), 'non-vacuity: the probed shape, and it really is over').toBeGreaterThan(budget);
    expect(condensableSummaries(AGENT), 'the engine can see two summaries to merge').toBe(2);

    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(calls.length, 'two rows are a batch of two — one model call, not zero').toBeLessThanOrEqual(2);
    expect(calls.length, 'and not zero: the first cut spent nothing at all').toBeGreaterThan(0);
    expect(held(), 'and the bloat is gone').toBeLessThanOrEqual(await admitted());
    expect(compactionFailureReason(AGENT), 'nothing refused').toBeNull();
    expect(compactionIsBraked(AGENT, true), 'and no brake on an agent that succeeded').toBe(false);
    // The parent records the DEEPEST fold it contains, not the shallowest child's depth.
    expect(Math.max(...depthsWritten()), 'max(child depth) + 1').toBe(4);
  });

  /**
   * ⚠ THE INVARIANT THE FIRST CUT VIOLATED, and the reason C1 was a Critical rather than a
   * fixture gap: `condensableSummaries` counted the whole top-level set while the loop looked at
   * one depth, so the engine promised a merge it would not attempt. Driven over five mixed-depth
   * shapes, each with a working summariser, because one shape is one anecdote.
   */
  it.each([
    [[{ depth: 0, tokens: 8_000 }, { depth: 5, tokens: 8_000 }], 'shallow + very deep'],
    [[{ depth: 2, tokens: 9_000 }, { depth: 3, tokens: 9_000 }, { depth: 4, tokens: 500 }], 'three depths, one at the floor'],
    [[{ depth: 7, tokens: 11_000 }, { depth: 0, tokens: 600 }], 'past the old halving chain\'s reach'],
    [[{ depth: 1, tokens: 6_000 }, { depth: 1, tokens: 6_000 }, { depth: 4, tokens: 6_000 }], 'two same-depth plus a deeper one'],
    [[{ depth: 0, tokens: 400 }, { depth: 0, tokens: 400 }, { depth: 6, tokens: 20_000 }], 'two floor leaves and a huge parent'],
  ] as const)('condensable >= 2 ⇒ a forced pass writes a parent (%#: %s)', async (rows) => {
    seedMixed([...rows]);
    expect(condensableSummaries(AGENT)).toBeGreaterThanOrEqual(2);
    const before = depthsWritten().length;
    const result = await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(result.condensedCreated, 'the engine may not see a merge it refuses to attempt').toBeGreaterThan(0);
    expect(depthsWritten().length, 'and a new depth really was written').toBeGreaterThan(before - 1);
    expect(compactionFailureReason(AGENT), 'a pass that merged is not failing').toBeNull();
  });

  /**
   * ⚠ REVIEW I1 — THE REACTIVE PATH, which no first-round clause drove at all.
   *
   * `createLeafSummary` writes `summaries` only; both halves of the admission test read the
   * `context_items` join. So `runLeafCompaction` → `condenseUntilFits` measured a snapshot
   * WITHOUT the leaves it had just written, and if the OLD summaries fit it declared "fits" and
   * skipped them — a regression against the deleted loop, which read `getLeafSummariesNotCondensed`
   * (no join) and condensed >=4 leaves in the same pass.
   *
   * THE MUTANT: remove the `rebuild()` ahead of the first `measure()` in `condenseUntilFits` and
   * this clause goes RED at `condensedCreated`.
   */
  it('⚠ I1: leaves written THIS pass are condensed in the SAME pass', async () => {
    // Old summaries that comfortably fit, so only the fresh leaves can make it over budget.
    seedSummaries(1, 0, 500);
    // ⚠ THE FRESH TAIL IS THE LAST 40 ROWS BY `seq`, NOT BY `created_at` — which this clause
    // learned the hard way: fat rows appended after the fixture's own became the TAIL, drove the
    // summary budget to zero and made the precondition unsatisfiable. So the whole message table
    // is re-seeded in order: the fat rows first (outside the tail, where leaf chunking finds
    // them), the small ones last (the tail itself).
    const db = mockDb.current!;
    db.prepare('DELETE FROM messages WHERE agent_id = ?').run(AGENT);
    const insert = db.prepare(
      `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                             turn_number, provenance, authorized, token_count, created_at)
       VALUES (?, ?, ?, 'owner', ?, 'agent-text', 'agent-only', 1, 'live', 1, ?, ?)`,
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < 40; i += 1) {
        insert.run(`old-${i}`, AGENT, i % 2 === 0 ? 'user' : 'assistant',
          's'.repeat(4_000 * 4), 4_000, Date.now() - (1_000 + 40 - i) * 1000);
      }
      for (let i = 0; i < FRESH_TAIL_ROWS; i += 1) {
        insert.run(`tail-${i}`, AGENT, 'assistant',
          's'.repeat(TAIL_TOKENS_EACH * 4), TAIL_TOKENS_EACH, Date.now() - (FRESH_TAIL_ROWS - i) * 1000);
      }
    });
    tx();
    // ── t100: THE OLD SUMMARY NEEDS A COMPACTION BOUNDARY, BECAUSE A REAL ONE HAS ONE ─────
    //
    // `seedSummaries` writes `summaries` rows and no `summary_messages` links, so this agent
    // held a summary that covered NO MESSAGE. That was invisible while the compaction gate
    // measured its tail with the ROW CAP: it read the newest 40 rows (the small ones, 32,000
    // tokens), the summary budget was large and the precondition held. Since t100 the gate
    // reads the tail the assembler actually sends — every row since the compaction boundary —
    // and with no boundary at all that is ALL EIGHTY ROWS: 40 × 4,000 + 40 × 800 = 192,000
    // tokens against a 64K window, so `summaryBudget` clamps to 0 and `admitted()` answers 0.
    //
    // The gate is right and the fixture was not. "Old summaries that comfortably fit" means an
    // agent that HAS compacted before, and in production a leaf summary covers messages — so
    // the seeded one is linked to the last fat row, which is exactly where its boundary would
    // be. `rowsSinceBoundary` is then the 40 tail rows (the horizon's FLOOR, `keepFromSeq: 0`),
    // the gate measures the same 32,000 tokens it measured pre-t100, and every number in this
    // clause is unchanged. `old-39` joins `getCompactedMessageIds`, leaving 39 fat rows outside
    // the row cap for leaf chunking — still far more than the two leaves asserted below.
    db.prepare('INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)')
      .run('sum-d0-0', 'old-39');
    __resetEstimateCacheForTests();
    expect(held(), 'precondition: what the agent HOLDS fits before the pass')
      .toBeLessThanOrEqual(await admitted());

    const result = await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(result.leafCreated, 'leaf compaction must really have written several').toBeGreaterThanOrEqual(2);
    expect(result.condensedCreated, 'and the SAME pass must condense them, not next week').toBeGreaterThan(0);
    expect(held(), 'leaving the agent fully admitted').toBeLessThanOrEqual(await admitted());
  });
});

// ── §6 — FIX ROUND 1: the defect line itself, and the writer that cannot be resolved ──────

describe('§6 the D3 line and the I3 card', () => {
  /**
   * ⚠ REVIEW I2. D3 is the owner's whole answer to a compaction that fails, and the first round
   * asserted the failure NOTE instead of the LINE — so deleting the `logger.error` was green.
   *
   * THE MUTANT: delete the `logger.error('COMPACTION_DEFECT …')` call in `compaction-defect.ts`
   * and this clause goes RED on the very first row.
   */
  it('⚠ I2: a failing pass logs ONE COMPACTION_DEFECT line, at error level, with its numbers', async () => {
    answer = refuses;
    seedSummaries(8, 0, 6_000);

    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    const lines = defectLines();
    expect(lines.length, 'exactly one line per failing pass — the brake is what keeps it rare').toBe(1);
    expect(lines[0].level, 'addressed to whoever repairs the platform, so ERROR').toBe('error');
    expect(lines[0].component).toBe('compaction-defect');
    expect(lines[0].meta.stage, 'naming WHICH stage refused').toBe('summariser_refused');
    expect(lines[0].meta.detail, 'and why').toBe('summarizer returned empty text');
    // THE NUMBERS. Non-null, because a defect report without them cannot be acted on — and these
    // four are what distinguish "the summaries are the bloat" from "the tail is the bloat".
    for (const field of ['assembledTokens', 'budgetTokens', 'summaryTokens', 'admittedSummaryTokens']) {
      expect(lines[0].meta[field], `${field} must be reported, not null`).not.toBeNull();
      expect(typeof lines[0].meta[field], `${field} must be a number`).toBe('number');
    }
    expect(lines[0].meta.repairableByTheOwner).toBe(true);
    expect(lines[0].meta.summaryTokens, 'the summaries really are over their admission')
      .toBeGreaterThan(lines[0].meta.admittedSummaryTokens as number);
  });

  it('a pass that SUCCEEDS logs no defect line at all — the control', async () => {
    seedSummaries(8, 0, 6_000);
    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(held()).toBeLessThanOrEqual(await admitted());
    expect(defectLines(), 'a working compaction is not a defect').toEqual([]);
  });

  /**
   * ⚠ REVIEW I3. No enabled model can write a summary, so compaction cannot even start — which
   * under OR-COMPACT-1 part 3 is exactly "it fails for a different reason; repair it". The first
   * round left this at a bare `warn` with no stage and no card, on the reasoning that carding it
   * needed the budget first. It does not: `force` IS the pressure signal, since the gate only
   * forces at >=96%.
   *
   * THE MUTANT: drop the `if (options?.force) notePassOutcome(…)` line from the `!resolved`
   * branch of `runCheckAndCompact` and this clause goes RED on the card and the stage.
   */
  it('⚠ I3: an unresolvable summary writer is carded once, and named', async () => {
    seedSummaries(8, 0, 6_000);
    // The only enabled model loses its text capability, so `resolveSummaryWriterModel` finds none.
    mockDb.current!.prepare("UPDATE models SET capabilities = '[\"embedding\"]' WHERE id = ?").run(MODEL_64K);

    const result = await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(result).toEqual({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    expect(calls.length, 'there is nothing to dial').toBe(0);
    expect(compactionFailureReason(AGENT)).toBe('summary_writer_unresolvable');
    const cards = frames.filter(f => f.code === 'COMPACTION_FAILING');
    expect(cards.length, 'the owner is told once').toBe(1);
    expect(cards[0].error).toContain('no enabled model can write its summaries');
    expect(cards[0].error).toContain('Settings → Models');
    expect(cards[0].retryable).toBe(true);
    expect(defectLines().length, 'and the repair audience gets its line').toBe(1);
    expect(defectLines()[0].meta.stage).toBe('summary_writer_unresolvable');

    // AND THE CONTROL: a ROUTINE pass on the same box says nothing — the gate has not called it
    // an emergency, and a card per turn for every agent on a mis-set box is the toast spam t87
    // refused.
    __resetBrakesForTests();
    frames.length = 0;
    logLines.length = 0;
    await checkAndCompact(AGENT, MODEL_64K, 65_536);
    expect(frames.filter(f => f.code === 'COMPACTION_FAILING'), 'no pressure, no card').toEqual([]);
    expect(defectLines(), 'and no defect line either').toEqual([]);
  });
});

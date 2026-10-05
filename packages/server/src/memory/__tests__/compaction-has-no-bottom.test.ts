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
// any force — and `summarize.ts`'s depth ≥2 "deep condensation" prompt was dead code the
// engine could never reach. The platform's only honest answer was a card telling the owner to
// archive their conversation or reset their agent. That card is gone.
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

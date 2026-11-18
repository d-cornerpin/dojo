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
// the real summary DAG writes and reads, the real provider breaker, and
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-or-compact-1', 'dojo.db'),
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
interface SummaryCall { depth: number; targetTokens: number; contentTokens: number; prompt: string; spanOpen?: boolean }
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
    generateSummary: async (p: { depth: number; targetTokens: number; content: string; spanOpen?: boolean }) => {
      calls.push({
        depth: p.depth, targetTokens: p.targetTokens, spanOpen: p.spanOpen,
        contentTokens: Math.ceil(p.content.length / 4),
        prompt: actual.getDepthPrompt(p.depth, p.targetTokens),
      });
      return answer(p);
    },
  };
});

import { runMigrations } from '../../db/migrations.js';
import { checkAndCompact, estimateAssembledTokens } from '../compaction.js';
import { mergeUntriedNotes } from '../merge-notes.js';
import { compactionIsBraked, LOW_YIELD_BACKOFF_MS, __resetBrakesForTests } from '../compaction-brakes.js';
import { compactionFailureReason } from '../compaction-defect.js';
import { __resetEstimateCacheForTests } from '../assembled-estimate-cache.js';
import {
  noteProviderFailure, noteProviderSuccess, permanentFailureReason,
  providerBreaker, __resetBreakersForTests,
} from '../../providers/billing-breaker.js';
import { classifyProviderError } from '../../agent/provider-error.js';
import { heldSummaryTokens } from './helpers/held-summary-tokens.js';

const AGENT = 'agent-no-bottom';
const PROVIDER = 'prov-under-test';
/** The reported box's cloud row: a 64K window, whose fresh tail count is 40. */
const MODEL_64K = 'm-cloud-64k';
const FRESH_TAIL_ROWS = 40;
/** 40 × 100 = 4,000 tokens of live conversation. t194: this was 800 each, "which is what makes the
 *  summary budget small" — a relation of the deleted phantom budget (0.7 × what the tail left). The
 *  gauge is the assembler's own fit, whose summaries lane is capped at its ceiling whatever the tail
 *  does (the cached phase is granted first), so the tail is kept inside the protected recent part and
 *  these clauses stay about condensation alone. */
const TAIL_TOKENS_EACH = 100;
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

/**
 * A SEEDED SUMMARY COVERS A MESSAGE, because a real box's summary does (t111-B2).
 *
 * `seedSummaries` and `seedMixed` used to write `summaries` rows and NO `summary_messages`
 * links, so every fixture here held summaries that covered nothing — a boundary-less agent a
 * real box cannot produce. t100 already hit this for one clause further down (see its note
 * around `old-39`) and linked that summary by hand; this does the same thing
 * once, for every seeder, so the shape is right by construction rather than per clause.
 *
 * ⚠ WHAT THIS DOES AND DOES NOT BUY, stated so nobody reads more into it. It closes the
 * STRUCTURAL lie (a summary covering no message). It does NOT make the agent look like one
 * that has genuinely compacted before: the link goes to the OLDEST message the agent holds, so
 * the compaction boundary sits at the very start and `rowsSinceBoundary` is still effectively
 * every row — which is exactly why every clause's numbers are unchanged. Making the fixture
 * boundary-REALISTIC (the link after the old rows, leaving a tail, as t100's one-off does)
 * moves numbers in many clauses and wants its own item.
 */
function linkSeededSummaries(ids: readonly string[]): void {
  const db = mockDb.current!;
  const oldest = db.prepare(
    'SELECT id FROM messages WHERE agent_id = ? ORDER BY created_at ASC LIMIT 1',
  ).get(AGENT) as { id: string } | undefined;
  if (!oldest) return;   // no messages yet: nothing to cover, and nothing to pretend about
  const link = db.prepare(
    'INSERT OR IGNORE INTO summary_messages (summary_id, message_id) VALUES (?, ?)',
  );
  for (const id of ids) link.run(id, oldest.id);
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
  linkSeededSummaries(Array.from({ length: count }, (_, i) => `sum-d${depth}-${i}`));
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
  linkSeededSummaries(rows.map((r, i) => `mix-${i}-d${r.depth}`));
}

/** What the single estimate says the assembler will ADMIT of this agent's summaries. */
async function admitted(): Promise<number> {
  return (await estimateAssembledTokens(AGENT, 65_536, MODEL_64K)).summaryTokens;
}

/** The raw cost of the summaries the agent actually holds. */
const held = (): number => heldSummaryTokens(mockDb.current!, AGENT);

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

describe('§1 a forced pass merges notes of one depth, level over level, while the view leaves one out', () => {
  /**
   * ⚠ THE BACKLOG'S OWN SHAPE, and the one the old code provably could not touch.
   *
   * THREE summaries at depth 1 — one short of `condensedMinFanout` — holding more than the
   * assembler will admit. `runCondensation` read `uncondensed.length < 4` and `continue`d,
   * every turn, for ever. THE MUTANT: make a merge need four notes (`find((b) => b.length >= 4)`
   * in `merge-notes.ts`) and this clause goes RED on the "fits" row.
   */
  it('THE BACKLOG SHAPE: three oversized summaries below the fanout floor: the agent holds less, the turn proceeds, and the note left out is named', async () => {
    seedSummaries(3, 1, 20_000);
    const before = held();
    expect(before, 'non-vacuity: the fixture must really be over budget').toBeGreaterThan(await admitted());

    const result = await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(result.condensedCreated, 'a pair of the three is merged').toBeGreaterThan(0);
    expect(calls.length, 'at the cost of exactly one model call').toBe(1);
    expect(calls[0].depth, 'written one level up from its parents').toBe(2);
    expect(held(), 'the agent holds less than before').toBeLessThan(before);
    expect(compactionIsBraked(AGENT, true), 'the emergency pass does not dead-end: the next one may run').toBe(false);
    expect(compactionFailureReason(AGENT), 'and nothing is reported as failing').toBeNull();
    const { assembleContext } = await import('../assembler.js');
    const text = JSON.stringify((await assembleContext(AGENT, MODEL_64K)).messages);
    expect(text, 'the note left out of view is named, with the tool that finds it').toMatch(/older summar(y is|ies are) not shown here[^)]*history_search/);
  });

  /**
   * ⚠ DEPTH 2 IS REACHED, AND THE DEAD PROMPT IS THE ONE SENT.
   *
   * `summarize.ts:115`'s depth ≥2 branch has existed and been unreachable: `incrementalMaxDepth`
   * was 1, so `newDepth` never exceeded 1. This clause climbs 8 → 2 → 1 and asserts on the
   * ACTUAL system prompt built for the call, not on the depth number alone — a depth argument
   * nobody turns into a prompt would satisfy the weaker assertion.
   *
   * THE MUTANT: stop the run after its first merge and the depth-2 row goes RED.
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
   * ⚠ ONE SUMMARY, ALONE, TOO BIG. Until t269 it was re-summarised to half its size, again on every
   * pass — the repetition that wore the oldest history down to ~3% of its facts (summary-quality
   * investigation, H5). It is now left WHOLE: the summaries lane shows the newest note and names the
   * ones it leaves out (`summaries-lane.ts`), and the next leaves give it peers. No call, no refusal,
   * no card.
   */
  it('t269: a single oversized summary is left whole — never rewritten into a smaller copy of itself', async () => {
    seedSummaries(1, 0, 40_000);
    const budget = await admitted();
    expect(held(), 'non-vacuity').toBeGreaterThan(budget);

    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(calls.length, 'a lone note costs no call').toBe(0);
    expect(held(), 'and it is kept as it was').toBe(40_000);
    expect(compactionFailureReason(AGENT), 'nothing refused: there is nothing to repair').toBeNull();
    // (A forced pass that bought nothing still arms the ordinary no-yield backoff, which new rows release.)
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
   * THE MUTANT: make a pass that merged arm the brake and pass 2 dials nothing, so the "fits"
   * row goes RED and the climb never finishes.
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
    // t269: with targets proportional to their input, 43 leaves fit at depth 2 (43→11→3) in one pass;
    // that the DAG has no depth ceiling is pinned by `t269-history-is-folded-once-per-level.test.ts`.
    expect(Math.max(...depthsWritten()), 'merged up through the levels').toBeGreaterThanOrEqual(2);
  });

  it('a lone small summary the view cannot admit: no call, no defect, no card (t269: the floor stage is gone)', async () => {
    seedSummaries(1, 0, 500);
    // Force the admitted budget below the note so "the view cannot admit it" is real. t194: the
    // tail no longer squeezes the summaries lane (that was the phantom budget; the cached phase is
    // granted first), so the squeeze is a window whose content room, after its own system prompt and
    // reserve, gives the summaries lane less than the note.
    // The tail is made weightless so that, in so tight a window, it is not itself the bloat (a
    // forced pass would rightly fold it): the lone summary is the clause's only subject.
    mockDb.current!.prepare('UPDATE messages SET token_count = 1 WHERE agent_id = ?').run(AGENT);
    const { view } = await estimateAssembledTokens(AGENT, 65_536, MODEL_64K);
    const tight = Math.ceil((view.systemTokens + view.reserveTokens + 1_000) / 0.96);
    __resetEstimateCacheForTests();
    expect(held(), 'non-vacuity: a small summary that still will not be admitted')
      .toBeGreaterThan((await estimateAssembledTokens(AGENT, tight, MODEL_64K)).summaryTokens);

    await checkAndCompact(AGENT, MODEL_64K, tight, { force: true });

    expect(calls.length, 'the engine must not dial a model to rewrite a lone note').toBe(0);
    expect(compactionFailureReason(AGENT)).toBeNull();
    expect(frames.filter(f => f.type === 'chat:error'), 'and the owner is shown nothing').toEqual([]);
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
   * The bound is the structure, not a constant: a merge turns two or more notes into one, so
   * the calls are fewer than the notes whatever the summariser returns.
   */
  it('a summariser that compresses nothing: each note is merged into the level above ONCE, and the next pass dials nothing', async () => {
    answer = echoesItsInput;
    seedSummaries(8, 0, 6_000);
    expect(held(), 'non-vacuity').toBeGreaterThan(await admitted());

    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    // t269: the bound is the structure — 8 leaves → 2 parents → 1 (a note is merged once), so the
    // calls are at most one fewer than the notes, whatever the summariser returns.
    expect(calls.length, 'bounded by the notes, whatever the summariser does').toBeLessThanOrEqual(8 - 1);
    expect(calls.length, 'and it really did try — a bound that stops at zero proves nothing').toBeGreaterThan(0);
    expect(held(), 'the adversary wins: nothing was reclaimed').toBeGreaterThan(await admitted());
    expect(frames.filter(f => f.type === 'chat:error'), 'and no dead-end card is shown').toEqual([]);

    // AND NO SECOND PASS — the anti-thrash half, under force: one note left, no peer, nothing to dial.
    const callsAfterFirst = calls.length;
    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(calls.length, 'a second forced pass must dial nothing').toBe(callsAfterFirst);
  });

  it('an abort signal stops the run between merges', async () => {
    seedSummaries(8, 0, 6_000);
    const ctl = new AbortController();
    answer = async (p) => { ctl.abort(); return producesWhatItWasAskedFor(p); };
    const outcome = await mergeUntriedNotes(AGENT, MODEL_64K, ctl.signal);
    expect(outcome.created, 'the forced path\'s bound (the turn\'s patience, round 6) must be able to stop this')
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
    // No terminal state. t268 round 5 (edited: the agent was braked on the writer): with no other writer of its order able
    // to run, the span WAITS — no brake — and nothing is dialled until its writer is back.
    expect(compactionIsBraked(AGENT, true)).toBe(false);
    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(calls.length, 'the next emergency builds nothing either').toBe(0);
  });

  it('⚠ AND WHEN THE WRITER COMES BACK, COMPACTION RESUMES WITH NOTHING TO CLICK', async () => {
    seedSummaries(8, 0, 6_000);
    noteProviderFailure(PROVIDER, HTTP_402, AGENT);
    noteProviderFailure(PROVIDER, HTTP_402, AGENT);
    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(compactionIsBraked(AGENT, true), 't268 round 5 (edited): waiting on a dead writer, never braked').toBe(false);

    // The account is topped up and the next call to it succeeds.
    noteProviderSuccess(PROVIDER);

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
    // v3.5 field fix 3 (owner ruling: there is no summarization setting): a fact naming the agent's own model, sending
    // the owner to no setting, informational (a toast that leaves by itself, never red).
    expect(cards[0].error).toContain("own model returned nothing usable for a memory summary");
    expect(cards[0].error).toContain('it retries by itself');
    expect(cards[0].error).not.toMatch(/Settings|provider|\u2014/);
    expect(cards[0].severity).toBe('warning');
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
   * THE MUTANT: stop forwarding `facts` to `noteProviderFailure` and the first row goes RED.
   */
  it('a WRAPPED 402 still opens the breaker, because the SDK\'s own facts travel with it', () => {
    const wrapped = 'OpenAI call failed: 402 Payment Required';
    const facts = classifyProviderError({ status: 402, message: '402 Payment Required' });
    expect(facts.basis, 'precondition: the SDK read the status off a real field').toBe('status');

    expect(noteProviderFailure(PROVIDER, wrapped, AGENT, facts), 'one is only counted').toBeNull();
    expect(noteProviderFailure(PROVIDER, wrapped, AGENT, facts)?.reason, 'the facts carry the verdict').toBe('no_balance');
    expect(providerBreaker(PROVIDER), 'two of them open the breaker, as they always did').toBeTruthy();

    // ⚠ THE CONTROL, AND IT IS A RECORDED GAP RATHER THAN A PASS: the SAME string with no
    // facts is still TRANSIENT. That is today's prose path, and this row is here so the next
    // person to lose the pass-through sees exactly what it was worth.
    expect(permanentFailureReason(wrapped), 'the wrapped prose alone carries no evidence at all').toBeNull();
    // …while the UNWRAPPED shape the classifier was written for still works without facts.
    expect(permanentFailureReason('402 Payment Required')).toBe('no_balance');
  });

  it('when the TAIL is the bloat, a forced pass folds it — the token floor, not a 40-row dead end', async () => {
    // Summaries inside their budget, the live tail far over its room. t194 (owner decision 7b): this
    // clause pinned "nothing left for compaction to do — no_yield" because the 40 rows were all inside
    // the row floor. That IS the v3.3.3 surrender loop on a 65K worker; the floor is tokens now.
    const db = mockDb.current!;
    db.prepare('UPDATE messages SET token_count = 4000 WHERE agent_id = ?').run(AGENT);
    __resetEstimateCacheForTests();
    const est = await estimateAssembledTokens(AGENT, 65_536, MODEL_64K);
    expect(est.view.tailTokens, 'non-vacuity: the live tail is far over its room').toBeGreaterThan(est.view.tailRoomTokens);
    expect(held(), 'and the summaries are not the problem — there are none').toBe(0);

    const result = await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(result.leafCreated, 'the rows before the protected recent part are folded').toBeGreaterThan(0);
    expect(compactionFailureReason(AGENT), 'and it is not a failing compaction').not.toBe('no_yield');
    expect(frames.filter(f => f.type === 'chat:error'), 'the owner is not blamed for a tail the platform grew').toEqual([]);
  });

  // Re-review 2 S6: a fold marks only its LAST chunk open (still growing), so a refused row there holds that span until
  // it closes instead of re-running the check on every busy pass (summary-check.ts writeThenCheck).
  it('S6: only the fold\'s last leaf chunk is marked open', async () => {
    mockDb.current!.prepare('UPDATE messages SET token_count = 4000 WHERE agent_id = ?').run(AGENT);
    __resetEstimateCacheForTests();
    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    const leaves = calls.filter((c) => c.depth === 0).map((c) => c.spanOpen === true);
    expect(leaves.length, 'non-vacuity: the fold wrote more than one chunk').toBeGreaterThan(1);
    expect(leaves).toEqual([...Array(leaves.length - 1).fill(false), true]);
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
    expect(compactionIsBraked(AGENT, false), 'a quiet turn must not arm a brake').toBe(false);
  });

  /**
   * ⚠ §3's SERVICEABILITY, RE-MEASURED WITH THE RECURSION IN PLACE. Each level does a
   * synchronous all-summaries read, so a climb that never handed the loop back would be the
   * v3.2.3 freeze with a new cause. The number is recorded, not asserted (a test box is not a
   * real box); what IS asserted is that the loop was serviced at all WHILE a multi-level
   * condensation ran — which is the fact a dead dashboard and a dead stop button contradict.
   *
   * THE MUTANT: delete the yield between merges in `merge-notes.ts` and `turns` falls to 0.
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

describe('§0 the FIXTURES themselves are shapes a real box can produce (t111-B2)', () => {
  // A fixture defect is invisible by construction: every clause here passes either way, which is
  // exactly why the boundary-less summaries survived this long. So the seeders get their own
  // clause. Without it `linkSeededSummaries` could become a silent no-op and nothing would say
  // so — the numbers are deliberately unchanged by the link (see that function's note).
  it('⚠ a seeded summary COVERS a message, rather than covering nothing', () => {
    seedSummaries(3, 0, 1_000);

    const db = mockDb.current!;
    const summaries = db.prepare('SELECT id FROM summaries WHERE agent_id = ?').all(AGENT) as Array<{ id: string }>;
    expect(summaries.length, 'non-vacuity: the seeder must have written summaries').toBe(3);

    const links = db.prepare(
      'SELECT summary_id, message_id FROM summary_messages WHERE summary_id IN (SELECT id FROM summaries WHERE agent_id = ?)',
    ).all(AGENT) as Array<{ summary_id: string; message_id: string }>;
    expect(links.length, 'every seeded summary must cover a message').toBe(3);

    // and it covers a message THIS AGENT HOLDS, not an invented id.
    const msgIds = new Set((db.prepare('SELECT id FROM messages WHERE agent_id = ?').all(AGENT) as Array<{ id: string }>).map(m => m.id));
    for (const l of links) {
      expect(msgIds.has(l.message_id), `${l.summary_id} covers a message that does not exist`).toBe(true);
    }
  });

  it('seedMixed links its summaries too — the other seeder, same property', () => {
    seedMixed([{ depth: 3, tokens: 1_000 }, { depth: 0, tokens: 400 }]);

    const db = mockDb.current!;
    const links = db.prepare(
      'SELECT COUNT(*) AS n FROM summary_messages WHERE summary_id LIKE ?',
    ).get('mix-%') as { n: number };
    expect(links.n).toBe(2);
  });
});

describe('§5 a level merges peers of ONE depth (t269; it was the whole top-level set at any mix of depths)', () => {
  /**
   * REVIEW C1's shape — a depth-3 12,000-token summary beside a depth-0 400-token leaf — merged the
   * deep note with the leaf at `max depth + 1`. That merge is the erosion t269 removes: the oldest
   * history went through the writer again with every new leaf (one chain reached depth 72). Now the
   * two are left whole: no call, nothing refused. The summaries lane shows the newest and
   * names the older one it leaves out; the next leaves give the leaf its peers.
   */
  it('C1 shape: a deep summary beside a shallow leaf is NOT merged, and nothing is reported as failing', async () => {
    seedMixed([{ depth: 3, tokens: 12_000 }, { depth: 0, tokens: 400 }]);
    expect(held(), 'non-vacuity: the probed shape, and it really is over').toBeGreaterThan(await admitted());

    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(calls.length, 'no call').toBe(0);
    expect(depthsWritten(), 'both notes as they were').toEqual([3, 0]);
    expect(compactionFailureReason(AGENT), 'nothing refused').toBeNull();
  });

  /** Two notes of one depth ⇒ a forced pass writes a parent, one depth above them. */
  it.each([
    [[{ depth: 1, tokens: 6_000 }, { depth: 1, tokens: 6_000 }, { depth: 4, tokens: 6_000 }], 'two same-depth plus a deeper one'],
    [[{ depth: 0, tokens: 400 }, { depth: 0, tokens: 400 }, { depth: 6, tokens: 20_000 }], 'two small leaves and a huge parent'],
    [[{ depth: 2, tokens: 9_000 }, { depth: 2, tokens: 9_000 }, { depth: 2, tokens: 500 }], 'three of one depth'],
  ] as const)('two notes of one depth ⇒ a forced pass writes a parent, one depth above its peers (%#: %s)', async (rows) => {
    seedMixed([...rows]);
    const result = await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(result.condensedCreated, 'the engine may not see a merge it refuses to attempt').toBeGreaterThan(0);
    const peerDepth = rows.find((r, i) => rows.some((o, j) => j !== i && o.depth === r.depth))!.depth;
    expect(calls.every((c) => c.depth === peerDepth + 1), 'a parent sits one depth above its peers').toBe(true);
    expect(compactionFailureReason(AGENT), 'a pass that merged is not failing').toBeNull();
  });

  it.each([
    [[{ depth: 0, tokens: 8_000 }, { depth: 5, tokens: 8_000 }], 'shallow + very deep'],
    [[{ depth: 7, tokens: 11_000 }, { depth: 0, tokens: 600 }], 'a deep chain and a new leaf'],
  ] as const)('no two notes of one depth ⇒ no call and no defect (%#: %s)', async (rows) => {
    seedMixed([...rows]);
    await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
    expect(calls.length).toBe(0);
    expect(compactionFailureReason(AGENT)).toBeNull();
  });

  /**
   * ⚠ REVIEW I1, THE REACTIVE PATH: the measure before a merge sees the leaves this same pass
   * wrote, so a pass whose fresh leaves push the notes over budget merges them at once.
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
    // clause is unchanged. `old-39` is then summarised, leaving 39 fat rows outside
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
    // The only enabled model loses its text capability, so `pickWriter` finds none.
    mockDb.current!.prepare("UPDATE models SET capabilities = '[\"embedding\"]' WHERE id = ?").run(MODEL_64K);

    const result = await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });

    expect(result).toEqual({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    expect(calls.length, 'there is nothing to dial').toBe(0);
    expect(compactionFailureReason(AGENT)).toBe('summary_writer_unresolvable');
    const cards = frames.filter(f => f.code === 'COMPACTION_FAILING');
    expect(cards.length, 'the owner is told once').toBe(1);
    expect(cards[0].error).toContain('has no model that can write a memory summary right now');
    expect(cards[0].error).not.toMatch(/Settings/);
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

  /**
   * ⚠ t109 item F — t91 re-review M-b, THE COMMENT THAT CLAIMED THE WRONG SPACER.
   *
   * `compaction.ts`'s `!resolved` branch said "the brake spaces the card to once per 15
   * minutes". It cannot: `compactionIsBraked` is consulted further down the SAME function,
   * after that branch's early `return NO_COMPACTION`, so a pass that dies there never reaches
   * the brake. The card IS spaced — by the once-per-outage `failures` map in
   * `reportCompactionDefect`, which is stronger than the brake — and the D3 LINE is per forced
   * pass by charter. Both comments now say that; this is the clause that makes the corrected
   * sentences false if the behaviour ever stops matching them, in BOTH directions:
   *
   *   - ONE card over three forced passes   (if the `failures` map stopped spacing it: 3)
   *   - THREE defect lines over three       (if anything started spacing the line: 1)
   *   - the brake is NEVER consulted on this path, proven by its own reader: an unresolvable
   *     writer arms `summary_writer_unresolvable`, which is NOT the `summary_writer_unavailable`
   *     stage `armBackoff` binds a model id to, so three passes in a row all get through —
   *     a braked path would have produced one line, not three.
   *
   * MUTANT: gate the defect line on the brake (`if (options?.force && !compactionIsBraked(...))`)
   * and the line count goes 3 → 1; move the `notePassOutcome` call below the brake check and
   * the card count goes 1 → 0.
   */
  it('⚠ F: three forced passes on an unresolvable writer — ONE card, THREE lines, no brake in it', async () => {
    seedSummaries(8, 0, 6_000);
    mockDb.current!.prepare("UPDATE models SET capabilities = '[\"embedding\"]' WHERE id = ?").run(MODEL_64K);

    for (let i = 0; i < 3; i++) {
      const r = await checkAndCompact(AGENT, MODEL_64K, 65_536, { force: true });
      expect(r, `pass ${i + 1} cannot compact`).toEqual({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    }

    const cards = frames.filter(f => f.code === 'COMPACTION_FAILING');
    expect(cards.length, 'the owner is told ONCE per outage — the failures map, not the brake').toBe(1);
    expect(defectLines().length, 'and the repair audience gets a line per forced pass').toBe(3);
    for (const l of defectLines()) expect(l.meta.stage).toBe('summary_writer_unresolvable');
  });
});

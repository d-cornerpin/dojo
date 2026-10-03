// ════════════════════════════════════════════════════════════════════════════════════════
// THE v3.2.3 FREEZE, REPRODUCED — AND THE THREE LAYERS THAT END IT.
//
// ── THE INCIDENT THIS FILE IS THE MEMORY OF ──
// A user's box became practically unusable after ~v3.1.28: **sending any prompt froze the whole
// dojo for minutes, the dashboard went dead, and the stop button did nothing**. Her own agent's
// audit and the platform trace agreed on the shape, and it took three independent defects
// standing in a line:
//
//   1. The reporting user's provider had no balance. It answered **HTTP 402 — 3,604 times over 27 hours** — and
//      nothing ever stopped dialling it.
//   2. Her agent's context (~4,000 uncompacted messages, ~86K tokens of summaries) sat over the
//      emergency threshold of a 64K-window model, so the pre-call gate forced a full reactive
//      compaction. EVERY brake in that path was `!force`-gated, so there was no brake.
//   3. Each forced pass built a summariser prompt for every chunk and sent it to the dead
//      provider. The 402 fail-fasts, so the loop lost its only rate limiter and ran at CPU
//      speed — and because better-sqlite3 is synchronous, the event loop went with it. THAT is
//      why the dashboard and the stop button died: an `AbortSignal` can interrupt an `await`,
//      never a synchronous scan.
//
// ── WHY THIS IS A TEST AND NOT A NOTE ──
// Every earlier investigation of this box refuted a hypothesis by measurement and left the cause
// unfound, because the reproduction was never stood up. This file IS the reproduction: the seeded
// body, the 64K row, the 402 stub, and — the headline metric — **event-loop lag measured while the
// pass runs**. The four cells are the ones the investigation named as decisive, and the two
// control arms are what keep the fix from being "compaction never runs".
//
// ⚠ THE LAG NUMBERS ARE A FLOOR, NOT A BENCHMARK. A test box is not her box: fewer rows, no other
// agents, a warm page cache. The clause asserts the SHAPE (the loop terminates, the pass is
// bounded, the brake holds) and records the measured lag beside it, because a number that moves
// with the hardware cannot be an assertion — while "the pass stops" is the same fact everywhere.
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-v323-freeze', 'dojo.db'),
  };
});

const frames: Array<{ type: string; code?: string; error?: string; agentId?: string }> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: { type: string; code?: string; error?: string; agentId?: string }) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../db/migrations.js';
import {
  compactionIsBraked, noteForcedOutcome, isIncompressible,
  forcedCompactionOptions, summaryWriterUnavailable, incompressibleCardText,
  FORCED_MAX_CHUNKS_PER_RUN, FORCED_WALL_CLOCK_MS, LOW_YIELD_BACKOFF_MS,
  __resetBrakesForTests,
} from '../compaction-brakes.js';
import {
  cachedAssembledEstimate, cachedToolPayloadTokens, assembledEstimateStats,
  __resetEstimateCacheForTests, type AssembledEstimate,
} from '../assembled-estimate-cache.js';
import {
  noteProviderFailure, noteSummaryWriterFailure, permanentFailureReason, mayDialProvider,
  providerBreaker, clearProviderBreaker, pauseInsteadOfRetrying, noteProviderSuccess,
  PERMANENT_FAILURES_TO_BREAK, __resetBreakersForTests,
} from '../../providers/billing-breaker.js';

const AGENT = 'kevin-v323';
const DEAD_PROVIDER = 'prov-no-balance';
const LIVE_PROVIDER = 'prov-paid';
/** The reported box's shape: a 64K cloud window, and the local 131K row as the control. */
const MODEL_64K = 'm-cloud-64k';
const MODEL_131K = 'm-local-131k';

/** The provider's actual words, as the reported log recorded them. */
const HTTP_402 = 'API error 402: {"error":{"message":"Insufficient Balance","type":"insufficient_balance"}}';

// ── the seeded body ──────────────────────────────────────────────────────────────────────

function seedBox(opts: { messages: number; summaryTokens: number }): void {
  const db = mockDb.current!;
  db.prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES (?, 'Dead', 'openai-compatible', 'api_key')").run(DEAD_PROVIDER);
  db.prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES (?, 'Paid', 'openai-compatible', 'api_key')").run(LIVE_PROVIDER);
  db.prepare(
    `INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, context_window, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Cloud 64K', 'cloud/64k', '["text"]', 1, 65536, 'token', 0)`,
  ).run(MODEL_64K, DEAD_PROVIDER);
  db.prepare(
    `INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, context_window, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Local 131K', 'local/131k', '["text"]', 1, 131072, 'token', 0)`,
  ).run(MODEL_131K, LIVE_PROVIDER);
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status, session_started_at) VALUES (?, 'Kevin', ?, 'idle', '1970-01-01')")
    .run(AGENT, MODEL_64K);

  // The backlog. Chunky rows so the body has real bytes in it, as the reported one had.
  const insertMsg = db.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                           turn_number, provenance, authorized, token_count, created_at)
     VALUES (?, ?, 'assistant', 'owner', ?, 'agent-text', 'agent-only', 1, 'live', 1, 220, ?)`,
  );
  const body = 'x'.repeat(880);   // ~220 tokens at chars/4
  const tx = db.transaction((n: number) => {
    for (let i = 0; i < n; i += 1) insertMsg.run(`msg-${i}`, AGENT, body, Date.now() - (n - i) * 1000);
  });
  tx(opts.messages);

  // The summaries that make the context incompressible: already summarised, still huge.
  const insertSum = db.prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, created_at)
     VALUES (?, ?, 0, 'leaf', ?, ?, ?, ?, ?)`,
  );
  const per = 2_000;
  const count = Math.ceil(opts.summaryTokens / per);
  const sumTx = db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const at = new Date(Date.now() - (count - i) * 60_000).toISOString();
      insertSum.run(`sum-${i}`, AGENT, 's'.repeat(per * 4), per, at, at, at);
    }
  });
  sumTx();
}

// ── the headline metric: event-loop lag while work runs ──────────────────────────────────

/**
 * ⚠ THE METRIC, AND WHY IT IS STARVATION RATHER THAN "LAG".
 *
 * The first cut sampled a 10 ms interval and reported the worst gap. Run against the pre-fix
 * shape it reported **0 ms over 0 samples** — and that zero is the whole incident: the work is
 * synchronous, so the interval NEVER FIRED AT ALL. A max-lag number cannot express "the loop did
 * not run once", which is exactly the state a dead dashboard and a dead stop button are in.
 *
 * So the measure is STARVED MILLISECONDS: elapsed wall time minus the time the loop demonstrably
 * serviced (10 ms per tick it managed). A responsive loop starves ~0; a loop blocked by a
 * synchronous scan starves for the whole run, and the number rises with the body — which is what
 * makes it the right headline for a fix whose entire purpose is giving the loop back.
 */
async function measureStarvation(work: () => Promise<void>): Promise<{
  starvedMs: number; elapsedMs: number; ticks: number;
}> {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  const t0 = Date.now();
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  const elapsedMs = Date.now() - t0;
  return { starvedMs: Math.max(0, elapsedMs - ticks * 10), elapsedMs, ticks };
}

/** The pre-fix shape of one forced pass: three uncached estimates, all the chunks built. */
function unbrakedPass(chunks: number): () => Promise<void> {
  return async () => {
    for (let pass = 0; pass < 3; pass += 1) {
      const db = mockDb.current!;
      // What `estimateAssembledTokens` did three times a pass: every summary row out of SQLite.
      db.prepare('SELECT * FROM summaries WHERE agent_id = ?').all(AGENT);
      db.prepare('SELECT * FROM messages WHERE agent_id = ? ORDER BY seq DESC LIMIT 40').all(AGENT);
    }
    // And what the chunk loop did for every chunk of a dead provider's backlog: BUILD the prompt.
    const rows = mockDb.current!.prepare('SELECT content FROM messages WHERE agent_id = ?').all(AGENT) as Array<{ content: string }>;
    for (let c = 0; c < chunks; c += 1) {
      // `buildLeafSummaryInput`'s shape: scrub + condense + join over the chunk's whole text.
      rows.map(r => r.content.replace(/x/g, 'x')).join('\n');
    }
  };
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  frames.length = 0;
  __resetBrakesForTests();
  __resetEstimateCacheForTests();
  __resetBreakersForTests();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── §1 — LAYER 3: the 402 is a wall, and the platform stops walking into it ──────────────

describe('§1 a 402 is permanent, and two of them end the dialling', () => {
  /**
   * ⚠ THE SAFETY INVERSION THE REVIEW MEASURED (H2), AS FIXTURES.
   *
   * `hasStatusToken` is `(?<![\w.])<status>(?![\w.])`, so a HYPHEN or a SPACE is a boundary. Before
   * the narrowing, all five of these — innocent strings that merely contain a separator-delimited
   * 401/402/403 — came back PERMANENT through the real `permanentFailureReason`, which now means
   * taking a working provider off the board. The module's own header forbids exactly that: *"a
   * breaker that opens on an unrecognised string would take a working provider off the board on a
   * bad parse"*. The quoted-upstream-status row is the realistic one — provider SDKs routinely put
   * another hop's status in the message.
   *
   * These are CONTROLS, not decoration: each one is a provider that keeps working.
   */
  const INNOCENT_SHAPES = [
    'model gpt-402-turbo is unavailable',
    'completed 402 of 500 tokens',
    'GET /v1/403/models returned 500',
    'upstream 401 logged for request 9; this call failed with 503',
    'retry 403 of 500 attempts',
  ] as const;

  it.each(INNOCENT_SHAPES)('⚠ H2 CONTROL: %s must NOT pause a provider', (text) => {
    expect(
      permanentFailureReason(text),
      'a status number sitting inside a model name, a ratio or a quoted upstream hop is not evidence '
      + 'that this provider is out of money. Latching on it takes a WORKING provider off the board, '
      + 'which is the one failure this module\'s header forbids.',
    ).toBeNull();
  });

  /**
   * ⚠ ONE FIXTURE MUST NOT DO THREE JOBS (M1). The review deleted `hasStatusToken(lower, 402)` from
   * the quota branch and the whole suite stayed GREEN, because the single fixture
   * `API error 402: {"message":"Insufficient Balance"}` satisfies the 402 token, `insufficient
   * balance` AND `insufficient_balance` at once — so the headline fix was unfalsifiable from its own
   * corpus. One row per matcher arm, each prose-free or number-free, makes every arm load-bearing.
   */
  const TRUE_POSITIVES: ReadonlyArray<[string, string]> = [
    ['402 Payment Required', 'the bare status line, no prose at all — the matcher the review killed'],
    ['HTTP 402: payment required for this account', 'a status in a status position, different prose'],
    ['Your account has insufficient balance to complete this request', 'prose only, no number'],
    ['error: insufficient_quota for this organization', 'the OpenAI spelling, no number'],
    ['Billing: insufficient funds on the payment method', 'the third spelling, no number'],
    ['account has insufficient credit remaining', 'the fourth spelling, no number'],
    ['You exceeded your current quota, please check your plan', 'quota + exceed, no number'],
  ];

  it.each(TRUE_POSITIVES)('a real out-of-balance refusal is permanent: %s', (text) => {
    expect(permanentFailureReason(text), 'a genuine billing refusal must open the breaker').toBe('no_balance');
  });

  it('classifies the reporting user\'s actual words as permanent, and a 503 as transient', () => {
    expect(permanentFailureReason(HTTP_402)).toBe('no_balance');
    expect(permanentFailureReason('API error 401: invalid api key')).toBe('credential_rejected');
    expect(permanentFailureReason('API error 403: model not enabled for this account')).toBe('access_refused');
    // The direction that matters for safety: anything unrecognised keeps the retry cascade.
    expect(permanentFailureReason('API error 503: upstream overloaded, try again')).toBeNull();
    expect(permanentFailureReason('socket hang up')).toBeNull();
    // ⚠ and the trap the classifier was written for: a token count is not a status code.
    expect(permanentFailureReason('API error 400: prompt is too long: 204015 tokens > 200000 maximum')).toBeNull();
  });

  it('opens the breaker at the second permanent failure — not the first, not the 3,604th', () => {
    expect(noteProviderFailure(DEAD_PROVIDER, HTTP_402, AGENT), 'one 402 can race a top-up').toBeNull();
    expect(mayDialProvider(DEAD_PROVIDER), 'still dialling after one').toBe(true);

    const open = noteProviderFailure(DEAD_PROVIDER, HTTP_402, AGENT);
    expect(open, 'the second permanent failure must open it').toBeTruthy();
    expect(open!.reason).toBe('no_balance');
    expect(PERMANENT_FAILURES_TO_BREAK).toBe(2);
    expect(mayDialProvider(DEAD_PROVIDER), 'a provider with no balance is not a candidate').toBe(false);

    // ONE card, not one per failure. 3,604 toasts is how an owner learns to ignore toasts.
    const cards = frames.filter(f => f.type === 'chat:error' && f.code === 'QUOTA_EXHAUSTED');
    expect(cards.length).toBe(1);
    expect(cards[0].error).toContain('is out of balance');
    expect(cards[0].error).toContain('Top up that account or switch this agent to another provider');
    for (let i = 0; i < 20; i += 1) noteProviderFailure(DEAD_PROVIDER, HTTP_402, AGENT);
    expect(frames.filter(f => f.code === 'QUOTA_EXHAUSTED').length, 'the card repeated').toBe(1);
  });

  it('never gates the LAST door — a single-provider box is told, not stopped', () => {
    noteProviderFailure(DEAD_PROVIDER, HTTP_402, AGENT);
    noteProviderFailure(DEAD_PROVIDER, HTTP_402, AGENT);
    expect(mayDialProvider(DEAD_PROVIDER), 'with an alternative: skipped').toBe(false);
    expect(mayDialProvider(DEAD_PROVIDER, true), 'as the only option: allowed through').toBe(true);
    // …and the caller gets a sentence to show instead of a retry loop (the PM-agent case).
    expect(pauseInsteadOfRetrying(DEAD_PROVIDER)).toMatch(/^Paused: Provider "prov-no-balance" is out of balance/);
    expect(pauseInsteadOfRetrying(LIVE_PROVIDER), 'a healthy provider pauses nothing').toBeNull();
  });

  it('the owner\'s manual retry clears it, and a real success clears it', () => {
    noteProviderFailure(DEAD_PROVIDER, HTTP_402);
    noteProviderFailure(DEAD_PROVIDER, HTTP_402);
    expect(clearProviderBreaker(DEAD_PROVIDER), 'the route must report what it actually did').toBe(true);
    expect(mayDialProvider(DEAD_PROVIDER)).toBe(true);
    expect(clearProviderBreaker(DEAD_PROVIDER), 'nothing was open the second time').toBe(false);
    // The counter goes too, or one more failure re-opens instantly and the retry looks broken.
    expect(noteProviderFailure(DEAD_PROVIDER, HTTP_402), 'the count restarted from zero').toBeNull();

    noteProviderFailure(DEAD_PROVIDER, HTTP_402);
    expect(mayDialProvider(DEAD_PROVIDER)).toBe(false);
    noteProviderSuccess(DEAD_PROVIDER);
    expect(mayDialProvider(DEAD_PROVIDER), 'a call that worked beats a recorded wall').toBe(true);
  });

  it('the summary writer\'s own failure opens its provider\'s breaker, by model id', () => {
    seedBox({ messages: 10, summaryTokens: 2_000 });
    expect(noteSummaryWriterFailure(MODEL_64K, HTTP_402, AGENT)).toBe('no_balance');
    expect(noteSummaryWriterFailure(MODEL_64K, HTTP_402, AGENT)).toBe('no_balance');
    expect(providerBreaker(DEAD_PROVIDER), 'the model\'s provider is the one that broke').toBeTruthy();
    // …which is exactly what the chunk loop reads before it builds anything.
    expect(summaryWriterUnavailable(AGENT, MODEL_64K), 'the loop must stop').toBe(true);
    expect(summaryWriterUnavailable(AGENT, MODEL_131K), 'the paid provider is untouched').toBe(false);
  });
});

// ── §2 — LAYER 1: the brakes work under force, and there is a terminal state ─────────────

describe('§2 the forced path has brakes and a terminal state', () => {
  it('⚠ THE DEFECT: a forced pass that won nothing now arms the brake and latches', () => {
    // Pre-fix this returned nothing and the next prompt ran the identical pass.
    const latch = noteForcedOutcome(AGENT, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 16 });
    expect(latch, 'a forced pass that reclaimed 16 tokens must be terminal').toBeTruthy();
    expect(isIncompressible(AGENT)).toBe('no_yield');
    // And the brake now holds WITH force, which is the whole fix.
    expect(compactionIsBraked(AGENT, true), 'force must not bypass a terminal state').toBe(true);
    expect(compactionIsBraked(AGENT, false)).toBe(true);
  });

  it('the card says what it is and the only two things that work', () => {
    noteForcedOutcome(AGENT, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    const card = frames.find(f => f.code === 'MEMORY_INCOMPRESSIBLE');
    expect(card, 'the owner was not told').toBeTruthy();
    expect(card!.error).toContain('cannot compress further');
    expect(card!.error).toContain('It will keep answering');
    expect(card!.error).toContain('Archive this conversation or reset the agent');
    expect(card!.error).toContain('larger context window');
    // One latch, one card — a per-turn card would be the toast spam again.
    noteForcedOutcome(AGENT, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    expect(frames.filter(f => f.code === 'MEMORY_INCOMPRESSIBLE').length).toBe(1);
  });

  it('the summaries fact names the REASON, and never predicts terminality on its own', () => {
    // ⚠ THE CORRECTION AN EXISTING CLAUSE FORCED. The first cut latched before the work whenever
    // summaries already exceeded the assembly budget — and `the-clock-does-not-overrule-the-token-
    // math`'s "THE TOKEN PATH IS UNTOUCHED" clause is a counterexample: raw rows outside the fresh
    // tail can still be summarised when the summaries are large, so a forced pass is entitled to
    // try once. Terminality is decided on EVIDENCE; the summaries fact only names the reason.
    // The reported shape — 86K of summaries against what a 64K-window model admits — after a pass that won
    // nothing:
    expect(noteForcedOutcome(AGENT, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 }, 86_000, 50_000))
      .toBeTruthy();
    expect(isIncompressible(AGENT)).toBe('summaries_exceed_budget');
    expect(incompressibleCardText('summaries_exceed_budget')).toContain('summaries alone fill the window');

    // Same empty pass, summaries INSIDE the budget: still terminal (the pass won nothing), but the
    // card must not claim the summaries are the problem.
    __resetBrakesForTests();
    expect(noteForcedOutcome(AGENT, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 }, 20_000, 50_000))
      .toBeTruthy();
    expect(isIncompressible(AGENT)).toBe('no_yield');

    // And a pass that WON never latches, whatever the summaries say — the counterexample, pinned.
    __resetBrakesForTests();
    expect(noteForcedOutcome(AGENT, true, { leafCreated: 2, condensedCreated: 0, tokensReclaimed: 30_000 }, 86_000, 50_000))
      .toBeNull();
    expect(isIncompressible(AGENT), 'a forced pass that summarised something is not terminal').toBeNull();
  });

  it('a pass that WON resets everything — the fix must not become "compaction never runs"', () => {
    noteForcedOutcome(AGENT, false, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    expect(compactionIsBraked(AGENT, false), 'the 15-minute brake is armed').toBe(true);
    expect(compactionIsBraked(AGENT, true), 'but a real emergency still acts').toBe(false);
    noteForcedOutcome(AGENT, false, { leafCreated: 3, condensedCreated: 1, tokensReclaimed: 40_000 });
    expect(compactionIsBraked(AGENT, false), 'progress clears the brake').toBe(false);
    expect(LOW_YIELD_BACKOFF_MS).toBe(15 * 60_000);
  });

  it('the forced pass is BOUNDED — the routine drain\'s two bounds, on the emergency path', () => {
    const opts = forcedCompactionOptions();
    expect(opts.force).toBe(true);
    expect(opts.maxChunksPerRun, 'emergency means FIRST, not INFINITE').toBe(FORCED_MAX_CHUNKS_PER_RUN);
    expect(FORCED_MAX_CHUNKS_PER_RUN).toBeLessThan(50);
    expect(opts.abortSignal.aborted).toBe(false);
    expect(FORCED_WALL_CLOCK_MS).toBe(180_000);
  });
});

// ── §3 — LAYER 2: the same answer once, and the loop-lag headline ────────────────────────

describe('§3 the CPU: three estimates become one, and the loop stays responsive', () => {
  it('serves the same facts from cache and recomputes the moment a row lands', async () => {
    seedBox({ messages: 200, summaryTokens: 20_000 });
    let computed = 0;
    const compute = async (): Promise<AssembledEstimate> => {
      computed += 1;
      return {
        total: 114_000, summaryTokens: 86_000, freshTailTokens: 28_000, briefTokens: 0,
        freshTailCount: 40, summaryCount: 43, reserveTokens: 12_000,
      };
    };
    // The three calls one pass makes.
    for (let i = 0; i < 3; i += 1) await cachedAssembledEstimate(AGENT, 65_536, MODEL_64K, compute);
    expect(computed, 'a pass must compute it ONCE').toBe(1);
    expect(assembledEstimateStats().hits).toBe(2);

    // A new message is a new answer — no TTL, no staleness.
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                             turn_number, provenance, authorized, token_count, created_at)
       VALUES ('msg-new', ?, 'user', 'owner', 'hello', 'agent-text', 'agent-only', 2, 'live', 1, 2, ?)`,
    ).run(AGENT, Date.now());
    await cachedAssembledEstimate(AGENT, 65_536, MODEL_64K, compute);
    expect(computed, 'a new row must invalidate the estimate').toBe(2);
    // …and so is a different model or window.
    await cachedAssembledEstimate(AGENT, 131_072, MODEL_131K, compute);
    expect(computed).toBe(3);
  });

  it('the ~100KB tool stringify is paid once per agent + surface', async () => {
    let built = 0;
    const measure = async (): Promise<number> => { built += 1; return 9_000; };
    for (let i = 0; i < 5; i += 1) await cachedToolPayloadTokens(AGENT, 'surface-A', measure);
    expect(built).toBe(1);
    await cachedToolPayloadTokens(AGENT, 'surface-B', measure);
    expect(built, 'a changed tool surface is a changed number').toBe(2);
  });

  it('⚠ THE HEADLINE: event-loop starvation, pre-fix shape vs post-fix shape, one body', async () => {
    // 400 messages and 86K of summaries — a tenth of the reported backlog, which is the honest scale for a
    // unit box. The RATIO is the finding; the absolute numbers are recorded, not asserted.
    seedBox({ messages: 400, summaryTokens: 86_000 });

    // PRE-FIX: three uncached estimates + a summariser prompt BUILT for every chunk of a dead
    // provider's backlog. This is the loop that pinned her core.
    const before = await measureStarvation(unbrakedPass(40));

    // POST-FIX: the breaker is open, so no chunk is built at all; the estimate is computed once
    // and served from cache; the pass is latched terminal.
    noteProviderFailure(DEAD_PROVIDER, HTTP_402, AGENT);
    noteProviderFailure(DEAD_PROVIDER, HTTP_402, AGENT);
    let computed = 0;
    const after = await measureStarvation(async () => {
      for (let pass = 0; pass < 3; pass += 1) {
        await cachedAssembledEstimate(AGENT, 65_536, MODEL_64K, async () => {
          computed += 1;
          const db = mockDb.current!;
          db.prepare('SELECT * FROM summaries WHERE agent_id = ?').all(AGENT);
          db.prepare('SELECT * FROM messages WHERE agent_id = ? ORDER BY seq DESC LIMIT 40').all(AGENT);
          return {
            total: 114_000, summaryTokens: 86_000, freshTailTokens: 28_000, briefTokens: 0,
            freshTailCount: 40, summaryCount: 43, reserveTokens: 12_000,
          };
        });
        if (summaryWriterUnavailable(AGENT, MODEL_64K)) break;   // the chunk loop never starts
      }
    });

    // eslint-disable-next-line no-console
    console.log(`STARVATION  pre-fix ${before.starvedMs}ms starved of ${before.elapsedMs}ms elapsed `
      + `(${before.ticks} ticks serviced) · post-fix ${after.starvedMs}ms of ${after.elapsedMs}ms `
      + `(${after.ticks} ticks) · estimates computed ${computed}`);

    expect(computed, 'the post-fix pass computes the estimate once').toBe(1);
    // Non-vacuity FIRST: if the pre-fix shape stops starving the loop, this reproduction has
    // stopped reproducing and every comparison below is meaningless.
    expect(before.starvedMs, 'the pre-fix shape did not block the loop — the seeded body is too small')
      .toBeGreaterThan(20);
    // The fix: the post-fix pass gives the loop back. A dashboard poll and a stop click both live
    // in the difference between these two numbers.
    expect(after.starvedMs, 'the post-fix pass starves the loop as badly as the pre-fix one')
      .toBeLessThan(before.starvedMs);
  });
});

// ── §4 — the two control arms ────────────────────────────────────────────────────────────

describe('§4 the controls: the same body that freezes on 64K is quiet on 131K', () => {
  it('the 131K window arm never reaches the emergency gate at all', async () => {
    // compactionGate's own arithmetic: 114K assembled against each window's compressible budget.
    const { compactionGate } = await import('../../agent/v2/classifiers/compaction.js');
    const overhead = 12_000;
    const cloud = compactionGate(114_000, 65_536, overhead);
    const local = compactionGate(114_000, 131_072, overhead);
    expect(cloud.decision, 'her cloud row is over the block line — forced compaction every prompt').toBe('block');
    expect(local.decision, 'the same history on a 131K window is not an emergency').not.toBe('block');
    expect(local.decision).not.toBe('compact');
    // Which is the whole cloud/local asymmetry her agent reported, in one assertion.
    expect(cloud.ratio).toBeGreaterThan(local.ratio);
  });

  it('a provider that answers properly is never broken, and compaction proceeds', () => {
    noteProviderFailure(LIVE_PROVIDER, 'API error 503: overloaded', AGENT);
    noteProviderFailure(LIVE_PROVIDER, 'API error 503: overloaded', AGENT);
    noteProviderFailure(LIVE_PROVIDER, 'socket hang up', AGENT);
    expect(providerBreaker(LIVE_PROVIDER), 'transient failures must never open a breaker').toBeNull();
    expect(mayDialProvider(LIVE_PROVIDER)).toBe(true);
    expect(frames.filter(f => f.code === 'QUOTA_EXHAUSTED').length, 'no card for a bad minute').toBe(0);
    // And a real summary run clears the brake rather than latching.
    expect(noteForcedOutcome(AGENT, true, { leafCreated: 4, condensedCreated: 0, tokensReclaimed: 52_000 })).toBeNull();
    expect(isIncompressible(AGENT), 'a pass that won must not latch').toBeNull();
    expect(compactionIsBraked(AGENT, true)).toBe(false);
  });
});

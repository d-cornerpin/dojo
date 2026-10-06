// ════════════════════════════════════════════════════════════════════════════════════════
// THE v3.2.3 FREEZE, REPRODUCED — AND THE THREE LAYERS THAT END IT.
//
// ── THE INCIDENT THIS FILE IS THE MEMORY OF ──
// A user's box became practically unusable after ~v3.1.28: **sending any prompt froze the whole
// dojo for minutes, the dashboard went dead, and the stop button did nothing**. The reporting user's own agent's
// audit and the platform trace agreed on the shape, and it took three independent defects
// standing in a line:
//
//   1. The reporting user's provider had no balance. It answered **HTTP 402 — 3,604 times over 27 hours** — and
//      nothing ever stopped dialling it.
//   2. That agent's context (~4,000 uncompacted messages, ~86K tokens of summaries) sat over the
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
// ⚠ THE LAG NUMBERS ARE A FLOOR, NOT A BENCHMARK. A test box is not the reported box: fewer rows, no other
// agents, a warm page cache. The clause asserts the SHAPE (the loop terminates, the pass is
// bounded, the brake holds) and records the measured lag beside it, because a number that moves
// with the hardware cannot be an assertion — while "the pass stops" is the same fact everywhere.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-v323-freeze', 'dojo.db'),
  };
});

const frames: Array<{ type: string; code?: string; error?: string; agentId?: string }> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: { type: string; code?: string; error?: string; agentId?: string }) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../db/migrations.js';
import {
  compactionIsBraked, notePassOutcome,
  forcedCompactionOptions, summaryWriterUnavailable,
  FORCED_MAX_CHUNKS_PER_RUN, FORCED_WALL_CLOCK_MS, LOW_YIELD_BACKOFF_MS,
  __resetBrakesForTests,
} from '../compaction-brakes.js';
// OR-COMPACT-1 (owner, 2026-10-02): the terminal latch and its "archive or reset" card are
// gone. `noteForcedOutcome` is `notePassOutcome`, `isIncompressible` is
// `compactionFailureReason` (a stage to repair, not a state to live in), and
// `incompressibleCardText` has no successor — a no-yield pass shows NO card at all.
import { compactionFailureReason, compactionFailingCardText } from '../compaction-defect.js';
import { condensableSummaries } from '../condense-until-fits.js';
import {
  cachedAssembledEstimate, cachedToolPayloadTokens, assembledEstimateStats,
  __resetEstimateCacheForTests, type AssembledEstimate,
} from '../assembled-estimate-cache.js';
import {
  noteProviderFailure, noteSummaryWriterFailure, permanentFailureReason, mayDialProvider,
  providerBreaker, clearProviderBreaker, pauseInsteadOfRetrying, noteProviderSuccess,
  PERMANENT_FAILURES_TO_BREAK, __resetBreakersForTests,
} from '../../providers/billing-breaker.js';
// t87b reads the position rule directly — see the STILL_ANCHORED table for why.
import { statusIsAnchored } from '../../agent/provider-error.js';

const AGENT = 'agent-v323-box';
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
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status, session_started_at) VALUES (?, 'Box Under Test', ?, 'idle', '1970-01-01')")
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
    // ── t87b: five more the H2 RE-review found still anchoring, closed by two narrowings ──
    // `exit code` is the realistic one and the reason this round happened: it is a PROCESS exit
    // code, and the incident box was running a local runtime that reports them.
    'exit code 402 from the local runtime',
    'code 402 of 500 processed',
    // Anything that merely BEGINS with a number used to announce itself as a status, because the
    // leading arm accepted any bracket or quote as a prefix. These are log prefixes and counts.
    '"402 items were skipped"',
    '[402] cache entries evicted',
    '(402) rows updated',
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
   * ⚠ WHAT THE TWO NARROWINGS MUST NOT COST, AND WHAT THEY DELIBERATELY DO NOT CLOSE (t87b).
   *
   * These read `statusIsAnchored` directly rather than through `permanentFailureReason`, because the
   * question is about the POSITION rule itself and the prose arms would answer some of these for
   * other reasons.
   */
  const STILL_ANCHORED: ReadonlyArray<[string, string]> = [
    ['status code 402', 'the compound introducer — it used to match through the bare `code` that '
      + 'narrowing 1 removed, so removing `code` without adding `status code` back would have taken '
      + 'a TRUE positive with it. This row is that pair.'],
    ['error code 402 returned by the gateway', 'the other compound spelling'],
    ['402 Payment Required', 'the leading arm still works on a bare status line'],
    ['HTTP/1.1 402 is what came back', 'narrowing 2 dropped brackets and quotes, NOT the HTTP '
      + 'version prefix — a message that opens with a real status line still announces one'],
    ['  402 Payment Required', 'leading whitespace is the same message untrimmed, and still counts'],
    // ⚠ KNOWN AND DELIBERATE. `err`/`error` stay bare introducers because the incident's own string
    // is `API error 402: {"message":"Insufficient Balance"}` — `error` + separator + number IS the
    // shape that matters. No rule this function can express separates it from the same words in a
    // sentence; doing so wants the number's RIGHT-hand side, which is a third narrowing and its own
    // round. These two rows exist so the gap is a recorded decision rather than an oversight: if a
    // later round closes it, they go red and whoever closes it updates the doc above with them.
    ['err 402 entries queued', 'RESIDUAL, not a pass: `err` is load-bearing for real SDK text'],
    ['the error 402 times in a row', 'RESIDUAL, not a pass: `error` is load-bearing for the '
      + 'incident string itself'],
  ];

  it.each(STILL_ANCHORED)('⚠ t87b: `%s` still reads as a status position', (text) => {
    expect(statusIsAnchored(text, 402), 'narrowing the anchor must not cost a real status position, '
      + 'and the two residual rows are recorded decisions — see the comment above this table').toBe(true);
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

// ── §2 — LAYER 1: the brakes work under force, and NO terminal state exists ──────────────

describe('§2 the forced path has a brake and NO terminal state', () => {
  // OR-COMPACT-1 re-aim: v3.2.3's §2 asserted "and there is a terminal state". The owner
  // abolished it. The anti-thrash half is unchanged and still asserted here; what changed is
  // that every arm of the brake LETS GO, and a pass that reclaims nothing is a defect report.
  it('⚠ THE DEFECT: a forced pass that won nothing arms the brake — under force, and on a clock', () => {
    // Pre-fix this returned nothing and the next prompt ran the identical pass.
    const defect = notePassOutcome(AGENT, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 16 },
      { assembledTokens: 114_000, budgetTokens: 62_000 });
    expect(defect, 'a forced pass that reclaimed 16 tokens while over budget is a DEFECT to repair').toBeTruthy();
    expect(compactionFailureReason(AGENT), 'named by the stage that refused, not by a state').toBe('no_yield');
    // And the brake now holds WITH force, which is the v3.2.3 fix, kept.
    expect(compactionIsBraked(AGENT, true), 'force must not bypass a brake the emergency itself armed').toBe(true);
    expect(compactionIsBraked(AGENT, false)).toBe(true);
    // ⚠ AND IT IS NOT FOR EVER — the whole of OR-COMPACT-1 in one assertion. Fifteen minutes
    // and one millisecond later the same agent, with nothing else changed, may compact again.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + LOW_YIELD_BACKOFF_MS + 1);
      expect(compactionIsBraked(AGENT, false), 'a brake with no expiry is the terminal state, re-grown').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('OR-COMPACT-1: a no-yield pass shows the owner NO card, and says so in the log instead', () => {
    // The clause this replaces demanded a card reading "This agent's memory cannot compress
    // further… Archive this conversation or reset the agent's session to give it room". The
    // owner deleted that sentence: a person must never be asked to destroy memory because the
    // engine ran out of ideas. So the assertion inverts — nothing user-facing is emitted at
    // all for a stage the owner cannot repair, and the repair audience is the defect log line
    // (`compaction-has-no-bottom.test.ts` §3 drives that line and its fields).
    notePassOutcome(AGENT, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 },
      { assembledTokens: 114_000, budgetTokens: 62_000 });
    expect(frames.filter(f => f.type === 'chat:error'), 'no card for a stage the owner cannot act on').toEqual([]);
    expect(compactionFailureReason(AGENT), 'but the platform knows it is failing').toBe('no_yield');
    // And the one card that IS left names a repairable reason and promises nothing destructive.
    const failing = compactionFailingCardText('summary_writer_unavailable');
    expect(failing).toContain('memory compaction is failing');
    expect(failing).toContain('compaction resumes by itself');
    expect(failing).not.toMatch(/archiv/i);
    expect(failing).not.toMatch(/reset/i);
    expect(failing).not.toMatch(/cannot compress/i);
  });

  it('OR-COMPACT-1: "the summaries are already over budget" is now the CASE FOR condensation', async () => {
    // ⚠ THE REASON THIS CLAUSE INVERTS. v3.2.3 made "summaries exceed the assembly budget" the
    // name of a terminal state (`summaries_exceed_budget`), with a card saying the summaries
    // alone fill the window. The owner's ruling is the opposite reading of the same fact: a
    // summary is compressible, so a window full of summaries is work to do, not a wall. The
    // reported shape — 43 leaf summaries, ~86K of tokens — must therefore report itself as
    // CONDENSABLE, and the reason vocabulary no longer contains the word.
    const { __resetEstimateCacheForTests: resetEst } = await import('../assembled-estimate-cache.js');
    resetEst();
    seedBox({ messages: 40, summaryTokens: 86_000 });
    expect(condensableSummaries(AGENT), '43 top-level summaries can always merge').toBeGreaterThan(1);

    // A pass that won nothing while over budget is a defect named by the STAGE that refused…
    expect(notePassOutcome(AGENT, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 },
      { assembledTokens: 114_000, budgetTokens: 50_000, stage: 'bounded_without_progress' })).toBeTruthy();
    expect(compactionFailureReason(AGENT)).toBe('bounded_without_progress');

    // …and a pass that WON clears it, whatever the summaries say — the counterexample, pinned.
    __resetBrakesForTests();
    expect(notePassOutcome(AGENT, true, { leafCreated: 2, condensedCreated: 0, tokensReclaimed: 30_000 }, { assembledTokens: 40_000, budgetTokens: 50_000 }))
      .toBeNull();
    expect(compactionFailureReason(AGENT), 'a pass that summarised something is not failing').toBeNull();
  });

  /**
   * ⚠ THE DOORS STILL WORK, AND NOW THEY WORK ON THE BRAKE. (review M2, re-aimed by OR-COMPACT-1)
   *
   * v3.2.3 wrote a card promising three things cleared the latch — archive, reset the session,
   * switch to a bigger model — and the review found `clearIncompressible` had ZERO callers, so
   * none of them did. The card is deleted, but the three doors are still the three things that
   * genuinely give an agent room, and each must still let the brake go EARLY rather than waiting
   * out the fifteen minutes. Driven through the real door, never through the clear function.
   */
  it('the three doors that give an agent room each release the backoff early', async () => {
    const { compactionIsBraked, notePassOutcome, __resetBrakesForTests } = await import('../compaction-brakes.js');
    const { archiveAgentConversation } = await import('../../vault/archive.js');
    seedBox({ messages: 40, summaryTokens: 4_000 });
    const db = mockDb.current!;
    const latchIt = (): void => {
      __resetBrakesForTests();
      notePassOutcome(AGENT, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
      expect(compactionIsBraked(AGENT, true), 'precondition: the agent is braked').toBe(true);
    };

    // PROMISE 1 — "archive this conversation". The chokepoint all six doors call.
    latchIt();
    archiveAgentConversation(AGENT, true);
    expect(compactionIsBraked(AGENT, true), 'archiving must give the agent room back').toBe(false);

    // PROMISE 2 — "reset the agent's session". The boundary the assembler reads from, moved by
    // raw SQL exactly as all five reset doors do it — no brake function is called here at all.
    latchIt();
    db.prepare('UPDATE agents SET session_started_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', AGENT);
    expect(compactionIsBraked(AGENT, true), 'a session reset must give the agent room back').toBe(false);

    // PROMISE 3 — "switching it to a model with a larger context window also clears this". Nine
    // sites write this column; the latch notices the column, not the sites.
    latchIt();
    db.prepare('UPDATE agents SET model_id = ? WHERE id = ?').run(MODEL_131K, AGENT);
    expect(compactionIsBraked(AGENT, true), 'a bigger window must give the agent room back').toBe(false);
    db.prepare('UPDATE agents SET model_id = ? WHERE id = ?').run(MODEL_64K, AGENT);

    // AND THE CONTROL: none of those happened, so the brake still binds. Without this row the
    // three above would pass just as well on a brake that never holds at all.
    latchIt();
    expect(compactionIsBraked(AGENT, true), 'an agent given no room stays braked').toBe(true);
  });

  /**
   * ⚠ THE PRE-WORK LATCH IS GONE, AND ITS SLOT NOW ROUTES TO CONDENSATION. (review M3, re-aimed
   * by OR-COMPACT-1)
   *
   * `latchIfSummariesExceedBudget` latched BEFORE any model call on two facts: the summaries
   * already exceed the assembly budget, and there is nothing left outside the fresh tail worth
   * compacting. Those two facts together are the incident, and the owner ruled they are the
   * CASE FOR condensation. So the function is deleted and the same slot — ahead of the
   * continuity brief, the chunk loop and every provider dial — now hands that state to
   * `condenseOnlyPass`. Two clauses again, because the deletion needs both halves proved: that
   * no latch survives anywhere, and that something real took its place.
   */
  it('the entry point has NO terminal pre-work latch left, and routes that state to condensation', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'compaction.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // THE DELETION, in the only place that can prove it: no latch call, under any name.
    expect(code, 'the pre-work terminal latch must be gone from the entry point, not merely unused')
      .not.toMatch(/latchIfSummariesExceedBudget|latchIncompressible|isIncompressible/);
    // AND THE REPLACEMENT, asserted as a call SHAPE with its application (G4): the leaf-less
    // branch must RETURN the condensation pass, or it is prose above a dead end.
    const call = code.match(/^\s*return condenseOnlyPass\(.*$/m)?.[0];
    expect(call, '`compaction.ts` must route the leaf-less over-budget state to the condenser').toBeTruthy();
    expect(call, 'with the summary-writer model it must dial').toContain('modelId');
    expect(call, 'with the budget it is trying to get under').toContain('threshold');
    expect(call, 'and the compactable-row count the branch was chosen on').toContain('guardUncompactedCount');
    const guard = code.match(/^\s*if \(guardUncompactedCount < MIN_COMPACTABLE_ROWS\) \{$/m);
    expect(guard, 'the branch must be chosen by the row floor, not by force').toBeTruthy();
    // IN THE SAME SLOT: ahead of the continuity brief, the chunk loop and every provider dial.
    const routeAt = code.indexOf('return condenseOnlyPass(agentId');
    const briefAt = code.indexOf('generateContinuityBrief(agentId');
    expect(routeAt).toBeGreaterThan(0);
    expect(briefAt).toBeGreaterThan(0);
    expect(routeAt, 'a pre-work route that runs after the work is not a pre-work route')
      .toBeLessThan(briefAt);
  });

  it('⚠ AND THE WORD IS GONE FROM EVERY SHIPPED SOURCE LINE — the census', () => {
    // OR-COMPACT-1 abolished the concept, so the census is the clause: not one production line
    // in the server or the shared wire may still say it. Comments are STRIPPED first, because a
    // clause satisfiable by prose tests the prose (G4); this file's own notes may say the word.
    const here = dirname(fileURLToPath(import.meta.url));
    const roots = [join(here, '..', '..'), join(here, '..', '..', '..', '..', 'shared', 'src')];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(full); continue; }
        if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (/INCOMPRESSIBLE/i.test(code)) hits.push(full);
      }
    };
    for (const r of roots) walk(r);
    expect(hits, 'a terminal state the owner abolished may not survive in code').toEqual([]);
  });

  it('a purge that SHRINKS the history releases it too — the old rule only looked up', async () => {
    const { compactionIsBraked, notePassOutcome, __resetBrakesForTests } = await import('../compaction-brakes.js');
    seedBox({ messages: 40, summaryTokens: 4_000 });
    const db = mockDb.current!;
    __resetBrakesForTests();
    notePassOutcome(AGENT, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    expect(compactionIsBraked(AGENT, true)).toBe(true);
    // The most room an agent can gain. `MAX(seq) - seqAtLatch` goes NEGATIVE, which the
    // six-rows-gained rule read as "nothing changed" and held the latch on an empty history.
    db.prepare('DELETE FROM messages WHERE agent_id = ? AND seq > (SELECT MIN(seq) FROM messages WHERE agent_id = ?)')
      .run(AGENT, AGENT);
    expect(compactionIsBraked(AGENT, true), 'a purged history is a different question').toBe(false);
  });

  it('a pass that WON resets everything — the fix must not become "compaction never runs"', () => {
    notePassOutcome(AGENT, false, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    expect(compactionIsBraked(AGENT, false), 'the 15-minute brake is armed').toBe(true);
    expect(compactionIsBraked(AGENT, true), 'but a real emergency still acts').toBe(false);
    notePassOutcome(AGENT, false, { leafCreated: 3, condensedCreated: 1, tokensReclaimed: 40_000 });
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

  /**
   * ⚠ AND THE KEY CAN SEE THE SURFACE IT IS KEYED ON. (review M4)
   *
   * The caller used to pass `agentId:modelId`, which moves for NONE of the three things the cache's
   * own doc names. Each row below moves one of them through its real mechanism and demands a
   * recompute; the first row demands that an UNCHANGED surface still only pays once, without which
   * "it recomputes" would pass on a key that is simply always different.
   */
  it('the surface key moves with the generation, the session docs and the agent row', async () => {
    seedBox({ messages: 10, summaryTokens: 1_000 });
    const { toolSurfaceKey } = await import('../assembled-estimate-cache.js');
    const { bumpToolConfigGeneration } = await import('../../agent/tool-config-generation.js');
    const { markToolsLoaded, resetSessionToolSetsForTests } = await import('../../tools/tool-session-set.js');
    resetSessionToolSetsForTests();
    const db = mockDb.current!;

    const first = toolSurfaceKey(AGENT, MODEL_64K);
    expect(toolSurfaceKey(AGENT, MODEL_64K), 'nothing moved, so the key must not').toBe(first);

    // 1. THE GLOBAL SURFACE — an integration connected or removed bumps this counter, which is the
    //    same one `getFilteredTools` keys its own memo on.
    bumpToolConfigGeneration();
    const afterBump = toolSurfaceKey(AGENT, MODEL_64K);
    expect(afterBump, 'a widened or narrowed global tool surface is a different payload').not.toBe(first);

    // 2. `load_tool_docs` IN A SESSION — the doc's second named mover, driven through the module
    //    that owns the session set rather than simulated.
    markToolsLoaded(AGENT, ['vault_search']);
    const afterLoad = toolSurfaceKey(AGENT, MODEL_64K);
    expect(afterLoad, 'loaded tool docs are real tokens in the payload').not.toBe(afterBump);

    // 3. THE PER-AGENT SURFACE — grants materialise onto the agent row, which stamps updated_at.
    db.prepare("UPDATE agents SET permissions = ?, updated_at = '2026-10-02T00:00:01Z' WHERE id = ?")
      .run('{"tools":{"allow":["vault_search"]}}', AGENT);
    expect(toolSurfaceKey(AGENT, MODEL_64K), 'a changed grant is a changed tool set').not.toBe(afterLoad);

    // And the measurement actually rides that key — not a key the call site invents.
    let built = 0;
    const measure = async (): Promise<number> => { built += 1; return 9_000; };
    const k1 = toolSurfaceKey(AGENT, MODEL_64K);
    await cachedToolPayloadTokens(AGENT, k1, measure);
    await cachedToolPayloadTokens(AGENT, k1, measure);
    expect(built, 'an unchanged surface is measured once').toBe(1);
    markToolsLoaded(AGENT, ['vault_get']);
    await cachedToolPayloadTokens(AGENT, toolSurfaceKey(AGENT, MODEL_64K), measure);
    expect(built, 'and a changed surface is measured again').toBe(2);
    resetSessionToolSetsForTests();
  });

  it('the entry point keys the tool payload on that surface, not on the model id', () => {
    // The review's finding was a CALL SITE passing the wrong ingredients, so the call site is what
    // this pins — the same reason the M3 wiring clause reads source.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'compaction.ts'), 'utf8');
    const call = src.match(/^\s*toolPayloadTokens: .*$/m)?.[0];
    expect(call, 'the tool payload must be keyed by `toolSurfaceKey`').toContain('toolSurfaceKey(agentId, modelId)');
    expect(call, 'and never again by an invented agent:model string').not.toMatch(/\$\{agentId\}:\$\{modelId/);
  });

  it('⚠ THE HEADLINE: event-loop starvation, pre-fix shape vs post-fix shape, one body', async () => {
    // 400 messages and 86K of summaries — a tenth of the reported backlog, which is the honest scale for a
    // unit box. The RATIO is the finding; the absolute numbers are recorded, not asserted.
    seedBox({ messages: 400, summaryTokens: 86_000 });

    // PRE-FIX: three uncached estimates + a summariser prompt BUILT for every chunk of a dead
    // provider's backlog. This is the loop that pinned the reported box's core.
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
    expect(cloud.decision, 'the reported cloud row is over the block line — forced compaction every prompt').toBe('block');
    expect(local.decision, 'the same history on a 131K window is not an emergency').not.toBe('block');
    expect(local.decision).not.toBe('compact');
    // Which is the whole cloud/local asymmetry the report describes, in one assertion.
    expect(cloud.ratio).toBeGreaterThan(local.ratio);
  });

  it('a provider that answers properly is never broken, and compaction proceeds', () => {
    noteProviderFailure(LIVE_PROVIDER, 'API error 503: overloaded', AGENT);
    noteProviderFailure(LIVE_PROVIDER, 'API error 503: overloaded', AGENT);
    noteProviderFailure(LIVE_PROVIDER, 'socket hang up', AGENT);
    expect(providerBreaker(LIVE_PROVIDER), 'transient failures must never open a breaker').toBeNull();
    expect(mayDialProvider(LIVE_PROVIDER)).toBe(true);
    expect(frames.filter(f => f.code === 'QUOTA_EXHAUSTED').length, 'no card for a bad minute').toBe(0);
    // And a real summary run clears the brake rather than reporting a defect.
    expect(notePassOutcome(AGENT, true, { leafCreated: 4, condensedCreated: 0, tokensReclaimed: 52_000 })).toBeNull();
    expect(compactionFailureReason(AGENT), 'a pass that won must not be marked failing').toBeNull();
    expect(compactionIsBraked(AGENT, true)).toBe(false);
  });
});

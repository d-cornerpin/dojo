// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 6 (H3, ruling R-V333-15) — THE EMERGENCY PASS IS BOUNDED BY THE TURN, NOT BY NUMBERS.
//
// t91's forced pass (the pre-call gate's 96 %/99 % arms, and the boundary refusal's condense) carried
// a three-minute clock and a ten-chunk cap, and condensation a twelve-call cap per run. The forced
// pass is awaited inside the owner's turn, so its real bound is the turn's own patience: how long the
// owner already lets the dialed model take to start answering (its provider's declared first-chunk
// patience, or the transport's standing one) — the same bound the out-of-view fold has had since
// round 5. Inside it the pass folds as much as it can; what is left continues next turn, as before.
// A writer that is answering is never cut by a clock of ours; one that is not is ended by its own
// transport's patience. Condensation stays finite by its level count (a backstop, kept).
//
// THE DOORS: `forcedCompactionOptions` → the real `checkAndCompact`; the real `condenseUntilFits`.
// The fixture is `compaction-has-no-bottom.test.ts`'s (t91), copied. Fake clock where time matters.
//
// ── t91's fixture header, kept for the harness's context ──
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
import { condenseUntilFits, rawContextSummaryTokens } from '../condense-until-fits.js';
import { forcedCompactionOptions, __resetBrakesForTests } from '../compaction-brakes.js';
import { cachedAssembledEstimate, __resetEstimateCacheForTests } from '../assembled-estimate-cache.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';

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

/**
 * A SEEDED SUMMARY COVERS A MESSAGE, because a real box's summary does (t111-B2).
 *
 * `seedSummaries` and `seedMixed` used to write `summaries` rows and NO `summary_messages`
 * links, so every fixture here held summaries that covered nothing — a boundary-less agent a
 * real box cannot produce. t100 already hit this for one clause further down (see its note
 * around `getCompactedMessageIds`) and linked that summary by hand; this does the same thing
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
  linkSeededSummaries(rows.map((r, i) => `mix-${i}-d${r.depth}`));
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


/** A writer that WORKS but needs `ms` — and stops if its call is aborted first. */
const slowWriter = (ms: number): Answer => async (p) => {
  const signal = (p as { abortSignal?: AbortSignal }).abortSignal;
  const ok = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    const cut = () => { clearTimeout(t); resolve(false); };
    if (signal?.aborted) cut(); else signal?.addEventListener('abort', cut, { once: true });
  });
  return ok ? producesWhatItWasAskedFor(p) : { ok: false, reason: 'summarizer call was aborted before it finished' };
};

async function onTheClock<T>(p: Promise<T>, maxMs = 900_000): Promise<T> {
  let done = false; let value: T | undefined; let error: unknown;
  p.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let t = 0; t < maxMs && !done; t += 1_000) {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(1_000);
  }
  if (!done) throw new Error('never settled on the clock');
  if (error) throw error;
  return value as T;
}

describe('t140 round 6 — the forced pass is bounded by the turn\'s patience', () => {
  it.fails('a writer that answers after 200 s — past t91\'s 3-minute clock, inside a 5-minute patience — has its work kept', async () => {
    seedSummaries(43, 0, 2_000);
    const before = held();
    answer = slowWriter(200_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const opts = forcedCompactionOptions(300_000);
    const result = await onTheClock(checkAndCompact(AGENT, MODEL_64K, 65_536, opts));
    expect(result.condensedCreated, 'the working writer finished inside the turn\'s patience').toBeGreaterThan(0);
    expect(held()).toBeLessThan(before);
  });

  it.fails('the forced pass carries no chunk cap: more than ten leaf chunks are folded in one pass', async () => {
    // 400 older rows of ~1,000 tokens outside the 40-row fresh tail: ~13 leaf chunks of 30K.
    const db = mockDb.current!;
    const ins = db.prepare(`INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
      turn_number, provenance, authorized, token_count, created_at) VALUES (?, ?, 'assistant', 'owner', ?, 'agent-text', 'agent-only', 1, 'live', 1, 1000, ?)`);
    const body = 'The north dock tally, stack by stack. '.repeat(105);
    db.transaction(() => { for (let i = 0; i < 400; i++) ins.run(`old-${i}`, AGENT, body, Date.now() - (2_000_000 - i * 1000)); })();
    __resetEstimateCacheForTests();
    const opts = forcedCompactionOptions(300_000);
    await checkAndCompact(AGENT, MODEL_64K, 65_536, opts);
    expect(calls.filter((c) => c.depth === 0).length, 'every leaving chunk, not ten').toBeGreaterThan(10);
    expect((opts as { maxChunksPerRun?: number }).maxChunksPerRun, 'no chunk cap on the forced pass').toBeUndefined();
  });

  it.fails('condensation has no per-run call cap: a level that needs fifteen calls makes fifteen', async () => {
    seedSummaries(60, 0, 2_000);
    await condenseUntilFits({
      agentId: AGENT, modelId: MODEL_64K, minFanout: 4, targetTokens: 2_000,
      measure: () => cachedAssembledEstimate(AGENT, 65_536, MODEL_64K, () => estimateAssembledTokens(AGENT, 65_536, MODEL_64K)),
      rebuild: () => rebuildContextItems(AGENT),
    });
    expect(calls.length, 'the first level alone is fifteen batches of four').toBeGreaterThan(12);
  });
});

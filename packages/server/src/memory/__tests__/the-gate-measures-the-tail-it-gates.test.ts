// ════════════════════════════════════════════════════════════════════════════════════════
// t100 — THE COMPACTION GATE MEASURES THE TAIL THE ASSEMBLER ACTUALLY SENDS.
//
// ── THE SEAM TWO MERGED LANES LEFT ──────────────────────────────────────────────────────
// t94 made the assembler's fresh tail HORIZON-BOUNDED: the live conversation is every row
// since the compaction boundary, it grows while the boundary holds still, and it is cut only
// where a compaction has just rewritten the prefix anyway (`memory/tail-horizon.ts`). The
// compaction gate's own dry run, `estimateAssembledTokens`, still read that tail with the OLD
// ROW CAP — `getRecentMessages(agentId, policy.freshTailCount)` — so it measured a tail the
// assembler no longer sends. t94's own instrument put the number on it: 68 rows admitted, 40
// seen, BLIND TO 28 OF THEM, and it pinned the disagreement as a tripwire
// (`the-tail-trims-only-at-a-boundary.test.ts` §9) that reds exactly when this seam lands.
//
// ── WHY A WRONG NUMBER HERE IS A BEHAVIOUR AND NOT A STATISTIC ──────────────────────────
// Two decisions read this one estimate, and both read it LOW while the row cap stood:
//   * the TOKEN trigger in `runCheckAndCompact` (`total > 0.96 × window`), and
//   * `context-gates.ts`'s warn / compact / block rungs, which run before the call.
// The ROW-GAP trigger (`UNCOMPACTED_GAP_THRESHOLD = 30` rows past the cap) is not token-based
// and kept firing on schedule, which is what stopped the blindness being a freeze. But the
// gap trigger cannot see WEIGHT. An agent whose span sits just under the gap threshold while
// its rows are heavy — a tool-heavy run, a few long pastes — is exactly the shape where the
// token trigger is the only one that can act, and it was the one reading a 40-row slice of a
// 68-row tail. That shape is clause 1 below, driven rather than described.
//
// ── WHAT "THE SAME TAIL" MEANS, PRECISELY, BECAUSE IT IS NOT "THE SAME BYTES SENT" ──────
// The gate measures the assembler's ASK — the span admitted before `budgetFreshTail`'s token
// trim runs — and that is the right input to "should this agent compact", not an oversight.
// It is also what the row cap used to measure: pre-t94 the gate's cap and the assembler's ask
// were the same number by construction. If the ASK is over the window, the assembler is about
// to front-trim to fit, and a front-trim is the prefix rewrite this whole subsystem exists to
// avoid; the gate's job is to get a compaction to run FIRST. So the identity the seam restores
// is gate-set == assembler-ask, and that identity is what these clauses hold.
//
// G1: every fixture body below is fictional depot chatter — no names, no personal data.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));

vi.mock('../../tools/tool-docs.js', () => ({
  measureAgentToolPayloadTokens: async () => 1000,
}));

/** The summary writer's model call: deterministic and fictional, so a compaction that runs
 *  produces the same summary every time. */
vi.mock('../../agent/model.js', () => ({
  callModel: async () => ({
    content: 'Earlier in this run the two sides worked through the depot crate inventory.',
    toolCalls: [],
    usage: {},
  }),
  // The literal is deliberate: a `vi.mock` factory is hoisted above this file's own
  // `const WINDOW`, so reading the constant here would depend on when the mock is first
  // touched. `WINDOW` below asserts the two agree.
  getContextWindow: () => 32_000,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

import {
  checkAndCompact, estimateAssembledTokens, getUncompactedGapCount, UNCOMPACTED_GAP_THRESHOLD,
} from '../compaction.js';
// Module state, keyed by agent id: without the reset a pass in one clause brakes the next
// clause's gate for fifteen minutes and the second one silently measures a tree with
// compaction switched off (the trap t94's own file documents).
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { __resetEstimateCacheForTests } from '../assembled-estimate-cache.js';
import { contextWindowPolicy, CONTEXT_THRESHOLD, getFreshTailCount } from '../budget.js';
import { freshTailHorizon } from '../tail-horizon.js';
import { insertMessage } from '../message-store.js';
import { createLeafSummary } from '../dag.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t100';
const MODEL = 'model-t100';
/** `getFreshTailCount(32000) = 40` rows, and the token trigger sits at 0.96 × 32,000. */
const WINDOW = 32_000;
/** The gate's token trigger, in tokens — the same expression `runCheckAndCompact` builds. */
const TOKEN_TRIGGER = CONTEXT_THRESHOLD * WINDOW;

const db = (): Database.Database => mockDb.current!;

function seedModel(): void {
  db().prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://localhost:11434/v1')",
  ).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 'local-mix', 'Local Mix', ?, 4096, '["tools","thinking"]', 1)`,
  ).run(MODEL, WINDOW);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, ?, 'idle', ?, '{}')")
    .run(AGENT, 'Instrument', MODEL);
}

/**
 * ONE ROW OF A HEAVY TURN, at a known cost.
 *
 * `message-store.ts` stamps `token_count = ceil(chars / 4)` at the write, so a body padded to
 * `tokens × 4` characters costs exactly `tokens`. The weight is the fixture's whole point —
 * see the arithmetic asserted in clause 1 — so it is built from the unit rather than guessed
 * at by writing long prose and hoping.
 */
function bodyOfTokens(tokens: number, tag: string): string {
  const head = `[${tag}] `;
  const filler = 'the depot crate inventory was checked against the clipboard again. ';
  let text = head;
  while (text.length < tokens * 4) text += filler;
  return text.slice(0, tokens * 4);
}

let turnNo = 0;

/** One outer turn: the ask and the answer, both at `rowTokens` apiece. */
function appendTurn(rowTokens: number): void {
  turnNo++;
  db().prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, 'user', datetime('now'), NULL, NULL, 0)`,
  ).run(AGENT, turnNo);
  insertMessage({
    agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner',
    content: bodyOfTokens(rowTokens, `t${turnNo}u`), turnNumber: turnNo,
  });
  insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'owner',
    content: bodyOfTokens(rowTokens, `t${turnNo}a`), turnNumber: turnNo,
  });
}

/** What the OLD read measured: the newest `cap` rows, by the stored unit the gate spends. */
function rowCapViewTokens(cap: number): number {
  const rows = db().prepare(
    'SELECT token_count AS t FROM (SELECT token_count FROM messages WHERE agent_id = ? ORDER BY seq DESC LIMIT ?)',
  ).all(AGENT, cap) as Array<{ t: number }>;
  return rows.reduce((sum, r) => sum + r.t, 0);
}

beforeEach(() => {
  turnNo = 0;
  __resetBrakesForTests();
  __resetEstimateCacheForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedModel();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── §1 THE PURPOSE OF THE SEAM: THE TRIGGER FIRES WHEN THE REAL TAIL IS HEAVY ───────────
//
// The fixture is t94's 68-vs-40 shape with WEIGHT on it, and it is built so the two readings
// straddle the trigger — which the clause computes from the database instead of asserting a
// remembered number:
//
//   * 34 turns × 2 rows × 600 tokens = 68 rows, 40,800 tokens. Over 30,720.
//   * the newest 40 of those rows — the row cap's view — are 24,000 tokens. Under 30,720.
//   * the ROW-GAP trigger cannot help: 68 − 40 = 28 uncompacted rows outside the tail, and
//     the gap threshold is 30. So the token trigger is the ONLY door, which is the condition
//     this clause exists for.
//
// Post-seam the gate reads 40,800, the trigger fires and a leaf summary is written. Pre-seam
// it read 24,000, nothing fired, and the assembler went on to front-trim the tail to fit —
// the prefix rewrite t94 exists to prevent, caused by the gate's own blindness.
describe('t100 §1 — a heavy tail past the row cap reaches the token trigger', () => {
  /** 34 heavy turns, and the fixture's own proof that it straddles the trigger. Stated as
   *  arithmetic over the stored rows rather than as two remembered literals: if a later edit
   *  makes either side stop straddling, it says so here instead of letting a clause below
   *  pass for the wrong reason. */
  function seedHeavyRunPastTheCap(cap: number): void {
    for (let t = 1; t <= 34; t++) appendTurn(600);
    expect(rowCapViewTokens(cap)).toBeLessThan(TOKEN_TRIGGER);          // 24,000 < 30,720
    // And the row-gap trigger is genuinely shut, so nothing but the token trigger can act.
    expect(getUncompactedGapCount(AGENT, WINDOW)).toBeLessThanOrEqual(UNCOMPACTED_GAP_THRESHOLD);
  }

  it('the gate measures the whole span, and that reading is over the trigger', async () => {
    const cap = getFreshTailCount(WINDOW);
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 4096 });
    expect(cap).toBe(40);
    seedHeavyRunPastTheCap(cap);

    const horizon = freshTailHorizon(AGENT, policy);
    expect(horizon.rowsSinceBoundary).toBe(68);
    expect(horizon.requestRows).toBe(68);
    expect(horizon.rowsSinceBoundary).toBeGreaterThan(cap);

    // THE SEAM: the gate's dry run measures the span the assembler will ask for.
    const est = await estimateAssembledTokens(AGENT, WINDOW, MODEL);
    expect(est.freshTailCount).toBe(horizon.rowsSinceBoundary);          // 68, not 40
    expect(est.freshTailTokens).toBeGreaterThan(TOKEN_TRIGGER);
    expect(est.total).toBeGreaterThan(TOKEN_TRIGGER);
  }, 120_000);

  // THE SAME FIXTURE, THROUGH THE DECISION THE NUMBER FEEDS. Separated from the measurement
  // above on purpose: a clause that stops at the count proves the gate SEES the tail, and the
  // requirement is that compaction RUNS. With the row cap restored this one reds too, with
  // `expected 0 to be greater than 0` — the behaviour, not the statistic.
  it('and the decision it feeds: a compaction actually runs on that turn', async () => {
    const cap = getFreshTailCount(WINDOW);
    seedHeavyRunPastTheCap(cap);

    const result = await checkAndCompact(AGENT, MODEL, WINDOW, {
      maxChunksPerRun: 1, skipContinuityBrief: true,
    });
    expect(result.leafCreated).toBeGreaterThan(0);
  }, 120_000);
});

// ── §2 THE CONTROL: BELOW THE CAP THE SEAM CHANGES NOTHING ──────────────────────────────
//
// A young conversation is the floor case — the uncompacted span is smaller than the row cap,
// so the horizon returns the pre-t94 answer (ask for the cap, filter nothing) and the gate's
// number is byte-for-byte the number the row cap produced. This clause is a CONTROL: it is
// green before the seam and after it, by design. Its job is to refuse the other failure
// shape, which is an over-eager gate — a dry run that measured MORE than the assembler asks
// for would fire compaction on a history that is not under pressure, and `compaction.ts`'s
// own 2026-07-23 receipt ("compaction SO much, saving like 16 tokens") is what that costs.
describe('t100 §2 — a young conversation is the pre-seam answer exactly', () => {
  it('the gate asks for the row cap, measures what is there, and no trigger fires', async () => {
    const cap = getFreshTailCount(WINDOW);
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 4096 });
    for (let t = 1; t <= 15; t++) appendTurn(600);                       // 30 rows, under the cap

    const horizon = freshTailHorizon(AGENT, policy);
    expect(horizon.keepFromSeq).toBe(0);                                 // no front filter
    expect(horizon.requestRows).toBe(cap);                               // the floor's own ask
    expect(horizon.rowsSinceBoundary).toBe(30);

    const est = await estimateAssembledTokens(AGENT, WINDOW, MODEL);
    expect(est.freshTailCount).toBe(30);                                 // every row there is
    expect(est.total).toBeLessThan(TOKEN_TRIGGER);                       // 18,000 < 30,720
    expect(getUncompactedGapCount(AGENT, WINDOW)).toBe(0);

    const result = await checkAndCompact(AGENT, MODEL, WINDOW, {
      maxChunksPerRun: 1, skipContinuityBrief: true,
    });
    expect(result.leafCreated).toBe(0);
  }, 120_000);

  // The same control on the other side of a compaction: the DEEP-COMPACTION FLOOR, where a
  // summary already covers nearly everything and the span left over is smaller than the cap.
  // This is the state where an over-ask is most expensive — the gate would count rows the
  // summary beside them already represents — so the floor's ask is pinned here too, as a
  // count, which is what an ask is when nothing is filtered.
  it('the deep-compaction floor still asks for exactly the cap', async () => {
    const cap = getFreshTailCount(WINDOW);
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 4096 });
    for (let t = 1; t <= 60; t++) appendTurn(150);                       // 120 light rows
    const covered = db().prepare(
      'SELECT id FROM messages WHERE agent_id = ? ORDER BY seq ASC LIMIT 110',
    ).all(AGENT) as Array<{ id: string }>;
    expect(covered.length).toBe(110);
    createLeafSummary(AGENT, 'The depot inventory run, condensed.', 400,
      covered.map((r) => r.id), '2026-01-01 00:00:00', '2026-01-02 00:00:00');

    const horizon = freshTailHorizon(AGENT, policy);
    expect(horizon.rowsSinceBoundary).toBe(10);                          // 10 <= cap: the floor
    expect(horizon.keepFromSeq).toBe(0);
    expect(horizon.requestRows).toBe(cap);

    // 120 rows exist, so an ask of `cap + cap` would answer 80 here and an ask of `cap`
    // answers 40. The count IS the ask.
    const est = await estimateAssembledTokens(AGENT, WINDOW, MODEL);
    expect(est.freshTailCount).toBe(cap);
  }, 120_000);
});

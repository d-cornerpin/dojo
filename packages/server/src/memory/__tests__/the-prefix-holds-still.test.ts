// ════════════════════════════════════════════════════════════════════════════════════════
// T67b — THE PREFIX HOLDS STILL. THE CROSS-TURN MESSAGE-PREFIX INVARIANCE GATE.
//
// ── THE INCIDENT (owner, 2026-08-31; his local-DS4 agent's own trace) ────────────────────
// The prefix his server re-processed every turn diverged at token ~33,600 — AT A DATE — and
// ~14,200 tokens were recomputed on every single turn, ~90s of prefill burned for nothing.
//
// ── WHAT NO GATE ASSERTED BEFORE THIS FILE ──────────────────────────────────────────────
// Three prefix gates existed and none of them could see this class:
//   • `check-cache-prefix.mjs` (kit) — the SYSTEM string and the tools array only.
//   • `deploy/checks/check-prefix-determinism.mjs` — the same two surfaces.
//   • `check-message-prefix.mjs` (kit) — the message array, but WITHIN one fixed ask, on a
//     freshly reset session, comparing exactly two receipts.
// So: per-assembly determinism was proven, SYSTEM-prefix invariance was proven, and
// CROSS-TURN invariance of the MESSAGE region — the property the owner's bill is a function
// of — was proven by nothing at all.
//
// ── THE PROPERTY, STATED ONCE ───────────────────────────────────────────────────────────
// History is APPEND-ONLY. Between two assemblies with no content-change event, the earlier
// assembly's message array must be a byte-exact PREFIX of the later one. Nothing above the
// newest exchange may move — not for the wall clock, not for a scaffolding gate flipping,
// not because a retrieval re-ranked against a new ask, not because a turn counter crossed a
// threshold. T56 established the one lawful exception and it is not weakened here: a
// COMPACTION has already rewritten that region, so it may move there and only there.
//
// ── EVERY CLAUSE BELOW IS RED AT THIS TASK'S BASE COMMIT `b522d36` ───────────────────────
//   §1  the briefing's `generated=` stamp is `new Date()` AT ASSEMBLY (assembler.ts:865) —
//       the date the owner's trace diverged on.
//   §2  `lane.briefing` / `lane.vault` / `lane.active-tasks` render only on
//       `shouldFireScaffolding`, so the prefix FLAPS between two shapes one turn apart.
//   §3  `lane.active-tasks` renders `relAgo(...)` — "3m ago" becomes "8m ago" with no
//       tracker row changed.
//   §4  `lane.vault` runs a retrieval built from the RECENT MESSAGES and `lane.summaries`
//       re-ranks against the LIVE ASK, both inside the cacheable region: a new question
//       rewrites history above it.
//   §5  `stubOldToolResults` re-derives from the live turn counter on every assembly, so a
//       tool_result twelve turns back is rewritten MID-SESSION, outside any compaction.
//   §6  the HL5 snapshot's `as of <now>` header (and its per-row ages) tick on the wall
//       clock with a byte-identical board — tail-side, but divergence that lands earlier
//       than it needs to.
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

// Retrieval that ANSWERS THE QUERY. The defect this file guards is a prefix lane re-ranking
// when the ask moves, so a stub that returns the same rows for every query would hide it.
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async (t: string) => new Float32Array([t.length % 7, 1, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));

vi.mock('../../tools/tool-docs.js', () => ({
  measureAgentToolPayloadTokens: async () => 1000,
}));

vi.mock('../../agent/model.js', () => ({
  callModel: async () => ({ content: 'x', toolCalls: [], usage: {} }),
  getContextWindow: () => CONTEXT_WINDOW,
  getModelOutputCap: () => 4096,
}));

// THE QUERY-SENSITIVE SEARCH. `vectorSearch` decides which SUMMARIES `lane.summaries` picks
// and `semanticSearch` decides which VAULT rows `lane.vault` pulls. Both are keyed on the
// live ask at HEAD. The stubs below rank by a token the query carries, so "the ask moved"
// produces a genuinely different selection — exactly as it does on the owner's box.
vi.mock('../vector-search.js', () => ({
  vectorSearch: async (query: string, _agentId: string, opts: { sourceType?: string }) => {
    if (opts.sourceType !== 'summary') return [];
    return query.includes('ZEBRA') ? [{ sourceId: 'sum-zebra', similarity: 0.9 }] : [];
  },
}));

import { assembleContext } from '../assembler.js';
import { buildRecallLaneMessage } from '../recall-lane.js';
import { contextWindowPolicy } from '../budget.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t67b';
const MODEL = 'model-t67b';
const CONTEXT_WINDOW = 200000;
const DAY_ONE = Date.parse('2026-08-30T18:00:00Z');

let seq = 0;

function seedModel(): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://localhost:8000/v1')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 'ds4-local', 'DS4', ?, 4096, '["tools","thinking"]', 1)`,
  ).run(MODEL, CONTEXT_WINDOW);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, ?, 'idle', ?, '{}')")
    .run(AGENT, 'T67b', MODEL);
}

function seedTurn(turn: number): void {
  mockDb.current!.prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, 'user', datetime('now'), NULL, NULL, 0)`,
  ).run(AGENT, turn);
}

function row(role: string, content: string, turn: number): string {
  seq += 1;
  const id = `t67b-${seq}`;
  const kind = content.startsWith('[{')
    ? 'tool-turn'
    : role === 'assistant' ? 'agent-text' : role === 'system' ? 'working-note' : 'user-text';
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, token_count, created_at)
     VALUES (?, ?, ?, 'owner', 'owner', ?, ?, 'user-visible', ?, 'live', 1, ?, ?)`,
  ).run(id, AGENT, role, content, kind, turn, Math.max(1, Math.ceil(content.length / 4)),
    DAY_ONE - 3_600_000 + seq * 1000);
  return id;
}

function seedBriefing(): void {
  mockDb.current!.prepare(
    `INSERT INTO briefings (id, agent_id, content, token_count, generated_at)
     VALUES ('brief-1', ?, 'Overnight: three deliveries landed and the Kevin thread is open.', 14, '2026-08-30 06:00:00')`,
  ).run(AGENT);
}

function seedActiveTask(): void {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, description, priority, opened_at, updated_at,
                       last_answered_turn, last_answered_at, last_delivery_summary)
     VALUES ('task-aaaaaaaa', 'task', ?, 'owner', 'tracker', 'task-aaaaaaaa', 'claimed', 'tracker',
             0, 0, 'Rewire the porch light', 'the description', 'normal', ?, ?, 7, ?,
             'sent by sms to David')`,
  ).run(AGENT, DAY_ONE - 7_200_000, DAY_ONE - 7_200_000,
    new Date(DAY_ONE - 600_000).toISOString().replace('T', ' ').slice(0, 19));
  // The stamp line the lane renders is DERIVED from `work_events` (tracker-view
  // `stampColumns`), so the row alone renders "no engine activity yet" and the clock tick
  // this clause is about never appears. The event is what puts `relAgo(...)` on the page.
  db.prepare(
    `INSERT INTO work_events (work_id, kind, actor, payload, created_at)
     VALUES ('task-aaaaaaaa', 'activity', ?, ?, ?)`,
  ).run(AGENT, JSON.stringify({ turn: 7, answered: 1, outcome: 'answered', delivery_summary: 'sent by sms to David' }),
    DAY_ONE - 600_000);
}

function seedSummaries(): void {
  const db = mockDb.current!;
  const ins = db.prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, descendant_count,
                            earliest_at, latest_at, created_at)
     VALUES (?, ?, 1, 'leaf', ?, ?, 4, ?, ?, ?)`,
  );
  ins.run('sum-zebra', AGENT, 'The ZEBRA enclosure permit was filed on the 14th.', 12,
    '2026-08-01 09:00:00', '2026-08-01 10:00:00', '2026-08-01 10:00:00');
  ins.run('sum-newest-1', AGENT, 'Kevin asked about the invoice and was answered.', 11,
    '2026-08-28 09:00:00', '2026-08-28 10:00:00', '2026-08-28 10:00:00');
  ins.run('sum-newest-2', AGENT, 'The porch light job was opened and assigned.', 11,
    '2026-08-29 09:00:00', '2026-08-29 10:00:00', '2026-08-29 10:00:00');
}

function seedVault(): void {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO vault_entries (id, agent_id, type, content, confidence, is_permanent, is_pinned,
                                is_obsolete, created_at, updated_at)
     VALUES ('vault-pin', ?, 'fact', 'David''s wife is named Claire.', 1.0, 1, 1, 0, ?, ?)`,
  ).run(AGENT, '2026-07-01 10:00:00', '2026-07-01 10:00:00');
}

const clone = (m: unknown) => JSON.parse(JSON.stringify(m)) as unknown[];

/** THE ASSERTION. History is append-only: the earlier array is a byte-exact prefix of the
 *  later one. Nothing above the newest exchange moved. */
function expectAppendOnly(before: unknown[], after: unknown[]): void {
  expect(after.length).toBeGreaterThanOrEqual(before.length);
  expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
}

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(DAY_ONE);
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedModel();
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

// ── §1 THE DATE THE OWNER'S TRACE DIVERGED ON ───────────────────────────────────────────

describe('T67b §1 — the briefing stamp is the ROW\'s date, never the assembly clock', () => {
  it('RED: two assemblies of an unchanged briefing across midnight are byte-identical', async () => {
    seedTurn(1);
    seedBriefing();
    row('user', 'what is on for today', 1);

    const first = clone((await assembleContext(AGENT, MODEL)).messages);
    // Nothing changed but the wall clock. The briefing row is the same row.
    vi.setSystemTime(DAY_ONE + 12 * 3_600_000);   // over midnight UTC
    const second = clone((await assembleContext(AGENT, MODEL)).messages);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('the stamp states the date the briefing was GENERATED, not today', async () => {
    seedTurn(1);
    seedBriefing();
    row('user', 'what is on for today', 1);
    vi.setSystemTime(Date.parse('2026-09-05T12:00:00Z'));

    const text = JSON.stringify((await assembleContext(AGENT, MODEL)).messages);
    expect(text).toContain('generated="2026-08-30"');
    expect(text).not.toContain('generated="2026-09-05"');
  });
});

// ── §2 THE SHAPE STOPS FLAPPING ─────────────────────────────────────────────────────────

describe('T67b §2 — the prefix shape does not depend on the scaffolding gate', () => {
  it('RED: the session-start assembly is a PREFIX of the next turn\'s assembly', async () => {
    seedTurn(1);
    seedBriefing();
    seedActiveTask();
    seedVault();
    row('user', 'morning', 1);

    // Turn 1: session start (no assistant row yet) — scaffolding fires at HEAD.
    const first = clone((await assembleContext(AGENT, MODEL)).messages);

    // The agent answers. Turn 2 is no longer session start — at HEAD the briefing, the vault
    // and the active-tasks blocks all VANISH, so message 0 changes and the whole prefix is
    // re-billed one turn into every conversation.
    row('assistant', 'good morning', 1);
    seedTurn(2);
    row('user', 'and the porch light?', 2);
    const second = clone((await assembleContext(AGENT, MODEL)).messages);

    expectAppendOnly(first, second);
  });
});

// ── §3 NO LANE AHEAD OF THE TAIL TICKS ON THE CLOCK ─────────────────────────────────────

describe('T67b §3 — the active-tasks lane does not tick', () => {
  it('RED: ten minutes pass, no tracker row changes, the array is byte-identical', async () => {
    seedTurn(1);
    seedActiveTask();
    row('user', 'status please', 1);

    const first = clone((await assembleContext(AGENT, MODEL)).messages);
    expect(JSON.stringify(first)).toContain('Rewire the porch light');
    // The clause only means something if the lane actually renders an engine stamp.
    expect(JSON.stringify(first)).toContain('answered T7');

    vi.setSystemTime(DAY_ONE + 10 * 60_000);
    const second = clone((await assembleContext(AGENT, MODEL)).messages);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// ── §4 NO LANE AHEAD OF THE TAIL RE-RANKS AGAINST THE LIVE ASK ──────────────────────────

describe('T67b §4 — a new question never rewrites history above it', () => {
  it('RED: summaries + vault hold still when the ask moves', async () => {
    seedTurn(1);
    seedSummaries();
    seedVault();
    row('user', 'tell me about the invoice for Kevin, the one we discussed', 1);

    const first = clone((await assembleContext(AGENT, MODEL)).messages);

    row('assistant', 'here is the invoice detail', 1);
    seedTurn(2);
    // A DIFFERENT ask. At HEAD `lane.summaries` re-ranks against it (the ZEBRA summary
    // arrives) and `lane.vault` re-retrieves from the recent window — both INSIDE the
    // cacheable region, both rewriting bytes the model already paid for.
    row('user', 'what happened with the ZEBRA enclosure permit', 2);
    const second = clone((await assembleContext(AGENT, MODEL)).messages);

    expectAppendOnly(first, second);
  });
});

// ── §5 T56'S BOUNDARY RULE, EXTENDED TO THE TOOL-RESULT STUB ────────────────────────────

describe('T67b §5 — nothing rewrites history outside a compaction boundary', () => {
  it('RED: a tool_result is not stubbed mid-session by the turn counter alone', async () => {
    seedTurn(1);
    row('user', 'go look it up', 1);
    row('assistant', JSON.stringify([{ type: 'tool_use', id: 'tu-1', name: 'web_search', input: { q: 'x' } }]), 1);
    row('tool', JSON.stringify([{ type: 'tool_result', tool_use_id: 'tu-1', content: 'a'.repeat(4000) }]), 1);
    row('assistant', 'found it', 1);

    const first = clone((await assembleContext(AGENT, MODEL)).messages);
    expect(JSON.stringify(first)).toContain('aaaa');

    // Twelve turns later, with NO compaction anywhere. At HEAD the assembler re-derives the
    // stub from the live turn counter and rewrites that row in place — mid-history, mid-
    // session, with no boundary to justify it.
    for (let t = 2; t <= 20; t++) { seedTurn(t); row('user', `turn ${t}`, t); row('assistant', `ok ${t}`, t); }
    const second = clone((await assembleContext(AGENT, MODEL)).messages);

    expectAppendOnly(first, second);
  });
});

// ── §7 THE LANE THE CENSUS FOUND THAT NOBODY HAD NAMED ──────────────────────────────────
//
// `lane.directive` (MessageSlot.ActiveDirective = 900) pins THE NEWEST UNANSWERED USER ASK
// and emits it AHEAD of the fresh tail. Its content is therefore a function of the newest
// exchange, and it is rendered at the FRONT of the cacheable region: every substantive user
// message rewrites message ~0 of the array and re-bills the entire history behind it. It is
// the same shape as the recall lane at slot 400 (CORE-2 item 4) and HL5's snapshot, one
// noun over, and it is the largest single term in the owner's per-turn recompute.

describe('T67b §7 — the directive pin is volatile by construction and rides the tail', () => {
  it('RED: a second ask does not rewrite the block ahead of the first one', async () => {
    seedTurn(1);
    const ask1 = `Please work out ${'x'.repeat(220)} the porch light wiring order`;
    row('user', ask1, 1);

    const first = clone((await assembleContext(AGENT, MODEL)).messages);
    expect(JSON.stringify(first)).toContain('ACTIVE USER DIRECTIVE');

    row('assistant', 'on it', 1);
    seedTurn(2);
    const ask2 = `And separately ${'y'.repeat(220)} chase the invoice with Kevin`;
    row('user', ask2, 2);
    const second = clone((await assembleContext(AGENT, MODEL)).messages);

    expectAppendOnly(first, second);
  });
});

// ── §6 THE TAIL-HYGIENE RIDER ───────────────────────────────────────────────────────────

describe('T67b §6 — the tail diverges as LATE as it can', () => {
  it('RED: the HL5 snapshot does not tick while the board is unchanged', async () => {
    seedTurn(1);
    row('user', 'what do I owe', 1);
    mockDb.current!.prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                         wakes, closes_thread, title, opened_at, updated_at, closed_at)
       VALUES ('cmt:bbbbbbbb', 'commitment', ?, 'agent', 'tracker', 'cmt:bbbbbbbb', 'open',
               'tracker', 0, 0, 'Send Kevin the invoice', ?, ?, NULL)`,
    ).run(AGENT, DAY_ONE - 7_200_000, DAY_ONE - 7_200_000);

    const policy = contextWindowPolicy(CONTEXT_WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 4096 });
    const first = await buildRecallLaneMessage(AGENT, true, policy, null);
    expect(first).toContain('OPEN COMMITMENTS');

    vi.setSystemTime(DAY_ONE + 37 * 60_000);
    const second = await buildRecallLaneMessage(AGENT, true, policy, null);

    expect(second).toBe(first);
  });
});

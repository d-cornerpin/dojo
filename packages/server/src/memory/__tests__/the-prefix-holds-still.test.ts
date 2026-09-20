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
  getContextWindow: () => windowNow.value,
  getModelOutputCap: () => 4096,
  // T82a: no provider in this suite declares a serving ceiling — this is the NULL-row R6
  // control, expressed as the mock's own answer rather than left for a missing export to
  // throw on.
  getProviderCeilingTokens: () => null,
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

import {
  assembleContext, selectSummariesForPrefix, renderScratchpadBlock, renderEventsBlock,
  scratchpadWorstCaseTokens, eventsLaneWorstCaseTokens,
} from '../assembler.js';
import { activeTasksWorstCaseTokens, attemptLedgerWorstCaseTokens } from '../work-board-lane.js';
import { POST_BUDGET_LANES, LANE_PRIORITY, isProtectedLaneId } from '../lanes.js';
import { estimateTokens } from '../budget.js';
import { MessageSlot } from '../../prompt/registry/types.js';
import { buildRecallLaneMessage } from '../recall-lane.js';
import { contextWindowPolicy } from '../budget.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t67b';
const MODEL = 'model-t67b';
const CONTEXT_WINDOW = 200000;
// W81 §2 needs a budget that actually BINDS — the defect it reproduces is the allocator
// spending the cached region against the live tail, which only shows when someone must give
// way. Every other clause runs at the roomy default, restored in `beforeEach`.
const windowNow = { value: 200000 };
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

function eventRow(content: string, turn: number): void {
  seq += 1;
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, origin_intent, sender_id, content, display_kind,
                           display_tier, turn_number, provenance, authorized, token_count, created_at)
     VALUES (?, ?, 'user', 'events', 'notice', 'engine', ?, 'engine-note', 'agent-only', ?, 'live', 0, ?, ?)`,
  ).run(`t67b-ev-${seq}`, AGENT, content, turn, Math.ceil(content.length / 4),
    DAY_ONE - 3_600_000 + seq * 1000);
}

function seedSummaries(): void {
  const db = mockDb.current!;
  const ins = db.prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, descendant_count,
                            earliest_at, latest_at, created_at)
     VALUES (?, ?, 1, 'leaf', ?, ?, 4, ?, ?, ?)`,
  );
  const ctxItem = db.prepare(
    "INSERT INTO context_items (agent_id, item_type, item_id, ordinal) VALUES (?, 'summary', ?, ?)",
  );
  ins.run('sum-zebra', AGENT, 'The ZEBRA enclosure permit was filed on the 14th.', 12,
    '2026-08-01 09:00:00', '2026-08-01 10:00:00', '2026-08-01 10:00:00');
  ins.run('sum-newest-1', AGENT, 'Kevin asked about the invoice and was answered.', 11,
    '2026-08-28 09:00:00', '2026-08-28 10:00:00', '2026-08-28 10:00:00');
  ins.run('sum-newest-2', AGENT, 'The porch light job was opened and assigned.', 11,
    '2026-08-29 09:00:00', '2026-08-29 10:00:00', '2026-08-29 10:00:00');
  // `getContextSummaries` JOINs `context_items`; without these rows the summaries lane never
  // renders and every clause that reads it is vacuous rather than red.
  ['sum-zebra', 'sum-newest-1', 'sum-newest-2'].forEach((id, i) => ctxItem.run(AGENT, id, i));
}

/** A summaries set big enough that a lane ceiling and a tight budget both bite. */
function seedBulkSummaries(n: number): void {
  const db = mockDb.current!;
  const ins = db.prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, descendant_count,
                            earliest_at, latest_at, created_at)
     VALUES (?, ?, 1, 'leaf', ?, ?, 4, ?, ?, ?)`,
  );
  const ctxItem = db.prepare(
    "INSERT INTO context_items (agent_id, item_type, item_id, ordinal) VALUES (?, 'summary', ?, ?)",
  );
  for (let i = 0; i < n; i++) {
    const day = String(1 + i).padStart(2, '0');
    const content = `Summary ${i}: ` + 'the quick brown fox jumped over the lazy dog. '.repeat(20);
    ins.run(`bulk-${i}`, AGENT, content, Math.ceil(content.length / 4),
      `2026-08-${day} 09:00:00`, `2026-08-${day} 10:00:00`, `2026-08-${day} 10:00:00`);
    ctxItem.run(AGENT, `bulk-${i}`, 100 + i);
  }
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

/** The rendered text of an assembly, for clauses about WORDS rather than about shape. */
const textOf = (msgs: Array<{ content: unknown }>): string =>
  msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

/** `lane.engine-end-of-history` is the integrity pass's trailing marker. It is framing for
 *  the newest exchange, not history, and it necessarily moves to the new end of the array —
 *  so it is dropped from the EARLIER side before the comparison rather than exempted inside
 *  it, which would be a hole every future lane could climb through. */
const END_OF_HISTORY = '[Engine: end of recorded history.';
function withoutTrailingMarker(msgs: Array<{ content: unknown }>): Array<{ content: unknown }> {
  const last = msgs[msgs.length - 1];
  return typeof last?.content === 'string' && last.content.startsWith(END_OF_HISTORY)
    ? msgs.slice(0, -1) : msgs;
}

/** THE ASSERTION. History is append-only: the earlier array is a byte-exact prefix of the
 *  later one. Nothing above the newest exchange moved. */
function expectAppendOnly(beforeIn: unknown[], afterIn: unknown[]): void {
  const before = withoutTrailingMarker(beforeIn as Array<{ content: unknown }>);
  const after = afterIn as Array<{ content: unknown }>;
  expect(after.length).toBeGreaterThanOrEqual(before.length);
  expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
}

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(DAY_ONE);
  windowNow.value = CONTEXT_WINDOW;
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

    const text = textOf((await assembleContext(AGENT, MODEL)).messages);
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
  it('RED: ten minutes pass, no tracker row changes, the block is byte-identical', async () => {
    seedTurn(1);
    seedActiveTask();
    row('user', 'status please', 1);

    // W81: the block is `ctx.activeTasksLane` now, not a message in the array — it left
    // MessageSlot.ActiveTasks = 600 because every `work_*` tool rewrites it mid-conversation.
    // The clause is asserted on BOTH surfaces, the way T67b §7 asserts the directive: the
    // content LEFT `messages` and it is CARRIED, because a lane that quietly stopped
    // rendering would satisfy the invariance half while costing the model the board.
    const a1 = await assembleContext(AGENT, MODEL);
    expect(textOf(a1.messages)).not.toContain('YOUR ACTIVE TASKS');
    expect(a1.activeTasksLane).toContain('Rewire the porch light');
    // The clause only means something if the lane actually renders an engine stamp.
    expect(a1.activeTasksLane).toContain('answered T7');
    const first = clone(a1.messages);

    vi.setSystemTime(DAY_ONE + 10 * 60_000);
    const a2 = await assembleContext(AGENT, MODEL);

    // The clock moved and no tracker row did, so NEITHER surface may move.
    expect(JSON.stringify(clone(a2.messages))).toBe(JSON.stringify(first));
    expect(a2.activeTasksLane).toBe(a1.activeTasksLane);
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

    const a1 = await assembleContext(AGENT, MODEL);
    const first = clone(a1.messages);
    // It LEFT the cacheable region and it is CARRIED, not deleted — both halves asserted,
    // because a lane that quietly stopped rendering would satisfy the invariance clause below
    // while costing the model the pin.
    expect(textOf(a1.messages)).not.toContain('ACTIVE USER DIRECTIVE');
    expect(a1.directiveLane).toContain('ACTIVE USER DIRECTIVE');
    expect(a1.directiveLane).toContain('the porch light wiring order');

    row('assistant', 'on it', 1);
    seedTurn(2);
    const ask2 = `And separately ${'y'.repeat(220)} chase the invoice with Kevin`;
    row('user', ask2, 2);
    const a2 = await assembleContext(AGENT, MODEL);

    expectAppendOnly(first, clone(a2.messages));
    // The pin itself DID move — it is the newest ask — which is exactly why it may not sit
    // in the prefix. Volatility is not the defect; volatility AHEAD OF THE TAIL is.
    expect(a2.directiveLane).toContain('chase the invoice with Kevin');
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
    // T69b RE-BLESS OF THE CALL, NOT OF THE CLAUSE: `buildRecallLaneMessage` returns the
    // lane's two halves separately now (`{ commitments, recall }`) so the loop can inject the
    // board-state half AHEAD of the per-ask half. The property this clause asserts is
    // unchanged and is asserted over BOTH halves — an identical board and an identical query,
    // 37 minutes apart, must produce identical bytes.
    const first = await buildRecallLaneMessage(AGENT, true, policy, null);
    expect(first.commitments).toContain('OPEN COMMITMENTS');

    vi.setSystemTime(DAY_ONE + 37 * 60_000);
    const second = await buildRecallLaneMessage(AGENT, true, policy, null);

    expect(second.commitments).toBe(first.commitments);
    expect(second.recall).toBe(first.recall);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// W81 — THE CLASS EXTENDS: A TOOL CALL MAY NOT MOVE THE PRE-CONVERSATION REGION.
//
// ── THE INCIDENT (owner, 2026-09-12; his production box, six occurrences) ────────────────
// State-mutating tools — `work_update` x2, `outlook_send`, `outlook_search`, calendar and
// plaud reads — each followed within seconds by a DEEP invalidation landing in the region
// BETWEEN the stable prefix and the conversation history. 15-50K tokens rebuilt each time,
// byte offsets drifting between 30,137 and 47,782, so the thing to hunt is BLOCKS and never
// offsets. His rule is this tree's own, one noun over from roadmap non-negotiable #10:
//
//     WHATEVER A TOOL CAN MUTATE MUST RENDER BELOW THE CONVERSATION.
//
// ── WHAT T67b'S CLAUSES ABOVE COULD NOT SEE ─────────────────────────────────────────────
// Every one of them holds ONE input still and advances another: the wall clock, a second
// ask, a turn counter. None of them DRIVES A TOOL, so all eight were green at `0cc9a3ba`
// while four separate mechanisms moved the pre-conversation region on a tool call. Three
// were reproduced before anything was changed and each is a clause below.
//
// ── THE ASSERTION SURFACE, and why it is not the whole array ────────────────────────────
// `mergeConsecutiveRoles` can weld the last cached message to the first live row. That is
// harmless for caching — a provider matches a TOKEN PREFIX, not a message boundary (T69b
// §5) — but it would let a live row's bytes into a slice taken at the first `lane.fresh-tail`
// tag. The scaffolding ack (assistant, slot 1000) separates the merged cached-lane block
// from the tail, so `cachedRegion` cuts THERE and cannot contain a live row by construction.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The PRE-CONVERSATION REGION: the merged cached-lane block, cut at the ack. */
function cachedRegion(a: {
  messages: Array<{ content: unknown }>; messageEntryIds?: (string | null)[];
}): string {
  const ids = a.messageEntryIds ?? [];
  let n = ids.indexOf('lane.scaffolding-ack');
  if (n < 0) n = ids.indexOf('lane.fresh-tail');
  if (n < 0) n = a.messages.length;
  return JSON.stringify(a.messages.slice(0, n));
}

function seedTaskLogEntry(note: string, at: number): void {
  mockDb.current!.prepare(
    `INSERT INTO work_events (work_id, kind, actor, payload, created_at)
     VALUES ('task-aaaaaaaa', 'activity', ?, ?, ?)`,
  ).run(AGENT, JSON.stringify({ turn: 8, answered: 1, outcome: 'answered', delivery_summary: note }), at);
}

describe('W81 §1 — a driven work_update between two quiet turns', () => {
  it('RED: the pre-conversation region is byte-identical across the tool call', async () => {
    seedTurn(1);
    seedActiveTask();
    seedSummaries();
    row('user', 'hello there, what is going on', 1);
    row('assistant', 'all quiet', 1);
    seedTurn(2);
    row('user', 'thanks', 2);

    const a1 = await assembleContext(AGENT, MODEL);
    const before = cachedRegion(a1);
    // The clause is vacuous unless the board actually renders somewhere.
    expect(a1.activeTasksLane).toContain('Rewire the porch light');

    // THE TOOL CALL. `work_update:edit` writes the note; `work_update:activity` writes the
    // work_event behind the stamp. Both are ordinary, both land mid-conversation, and the
    // tool's own result is appended to the tail exactly as the loop would append it.
    mockDb.current!.prepare("UPDATE work SET notes = ?, updated_at = ? WHERE id = 'task-aaaaaaaa'")
      .run('checked the breaker panel, needs a new junction box', DAY_ONE + 1000);
    seedTaskLogEntry('updated', DAY_ONE + 1000);
    row('assistant', JSON.stringify([{ type: 'tool_use', id: 'tu-w81', name: 'work_update', input: { id: 'task-aaaaaaaa' } }]), 2);
    row('tool', JSON.stringify([{ type: 'tool_result', tool_use_id: 'tu-w81', content: 'updated' }]), 2);

    const a2 = await assembleContext(AGENT, MODEL);

    // The region the owner measured drifting did not move one byte…
    expect(cachedRegion(a2)).toBe(before);
    // …and the board DID change, below the conversation, which is where a tool write belongs.
    expect(a2.activeTasksLane).toContain('checked the breaker panel');
    expect(a2.activeTasksLane).not.toBe(a1.activeTasksLane);
  });

  it('RED: the work board and the attempt ledger are not in `messages` at all', async () => {
    seedTurn(1);
    seedActiveTask();
    row('user', 'status', 1);

    const a = await assembleContext(AGENT, MODEL);
    const text = textOf(a.messages);
    expect(text).not.toContain('YOUR ACTIVE TASKS');
    expect(text).not.toContain('ATTEMPT LEDGER');
    // CARRIED, not deleted — the other half of the same statement.
    expect(a.activeTasksLane).toContain('YOUR ACTIVE TASKS');
  });
});

describe('W81 §2 — a PURE READ never re-truncates a cached lane', () => {
  it('RED: the allocator does not spend the cached region against the live tail', async () => {
    windowNow.value = 32_000;
    seedTurn(1);
    seedBulkSummaries(40);
    row('user', 'hello there, what is going on', 1);
    // A tail already large enough that the budget must bind on someone.
    for (let i = 0; i < 6; i++) {
      row('assistant', JSON.stringify([{ type: 'tool_use', id: `pre-${i}`, name: 'outlook_search', input: { q: 'x' } }]), 1);
      row('tool', JSON.stringify([{ type: 'tool_result', tool_use_id: `pre-${i}`, content: 'MAIL. '.repeat(1200) }]), 1);
    }
    seedTurn(2);
    row('user', 'thanks', 2);

    const a1 = await assembleContext(AGENT, MODEL);
    const before = cachedRegion(a1);
    expect(before).toContain('COMPRESSED HISTORY');

    // `outlook_search` MUTATES NOTHING. It appends a result, the result grows the fresh tail,
    // and at `0cc9a3ba` the fresh tail (priority 30) was granted BEFORE every lane emitted
    // ahead of it, so `lane.summaries` at slot 300 divided the remainder: 22,424 -> 10,580
    // chars, with no content changed anywhere. That is FINDING 2 for the tools that write
    // nothing. `fitLanes` walks the CACHED phase to completion first now.
    row('assistant', JSON.stringify([{ type: 'tool_use', id: 'tu-r', name: 'outlook_search', input: { q: 'invoice' } }]), 2);
    row('tool', JSON.stringify([{ type: 'tool_result', tool_use_id: 'tu-r', content: 'MAIL RESULT. '.repeat(900) }]), 2);

    const a2 = await assembleContext(AGENT, MODEL);
    expect(cachedRegion(a2)).toBe(before);
  });

  it('CONTROL: a cached lane still shrinks when its OWN content grows past the ceiling', () => {
    // The clause above must not be satisfied by a lane that stopped responding to anything.
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `s-${i}`, tokenCount: 500, content: `c${i}`,
    })) as unknown as Parameters<typeof selectSummariesForPrefix>[0];
    expect(selectSummariesForPrefix(many, 20000).length)
      .toBeGreaterThan(selectSummariesForPrefix(many, 2000).length);
  });
});

describe('W81 §3 — the events block is a scrolling window, so it rides the tail', () => {
  it('RED: a pure read that scrolls an awareness row out moves nothing above it', async () => {
    seedTurn(1);
    for (let i = 0; i < 14; i++) {
      eventRow(`Outlook notice ${i}: a message arrived from someone about invoice ${i}`, 1);
      row('user', `chatter ${i} about the day and what is on it`, 1);
      row('assistant', `noted ${i}`, 1);
    }
    seedTurn(2);
    row('user', 'thanks', 2);

    const a1 = await assembleContext(AGENT, MODEL);
    const before = cachedRegion(a1);
    // Vacuity guard: the block must actually be carrying bullets.
    expect(a1.eventsLane).toContain('EVENTS & NOTICES');

    // Two rows appended, nothing mutated. At `0cc9a3ba` the oldest bullet fell out of
    // `getRecentMessages(agentId, policy.freshTailCount)` and the block re-rendered at slot
    // 1050, ahead of every message in the array: 1,344 -> 1,276 chars.
    row('assistant', JSON.stringify([{ type: 'tool_use', id: 'tu-e', name: 'outlook_search', input: { q: 'x' } }]), 2);
    row('tool', JSON.stringify([{ type: 'tool_result', tool_use_id: 'tu-e', content: 'ok' }]), 2);

    const a2 = await assembleContext(AGENT, MODEL);
    expect(cachedRegion(a2)).toBe(before);
    expect(textOf(a2.messages)).not.toContain('EVENTS & NOTICES');
  });
});

describe('W81 §4 — the vault block stops reading the tracker', () => {
  it('RED: opening an in_progress task does not rewrite the pinned vault section', async () => {
    seedTurn(1);
    // A pinned PROCEDURE entry whose topic overlaps the task seeded below. At `0cc9a3ba`
    // `pinnedContextSection` ran `activeTaskSuppressor`, which reads
    // `listTasks({status:'in_progress'})` and dropped this entry at >=0.45 overlap — so
    // OPENING A TASK silently rewrote MessageSlot.VaultPull = 200, ahead of everything.
    mockDb.current!.prepare(
      `INSERT INTO vault_entries (id, agent_id, type, content, confidence, is_permanent, is_pinned,
                                  is_obsolete, created_at, updated_at)
       VALUES ('vault-proc', ?, 'procedure', 'Rewire the porch light: kill the breaker, pull the junction box, rewire the fixture.', 1.0, 0, 1, 0, ?, ?)`,
    ).run(AGENT, '2026-07-01 10:00:00', '2026-07-01 10:00:00');
    row('user', 'what do you remember', 1);

    const before = cachedRegion(await assembleContext(AGENT, MODEL));
    expect(before).toContain('Rewire the porch light: kill the breaker');

    // THE TOOL CALL: `work_open:task` / `work_update:status` — an in_progress row appears.
    seedActiveTask();
    seedTurn(2);
    row('assistant', JSON.stringify([{ type: 'tool_use', id: 'tu-v', name: 'work_update', input: { action: 'status' } }]), 2);
    row('tool', JSON.stringify([{ type: 'tool_result', tool_use_id: 'tu-v', content: 'ok' }]), 2);

    expect(cachedRegion(await assembleContext(AGENT, MODEL))).toBe(before);
  });
});

describe('W81 §5 — every moved lane declares a reserve DERIVED from its own renderer', () => {
  it('each literal in POST_BUDGET_LANES is the generator\'s worst case, not a number beside it', () => {
    const declared = (id: string) => POST_BUDGET_LANES.find((l) => l.id === id)!;
    expect(declared('lane.attempt-ledger').reserveTokens).toBe(attemptLedgerWorstCaseTokens());
    expect(declared('lane.active-tasks').reserveTokens).toBe(activeTasksWorstCaseTokens());
    expect(declared('lane.scratchpad').reserveTokens).toBe(scratchpadWorstCaseTokens());
    expect(declared('lane.events').reserveTokens).toBe(eventsLaneWorstCaseTokens());
    for (const id of ['lane.attempt-ledger', 'lane.active-tasks', 'lane.scratchpad', 'lane.events']) {
      // Post-budget, at a TAIL slot, protected from the repair, and attributed to its entry.
      expect(declared(id).slot).toBeGreaterThan(MessageSlot.FreshTail);
      expect(isProtectedLaneId(id)).toBe(true);
      expect(LANE_PRIORITY[id]).toBeUndefined();
      expect(declared(id).measured.length).toBeGreaterThan(20);
    }
  });

  it('no input can exceed a declared reserve — every cap flooded at once', () => {
    // The enforcement, not the arithmetic: a pad and a title far past their caps still fit.
    const pad = renderScratchpadBlock('p'.repeat(40_000))!;
    expect(estimateTokens(pad)).toBeLessThanOrEqual(scratchpadWorstCaseTokens());
    const ev = renderEventsBlock(Array.from({ length: 40 }, () => `• ${'g'.repeat(4000)}`))!;
    // The row cap is applied by the renderer's caller, so this clause pins the FRAME only;
    // the row/gist caps are pinned by the worst-case identity above.
    expect(ev.startsWith('═══ EVENTS & NOTICES')).toBe(true);
  });
});

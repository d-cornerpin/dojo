// ════════════════════════════════════════════════════════════════════════════════════════
// t139 ROUND 5 — THE TASK LIST'S WORDS GET THE ROOM THE VIEW ACTUALLY HAS, NOT A FIXED POOL.
//
// Owner ruling, 2026-10-13: "I don't want to put hard limits on the dojo. The dojo should be
// smart enough to know when enough is enough."
//
// Rounds 1-4 printed the owner's original words for every open task out of ONE fixed pool of
// 8,000 characters (inherited from the deleted pin's cap). With three live tasks of
// 4,000 characters each, the third was cut to a pointer even on a 200K-window model whose view
// had room for all of them many times over. The signal that should decide is the room this
// assembly actually left: the lane's own share of the reserve ladder plus whatever the content
// fit did not spend. This file drives the REAL assembly door (`assembleContext`):
//
//   §1 a 200K window: three 4,000-character requests all appear whole;
//   §2 a 16K window whose conversation fills its content budget: the words are cut, labelled,
//      with the `history_get` pointer; the newest exchange still reaches the model; and the
//      task list spends no more than the room the assembly left it;
//   §3 the arithmetic stays honest on every window: the block never exceeds that room.
//
// Fixtures are fictional (G1).
//
// RED-FIRST: committed at `f58214e5` with the RED witnesses marked `it.fails`; the fix commit
// flips them to `it`.
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
  generateEmbedding: async () => null,
  queueEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { createTask } from '../../tracker/schema.js';
import { assembleContext } from '../assembler.js';
import { POST_BUDGET_LANES } from '../lanes.js';
import { estimateTokens, contextWindowPolicy } from '../budget.js';
import { assemblyTokens } from '../assembly-validation.js';

const AGENT = 'agent-room';
const MODEL = 'model-room';
const db = (): Database.Database => mockDb.current!;

function seed(contextWindow: number): void {
  db().prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'm', 'M', ?, 2048, '["tools"]')`,
  ).run(MODEL, contextWindow);
  db().prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Roomy', 'idle', ?)")
    .run(AGENT, MODEL);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-dash', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(AGENT);
}

/** A fictional multi-step request of exactly `len` characters with an end marker. */
function longAsk(len: number, tag: string): string {
  const step = 'then check the depot inventory against the delivery notes, row by row, ';
  let s = `[${tag}] Please work through this list in order: `;
  while (s.length < len) s += step;
  const tail = ` END-OF-${tag}`;
  return s.slice(0, len - tail.length) + tail;
}

/** Live tasks, each linked (through the tracker's own door) to a 4,000-char owner ask. */
function liveTasks(tags: string[]): string[] {
  const asks: string[] = [];
  for (const tag of tags) {
    const ask = longAsk(4000, tag);
    const id = `msg-${tag.toLowerCase()}`;
    insertMessage({
      id, agentId: AGENT, role: 'user', content: ask, turnNumber: 1,
      channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    });
    createTask({
      title: `Depot job ${tag}`, assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'model', sourceMessageId: id, turn: 1, convKey: null },
    });
    asks.push(ask);
  }
  return asks;
}
const threeLiveTasks = () => liveTasks(['ALPHA', 'BRAVO', 'CHARLIE']);

let turnNo = 1;
/** One owner/agent exchange, long enough that a handful of them fill a small window. */
function exchange(): void {
  turnNo++;
  db().prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, answered)
     VALUES (?, ?, 'user', datetime('now'), 0)`,
  ).run(AGENT, turnNo);
  insertMessage({
    agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', conversationId: 'conv-dash',
    content: `[x${turnNo}] How many crates are still unlabelled in the back row? ` + 'Count them twice. '.repeat(30),
    turnNumber: turnNo,
  });
  insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'owner', conversationId: 'conv-dash',
    content: `[x${turnNo}] Fourteen crates are unlabelled; the row numbers are on the clipboard. `
      + 'The labels are in the second drawer. '.repeat(30),
    turnNumber: turnNo,
  });
}

/** A compaction covered these rows (one summary linked to them), so the live tail's front moves
 *  past them and the task list is the only place their words are (round 6: words still in the
 *  live conversation are pointed to, not repeated). */
function condense(messageIds: string[]): void {
  db().prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, descendant_count,
                            earliest_at, latest_at, created_at)
     VALUES ('sum-asks', ?, 1, 'leaf', 'The owner asked for several depot jobs.', 10, ?,
             datetime('now'), datetime('now'), datetime('now'))`,
  ).run(AGENT, messageIds.length);
  db().prepare("INSERT INTO context_items (agent_id, item_type, item_id, ordinal) VALUES (?, 'summary', 'sum-asks', 0)")
    .run(AGENT);
  const link = db().prepare('INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)');
  for (const id of messageIds) link.run('sum-asks', id);
}
const idsOf = (tags: string[]): string[] => tags.map((t) => `msg-${t.toLowerCase()}`);

/**
 * ROUND 6 (R-V333-14, review M1): the room is read against the WHOLE array. This is that array's
 * cost as the provider boundary measures it — the assembled messages, every post-budget block
 * the assembler returns, and the loop's own appends at their declared reserves — and the budget
 * that boundary enforces (the assembly budget minus the system prompt).
 */
function wholeArray(ctx: Awaited<ReturnType<typeof assembleContext>>, window: number): { tokens: number; budget: number } {
  const msgs: Array<{ role: 'user' | 'assistant'; content: unknown }> = [...(ctx.messages as never[])];
  for (const b of [ctx.recallLane, ctx.openCommitmentsLane, ctx.attemptLedgerLane,
    ctx.activeTasksLane, ctx.scratchpadLane, ctx.eventsLane, ctx.integrationStatusLane]) {
    if (b) msgs.push({ role: 'user', content: b });
  }
  const loop = ['lane.loop-tail', 'lane.deliveries']
    .reduce((t, id) => t + POST_BUDGET_LANES.find((l) => l.id === id)!.reserveTokens, 0);
  const policy = contextWindowPolicy(window, { toolPayloadTokens: 1000, maxOutputTokens: 2048 });
  return { tokens: assemblyTokens(msgs as never) + loop, budget: policy.assemblyBudgetTokens - estimateTokens(ctx.systemPrompt) };
}

beforeEach(() => {
  turnNo = 1;
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('§1 a 200K window has room for every live request, whole', () => {
  it('(RED at f58214e5) three 4,000-character requests all appear whole on a 200K window', async () => {
    seed(200_000);
    const asks = threeLiveTasks();
    condense(idsOf(['ALPHA', 'BRAVO', 'CHARLIE']));
    exchange();

    const ctx = await assembleContext(AGENT, MODEL);
    const block = ctx.activeTasksLane ?? '';
    for (const ask of asks) expect(block, 'every request whole').toContain(ask);
    expect(block, 'nothing cut').not.toContain('original request continues');
    // The view genuinely had the room: the content fit left far more than the words need.
    const slack = ctx.allocation!.budgetTokens - ctx.allocation!.spentTokens;
    expect(slack).toBeGreaterThan(estimateTokens(asks.join('')));
  });

  it('more words than the list\'s own reserve holds (six 4,000-character requests) are all whole when the view has the room', async () => {
    seed(200_000);
    const tags = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT'];
    const asks = liveTasks(tags);
    condense(idsOf(tags));
    exchange();
    const reserve = POST_BUDGET_LANES.find((l) => l.id === 'lane.active-tasks')!.reserveTokens;
    expect(estimateTokens(asks.join('')), 'the premise: the words alone exceed the reserve').toBeGreaterThan(reserve);

    const ctx = await assembleContext(AGENT, MODEL);
    const block = ctx.activeTasksLane ?? '';
    for (const ask of asks) expect(block).toContain(ask);
    expect(block).not.toContain('original request continues');
    expect(block, 'every task listed, the sixth included').not.toContain('not shown here');
    const whole = wholeArray(ctx, 200_000);
    expect(whole.tokens).toBeLessThanOrEqual(whole.budget);
  });

  it('the whole array, the list included, stays inside the budget the provider boundary enforces', async () => {
    seed(200_000);
    threeLiveTasks();
    condense(idsOf(['ALPHA', 'BRAVO', 'CHARLIE']));
    exchange();
    const ctx = await assembleContext(AGENT, MODEL);
    const whole = wholeArray(ctx, 200_000);
    expect(whole.tokens).toBeLessThanOrEqual(whole.budget);
  });
});

describe('§2 a 16K window: cut only because the view cannot hold them, and the conversation is not starved', () => {
  async function smallBox() {
    seed(16_000);
    const asks = threeLiveTasks();
    for (let i = 0; i < 40; i++) exchange();
    const ctx = await assembleContext(AGENT, MODEL);
    return { asks, ctx, block: ctx.activeTasksLane ?? '' };
  }

  it('the words are cut, labelled, with the history_get pointer — and the newest exchange still reaches the model', async () => {
    const { ctx, block } = await smallBox();
    // The premise: the conversation really does fill this window's content budget.
    expect(ctx.allocation!.spentTokens).toBeGreaterThan(ctx.allocation!.budgetTokens * 0.9);
    expect(block).toContain('Original request (from ');
    expect(block).toMatch(/original request continues: \d+ more characters; history_get\(id="msg-[a-z]+"\) returns it in full/);
    const text = ctx.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(text, 'the newest exchange reaches the model').toContain(`[x${turnNo}]`);
    expect(ctx.allocation!.admittedIds).toContain('lane.fresh-tail');
  });

  // Round 5's RED (`f58214e5`: the list outspent its room) restated in round 6 against the whole
  // array, which is what the room is now read against (R-V333-14, M1).
  it('(RED at f58214e5) the whole 16K array, the list included, stays inside the provider boundary\'s budget', async () => {
    const { ctx } = await smallBox();
    const whole = wholeArray(ctx, 16_000);
    expect(whole.tokens).toBeLessThanOrEqual(whole.budget);
  });
});

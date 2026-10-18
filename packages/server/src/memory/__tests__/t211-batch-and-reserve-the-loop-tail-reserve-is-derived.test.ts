// ════════════════════════════════════════════════════════════════════════════════════════
// t211 (t207 hand-up 2) — THE LOOP-TAIL RESERVE IS DERIVED FROM WHAT THE LOOP WILL APPEND.
//
// t207 removed the other-threads lane's declared maximum (3 rows) because it named people and threads by a
// constant. The loop still appends that block inside `lane.loop-tail`, whose reserve is a literal measured when
// the block held at most three rows. A box with many people waiting then appends a block far larger than the
// room the assembler set aside, on a conversation that already fills the budget, and the whole array exceeds
// the budget the provider boundary enforces (the repair then drops summaries and, in the limit, live turns).
//
// The wanted shape: the reserve for the block follows the block this turn would actually render.
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
vi.mock('../../services/capability-registry.js', () => ({
  listChannelStatuses: () => [{ name: 'imessage', displayName: 'iMessage', configured: true, inboundLive: true }],
}));
vi.mock('../../agent/access/read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/access/read.js')>()),
  toolCategoryGranted: () => true,
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { assembleContext } from '../assembler.js';
import { buildOtherThreadsInjection } from '../other-threads-lane.js';
import { contextWindowPolicy, estimateTokens } from '../budget.js';
import { assemblyTokens } from '../assembly-validation.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const AGENT = 'agent-tail';
const MODEL = 'model-tail';
const WINDOW = 64_000;
const SERVED = 'conv-dash';
const db = (): Database.Database => mockDb.current!;

function seed(): void {
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')").run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'm', 'M', ?, 2048, '["tools"]')`,
  ).run(MODEL, WINDOW);
  db().prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Tail', 'idle', ?)").run(AGENT, MODEL);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(SERVED, AGENT);
}

/** `n` people who each wrote last and were not answered. */
function waitingPeople(n: number): void {
  for (let i = 0; i < n; i++) {
    db().prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name) VALUES (?, ?, 'imessage', 'imessage', ?, ?)`)
      .run(`w${i}`, AGENT, `id-${i}`, `contact ${i}`);
    db().prepare(`INSERT INTO messages (id, agent_id, conversation_id, role, content, created_at, display_kind) VALUES (?, ?, ?, 'user', 'hello', ?, 'user-text')`)
      .run(`wm${i}`, AGENT, `w${i}`, Date.now() - 60_000 - i);
  }
}

/** A live conversation (the fit does not fill the budget with it, so the test counts the unspent part below). */
function fullConversation(): void {
  for (let i = 0; i < 400; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    insertMessage({
      agentId: AGENT, role, lane: 'owner', senderId: role === 'user' ? 'owner' : undefined, conversationId: SERVED, turnNumber: 1 + Math.floor(i / 2),
      content: `[r${i}] ${'Reconcile the ledger bay totals against the manifest. '.repeat(10)}`,
    });
  }
}

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { endTurnContext(AGENT); mockDb.current?.close(); mockDb.current = null; });

describe('t211 hand-up 2 — many waiting people do not overflow the reserve', () => {
  it('the whole array (assembly + blocks + the real other-threads block + a typical rest-of-tail) fits the budget', async () => {
    seed();
    fullConversation();
    waitingPeople(400);
    const bag = openTurnContext(AGENT);
    bag.conversationId = SERVED;

    const ctx = await assembleContext(AGENT, MODEL);
    type Msg = { role: 'user' | 'assistant'; content: string | unknown[] };
    const whole: Msg[] = [...(ctx.messages as Msg[])];
    for (const block of [ctx.recallLane, ctx.openCommitmentsLane, ctx.attemptLedgerLane,
      ctx.activeTasksLane, ctx.scratchpadLane, ctx.eventsLane, ctx.integrationStatusLane]) {
      if (block) whole.push({ role: 'user', content: block });
    }
    const block = buildOtherThreadsInjection(AGENT, SERVED);
    expect(block, 'the premise: the lane fires').toBeTruthy();
    expect(estimateTokens(block!), 'the premise: it is far larger than the old three-row block').toBeGreaterThan(8000);
    whole.push({ role: 'user', content: block! });
    // The rest of the loop's tail at a typical turn (the measured p90 is 536 tokens; the old figure for the
    // block itself, 292, is not part of this).
    whole.push({ role: 'user', content: 'x'.repeat(4 * 600) });

    // A longer conversation would have spent the whole content budget: count what this one left unspent too.
    const unspent = Math.max(0, ctx.allocation!.budgetTokens - ctx.allocation!.spentTokens);
    whole.push({ role: 'user', content: 'x'.repeat(4 * unspent) });

    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 2048 });
    const budget = policy.assemblyBudgetTokens - estimateTokens(ctx.systemPrompt);
    expect(assemblyTokens(whole as never), 'within the budget the repair enforces').toBeLessThanOrEqual(budget);
  });
});

describe('t211 hand-up 2 — a box with a small block sets aside what it always did', () => {
  it('three people waiting: the reserve taken off the top is the same as with nobody waiting', async () => {
    seed();
    const bag = openTurnContext(AGENT);
    bag.conversationId = SERVED;
    const none = (await assembleContext(AGENT, MODEL)).allocation!.offTheTopTokens;
    waitingPeople(3);
    const three = (await assembleContext(AGENT, MODEL)).allocation!.offTheTopTokens;
    expect(three).toBe(none);
  });

  it('the extra is the size of the block beyond what the literal covers, and it grows with the block', async () => {
    seed();
    const bag = openTurnContext(AGENT);
    bag.conversationId = SERVED;
    const base = (await assembleContext(AGENT, MODEL)).allocation!.offTheTopTokens;
    waitingPeople(100);
    const hundred = (await assembleContext(AGENT, MODEL)).allocation!;
    expect(hundred.loopTailExtraTokens).toBeGreaterThan(1000);
    expect(hundred.offTheTopTokens - base).toBe(hundred.loopTailExtraTokens);
  });
});

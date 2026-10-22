// ════════════════════════════════════════════════════════════════════════════════════════
// tracker #24 — THOUSANDS OF WAITING THREADS MUST NOT PUSH EVERY TURN OVER BUDGET.
//
// The owner's box (v3.4.0): a mailbox agent's other-threads block named every email thread whose
// last message was inbound — about 2,000 lines. The loop-tail reserve tried to set that aside, the
// reserve ladder can take at most half the room, so it was SCALED and the block overflowed the
// budget on every call. Nothing else was droppable, the boundary refused to drop the live
// conversation, and it started a forced condense: one condense per message, a failed condense,
// a wrong answer. The t211 test above this one proved 400 people; 2,000 was never driven.
//
// The wanted shape: the block is laid out in the room it is given (a declared share of the
// budget), waiting threads newest first, the rest COUNTED with the tool that reaches them. The
// whole array fits and the live conversation keeps its room.
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
import { otherThreadsRoomTokens } from '../other-threads-room.js';
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

describe('tracker #24 — thousands of waiting threads', () => {
  it('the whole array fits the budget, and the block counts the threads it cannot name', async () => {
    seed();
    // The waiting threads are older history (the fixture's raw rows carry no origin, so if they were the newest
    // rows the conversation view would read them as this conversation's; real inbound rows are filtered out).
    waitingPeople(2000);
    fullConversation();
    const bag = openTurnContext(AGENT);
    bag.conversationId = SERVED;

    // A real dashboard turn with the owner: the live conversation is scoped to it, as on the box.
    const ctx = await assembleContext(AGENT, MODEL, {
      counterparty: { kind: 'user', name: 'owner', relation: 'owner', channel: 'dashboard', senderId: 'owner', threadId: null },
    } as never);
    type Msg = { role: 'user' | 'assistant'; content: string | unknown[] };
    const whole: Msg[] = [...(ctx.messages as Msg[])];
    for (const block of [ctx.recallLane, ctx.openCommitmentsLane, ctx.attemptLedgerLane,
      ctx.activeTasksLane, ctx.scratchpadLane, ctx.eventsLane, ctx.integrationStatusLane]) {
      if (block) whole.push({ role: 'user', content: block });
    }
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 2048 });
    const budget = policy.assemblyBudgetTokens - estimateTokens(ctx.systemPrompt);
    const block = buildOtherThreadsInjection(AGENT, SERVED, otherThreadsRoomTokens(policy.assemblyBudgetTokens, ctx.systemPrompt));
    expect(block, 'the premise: the lane fires').toBeTruthy();
    expect(block!, 'the newest waiting person is named').toContain('contact 0 ');
    expect(block!, 'the ones it cannot name are counted, never dropped silently').toMatch(/and \d+ more threads? not listed/);
    whole.push({ role: 'user', content: block! });
    whole.push({ role: 'user', content: 'x'.repeat(4 * 600) });
    const unspent = Math.max(0, ctx.allocation!.budgetTokens - ctx.allocation!.reservedTokens - ctx.allocation!.spentTokens);
    whole.push({ role: 'user', content: 'x'.repeat(4 * unspent) });

    expect(assemblyTokens(whole as never), 'within the budget the repair enforces').toBeLessThanOrEqual(budget);
    // The live conversation keeps its room: the reserve ladder was not scaled by a list of names.
    expect(ctx.allocation!.budgetTokens, 'the content budget is not halved by the block').toBeGreaterThan(budget / 2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// t139 ROUND 6 — "ENOUGH IS ENOUGH" IS: THE WORDS ARE ALREADY IN VIEW (ruling R-V333-14, I1).
//
// Round 5 sized the task list by the room the view had, and the only stop was "the window is
// full". The round-5 review measured the cost: twelve open tasks whose 8,000-character asks
// were all still in the live conversation put ~25K tokens on the list, a second, uncached copy
// of words the agent was already reading. The ruling: when a task's original request message is
// among the live conversation rows THIS assembly included, the list prints a labelled pointer
// to it instead of the words; the moment it leaves view (condensed or trimmed), the words come
// back on the list, sized by room. The agent sees the words EXACTLY ONCE — de-duplication,
// never hiding (OR-LABEL-NOT-HIDE).
//
// Driven through the real assembly door (`assembleContext`) on a migrated fixture DB.
//   §1 twelve visible asks: pointers on the list, each ask seen once (RED at `df98f44c`);
//   §2 the same asks pushed out of the live view: whole on the list, each seen once (control).
// Fixtures are fictional (G1). RED-first: the RED clause is committed as `it.fails`.
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
import { estimateTokens } from '../budget.js';

const AGENT = 'agent-view';
const MODEL = 'model-view';
const db = (): Database.Database => mockDb.current!;

function seed(contextWindow: number): void {
  db().prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'm', 'M', ?, 2048, '["tools"]')`,
  ).run(MODEL, contextWindow);
  db().prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Viewer', 'idle', ?)")
    .run(AGENT, MODEL);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-dash', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(AGENT);
}

function longAsk(len: number, tag: string): string {
  const step = 'then reconcile the warehouse ledger against the shipping manifests, bay by bay, ';
  let s = `[${tag}] Please work through this list in order: `;
  while (s.length < len) s += step;
  const tail = ` END-OF-${tag}`;
  return s.slice(0, len - tail.length) + tail;
}

const TAGS = Array.from({ length: 12 }, (_, i) => `JOB${String(i).padStart(2, '0')}`);

/** Twelve live tasks, each linked through the tracker's own door to an 8,000-char owner ask. */
function twelveLiveTasks(): Array<{ id: string; ask: string }> {
  return TAGS.map((tag) => {
    const ask = longAsk(8000, tag);
    const id = `msg-${tag.toLowerCase()}`;
    insertMessage({
      id, agentId: AGENT, role: 'user', content: ask, turnNumber: 1,
      channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    });
    createTask({
      title: `Ledger job ${tag}`, assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'model', sourceMessageId: id, turn: 1, convKey: null },
    });
    return { id, ask };
  });
}

let turnNo = 1;
function exchange(): void {
  turnNo++;
  db().prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, answered)
     VALUES (?, ?, 'user', datetime('now'), 0)`,
  ).run(AGENT, turnNo);
  insertMessage({
    agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', conversationId: 'conv-dash',
    content: `[x${turnNo}] Any news on the bay counts?`, turnNumber: turnNo,
  });
  insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'owner', conversationId: 'conv-dash',
    content: `[x${turnNo}] Still counting; bay 4 is done.`, turnNumber: turnNo,
  });
}

/** A compaction covered these rows: one summary, linked to them, so the live tail's front (the
 *  compaction boundary, `tail-horizon.ts`) moves past them. The summary's own words are a
 *  condensation, never the asks verbatim. */
function condense(messageIds: string[]): void {
  db().prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, descendant_count,
                            earliest_at, latest_at, created_at)
     VALUES ('sum-asks', ?, 1, 'leaf', 'The owner asked for twelve ledger reconciliations.', 12, ?,
             datetime('now'), datetime('now'), datetime('now'))`,
  ).run(AGENT, messageIds.length);
  db().prepare("INSERT INTO context_items (agent_id, item_type, item_id, ordinal) VALUES (?, 'summary', 'sum-asks', 0)")
    .run(AGENT);
  const link = db().prepare('INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)');
  for (const id of messageIds) link.run('sum-asks', id);
}

/** Every string the agent will read this call: the assembled messages plus the task list. */
function seenText(ctx: Awaited<ReturnType<typeof assembleContext>>): string {
  return [
    ...ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
    ctx.activeTasksLane ?? '',
  ].join('\n');
}
const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

beforeEach(() => {
  turnNo = 1;
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('§1 asks still in the live conversation are pointed to, not repeated', () => {
  it.fails('(RED at df98f44c) twelve visible 8,000-char asks: the list carries pointers, and each ask is seen exactly once', async () => {
    seed(128_000);
    const tasks = twelveLiveTasks();
    exchange();

    const ctx = await assembleContext(AGENT, MODEL);
    const block = ctx.activeTasksLane ?? '';
    const seen = seenText(ctx);
    for (const { id, ask } of tasks) {
      expect(occurrences(seen, ask), `${id} seen exactly once`).toBe(1);
      expect(block).toContain(`message ${id}`);
    }
    expect(block).toMatch(/in the conversation above/);
    // Not ~25K tokens of duplicate words: twelve labelled pointer lines.
    expect(estimateTokens(block)).toBeLessThan(2_500);
  });
});

describe('§2 asks that have been condensed out of the live view come back whole on the list', () => {
  it('condensed out of the live conversation, all twelve asks are whole on the list — each seen exactly once', async () => {
    seed(128_000);
    const tasks = twelveLiveTasks();
    condense(tasks.map((t) => t.id));
    for (let i = 0; i < 3; i++) exchange();

    const ctx = await assembleContext(AGENT, MODEL);
    const block = ctx.activeTasksLane ?? '';
    const seen = seenText(ctx);
    for (const { id, ask } of tasks) {
      expect(block, `${id} whole on the list`).toContain(ask);
      expect(occurrences(seen, ask), `${id} seen exactly once`).toBe(1);
    }
    expect(block).not.toContain('original request continues');
  });
});

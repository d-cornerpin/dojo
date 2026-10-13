// ════════════════════════════════════════════════════════════════════════════════════════
// t139 — THE TASK LIST CARRIES THE REQUESTER'S OWN WORDS (#7 part 1).
//
// Owner ruling OR-TRACKER-1: "The task list should be what is current." The task list is the
// record of what the agent is working on, so it has to carry WHAT WAS ASKED — the requester's
// original words, read through the task's link to the message that started it
// (`work.source_message_id`), dated, and labelled with the conversation it came from. At
// v3.3.2 the block printed the agent's own `description` cut at 300 characters, so a long
// multi-step ask reached the agent as a 300-character stub while the "still in force" pin
// carried the full text. This file holds the block to the replacement contract:
//
//   §1 a linked task shows the original words byte-for-byte, dated and labelled — through the
//      lane builder AND through the real assembler the turn uses;
//   §2 a task with no linked origin shows its stored description, labelled as such, never an
//      invented request;
//   §3 the words are bounded by a DECLARED cap (the pin's own 8,000 characters, now spread
//      across every open task) and an over-cap request is truncated with a pointer that names
//      the full message, never silently;
//   §4 the reserve is derived by calling the renderer, so no input can outgrow it.
//
// Fixtures are fictional (G1).
//
// RED-FIRST: committed at v3.3.2 with every witness marked `it.fails` (it is RED there); the fix
// commit flips each one to `it`.
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
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../agent/model.js', () => ({
  callModel: async () => ({ content: 'x', toolCalls: [], usage: {} }),
  getContextWindow: () => 200000,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));
vi.mock('../vector-search.js', () => ({ vectorSearch: async () => [] }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { createTask } from '../../tracker/schema.js';
import { setTrackerStatus } from '../../work/tracker-store.js';
import { assembleContext } from '../assembler.js';
import { buildWorkBoardLane, activeTasksWorstCaseTokens } from '../work-board-lane.js';
import { POST_BUDGET_LANES } from '../lanes.js';
import { renderMessageTimeStamp } from '../message-stamp.js';
import { estimateTokens } from '../budget.js';

const AGENT = 'agent-t139';
const MODEL = 'model-t139';
const DAY_ONE = Date.parse('2026-10-01T15:00:00Z');

/** A long multi-step request, fictional, exactly 2,000 characters, with a distinct marker at
 *  the very end so a truncation anywhere is visible. */
function longAsk(len: number, tag: string): string {
  const step = 'Then pull the quarterly figures for the harbour project, compare them line by line, ';
  let s = `[${tag}] Please do the following in order. `;
  while (s.length < len) s += step;
  const tail = ` END-OF-${tag}`;
  return s.slice(0, len - tail.length) + tail;
}

function seed(): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://localhost:8000/v1')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 'm-local', 'M', 200000, 4096, '["tools"]', 1)`,
  ).run(MODEL);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'T139', 'idle', ?, '{}')")
    .run(AGENT, MODEL);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-dash', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name, created_at)
     VALUES ('conv-mail', ?, 'email', 'gmail', 'pat@example.test', 'Pat Example', datetime('now'))`,
  ).run(AGENT);
}

/** The owner's message, through the REAL writer (it opens the ask the message belongs to). */
function ownerSays(id: string, content: string, at: number, conversationId = 'conv-dash', channel = 'dashboard'): void {
  vi.setSystemTime(at);
  insertMessage({
    id, agentId: AGENT, role: 'user', content, turnNumber: 1,
    channel, senderId: 'owner', conversationId,
    inboundMeta: JSON.stringify({ channel, relation: 'owner' }),
  });
}

/** A task through the tracker's own creation door, linked (or not) to its originating row. */
function task(title: string, description: string | undefined, sourceMessageId: string | null): string {
  return createTask({
    title, description, assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'model', sourceMessageId, turn: 1, convKey: null },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(DAY_ONE);
  mockDb.current = new Database(':memory:');
  runMigrations();
  seed();
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t139 §1 — a linked task shows the requester\'s original words', () => {
  it('RED at v3.3.2: a 2,000-character multi-step ask appears on the task list byte-for-byte', async () => {
    const ask = longAsk(2000, 'HARBOUR');
    expect(ask.length).toBe(2000);
    ownerSays('msg-harbour', ask, DAY_ONE - 3_600_000);
    // The agent restates the ask as its description — exactly what models do.
    task('Harbour figures comparison', ask, 'msg-harbour');

    const board = await buildWorkBoardLane(AGENT);
    expect(board.activeTasks).not.toBeNull();
    // At v3.3.2 the block printed `ask.slice(0, 300) + '...'`. The whole request, in order,
    // with nothing between its characters, is the contract.
    expect(board.activeTasks!).toContain(ask);
  });

  it('the words are dated with the message\'s own recorded instant and labelled with its conversation', async () => {
    const ask = longAsk(600, 'DATED');
    ownerSays('msg-dated', ask, DAY_ONE - 5 * 86_400_000);
    task('Dated ask', undefined, 'msg-dated');

    // Dated with THE ROW'S OWN recorded instant — read back from the row the writer stored,
    // so the clause holds whatever clock the writer stamps with.
    const recorded = (mockDb.current!.prepare('SELECT created_at FROM messages WHERE id = ?')
      .get('msg-dated') as { created_at: number }).created_at;
    vi.setSystemTime(DAY_ONE + 30 * 86_400_000);   // a month later: the stamp may not follow the clock
    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    const stamp = renderMessageTimeStamp(recorded)!;
    expect(stamp).toMatch(/^\[.+\]$/);
    expect(block).toContain(stamp);
    expect(block).toMatch(/Original request/);
    // The owner's dashboard conversation is named as such (the label reads the conversation
    // row: its channel and its party), so a request is never anonymous on the list.
    expect(block).toMatch(/dashboard/);
    expect(block).toContain(ask);
  });

  it('an email-channel request is labelled with ITS conversation, not the owner\'s chat', async () => {
    const ask = 'Could you collect the three supplier quotes and send me a comparison table?';
    ownerSays('msg-mail', ask, DAY_ONE - 7_200_000, 'conv-mail', 'email');
    task('Supplier quotes', undefined, 'msg-mail');

    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain(ask);
    expect(block).toContain('Pat Example');
    expect(block).toMatch(/email/);
  });

  it('the real assembler carries the same words on the turn\'s task-list lane', async () => {
    const ask = longAsk(2000, 'ASSEMBLED');
    ownerSays('msg-assembled', ask, DAY_ONE - 60_000);
    task('Assembled ask', ask, 'msg-assembled');

    const assembled = await assembleContext(AGENT, MODEL);
    expect(assembled.activeTasksLane).toContain(ask);
  });
});

describe('t139 §2 — a task with no linked origin never gets an invented request', () => {
  it('RED at v3.3.2: the stored description is shown, labelled "(original request not linked)"', async () => {
    task('Legacy row', 'Tidy the shared drive folders by year.', null);

    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain('Tidy the shared drive folders by year.');
    expect(block).toContain('(original request not linked)');
    expect(block).not.toMatch(/Original request \(/);
  });
});

describe('t139 §2b — every UNFINISHED task is listed, waiting ones labelled; nothing is hidden', () => {
  it('a paused task stays on the list with its words, labelled as waiting', async () => {
    const ask = 'Price three flights to the conference and hold the cheapest until I confirm.';
    ownerSays('msg-paused', ask, DAY_ONE - 60_000);
    const id = task('Conference flights', undefined, 'msg-paused');
    const r = setTrackerStatus(id, 'paused', { by: 'agent', actorId: AGENT, reason: 'waiting on the person' });
    expect(r.kind).toBe('applied');

    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain(ask);
    expect(block).toContain('Status: paused, waiting');
  });

  it('a task scheduled for later (on_deck) is not current work and is not listed', async () => {
    ownerSays('msg-later', 'Next month, remind me to renew the domain.', DAY_ONE - 60_000);
    const id = task('Renew the domain', undefined, 'msg-later');
    const r = setTrackerStatus(id, 'on_deck', { by: 'agent', actorId: AGENT, reason: 'scheduled for later' });
    expect(r.kind).toBe('applied');
    expect((await buildWorkBoardLane(AGENT)).activeTasks).toBeNull();
  });

  it('a description that records a later change is shown after the words; one that repeats them is not printed twice', async () => {
    const ask = 'Make nine square headshots for the team page.';
    ownerSays('msg-desc', ask, DAY_ONE - 60_000);
    task('Headshots', 'Owner changed it: four, black and white.', 'msg-desc');
    ownerSays('msg-same', 'Book the Thursday room.', DAY_ONE - 30_000);
    task('Room', 'Book the Thursday room.', 'msg-same');

    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain(ask);
    expect(block).toContain("The task's own description (as last edited):\nOwner changed it: four, black and white.");
    expect(block.split('Book the Thursday room.').length - 1).toBe(1);
  });
});

describe('t139 §3 — the words are bounded by a declared cap, and a cut is never silent', () => {
  it('an over-cap request keeps its first 8,000 characters byte-for-byte and names the full message', async () => {
    const ask = longAsk(8500, 'OVERCAP');
    ownerSays('msg-overcap', ask, DAY_ONE - 60_000);
    task('Over cap', undefined, 'msg-overcap');

    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain(ask.slice(0, 8000));
    expect(block).not.toContain(ask.slice(0, 8001));
    expect(block).toContain('history_get(id="msg-overcap")');
    expect(block).toContain('500 more characters');
  });

  it('the cap is shared across open tasks: words appear in full until the pool is spent', async () => {
    const a = longAsk(5000, 'FIRST');
    const b = longAsk(5000, 'SECOND');
    ownerSays('msg-first', a, DAY_ONE - 120_000);
    ownerSays('msg-second', b, DAY_ONE - 60_000);
    vi.setSystemTime(DAY_ONE - 110_000);
    task('First', undefined, 'msg-first');
    vi.setSystemTime(DAY_ONE - 50_000);
    task('Second', undefined, 'msg-second');
    vi.setSystemTime(DAY_ONE);

    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain(a);
    expect(block).toContain(b.slice(0, 3000));
    expect(block).not.toContain(b.slice(0, 3001));
    expect(block).toContain('history_get(id="msg-second")');
  });
});

describe('t139 §4 — the reserve is the renderer\'s own worst case', () => {
  it('the declared reserve equals the derived worst case', () => {
    const declared = POST_BUDGET_LANES.find((l) => l.id === 'lane.active-tasks')!;
    expect(declared.reserveTokens).toBe(activeTasksWorstCaseTokens());
  });

  it('a maximal real board (five tasks, every request far over the cap) fits the reserve', async () => {
    for (let i = 0; i < 6; i++) {
      const id = `msg-flood-${i}`;
      ownerSays(id, longAsk(12000, `FLOOD${i}`), DAY_ONE - (10 - i) * 60_000);
      vi.setSystemTime(DAY_ONE - (10 - i) * 60_000 + 1000);
      task('t'.repeat(300), 'd'.repeat(5000), id);
    }
    vi.setSystemTime(DAY_ONE);
    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(estimateTokens(block)).toBeLessThanOrEqual(activeTasksWorstCaseTokens());
    // And the cap really bit: the pool was spent on the first request in block order, and the
    // next one is reduced to its pointer rather than dropped without a word.
    expect(block).toContain('history_get(id="msg-flood-0")');
    expect(block).toContain('history_get(id="msg-flood-1")');
  });
});

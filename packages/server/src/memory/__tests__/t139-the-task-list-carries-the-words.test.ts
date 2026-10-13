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
import { updateTask, listTasks } from '../../tracker/schema.js';
import { writeTaskLog } from '../../tracker/task-log.js';
import { assembleContext } from '../assembler.js';
import {
  buildWorkBoardLane, activeTasksWorstCaseTokens, type TaskListView,
} from '../work-board-lane.js';
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

/** The list's room with no view passed: its declared reserve. */
const reserveRoom = (): number => POST_BUDGET_LANES.find((l) => l.id === 'lane.active-tasks')!.reserveTokens;
/** A room of exactly `tokens` for the list, in the shape the assembler passes (round 6): an
 *  empty array so far, and the loop's declared appends on top of the room. No technique is
 *  published in this file's fixture, so none is counted. */
function roomOf(tokens: number): TaskListView {
  const loop = ['lane.loop-tail', 'lane.deliveries']
    .reduce((t, id) => t + POST_BUDGET_LANES.find((l) => l.id === id)!.reserveTokens, 0);
  return { availableTokens: tokens + loop, emitted: [], blocks: [], liveRows: [] };
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

  it('the real assembler carries the same words exactly once: in view, the list points to them', async () => {
    const ask = longAsk(2000, 'ASSEMBLED');
    ownerSays('msg-assembled', ask, DAY_ONE - 60_000);
    task('Assembled ask', ask, 'msg-assembled');

    // Round 6 (R-V333-14): the ask is still in the live conversation, so the list points to it
    // rather than printing it twice — the words reach the model exactly once, and the pointer
    // names the message.
    const assembled = await assembleContext(AGENT, MODEL);
    expect(assembled.activeTasksLane).toContain('it is in the conversation above, message msg-assembled');
    const seen = [...assembled.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
      assembled.activeTasksLane ?? ''].join('\n');
    expect(seen.split(ask).length - 1).toBe(1);
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
  // ROUND 2 (review C1): a waiting task is VISIBLE but NOT CURRENT. Round 1 printed its full
  // words under "Status: paused, waiting", so a weeks-old paused job read like live work on
  // every turn — the #7 shape. It now carries a pointer to its request, says whom it waits on and
  // since when, says plainly it is not current, and takes nothing from the words pool.
  it('a month-old paused task: visible, labelled not current, a POINTER instead of the words, nothing from the pool', async () => {
    const old = 'Price three flights to the conference and hold the cheapest until I confirm.';
    ownerSays('msg-paused', old, DAY_ONE - 31 * 86_400_000);
    vi.setSystemTime(DAY_ONE - 30 * 86_400_000);
    const id = task('Conference flights', undefined, 'msg-paused');
    const r = setTrackerStatus(id, 'paused', { by: 'agent', actorId: AGENT, reason: 'waiting on the person' });
    expect(r.kind).toBe('applied');
    const pausedAt = (mockDb.current!.prepare(
      "SELECT created_at FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id DESC LIMIT 1",
    ).get(id) as { created_at: number }).created_at;
    // A live 8,000-char request beside it gets the WHOLE pool.
    const live = longAsk(8000, 'LIVE');
    ownerSays('msg-live', live, DAY_ONE - 60_000);
    vi.setSystemTime(DAY_ONE - 30_000);
    task('Live job', undefined, 'msg-live');
    vi.setSystemTime(DAY_ONE);

    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain('Conference flights');
    expect(block).not.toContain(old);
    expect(block).toContain(`Status: paused since ${renderMessageTimeStamp(pausedAt)}`);
    expect(block).toMatch(/Not current work: do not resume it unless asked\./);
    expect(block).toContain('[original request: message msg-paused, ');
    expect(block).toContain('history_get(id="msg-paused")');
    expect(block).toContain(live);
    // The live request is listed before the waiting one.
    expect(block.indexOf('Live job')).toBeLessThan(block.indexOf('Conference flights'));
  });

  // ROUND 3 (re-review minor): `status_before_pause` is written for EVERY pause, so a task the
  // OWNER paused himself read "waiting on <owner> to answer". Who paused it is the transition's
  // own `by`, and an owner's pause is not a question waiting on his answer.
  it('a task the OWNER paused is labelled as paused by the owner, never "waiting on <owner> to answer"', async () => {
    ownerSays('msg-ownerpause', 'Book the photographer for the launch.', DAY_ONE - 60_000);
    const id = task('Photographer', undefined, 'msg-ownerpause');
    expect(setTrackerStatus(id, 'paused', { by: 'owner', actorId: 'owner', reason: 'owner paused it' }).kind).toBe('applied');

    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toMatch(/Status: paused since \[[^\]]+\] — paused by the owner/);
    expect(block).not.toMatch(/to answer/);
  });

  it('CONTROL: the engine\'s own waiting-on-owner pause still says whose answer it waits for', async () => {
    ownerSays('msg-enginepause', 'Draft the newsletter intro.', DAY_ONE - 60_000);
    const id = task('Newsletter', undefined, 'msg-enginepause');
    // The engine's pause cites the delivery it is keyed on (G6), exactly as the disposition does.
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
       VALUES ('dl-x', ?, 1, 'dashboard', 'dashboard', 'delivered', datetime('now'))`,
    ).run(AGENT);
    expect(setTrackerStatus(id, 'paused', { by: 'engine', actorId: AGENT, evidenceRef: 'dl-x', reason: 'waiting on the person' }).kind).toBe('applied');

    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toMatch(/waiting on [^\n]+ to answer/);
  });

  it('a task scheduled for later (on_deck) is not current work and is not listed', async () => {
    ownerSays('msg-later', 'Next month, remind me to renew the domain.', DAY_ONE - 60_000);
    const id = task('Renew the domain', undefined, 'msg-later');
    const r = setTrackerStatus(id, 'on_deck', { by: 'agent', actorId: AGENT, reason: 'scheduled for later' });
    expect(r.kind).toBe('applied');
    expect((await buildWorkBoardLane(AGENT)).activeTasks).toBeNull();
  });

  // ROUND 2 (review M3): a description is printed only when the task's record says it was
  // EDITED after creation — a recorded fact, not a byte comparison a paraphrase always fails.
  it('a description EDITED after creation is shown after the words; an unedited one is not printed', async () => {
    const ask = 'Make nine square headshots for the team page.';
    ownerSays('msg-desc', ask, DAY_ONE - 60_000);
    const id = task('Headshots', 'Nine headshots, soft studio light (my restatement).', 'msg-desc');
    let block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain(ask);
    expect(block).not.toContain('my restatement');

    updateTask(id, { description: 'Owner changed it: four, black and white.' });
    writeTaskLog({ taskId: id, fromEntity: AGENT, entryKind: 'observation', actionTaken: 'description_edited',
      note: 'BEFORE: Nine headshots -- AFTER: four, black and white' });
    block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain("The task's own description (as last edited):\nOwner changed it: four, black and white.");
  });

  // ROUND 2 (item 6, the factual fallback): newer messages in the request's conversation are
  // COUNTED under the request — a fact from the rows, claiming no relation to the task.
  it('newer owner messages in the same conversation are counted under the request, with the newest instant', async () => {
    ownerSays('msg-orig', 'Make nine square headshots for the team page.', DAY_ONE - 600_000);
    task('Headshots', undefined, 'msg-orig');
    ownerSays('msg-later-1', 'Actually make it four.', DAY_ONE - 300_000);
    ownerSays('msg-later-2', 'And black and white, please.', DAY_ONE - 120_000);
    vi.setSystemTime(DAY_ONE);
    const newest = (mockDb.current!.prepare("SELECT created_at FROM messages WHERE id = 'msg-later-2'").get() as { created_at: number }).created_at;
    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain(`Newer messages in this conversation since this request: 2, the newest ${renderMessageTimeStamp(newest)}`);
  });
});

describe('t139 §3 — the words get the room the view has (round 5), and a cut is never silent', () => {
  // ROUND 5: these two clauses asserted the fixed 8,000-char pool (round 1). The pool is now the
  // room the assembly left the list; the clauses keep their subject — byte-for-byte prefix, a
  // named pointer, newest first — at an explicit room.
  it('an over-room request keeps the most the room holds byte-for-byte — at least the guaranteed floor — and names the full message', async () => {
    const ask = longAsk(20000, 'OVERCAP');
    ownerSays('msg-overcap', ask, DAY_ONE - 60_000);
    task('Over cap', undefined, 'msg-overcap');

    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    const shown = /word for word:\n([^]*?)\n  \[original request continues: (\d+) more characters/.exec(block)!;
    expect(shown, 'cut, with the count of what is missing').not.toBeNull();
    expect(ask.startsWith(shown[1]), 'byte-for-byte prefix').toBe(true);
    expect(shown[1].length, 'at least the guaranteed floor').toBeGreaterThanOrEqual(8000);
    expect(Number(shown[2])).toBe(ask.length - shown[1].length);
    expect(block).toContain('history_get(id="msg-overcap")');
    // The LARGEST pool the room holds, not merely one that fits: one more character of words
    // moves the block by at most one character, so a cut block fills the room exactly.
    expect(block.length, 'fills the room to the character').toBe(reserveRoom() * 4);
  });

  it('the room is shared across open tasks, newest first: words appear in full until the room is spent', async () => {
    const a = longAsk(5000, 'FIRST');
    const b = longAsk(5000, 'SECOND');
    ownerSays('msg-first', a, DAY_ONE - 120_000);
    ownerSays('msg-second', b, DAY_ONE - 60_000);
    vi.setSystemTime(DAY_ONE - 110_000);
    task('First', undefined, 'msg-first');
    vi.setSystemTime(DAY_ONE - 50_000);
    task('Second', undefined, 'msg-second');
    vi.setSystemTime(DAY_ONE);

    const block = (await buildWorkBoardLane(AGENT, roomOf(2600))).activeTasks!;
    expect(block).toContain(b);
    expect(block).toContain(a.slice(0, 2000));
    expect(block).not.toContain(a);
    expect(block).toContain('history_get(id="msg-first")');
    expect(block.indexOf('• Second')).toBeLessThan(block.indexOf('• First'));
    expect(estimateTokens(block)).toBeLessThanOrEqual(2600);
    // And with the room a roomy view has, both are whole.
    const roomy = (await buildWorkBoardLane(AGENT, roomOf(20_000))).activeTasks!;
    expect(roomy).toContain(a);
    expect(roomy).toContain(b);
  });
});

describe('t139 §3b — round 2 order: the newest request is intact; every request before any description', () => {
  it('every request is spent before any description: a newer task\'s edited description never starves an older request', async () => {
    const older = longAsk(7000, 'MONDAY');
    ownerSays('msg-monday', older, DAY_ONE - 3 * 86_400_000);
    vi.setSystemTime(DAY_ONE - 3 * 86_400_000 + 1000);
    task('Monday brief', undefined, 'msg-monday');
    const newer = longAsk(600, 'TODAY');
    ownerSays('msg-today', newer, DAY_ONE - 60_000);
    vi.setSystemTime(DAY_ONE - 30_000);
    const nid = task('Change of plan', undefined, 'msg-today');
    updateTask(nid, { description: 'x'.repeat(1000) });
    writeTaskLog({ taskId: nid, fromEntity: AGENT, entryKind: 'observation', actionTaken: 'description_edited', note: 'edited' });
    vi.setSystemTime(DAY_ONE);

    // A room 100 tokens short of everything whole: the cut must land on the description.
    const whole = (await buildWorkBoardLane(AGENT, roomOf(20_000))).activeTasks!;
    const room = estimateTokens(whole) - 100;
    const block = (await buildWorkBoardLane(AGENT, roomOf(room))).activeTasks!;
    expect(block.indexOf('• Change of plan')).toBeLessThan(block.indexOf('• Monday brief'));   // newest first
    expect(block).toContain(newer);
    expect(block).toContain(older);                      // 600 + 7,000 fit; the description pays
    expect(block).toMatch(/\[description continues: \d+ more characters, not shown\]/);
    expect(estimateTokens(block)).toBeLessThanOrEqual(room);
  });

  it('the newest request is intact while an older long one is listed', async () => {
    const older = longAsk(7900, 'OLDLONG');
    ownerSays('msg-oldlong', older, DAY_ONE - 3 * 86_400_000);
    vi.setSystemTime(DAY_ONE - 3 * 86_400_000 + 1000);
    task('Old long', undefined, 'msg-oldlong');
    const newer = longAsk(600, 'NEWSHORT');
    ownerSays('msg-newshort', newer, DAY_ONE - 60_000);
    vi.setSystemTime(DAY_ONE - 30_000);
    task('New short', undefined, 'msg-newshort');
    vi.setSystemTime(DAY_ONE);

    const block = (await buildWorkBoardLane(AGENT, roomOf(2000))).activeTasks!;
    expect(block).toContain(newer);
    expect(block).toContain('history_get(id="msg-oldlong")');
  });

  it('the tracker lists high before normal before low (priority is TEXT; it sorted alphabetically)', () => {
    for (const [title, priority] of [['Low one', 'low'], ['High one', 'high'], ['Normal one', 'normal']] as const) {
      createTask({ title, assignedTo: AGENT, createdBy: AGENT, priority,
        origin: { kind: 'model', sourceMessageId: null, turn: 1, convKey: null } });
    }
    expect(listTasks({ assignedTo: AGENT }).map((t) => t.title)).toEqual(['High one', 'Normal one', 'Low one']);
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
    expect(block).toContain('history_get(id="msg-flood-5")');
    expect(block).toContain('history_get(id="msg-flood-4")');
    // Round 5: the guarantee holds on the fullest board — the newest request keeps at least the
    // floor — and the sixth task is COUNTED, not dropped without a word.
    const first = /word for word:\n([^]*?)\n  \[original request continues/.exec(block)!;
    expect(first[1].length).toBeGreaterThanOrEqual(8000);
    expect(block).toContain('…and 1 more unfinished task not shown here');
  });
});

describe('t139 §5 — round 5: rows, titles and notes follow the room too', () => {
  it('with room, every unfinished task is listed whole — more than the five the reserve guarantees', async () => {
    for (let i = 0; i < 8; i++) {
      ownerSays(`msg-row-${i}`, `Short job number ${i}.`, DAY_ONE - (20 - i) * 60_000);
      vi.setSystemTime(DAY_ONE - (20 - i) * 60_000 + 1000);
      task(`Row ${i}`, undefined, `msg-row-${i}`);
    }
    vi.setSystemTime(DAY_ONE);
    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    for (let i = 0; i < 8; i++) expect(block).toContain(`• Row ${i} `);
    expect(block).not.toContain('not shown here');
  });

  it('without room, the guaranteed rows are listed and every other row is COUNTED, with where to find it', async () => {
    for (let i = 0; i < 7; i++) {
      ownerSays(`msg-big-${i}`, longAsk(4000, `BIG${i}`), DAY_ONE - (20 - i) * 60_000);
      vi.setSystemTime(DAY_ONE - (20 - i) * 60_000 + 1000);
      task(`Big ${i}`, undefined, `msg-big-${i}`);
    }
    vi.setSystemTime(DAY_ONE);
    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block.match(/^• Big /gm)?.length).toBe(5);
    expect(block).toContain('…and 2 more unfinished tasks not shown here: this view has no room left for them. '
      + 'work_update(action="list") lists every task.');
    expect(estimateTokens(block)).toBeLessThanOrEqual(reserveRoom());
    // With the room, all seven are listed and whole.
    const roomy = (await buildWorkBoardLane(AGENT, roomOf(20_000))).activeTasks!;
    expect(roomy.match(/^• Big /gm)?.length).toBe(7);
    expect(roomy).not.toContain('original request continues');
  });

  it('a room too small for even the guaranteed rows\' framing lists fewer rows, counts the rest, and is never chopped mid-line', async () => {
    for (let i = 0; i < 5; i++) {
      ownerSays(`msg-tiny-${i}`, longAsk(1500, `TINY${i}`), DAY_ONE - (20 - i) * 60_000);
      vi.setSystemTime(DAY_ONE - (20 - i) * 60_000 + 1000);
      task(`Tiny ${i}`, undefined, `msg-tiny-${i}`);
    }
    vi.setSystemTime(DAY_ONE);
    const block = (await buildWorkBoardLane(AGENT, roomOf(300))).activeTasks!;
    expect(estimateTokens(block)).toBeLessThanOrEqual(300);
    expect(block, 'laid out, not truncated by the backstop').not.toContain('shortened to fit');
    expect(block).toMatch(/…and [1-4] more unfinished tasks? not shown here/);
    expect(block).toContain('═══ END ACTIVE TASKS ═══');
    expect(block).toContain('• Tiny 4 ');   // the newest is the one that stays
  });

  it('a room that holds not even one bare row still says the tasks exist and where they are (round 6)', async () => {
    for (let i = 0; i < 3; i++) {
      ownerSays(`msg-none-${i}`, longAsk(1500, `NONE${i}`), DAY_ONE - (20 - i) * 60_000);
      vi.setSystemTime(DAY_ONE - (20 - i) * 60_000 + 1000);
      task(`None ${i}`, undefined, `msg-none-${i}`);
    }
    vi.setSystemTime(DAY_ONE);
    const block = (await buildWorkBoardLane(AGENT, roomOf(0))).activeTasks!;
    expect(block).toContain('You have 3 unfinished tasks; this view has no room left to list them. '
      + 'work_update(action="list") lists every task.');
    expect(block).not.toContain('shortened to fit');
    expect(estimateTokens(block)).toBeLessThan(60);
  });

  it('a long title and a long last note are whole when the view holds them, and cut only when it cannot', async () => {
    const title = 'Quarterly depot audit: ' + 'reconcile every bay against the manifest, '.repeat(6);
    const note = 'Bay 7 still open: ' + 'the scanner keeps losing the pallet labels, '.repeat(8);
    ownerSays('msg-title', 'Run the audit.', DAY_ONE - 60_000);
    const id = task(title, undefined, 'msg-title');
    updateTask(id, { notes: note });
    expect(title.length).toBeGreaterThan(120);
    expect(note.length).toBeGreaterThan(200);

    const roomy = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(roomy).toContain(`• ${title} (ID:`);
    expect(roomy).toContain(`Last note: ${note.trimEnd()}`);

    // A room one token short of the whole block: the declared widths apply.
    const tight = (await buildWorkBoardLane(AGENT, roomOf(estimateTokens(roomy) - 1))).activeTasks!;
    expect(tight).toContain(`• ${title.slice(0, 120)}... (ID:`);
    expect(tight).toContain(`Last note: ${note.slice(0, 200)}\n`);
  });
});

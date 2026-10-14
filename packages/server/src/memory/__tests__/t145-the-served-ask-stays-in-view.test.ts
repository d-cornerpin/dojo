// ════════════════════════════════════════════════════════════════════════════════════════
// t145 group A, round 4 — THE OWNER MESSAGE A RUNNING TURN SERVES IS NEVER OUT OF VIEW.
//
// The "still in force" pin carried the newest long ask into every call. Deleting it is only safe
// if no shape loses the owner's words, and one did: a long, tool-heavy turn on an ask with no
// task, where a pressure fold in the middle of the turn summarised the ask's raw row away.
//
// ROUND 3 froze every row from the ask onward; the owner's long jobs make that unacceptable (a long
// job's own tool rows must fold like any other). So the protection is NARROW: only the owner
// message(s) the running turn serves (the claimed ask's own message, and the unanswered owner
// messages merged into it in the same conversation). Folds, the condense trigger, the ceiling cut
// and the token trim proceed exactly as before. When the served message ends up behind the fold
// boundary (or off the front of the trimmed tail), the assembler re-emits that one row verbatim at
// the front of the live tail, labelled plainly with its time, once, for as long as the turn (and its
// carried continuations) runs. If the row is still in view, nothing extra is emitted (t139's rule).
// Structural: the turn's own claimed ask rows; no content is read.
//
// The turn-level proof (a real turn, a real forced fold, the words verbatim on the next call, the
// turn's own tool rows folded, no refusal) is in `t145-the-pin-is-gone.test.ts`.
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

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { claimAsk } from '../../work/store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { getMessagesOutsideFreshTail } from '../store.js';
import { rowsLeavingView } from '../tail-horizon.js';
import { servedOwnerMessageIds } from '../served-ask.js';
import { createLeafSummary } from '../dag.js';
import { noteEngineCheckpoint } from '../../work/engine-checkpoint-note.js';
import { queueJobContinuation } from '../../work/job-continuation.js';
import { beginJobRun, endJobCarry } from '../../work/task-freshness.js';
import { assembleContext } from '../assembler.js';

const AGENT = 'primary';
let image: Buffer | null = null;
function freshDb(): Database.Database {
  if (!image) {
    const s = new Database(':memory:');
    mockDb.current = s;
    runMigrations();
    image = s.serialize();
    s.close();
  }
  const db = new Database(image);
  db.pragma('foreign_keys = ON');
  return db;
}

let n = 0;
function say(role: 'user' | 'assistant', content: string, id = `m-${++n}`): number {
  return insertMessage({
    id, agentId: AGENT, role, content, turnNumber: 1,
    channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
    ...(role === 'user' ? { inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }) } : {}),
  }).seq;
}

beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')").run();
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
              VALUES ('conv-dash', 'primary', 'dashboard', NULL, 'owner', datetime('now'))`).run();
  n = 0;
});
afterEach(() => { endTurnContext(AGENT); mockDb.current?.close(); mockDb.current = null; });

/** 10 older rows, the owner's long ask (claimed by a running turn), then `after` rows of the turn. */
/** The turn that picked the ask up: its bag, with the trigger root the preflight publishes. */
function runningTurnOn(askId: string): void {
  const bag = openTurnContext(AGENT);
  bag.root = { kind: 'ask', id: askId, sourceMessageId: askId };
}

function servedAsk(after: number): { askSeq: number; lastSeq: number } {
  for (let i = 0; i < 5; i++) { say('user', `older question ${i}`); say('assistant', `older answer ${i}`); }
  const askSeq = say('user', 'THE-LONG-ASK '.repeat(30), 'ask-row');
  expect(claimAsk('ask:ask-row', AGENT).kind).toBe('applied');
  let lastSeq = askSeq;
  for (let i = 0; i < after; i++) lastSeq = say(i % 2 === 0 ? 'assistant' : 'user', `turn row ${i}`);
  return { askSeq, lastSeq };
}

const policy = { freshTailCount: 24 };
const LABEL = '(the message this work is answering)';
const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;
const wire = async (): Promise<string> => JSON.stringify((await assembleContext(AGENT, 'm')).messages);

describe('t145 R4 — only the served owner message is protected, and it is re-emitted when it is out of view', () => {
  it('the served ids are the claimed ask\'s own message and the unanswered owner messages merged into it, only while a turn runs', () => {
    servedAsk(0);
    say('user', 'a later owner message merged into the same turn', 'later-row');
    expect(servedOwnerMessageIds(AGENT), 'no turn is running: nothing is served').toEqual([]);
    runningTurnOn('ask-row');
    expect(servedOwnerMessageIds(AGENT)).toEqual(['ask-row', 'later-row']);
    endTurnContext(AGENT);
    expect(servedOwnerMessageIds(AGENT)).toEqual([]);
  });

  // ── ROUND 5: a continuation re-shows only the ask(s) THE JOB is serving, carried on t143's own record ──
  /** Two claimed asks in one conversation: H, an old held job, and B, the long ask this turn serves. */
  function heldAndCurrent(): void {
    say('user', 'OLD-HELD-JOB '.repeat(30), 'held-row');
    expect(claimAsk('ask:held-row', AGENT).kind).toBe('applied');
    say('assistant', 'On it, handed to a helper.');
    say('user', 'THE-LONG-ASK '.repeat(30), 'ask-row');
    expect(claimAsk('ask:ask-row', AGENT).kind).toBe('applied');
  }
  /** The park: the serving turn checkpoints (the real note path) and queues its continuation wake. */
  function parkTurnServing(askId: string): void {
    runningTurnOn(askId);
    noteEngineCheckpoint(AGENT, 'turn-budget');
    expect(queueJobContinuation(AGENT, 'turn-budget')).toBe(true);
    endTurnContext(AGENT);
  }
  /** The run launched FROM the park's own wake: no trigger of its own, the stash's conversation restored. */
  function continuationRun(): void {
    expect(beginJobRun(AGENT, 'drain')).toBe(true);
    const bag = openTurnContext(AGENT);
    bag.conversationId = 'conv-dash';
  }
  afterEach(() => { endJobCarry(AGENT); });

  it('R4-C1: two claimed asks, a job serving only one, a continuation: ONLY that one ask is served', () => {
    heldAndCurrent();
    parkTurnServing('ask-row');
    continuationRun();
    expect(servedOwnerMessageIds(AGENT)).toEqual(['ask-row']);   // never the held job
  });

  it('R4-I1: an intervening turn (an owner message, an A2A, the scheduler) neither eats nor widens the carry', () => {
    heldAndCurrent();
    parkTurnServing('ask-row');
    const other = openTurnContext(AGENT);               // some other turn runs first: not launched from the wake
    other.conversationId = 'conv-dash';
    expect(servedOwnerMessageIds(AGENT), 'a run that is not the job\'s continuation serves nothing it did not pick up').toEqual([]);
    endTurnContext(AGENT);
    continuationRun();
    expect(servedOwnerMessageIds(AGENT), 'the job\'s own continuation still carries its ask').toEqual(['ask-row']);
  });

  it('an old FINISHED request is never re-shown: a carried ask that has since closed drops out', async () => {
    heldAndCurrent();
    parkTurnServing('ask-row');
    mockDb.current!.prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = 'ask:ask-row'").run(Date.now());   // the ask is closed
    continuationRun();
    expect(servedOwnerMessageIds(AGENT)).toEqual([]);
  });

  it('a run with no park behind it (no job carried) serves nothing, however many asks are claimed', () => {
    heldAndCurrent();
    const bag = openTurnContext(AGENT);
    bag.conversationId = 'conv-dash';
    expect(servedOwnerMessageIds(AGENT)).toEqual([]);
  });

  it('the job\'s own ask survives TWO condenses: behind two summaries, the continuation still holds it verbatim, once', async () => {
    heldAndCurrent();
    for (let i = 0; i < 12; i++) say(i % 2 === 0 ? 'assistant' : 'user', `job row ${i}`);
    parkTurnServing('ask-row');
    const idsThrough = (seq: number): string[] => (mockDb.current!.prepare(
      'SELECT id FROM messages WHERE seq <= ? AND id NOT IN (SELECT message_id FROM summary_messages) ORDER BY seq').all(seq) as Array<{ id: string }>).map((r) => r.id);
    const askSeq = (mockDb.current!.prepare("SELECT seq FROM messages WHERE id = 'ask-row'").get() as { seq: number }).seq;
    createLeafSummary(AGENT, 'Earlier: a held job and a big ask.', 20, idsThrough(askSeq), new Date().toISOString(), new Date().toISOString());
    for (let i = 0; i < 6; i++) say(i % 2 === 0 ? 'assistant' : 'user', `later job row ${i}`);
    const lastSeq = (mockDb.current!.prepare('SELECT MAX(seq) AS s FROM messages').get() as { s: number }).s;
    createLeafSummary(AGENT, 'Later: the job kept going.', 20, idsThrough(lastSeq - 2), new Date().toISOString(), new Date().toISOString());
    continuationRun();
    const text = await wire();
    expect(occurrences(text, LABEL)).toBe(1);
    expect(occurrences(text, 'THE-LONG-ASK '.repeat(30).trim())).toBe(1);
    expect(text, 'the held job is not re-shown').not.toContain('OLD-HELD-JOB');
  });

  it('CONTROL (#7): a new ask while an older one is still claimed re-shows only the new one, never the held job', () => {
    servedAsk(0);                                   // the held job: claimed, never answered here
    say('user', 'You there?', 'ping-row');          // opens its own ask
    runningTurnOn('ping-row');
    expect(servedOwnerMessageIds(AGENT)).toEqual(['ping-row']);
  });

  it('NOTHING after the ask is frozen: the fold input and the condense trigger reach past it, as before', () => {
    const { askSeq } = servedAsk(70);
    runningTurnOn('ask-row');
    expect(getMessagesOutsideFreshTail(AGENT, 24).map((m) => m.rowid as number)).toContain(askSeq);
    const leaving = rowsLeavingView(AGENT, policy, { viewFull: true });
    expect(leaving!.throughSeq).toBeGreaterThanOrEqual(askSeq);
  });

  it('in view: the ask is in the live conversation and nothing extra is emitted', async () => {
    servedAsk(6);
    runningTurnOn('ask-row');
    const text = await wire();
    expect(occurrences(text, 'THE-LONG-ASK')).toBeGreaterThan(0);
    expect(text).not.toContain(LABEL);
  });

  it('behind the fold boundary: the ask is re-emitted verbatim at the front of the live tail, labelled, exactly once', async () => {
    const { askSeq } = servedAsk(30);
    // A summary covers everything up to and including the ask: the live view starts after it.
    const ids = (mockDb.current!.prepare('SELECT id FROM messages WHERE seq <= ? ORDER BY seq').all(askSeq) as Array<{ id: string }>).map((r) => r.id);
    createLeafSummary(AGENT, 'Earlier: the owner asked for a big job.', 20, ids, new Date().toISOString(), new Date().toISOString());
    const ask = 'THE-LONG-ASK '.repeat(30);
    expect(occurrences(await wire(), 'THE-LONG-ASK'), 'control: no turn running, the ask is only in the note').toBe(0);
    runningTurnOn('ask-row');
    const ctx = await assembleContext(AGENT, 'm');
    const text = JSON.stringify(ctx.messages);
    expect(text).toContain(LABEL);
    expect(occurrences(text, LABEL), 'exactly once').toBe(1);
    expect(text).toContain(ask.trim());
    expect(occurrences(text, ask.trim()), 'the words appear once').toBe(1);
    // it leads the live tail: it is the first message that is not the summary scaffolding
    const firstLabelled = ctx.messages.findIndex((m) => JSON.stringify(m).includes(LABEL));
    const firstTurnRow = ctx.messages.findIndex((m) => JSON.stringify(m).includes('turn row 0'));
    expect(firstLabelled).toBeGreaterThanOrEqual(0);
    expect(firstLabelled).toBeLessThan(firstTurnRow);
    // and once the turn ends it is gone
    endTurnContext(AGENT);
    expect(await wire()).not.toContain(LABEL);
  });

  it('trimmed off the front by the token budget: the ask is re-emitted, older rows are what went, the budget holds', async () => {
    mockDb.current!.prepare("UPDATE models SET context_window = 40000 WHERE id = 'm'").run();
    for (let i = 0; i < 10; i++) { say('user', `older question ${i} ${'pad '.repeat(300)}`); say('assistant', `older answer ${i} ${'pad '.repeat(300)}`); }
    say('user', 'THE-LONG-ASK '.repeat(8), 'ask-row');
    claimAsk('ask:ask-row', AGENT);
    for (let i = 0; i < 40; i++) say(i % 2 === 0 ? 'assistant' : 'user', `turn row ${i} ${'pad '.repeat(300)}`);
    const control = await wire();
    expect(control, 'control: no turn running, the trim drops the ask with the front').not.toContain('THE-LONG-ASK');
    runningTurnOn('ask-row');
    const text = await wire();
    expect(text).toContain(LABEL);
    expect(occurrences(text, 'THE-LONG-ASK '.repeat(8).trim())).toBe(1);
    expect(text).not.toContain('older question 0');
    expect(text).toContain('turn row 39');   // the newest rows are untouched
  });
});

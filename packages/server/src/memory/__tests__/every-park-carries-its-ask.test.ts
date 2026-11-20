// ════════════════════════════════════════════════════════════════════════════════════════
// EVERY PARK THAT RESUMES A JOB CARRIES ITS ASK. ONE helper, `parkJob` (`work/job-continuation.ts`), is the
// single definition of "park": it dates the job's task, opening one linked to the request when the turn has
// none, and the job's own turn is rooted in that request (`preflight/turn-trigger.ts`). On a job with no task
// and no earlier park, the first turn's compaction folds the ask; the job's own turn still holds it verbatim.
//
// The sequence the gates run is driven for real below: the forced fold that takes the ask behind the
// boundary, then the park, then the continuation. One recovery site is driven through the real
// `recoverFromError`.
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
// The note a forced fold writes: the summarizer's own door, answered by script.
vi.mock('../summarize.js', async (orig) => ({
  ...(await orig<typeof import('../summarize.js')>()),
  generateSummary: async () => ({ ok: true as const, text: 'Earlier: the owner asked for a big job and it was started.', tokenCount: 20 }),
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { claimAsk } from '../../work/store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { checkAndCompact } from '../compaction.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { assembleContext } from '../assembler.js';
import { servedOwnerMessageIds } from '../served-ask.js';
import { parkJob } from '../../work/job-continuation.js';
import { recoverFromError } from '../../agent/v2/recovery.js';
import { initState } from '../../agent/v2/state.js';
import { AgentError } from '../../agent/errors.js';

const AGENT = 'primary';
const WINDOW = 40000;   // the smallest window the assembler can admit a message into (the system prompt and tools take the rest)
const LABEL = '(the message this work is answering)';
const ASK = 'THE-LONG-ASK '.repeat(30);
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

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
function say(role: 'user' | 'assistant', content: string, id = `m-${++n}`): void {
  insertMessage({
    id, agentId: AGENT, role, content, turnNumber: 1,
    channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
    ...(role === 'user' ? { inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }) } : {}),
  });
}

beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 40000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')").run();
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
              VALUES ('conv-dash', 'primary', 'dashboard', NULL, 'owner', datetime('now'))`).run();
  n = 0;
  __resetBrakesForTests();
});
afterEach(() => { endTurnContext(AGENT); mockDb.current?.close(); mockDb.current = null; });

/** The FIRST turn of a job: older talk, the owner's long ask (claimed), then 70 rows of the turn's own work. No task, no earlier park. */
function firstTurnOfAJob(): void {
  for (let i = 0; i < 5; i++) { say('user', `older question ${i}`); say('assistant', `older answer ${i}`); }
  say('user', ASK, 'ask-row');
  expect(claimAsk('ask:ask-row', AGENT).kind).toBe('applied');
  // t194: the turn's work is heavy (an overflow is what forces these passes), so the ask lies before the
  // protected recent part, which is sized in tokens now rather than the 40-row rung.
  for (let i = 0; i < 70; i++) say('assistant', `turn row ${i} ${'w'.repeat(1_200)}`);
  const bag = openTurnContext(AGENT);
  bag.turnNumber = 1;
  bag.root = { kind: 'ask', id: 'ask-row', sourceMessageId: 'ask-row' };
  bag.conversationId = 'conv-dash';
}
/** The job's own turn, as the preflight picks up its parked task: rooted in the request the task names. */
async function continuationRun(): Promise<void> {
  endTurnContext(AGENT);
  const { nextOwed } = await import('../../agent/v2/owed.js');
  const item = nextOwed(AGENT).find((i) => i.kind === 'job');
  expect(item, 'the park dated a task the clock serves').toBeDefined();
  const bag = openTurnContext(AGENT);
  bag.servedJob = item!.ref;
  bag.conversationId = 'conv-dash';
  const r = item!.job!.ask!.row;
  bag.root = { kind: 'ask', id: r.id, sourceMessageId: r.id, conversationId: r.conversation_id };
}
const foldedIntoNote = (): boolean => (mockDb.current!.prepare("SELECT COUNT(*) AS n FROM summary_messages WHERE message_id = 'ask-row'").get() as { n: number }).n > 0;
const wire = async (): Promise<string> => JSON.stringify((await assembleContext(AGENT, 'm')).messages);

describe('t145 R6 — a park that is not the turn-budget or tool-loop park still carries the job\'s ask', () => {
  it('emergency compaction / context-full (the gates\' sequence): fold, park, continue: the ask is verbatim and labelled', async () => {
    firstTurnOfAJob();
    const out = await checkAndCompact(AGENT, 'm', WINDOW, { force: true });   // what the gate runs
    expect(out.leafCreated).toBeGreaterThan(0);
    expect(foldedIntoNote(), 'premise: the compaction took the ask behind the boundary').toBe(true);
    expect(parkJob(AGENT, 'context-gate-rebuild', Date.now())).toBe(true);           // what the gate then parks
    await continuationRun();
    expect(servedOwnerMessageIds(AGENT)).toEqual(['ask-row']);
    const text = await wire();
    expect(count(text, LABEL)).toBe(1);
    expect(count(text, ASK.trim())).toBe(1);
  });

  it('CONTROL: an unrelated turn after that carries nothing', async () => {
    firstTurnOfAJob();
    await checkAndCompact(AGENT, 'm', WINDOW, { force: true });
    parkJob(AGENT, 'context-gate-rebuild', Date.now());
    await continuationRun();
    endTurnContext(AGENT);                                     // the job's turn ended
    openTurnContext(AGENT).conversationId = 'conv-dash';       // some other turn (a scheduler tick, an A2A) runs
    expect(servedOwnerMessageIds(AGENT)).toEqual([]);
    expect(await wire()).not.toContain(LABEL);
  });

  it('a recovery site, through the real recoverFromError: a context overflow forces a compaction and the continuation holds the ask', async () => {
    firstTurnOfAJob();
    const state = initState({
      agentId: AGENT, contextWindow: WINDOW, isAutoRouted: false, configuredModelId: 'm', turnNumber: 1,
      triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: ASK, lastUserMessageId: 'ask-row',
      inboundChannel: null, inboundContext: null,
    });
    await recoverFromError(state, new AgentError('prompt is too long: context_length_exceeded', AGENT, { code: 'CONTEXT_OVERFLOW' }), { isUserFacingTurn: true });
    expect(foldedIntoNote(), 'premise: the recovery\'s forced compaction took the ask behind the boundary').toBe(true);
    await continuationRun();
    expect(servedOwnerMessageIds(AGENT)).toEqual(['ask-row']);
    const text = await wire();
    expect(count(text, LABEL)).toBe(1);
    expect(count(text, ASK.trim())).toBe(1);
  });
});

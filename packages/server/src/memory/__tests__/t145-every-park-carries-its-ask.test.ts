// ════════════════════════════════════════════════════════════════════════════════════════
// t145 group A, round 6 — EVERY WAKE THAT RESUMES A JOB CARRIES ITS ASK.
//
// Round 5 put the served ask on t143's job record, but only the turn-budget and tool-loop parks wrote
// it. Four other wakes resume a job and called a bare `queueSelfWake`: the emergency compaction and the
// context-full block (`context-gates.ts`) and the two forced compactions of error recovery
// (`recovery.ts`). On a job with no task and no earlier park, the first turn's compaction folds the
// ask, and the continuation then saw nothing. ONE helper, `parkJob` (`work/job-continuation.ts`), is
// the single definition of "park": carry the job's work and served asks, then queue the wake. All six
// sites go through it.
//
// The sequence the gates run is driven for real below: the forced fold that takes the ask behind the
// boundary, then the park, then the continuation. One recovery site is driven through the real
// `recoverFromError`.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

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
import { beginJobRun, endJobRun, endJobCarry } from '../../work/task-freshness.js';
import { pendingWakeups } from '../../agent/shared-state.js';
import { recoverFromError } from '../../agent/v2/recovery.js';
import { initState } from '../../agent/v2/state.js';
import { AgentError } from '../../agent/errors.js';
import { engineFileContaining } from '../../agent/v2/__tests__/engine-sources.js';

const AGENT = 'primary';
const WINDOW = 40000;   // the smallest window the assembler can admit a message into (the system prompt and tools take the rest)
const LABEL = 'The message from you this work is answering';
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
  pendingWakeups.clear();
});
afterEach(() => { endTurnContext(AGENT); endJobCarry(AGENT); pendingWakeups.clear(); mockDb.current?.close(); mockDb.current = null; });

/** The FIRST turn of a job: older talk, the owner's long ask (claimed), then 70 rows of the turn's own work. No task, no earlier park. */
function firstTurnOfAJob(): void {
  for (let i = 0; i < 5; i++) { say('user', `older question ${i}`); say('assistant', `older answer ${i}`); }
  say('user', ASK, 'ask-row');
  expect(claimAsk('ask:ask-row', AGENT).kind).toBe('applied');
  for (let i = 0; i < 70; i++) say(i % 2 === 0 ? 'assistant' : 'user', `turn row ${i}`);
  const bag = openTurnContext(AGENT);
  bag.root = { kind: 'ask', id: 'ask-row', sourceMessageId: 'ask-row' };
  bag.conversationId = 'conv-dash';
}
/** The run the drain starts from the park's wake: no trigger of its own. */
function continuationRun(): void {
  endTurnContext(AGENT);
  expect(beginJobRun(AGENT, 'drain'), 'the park registered a wake the drain serves').toBe(true);
  openTurnContext(AGENT).conversationId = 'conv-dash';
}
const foldedIntoNote = (): boolean => (mockDb.current!.prepare("SELECT COUNT(*) AS n FROM summary_messages WHERE message_id = 'ask-row'").get() as { n: number }).n > 0;
const wire = async (): Promise<string> => JSON.stringify((await assembleContext(AGENT, 'm')).messages);

describe('t145 R6 — a park that is not the turn-budget or tool-loop park still carries the job\'s ask', () => {
  it('emergency compaction / context-full (the gates\' sequence): fold, park, continue: the ask is verbatim and labelled', async () => {
    firstTurnOfAJob();
    const out = await checkAndCompact(AGENT, 'm', WINDOW, { force: true });   // what the gate runs
    expect(out.leafCreated).toBeGreaterThan(0);
    expect(foldedIntoNote(), 'premise: the compaction took the ask behind the boundary').toBe(true);
    expect(parkJob(AGENT, 'context-gate-rebuild')).toBe(true);                       // what the gate then queues
    continuationRun();
    expect(servedOwnerMessageIds(AGENT)).toEqual(['ask-row']);
    const text = await wire();
    expect(count(text, LABEL)).toBe(1);
    expect(count(text, ASK.trim())).toBe(1);
  });

  it('CONTROL: an unrelated wake after that carries nothing', async () => {
    firstTurnOfAJob();
    await checkAndCompact(AGENT, 'm', WINDOW, { force: true });
    parkJob(AGENT, 'context-gate-rebuild');
    continuationRun();
    endTurnContext(AGENT);
    endJobRun(AGENT);                                          // the continuation ended
    pendingWakeups.add(AGENT);                                 // some other wake (a scheduler tick, an A2A) is queued
    expect(beginJobRun(AGENT, 'drain'), 'no job wake is registered any more').toBe(false);
    openTurnContext(AGENT).conversationId = 'conv-dash';
    expect(servedOwnerMessageIds(AGENT)).toEqual([]);
    expect(await wire()).not.toContain(LABEL);
  });

  it('a recovery site, through the real recoverFromError: a context overflow forces a compaction and the continuation holds the ask', async () => {
    firstTurnOfAJob();
    const state = initState({
      agentId: AGENT, contextWindow: WINDOW, isAutoRouted: false, configuredModelId: 'm', turnNumber: 1,
      triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: ASK, lastUserMessageId: 'ask-row',
      inboundChannel: null, inboundContext: null, pendingTechniqueAck: null,
    });
    await recoverFromError(state, new AgentError('prompt is too long: context_length_exceeded', AGENT, { code: 'CONTEXT_OVERFLOW' }), { isUserFacingTurn: true });
    expect(foldedIntoNote(), 'premise: the recovery\'s forced compaction took the ask behind the boundary').toBe(true);
    continuationRun();
    expect(servedOwnerMessageIds(AGENT)).toEqual(['ask-row']);
    const text = await wire();
    expect(count(text, LABEL)).toBe(1);
    expect(count(text, ASK.trim())).toBe(1);
  });

  it('CENSUS: the four wakes and both parks go through parkJob; none queues a bare self-wake for a job', () => {
    const SRC = path.resolve(__dirname, '..', '..');
    const strip = (t: string): string => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // The engine's driver and step packages are found through the one shared derivation (the guard-corpus rule).
    const engineCode = (needle: string): string => {
      const f = engineFileContaining(needle);
      expect(f, `no engine file contains ${needle}`).not.toBeNull();
      return strip(f!.text);
    };
    const gates = engineCode("parkJob(agentId, 'context-gate-rebuild')");
    expect(gates).not.toMatch(/queueSelfWake\(agentId, 'context-gate-rebuild'\)/);
    expect(gates.match(/parkJob\(agentId, 'context-gate-rebuild'\)/g)?.length).toBe(2);
    const recovery = strip(fs.readFileSync(path.join(SRC, 'agent/v2/recovery.ts'), 'utf8'));
    expect(recovery).not.toMatch(/queueSelfWake\(agentId, 'recovery-forced-compaction'\)/);
    expect(recovery).not.toMatch(/queueSelfWake\(agentId, 'recovery-doomed-prefill-compaction'\)/);
    expect(recovery).toMatch(/parkJob\(agentId, 'recovery-forced-compaction'\)/);
    expect(recovery).toMatch(/parkJob\(agentId, 'recovery-doomed-prefill-compaction'\)/);
    expect(engineCode("parkJob(agentId, 'turn-budget-continuation')")).toMatch(/parkJob\(agentId, 'turn-budget-continuation'\)/);
    expect(engineCode("parkJob(agentId, 'tool-loop', 'timer')")).toMatch(/parkJob\(agentId, 'tool-loop', 'timer'\)/);
  });
});

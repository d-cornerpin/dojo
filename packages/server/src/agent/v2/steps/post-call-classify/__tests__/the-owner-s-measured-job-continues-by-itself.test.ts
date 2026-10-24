// v3.5 D1, ORCHESTRATOR RULING 1 — THE OWNER'S OWN JOB CONTINUES BY ITSELF.
//
// The owner asks for a measured job. The agent works, replies ("on it, 139 so far") and its turn ends
// the way a replied turn ends: the reply stands and nothing delays or replaces it. THEN, because the
// task has items left and the turn made progress, the engine parks a continuation through the one
// park door (`parkJob`, on its own timer), and the next turn runs from that wake — with no PM
// check-in in between. Real park door, real timer (faked clock); the runtime and the PM's A2A door
// are spies.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-d1-owner-job-test', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const { countMeasure, handleMessage, deliverA2A, stash } = vi.hoisted(() => ({
  stash: vi.fn(),
  countMeasure: vi.fn(),
  handleMessage: vi.fn(async () => undefined),
  deliverA2A: vi.fn(async () => ({ delivered: true, threadId: 't' })),
}));
vi.mock('../../../../../work/measure.js', async (orig) => ({ ...(await orig<typeof import('../../../../../work/measure.js')>()), countMeasure }));
vi.mock('../../../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage }) }));
vi.mock('../../../../a2a-transport.js', () => ({ deliverA2AMessage: deliverA2A, makeThreadId: (s: string) => `thread-${s}` }));

import { runMigrations } from '../../../../../db/migrations.js';
import { trackerHandlers } from '../../../../tools/cat/tracker.js';
import { recordTouched } from '../../../../../work/ledger-store.js';
import { chargeEffortCalls } from '../../../../../tracker/effort-ledger.js';
import { endJobCarry } from '../../../../../work/task-freshness.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runGoingIdle } from '../going-idle.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'agent-owner-job';
const MEASURE = { tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' };
const REPLY = 'On it: 139 labelled so far, carrying on.';
const db = (): Database.Database => mockDb.current!;
type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'Worker', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(AGENT);
  countMeasure.mockReset();
  handleMessage.mockClear();
  deliverA2A.mockClear();
  endJobCarry(AGENT);
  stash.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('ruling 1: an owner asks for a measured job — reply delivered, then the job continues by itself', () => {
  it('the replied owner turn ends as replied turns end; a `continued` is recorded; the next turn runs from the park\'s wake; no PM check-in', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 10551 });
    const opened = await call('work_open:task', { title: 'Sort the inbox', goal: 'every inbox message labelled', measure: MEASURE });
    const id = /task_id=([0-9a-f-]{36})/.exec(opened.content)![1];
    await call('work_update:status', { task_id: id, status: 'in_progress' });

    let state: AgentTurnState = advance(initState({ agentId: AGENT, maxToolLoops: 75, turnNumber: 3, lastUserMessageContent: 'please sort my inbox' } as unknown as Parameters<typeof initState>[0]),
      { loopCount: 1, modelId: 'test-model' });
    const label = { id: 'tc-1', name: 'gmail_label', arguments: { message_ids: ['a', 'b'], add: ['Done'] } } as ToolCall;
    chargeEffortCalls(id, [label], state.turnStartMs);
    recordTouched(id, 'gmail_label', ['gmail:msg:a', 'gmail:msg:b'], state.turnStartMs + 1);
    state = advance(state, { toolCalls: [label], toolResults: [{ toolCallId: 'tc-1', name: 'gmail_label', isError: false, content: '[OK]' } as AgentTurnState['toolResults'][number]] });

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    countMeasure.mockResolvedValueOnce({ ok: true, count: 10412 });
    const sc = { persistedContent: REPLY } as PostCallScratch;
    const out = await runGoingIdle(state, {
      agentId: AGENT, db: db(), turnNumber: 3, agent: { id: AGENT, name: 'Worker' },
      turnCtx: { agentId: AGENT, goingIdleDetectorRanThisTurn: false, conversationId: 'conv-owner' } as never,
      triggerRow: { rowid: 1, content: 'please sort my inbox' }, isA2ATurn: false, mostRecentInbound: undefined,
      lastUserMessageContent: 'please sort my inbox', chosenConvKey: 'dashboard:owner',
      counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' }, stashContinuationIfHuman: stash,
    } as unknown as PostCallClassifyContext, sc);

    // The owner's reply stands, and nothing was said in its place.
    expect(out.directive).toBe('exit');
    expect(sc.persistedContent).toBe(REPLY);
    expect((db().prepare(`SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND role = 'system'`).get(AGENT) as { n: number }).n).toBe(0);
    const continued = db().prepare(`SELECT payload FROM work_events WHERE work_id = ? AND kind = 'continued'`).all(id) as Array<{ payload: string }>;
    expect(continued.map((r) => JSON.parse(r.payload))).toEqual([expect.objectContaining({ remaining: 10412, touchedThisTurn: 2 })]);
    expect(handleMessage).not.toHaveBeenCalled();   // the continuation never runs before the turn is over
    expect(stash).not.toHaveBeenCalled();            // not a human continuation: its progress lines are not answers to him

    // The park's own timer starts the next turn, from the wake, carrying the job.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(1));
    expect(handleMessage).toHaveBeenCalledWith(AGENT, '', { job: true });
    // And no PM check-in was needed for it.
    expect(deliverA2A).not.toHaveBeenCalled();
    expect((db().prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'poke'`).get(id) as { n: number }).n).toBe(0);
  });
});

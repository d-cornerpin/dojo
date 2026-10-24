// v3.5 DONE IS MEASURED, Task D1 — A TURN THAT ENDS MID-JOB IS PARKED AND CONTINUED.
//
// The turn end used to show the worker a menu with "complete" on it, or (when it had already said
// something) end and leave the job for the PM's check-in. Now, for the worker's most recently
// updated claimed task: a turn with MOMENTUM (it touched an item, or made a call the task had never
// made before; owner 2026-10-19, time is not a factor) is parked and continued while items remain,
// whatever it said; a CONTINUED turn that comes back with no momentum is recorded as stalled, is not
// parked, and is left for the PM. A human waiting on the agent keeps today's behaviour.
//
// Driven through the real detector (`runGoingIdle`) on the real migration chain. Seams: the counter
// (`countMeasure`, no mailbox is read), the park's wake (`parkJob`, no timer or run is started) and
// the dashboard socket.
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-d1-continues-test', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const { countMeasure, parkJob } = vi.hoisted(() => ({ countMeasure: vi.fn(), parkJob: vi.fn(() => true) }));
vi.mock('../../../../../work/measure.js', async (orig) => ({ ...(await orig<typeof import('../../../../../work/measure.js')>()), countMeasure }));
vi.mock('../../../../../work/job-continuation.js', async (orig) => ({ ...(await orig<typeof import('../../../../../work/job-continuation.js')>()), parkJob }));

import { runMigrations } from '../../../../../db/migrations.js';
import { trackerHandlers } from '../../../../tools/cat/tracker.js';
import { recordTouched } from '../../../../../work/ledger-store.js';
import { chargeEffortCalls } from '../../../../../tracker/effort-ledger.js';
import { armTimerWake, beginJobRun, endJobCarry, endJobRun } from '../../../../../work/task-freshness.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runGoingIdle } from '../going-idle.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'agent-d1';
const MEASURE = { tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' };

type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });
const db = (): Database.Database => mockDb.current!;
const taskIdFrom = (out: Out): string => {
  const m = /task_id=([0-9a-f-]{36})/.exec(out.content);
  if (!m) throw new Error(`no task id in: ${out.content}`);
  return m[1];
};

async function openTask(measured: boolean): Promise<string> {
  if (measured) countMeasure.mockResolvedValueOnce({ ok: true, count: 10551 });
  const out = await call('work_open:task', {
    title: 'Sort the inbox', goal: 'every inbox message labelled', ...(measured ? { measure: MEASURE } : {}),
  });
  const id = taskIdFrom(out);
  await call('work_update:status', { task_id: id, status: 'in_progress' });
  return id;
}

const events = (id: string, kind: string): Array<Record<string, unknown>> =>
  (db().prepare('SELECT payload FROM work_events WHERE work_id = ? AND kind = ? ORDER BY id').all(id, kind) as Array<{ payload: string }>)
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>);
const systemRows = (): number =>
  (db().prepare(`SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND role = 'system'`).get(AGENT) as { n: number }).n;
const menuSteers = (s: AgentTurnState): Array<{ content: string }> =>
  (s.steerQueue as unknown as { fired: Array<{ floor: string; content: string }> }).fired.filter((e) => e.floor === 'going-idle-in-progress');

let turnNumber = 10;
let lastTurnStartMs = 0;
/** A new turn. Its start is strictly later than the last one's, as two real turns' are (a fast test can
 *  otherwise open two in the same millisecond, which no turn boundary can tell apart). */
function freshTurn(): AgentTurnState {
  turnNumber += 1;
  lastTurnStartMs = Math.max(Date.now(), lastTurnStartMs + 1000);
  return advance(initState({ agentId: AGENT, maxToolLoops: 75, turnNumber, lastUserMessageContent: null } as unknown as Parameters<typeof initState>[0]),
    { loopCount: 1, modelId: 'test-model', turnStartMs: lastTurnStartMs });
}

/** This turn's calls and their results, as the loop records them, and what the execute step's charge
 *  site does with them: the effort meter's novel-vs-repeat charge and the ledger's touched items. */
function ranCalls(state: AgentTurnState, taskId: string, calls: ToolCall[], touched: string[] = []): AgentTurnState {
  chargeEffortCalls(taskId, calls, state.turnStartMs);
  if (touched.length > 0) recordTouched(taskId, 'gmail_label', touched, state.turnStartMs + 1);
  return advance(state, {
    toolCalls: [...state.toolCalls, ...calls],
    toolResults: [...state.toolResults, ...calls.map((c) => ({ toolCallId: c.id, name: c.name, isError: false, content: '[OK]' }) as AgentTurnState['toolResults'][number])],
  });
}
const labelCall = (n: number, from = 0): ToolCall => ({
  id: `tc-label-${from}`, name: 'gmail_label',
  arguments: { message_ids: Array.from({ length: n }, (_, i) => `m${from + i}`), add: ['Done'] },
} as ToolCall);
const ids = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `gmail:msg:m${from + i}`);

function ctxFor(over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT, db: db(), turnNumber, agent: { id: AGENT, name: 'Worker' },
    turnCtx: { agentId: AGENT, goingIdleDetectorRanThisTurn: false } as never,
    triggerRow: null, isA2ATurn: false, mostRecentInbound: undefined, lastUserMessageContent: null,
    ...over,
  } as unknown as PostCallClassifyContext;
}
const scratch = (reply: string | null = null): PostCallScratch => ({ persistedContent: reply } as PostCallScratch);

/** The park's timer fires and the run it starts is the continuation (`job-continuation.ts`). */
function theContinuationStarts(): void {
  armTimerWake(AGENT);
  beginJobRun(AGENT, 'timer');
}

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
  parkJob.mockClear();
  endJobRun(AGENT);
  endJobCarry(AGENT);
});

describe('D1: a turn that ends mid-job is parked and continued', () => {
  it('measured task, 139 touched this turn, count 10,412, no reply: parked on the timer, `continued` recorded, no message', async () => {
    const id = await openTask(true);
    let state = ranCalls(freshTurn(), id, [labelCall(139)], ids(139));
    countMeasure.mockResolvedValueOnce({ ok: true, count: 10412 });
    const out = await runGoingIdle(state, ctxFor(), scratch());
    state = out.state;

    expect(out.directive).toBe('exit');
    expect(parkJob).toHaveBeenCalledTimes(1);
    expect(parkJob.mock.calls[0]).toEqual([AGENT, 'job continues: 10412 remain', 'timer']);
    expect(events(id, 'continued')).toEqual([expect.objectContaining({ remaining: 10412, touchedThisTurn: 139, turnNumber })]);
    expect(events(id, 'measured').at(-1)).toMatchObject({ remaining: 10412, ok: true });
    expect(systemRows()).toBe(0);
    expect(menuSteers(state)).toHaveLength(0);
    expect(events(id, 'stalled')).toHaveLength(0);
  });

  it('REVIEW FOCUS 3: the agent replied "500 done so far" — still parked, no second message', async () => {
    const id = await openTask(true);
    const state = ranCalls(freshTurn(), id, [labelCall(139)], ids(139));
    countMeasure.mockResolvedValueOnce({ ok: true, count: 10412 });
    const out = await runGoingIdle(state, ctxFor(), scratch('500 done so far'));

    expect(out.directive).toBe('exit');
    expect(parkJob).toHaveBeenCalledTimes(1);
    expect(events(id, 'continued')).toHaveLength(1);
    expect(systemRows()).toBe(0);
    expect(menuSteers(out.state)).toHaveLength(0);
  });

  it('a continued turn that touched 0 items and made no new call: `stalled`, not parked, no menu', async () => {
    const id = await openTask(true);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 10412 });
    await runGoingIdle(ranCalls(freshTurn(), id, [labelCall(139)], ids(139)), ctxFor(), scratch());
    parkJob.mockClear();
    theContinuationStarts();

    countMeasure.mockResolvedValueOnce({ ok: true, count: 10412 });
    const out = await runGoingIdle(freshTurn(), ctxFor(), scratch('still on it'));

    expect(parkJob).not.toHaveBeenCalled();
    expect(events(id, 'stalled')).toEqual([expect.objectContaining({ remaining: 10412, turnNumber })]);
    expect(menuSteers(out.state)).toHaveLength(0);
    expect(systemRows()).toBe(0);
    expect((db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state).toBe('claimed');
  });

  it('NO LOOP WITHOUT PROGRESS: a continued turn that only REPEATS calls the task already made is stalled', async () => {
    const id = await openTask(true);
    const search: ToolCall = { id: 'tc-s', name: 'gmail_search', arguments: { query: 'in:inbox -label:Done' } } as ToolCall;
    countMeasure.mockResolvedValueOnce({ ok: true, count: 10412 });
    await runGoingIdle(ranCalls(freshTurn(), id, [search, labelCall(139)], ids(139)), ctxFor(), scratch());
    parkJob.mockClear();
    theContinuationStarts();

    countMeasure.mockResolvedValueOnce({ ok: true, count: 10412 });
    await runGoingIdle(ranCalls(freshTurn(), id, [{ ...search, id: 'tc-s2' }]), ctxFor(), scratch());

    expect(parkJob).not.toHaveBeenCalled();
    expect(events(id, 'stalled')).toHaveLength(1);
  });

  it('NO LOOP WITHOUT PROGRESS: a continued turn that re-touches only items it already touched, with calls it already made, is stalled', async () => {
    const id = await openTask(true);
    countMeasure.mockResolvedValue({ ok: true, count: 10412 });
    await runGoingIdle(ranCalls(freshTurn(), id, [labelCall(10)], ids(10)), ctxFor(), scratch());
    parkJob.mockClear();
    theContinuationStarts();

    // The very same label call on the very same ten messages: the ledger's rows move, nothing new is touched.
    await runGoingIdle(ranCalls(freshTurn(), id, [{ ...labelCall(10), id: 'tc-again' }], ids(10)), ctxFor(), scratch());

    expect(parkJob).not.toHaveBeenCalled();
    expect(events(id, 'stalled')).toHaveLength(1);
  });

  it('a continued turn that made a call the task had never made (the next search page) has momentum and is continued again', async () => {
    const id = await openTask(true);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 10412 });
    await runGoingIdle(ranCalls(freshTurn(), id, [labelCall(139)], ids(139)), ctxFor(), scratch());
    parkJob.mockClear();
    theContinuationStarts();

    const nextPage: ToolCall = { id: 'tc-p2', name: 'gmail_search', arguments: { query: 'in:inbox -label:Done', page_token: 'p2' } } as ToolCall;
    countMeasure.mockResolvedValueOnce({ ok: true, count: 10412 });
    await runGoingIdle(ranCalls(freshTurn(), id, [nextPage]), ctxFor(), scratch());

    expect(parkJob).toHaveBeenCalledTimes(1);
    expect(events(id, 'continued').at(-1)).toMatchObject({ touchedThisTurn: 0, novelCallsThisTurn: 1 });
    expect(events(id, 'stalled')).toHaveLength(0);
  });

  it('after a stall, a turn that works again re-arms the continuation on its own (nothing to reset)', async () => {
    const id = await openTask(true);
    countMeasure.mockResolvedValue({ ok: true, count: 10412 });
    await runGoingIdle(ranCalls(freshTurn(), id, [labelCall(10)], ids(10)), ctxFor(), scratch());
    theContinuationStarts();
    await runGoingIdle(freshTurn(), ctxFor(), scratch());
    endJobRun(AGENT);
    expect(events(id, 'stalled')).toHaveLength(1);
    parkJob.mockClear();

    await runGoingIdle(ranCalls(freshTurn(), id, [labelCall(20, 10)], ids(20, 10)), ctxFor({ isA2ATurn: true }), scratch('back on it'));
    expect(parkJob).toHaveBeenCalledTimes(1);
    expect(events(id, 'continued')).toHaveLength(2);
  });

  it('a turn that is not the continuation (an interleaved run) is never recorded as stalled', async () => {
    const id = await openTask(true);
    countMeasure.mockResolvedValue({ ok: true, count: 10412 });
    await runGoingIdle(ranCalls(freshTurn(), id, [labelCall(10)], ids(10)), ctxFor(), scratch());
    // No `theContinuationStarts()`: some other run of this agent ends first, having done nothing.
    await runGoingIdle(freshTurn(), ctxFor({ isA2ATurn: true }), scratch('noted'));
    expect(events(id, 'stalled')).toHaveLength(0);
  });

  it('a human is waiting on the agent (the close-out gate\'s trigger row): no park; the menu when there is no reply', async () => {
    const id = await openTask(true);
    const state = ranCalls(freshTurn(), id, [labelCall(139)], ids(139));
    const out = await runGoingIdle(state, ctxFor({ triggerRow: { rowid: 1, content: 'how is it going?' } }), scratch());

    expect(parkJob).not.toHaveBeenCalled();
    expect(events(id, 'continued')).toHaveLength(0);
    expect(out.directive).toBe('continue');
    expect(menuSteers(out.state)).toHaveLength(1);
  });

  it('no measure, one effectful call succeeded, no reply: parked with remaining null', async () => {
    const id = await openTask(false);
    const send: ToolCall = { id: 'tc-send', name: 'gmail_send', arguments: { to: 'x@example.invalid', subject: 's', body: 'b' } } as ToolCall;
    const out = await runGoingIdle(ranCalls(freshTurn(), id, [send]), ctxFor(), scratch());

    expect(out.directive).toBe('exit');
    expect(parkJob).toHaveBeenCalledTimes(1);
    expect(parkJob.mock.calls[0]).toEqual([AGENT, 'job continues', 'timer']);
    expect(events(id, 'continued')).toEqual([expect.objectContaining({ remaining: null, novelCallsThisTurn: 1 })]);
    expect(countMeasure).not.toHaveBeenCalled();
  });

  it('no measure, nothing touched, no reply: the menu (today\'s text until the text wave), no park', async () => {
    await openTask(false);
    const out = await runGoingIdle(freshTurn(), ctxFor({ mostRecentInbound: { origin_intent: 'scheduler' } }), scratch());

    expect(parkJob).not.toHaveBeenCalled();
    expect(out.directive).toBe('continue');
    expect(menuSteers(out.state)).toHaveLength(1);
  });

  it('a measure that reads 0 is a finished job: no park, the menu', async () => {
    const id = await openTask(true);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
    const out = await runGoingIdle(ranCalls(freshTurn(), id, [labelCall(5)], ids(5)), ctxFor(), scratch());

    expect(parkJob).not.toHaveBeenCalled();
    expect(events(id, 'continued')).toHaveLength(0);
    expect(menuSteers(out.state)).toHaveLength(1);
  });

  it('the measure cannot be read at the turn end: the last stored count stands and the job continues', async () => {
    const id = await openTask(true);
    countMeasure.mockResolvedValueOnce({ ok: false, error: 'Gmail 503' });
    await runGoingIdle(ranCalls(freshTurn(), id, [labelCall(3)], ids(3)), ctxFor(), scratch());

    expect(parkJob).toHaveBeenCalledTimes(1);
    expect(events(id, 'continued')).toEqual([expect.objectContaining({ remaining: 10551 })]);
    expect(events(id, 'measured').at(-1)).toMatchObject({ remaining: null, ok: false });
  });
});

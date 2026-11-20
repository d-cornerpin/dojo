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
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runGoingIdle } from '../going-idle.js';
import { taskMovedAtSql } from '../../../../../work/task-freshness.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';
import { noteRepeatResult } from '../../../identical-call-brake.js';
import { openTurnContext, turnContext } from '../../../../turn-context.js';
/** The repeat rule counting this turn's calls: a successful result new to the window moves the job. */
function chargeEffortCalls(calls: ToolCall[], turn: { succeeded: () => boolean }): void {
  const bag = turnContext(AGENT) ?? openTurnContext(AGENT);
  for (const c of calls) noteRepeatResult(AGENT, bag, c.name, c.arguments, 'result', turn.succeeded());
}

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

async function openTask(measured: boolean, title = 'Sort the inbox'): Promise<string> {
  if (measured) countMeasure.mockResolvedValueOnce({ ok: true, count: 10551 });
  const out = await call('work_open:task', {
    title, goal: 'every inbox message labelled', ...(measured ? { measure: MEASURE } : {}),
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
/** While set, each new turn is the job's own, started from that task's row. */
let jobTurnOf: string | null = null;
let lastTurnStartMs = 0;
/** A new turn. Its start is strictly later than the last one's, as two real turns' are (a fast test can
 *  otherwise open two in the same millisecond, which no turn boundary can tell apart). */
function freshTurn(): AgentTurnState {
  turnNumber += 1;
  const bag = openTurnContext(AGENT);
  bag.turnNumber = turnNumber;
  bag.servedJob = jobTurnOf;
  lastTurnStartMs = Math.max(Date.now(), lastTurnStartMs + 1000);
  return advance(initState({ agentId: AGENT, turnNumber, lastUserMessageContent: null } as unknown as Parameters<typeof initState>[0]),
    { loopCount: 1, modelId: 'test-model', turnStartMs: lastTurnStartMs });
}

/** This turn's calls and their results, as the loop records them, and what the execute step's charge
 *  site does with them: the effort meter's novel-vs-repeat charge and the ledger's touched items. */
function ranCalls(state: AgentTurnState, taskId: string, calls: ToolCall[], touched: string[] = [], failed = false): AgentTurnState {
  chargeEffortCalls(calls, { succeeded: () => !failed });
  if (touched.length > 0 && !failed) recordTouched(taskId, 'gmail_label', touched, state.turnStartMs + 1);
  return advance(state, {
    toolCalls: [...state.toolCalls, ...calls],
    toolResults: [...state.toolResults, ...calls.map((c) => ({ toolCallId: c.id, name: c.name, isError: failed, content: failed ? 'Error: failed' : '[OK]' }) as AgentTurnState['toolResults'][number])],
  });
}
/** The task's last-moved time as the PM's ladder reads it. */
const movedAt = (id: string): number =>
  (db().prepare(`SELECT ${taskMovedAtSql('w')} AS t FROM work w WHERE w.id = ?`).get(id) as { t: number }).t;
const labelCall = (n: number, from = 0): ToolCall => ({
  id: `tc-label-${from}`, name: 'gmail_label',
  arguments: { message_ids: Array.from({ length: n }, (_, i) => `m${from + i}`), add: ['Done'] },
} as ToolCall);
const ids = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `gmail:msg:m${from + i}`);

function ctxFor(over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT, db: db(), turnNumber, agent: { id: AGENT, name: 'Worker' },
    turnCtx: turnContext(AGENT) ?? openTurnContext(AGENT),
    triggerRow: null, isA2ATurn: false, mostRecentInbound: undefined, lastUserMessageContent: null,
    result: { content: '', toolCalls: [] },
    ...over,
  } as unknown as PostCallClassifyContext;
}
const scratch = (reply: string | null = null): PostCallScratch => ({ persistedContent: reply } as PostCallScratch);

/** The park's due time comes and the next turns are the job's own (`job-continuation.ts`). */
function theContinuationStarts(id: string): void { jobTurnOf = id; }

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
  jobTurnOf = null;
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
    expect(parkJob.mock.calls[0]).toEqual([AGENT, 'job continues: 10412 remain', expect.any(Number)]);
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
    theContinuationStarts(id);

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
    theContinuationStarts(id);

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
    theContinuationStarts(id);

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
    theContinuationStarts(id);

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
    theContinuationStarts(id);
    await runGoingIdle(freshTurn(), ctxFor(), scratch());
    jobTurnOf = null;
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
    // No `theContinuationStarts(id)`: some other run of this agent ends first, having done nothing.
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

  it('ORCHESTRATOR RULING 2: no measure, one effectful call succeeded (progress), no reply: TODAY\'s path — the menu and its "already ran" hint, no park', async () => {
    const id = await openTask(false);
    const send: ToolCall = { id: 'tc-send', name: 'gmail_send', arguments: { to: 'x@example.invalid', subject: 's', body: 'b' } } as ToolCall;
    const out = await runGoingIdle(ranCalls(freshTurn(), id, [send]), ctxFor(), scratch());

    expect(parkJob).not.toHaveBeenCalled();
    expect(events(id, 'continued')).toHaveLength(0);
    expect(out.directive).toBe('continue');
    expect(menuSteers(out.state)).toHaveLength(1);
    expect(menuSteers(out.state)[0].content).toContain('gmail_send');
    expect(countMeasure).not.toHaveBeenCalled();
  });

  it('ORCHESTRATOR RULING 2: no measure, progress, already replied: no park, no `continued`', async () => {
    const id = await openTask(false);
    const send: ToolCall = { id: 'tc-send', name: 'gmail_send', arguments: { to: 'x@example.invalid', subject: 's', body: 'b' } } as ToolCall;
    const out = await runGoingIdle(ranCalls(freshTurn(), id, [send]), ctxFor(), scratch('sent it'));
    expect(parkJob).not.toHaveBeenCalled();
    expect(events(id, 'continued')).toHaveLength(0);
    expect(out.directive).toBe('proceed');
  });

  it('ORCHESTRATOR RULING 1: the owner\'s own job-starting turn — the reply stands, THEN the job is parked and continued', async () => {
    const id = await openTask(true);
    const state = ranCalls(freshTurn(), id, [labelCall(139)], ids(139));
    countMeasure.mockResolvedValueOnce({ ok: true, count: 10412 });
    const sc = scratch('On it: 139 labelled so far, carrying on.');
    const turnCtx = { agentId: AGENT, goingIdleDetectorRanThisTurn: false, conversationId: 'conv-owner' };
    const out = await runGoingIdle(state, ctxFor({
      triggerRow: { rowid: 1, content: 'please sort my inbox' }, turnCtx: turnCtx as never,
      chosenConvKey: 'dashboard:owner', counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as never,
    }), sc);

    expect(out.directive).toBe('exit');   // the turn ends the way a replied turn ends; nothing is said in its place
    expect(sc.persistedContent).toBe('On it: 139 labelled so far, carrying on.');
    expect(systemRows()).toBe(0);
    expect(menuSteers(out.state)).toHaveLength(0);
    expect(parkJob).toHaveBeenCalledTimes(1);
    expect(parkJob.mock.calls[0]).toEqual([AGENT, 'job continues: 10412 remain', expect.any(Number)]);
    expect(events(id, 'continued')).toEqual([expect.objectContaining({ remaining: 10412, touchedThisTurn: 139 })]);
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

describe('D1 fix round 1: the stop is the job task\'s own successful effects; momentum is new SUCCESSFUL work', () => {
  it('I1 (probe P1): the measured hand-in is REFUSED ("still lists N"), then the agent replies: still parked, no menu', async () => {
    const id = await openTask(true);
    let state = ranCalls(freshTurn(), id, [labelCall(139)], ids(139));
    countMeasure.mockResolvedValue({ ok: true, count: 10412 });
    const refused = await call('work_update:hand_in', { task_id: id, outcome: 'finished', proof: [], note: 'labelled' });
    expect(refused.content).toMatch(/^Refused: [\s\S]*still lists 10412/);
    const close = { id: 'tc-close', name: 'work_update', arguments: { action: 'hand_in', task_id: id, outcome: 'finished' } } as ToolCall;
    state = advance(state, {
      toolCalls: [...state.toolCalls, close],
      toolResults: [...state.toolResults, { toolCallId: 'tc-close', name: 'work_update', isError: true, content: refused.content } as AgentTurnState['toolResults'][number]],
      trackerStatusUpdatedThisTurn: true,
    });
    const out = await runGoingIdle(state, ctxFor(), scratch('Labelled 139 so far; 10,412 still to go.'));
    expect(out.directive).toBe('exit');
    expect(parkJob).toHaveBeenCalledTimes(1);
    expect(events(id, 'continued')).toHaveLength(1);
    expect(menuSteers(out.state)).toHaveLength(0);
  });

  it('I1 (probe P2): a failed status call on ANOTHER task mid-job does not stop the job', async () => {
    const other = await openTask(false, 'File the receipts');
    const id = await openTask(true);
    let state = ranCalls(freshTurn(), id, [labelCall(50)], ids(50));
    const move = { id: 'tc-other', name: 'work_update', arguments: { action: 'status', task_id: other, status: 'blocked' } } as ToolCall;
    state = advance(state, {
      toolCalls: [...state.toolCalls, move],
      toolResults: [...state.toolResults, { toolCallId: 'tc-other', name: 'work_update', isError: true, content: 'Error: no' } as AgentTurnState['toolResults'][number]],
      trackerStatusUpdatedThisTurn: true,
    });
    countMeasure.mockResolvedValue({ ok: true, count: 10412 });
    const out = await runGoingIdle(state, ctxFor(), scratch('50 more done.'));
    expect(out.directive).toBe('exit');
    expect(parkJob).toHaveBeenCalledTimes(1);
  });

  it('a SUCCESSFUL pause of the job\'s own task ends the job: no park', async () => {
    const id = await openTask(true);
    const state = ranCalls(freshTurn(), id, [labelCall(50)], ids(50));
    countMeasure.mockResolvedValue({ ok: true, count: 10412 });
    await call('work_update:status', { task_id: id, status: 'paused', notes: 'waiting for the owner' });
    await runGoingIdle(state, ctxFor(), scratch('Paused: waiting for you.'));
    expect(parkJob).not.toHaveBeenCalled();
    expect(events(id, 'continued')).toHaveLength(0);
  });

  it('I3: a job that only ever makes NEW calls that FAIL is stalled after its first no-progress continuation', async () => {
    const id = await openTask(true);
    countMeasure.mockResolvedValue({ ok: true, count: 10412 });
    await runGoingIdle(ranCalls(freshTurn(), id, [labelCall(10)], ids(10)), ctxFor(), scratch());
    parkJob.mockClear();
    theContinuationStarts(id);
    const newButFailing = { id: 'tc-new', name: 'gmail_search', arguments: { query: 'a wording never tried' } } as ToolCall;
    await runGoingIdle(ranCalls(freshTurn(), id, [newButFailing], [], true), ctxFor(), scratch());
    expect(parkJob).not.toHaveBeenCalled();
    expect(events(id, 'stalled')).toEqual([expect.objectContaining({ remaining: 10412 })]);
  });

  it('I3: a park does not move the task for the PM\'s ladder — only real progress does', async () => {
    const id = await openTask(true);
    countMeasure.mockResolvedValue({ ok: true, count: 10412 });
    // Its last real movement an hour ago, so any touch the park made would show.
    db().prepare('UPDATE work SET updated_at = updated_at - 3600000 WHERE id = ?').run(id);
    db().prepare('UPDATE work_events SET created_at = created_at - 3600000 WHERE work_id = ?').run(id);
    const before = movedAt(id);
    // A new, successful read: momentum, so it is parked; but it touched no item, so nothing moved.
    const page = { id: 'tc-page', name: 'gmail_search', arguments: { query: 'in:inbox -label:Done', page_token: 'p9' } } as ToolCall;
    const state = advance(ranCalls(freshTurn(), id, [page]), { turnStartMs: lastTurnStartMs });
    await runGoingIdle(state, ctxFor(), scratch());
    expect(parkJob).toHaveBeenCalledTimes(1);
    expect(movedAt(id)).toBe(before);
  });

  it('I4: an owner turn that only OPENS the measured task and says "on it" has started the job: parked', async () => {
    const state = advance(freshTurn(), { turnStartMs: Date.now() - 5 });
    countMeasure.mockResolvedValue({ ok: true, count: 10551 });
    const id = await openTask(true);
    const out = await runGoingIdle(state, ctxFor({ triggerRow: { rowid: 1, content: 'please sort my inbox' } }), scratch('On it.'));
    expect(out.directive).toBe('exit');
    expect(parkJob).toHaveBeenCalledTimes(1);
    expect(events(id, 'continued')).toEqual([expect.objectContaining({ remaining: 10551, touchedThisTurn: 0, novelCallsThisTurn: 0 })]);
  });
});

// v3.5 Part C2: the end-of-turn text states facts and leaves continuing as the default.
describe('C2: the end-of-turn text never coaches closure', () => {
  const FORBIDDEN = ['Close the task NOW', 'auto-pause', 'Save everyone', 'almost always option', 'Pick exactly one'];

  it('a scheduled turn ending with an unmeasured task in progress: continue first, then the doors; no scheduler "DONE" hint', async () => {
    await openTask(false);
    const out = await runGoingIdle(freshTurn(), ctxFor({ mostRecentInbound: { origin_intent: 'scheduler' } }), scratch());
    const text = menuSteers(out.state)[0].content;
    for (const f of FORBIDDEN) expect(text).not.toContain(f);
    expect(text).not.toContain('scheduler-triggered');
    const cont = text.indexOf('If there is more to do, do it');
    expect(cont).toBeGreaterThan(-1);
    for (const door of ['status="paused"', 'status="blocked"', 'action="hand_in"']) expect(text.indexOf(door)).toBeGreaterThan(cont);
    expect(text).toContain('A task left in progress is not a problem: a one-off task stays open and you are brought back to it; a scheduled run left in progress is recorded as not done, and its schedule goes on.');   // fix round 1 I-4
    expect(text).not.toContain('or you name what is left');   // fix round 1 I-5
  });

  it('a side effect that already ran is listed as a fact, with no close command', async () => {
    const id = await openTask(false);
    const send: ToolCall = { id: 'tc-send', name: 'gmail_send', arguments: { to: 'x@example.invalid', subject: 's', body: 'b' } } as ToolCall;
    const text = menuSteers((await runGoingIdle(ranCalls(freshTurn(), id, [send]), ctxFor(), scratch())).state)[0].content;
    expect(text).toContain('Side-effecting calls that already ran this turn (do not repeat them):\n  - `gmail_send`: [OK]');
    for (const f of FORBIDDEN) expect(text).not.toContain(f);
    expect(text).not.toContain(`task_id="${id}", status="complete"`);
  });
});

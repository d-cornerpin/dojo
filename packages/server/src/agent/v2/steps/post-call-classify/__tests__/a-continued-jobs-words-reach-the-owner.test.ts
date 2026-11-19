// A CONTINUED JOB'S WORDS REACH THE OWNER (owner decision DEC-ENG-5: the engine does not suppress an agent's
// replies). The closing text of a job's own turn reaches him whether the measure still counts items or not: its
// progress, a question or a blocker through the tracker's own doors, and its final report. His request is held on
// the job meanwhile (settlement's job hold), so a progress line does not close it.
//
// Driven through the whole post-call step (`runPostCallClassify`) on the real migration chain, so
// "reached the owner" is read off the owner lane of `messages`, where the dashboard reads it.
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-d1-owner-hears-test', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../../services/imessage-bridge.js', () => ({ stripSystemTags: (s: string) => s }));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'active' }));
const { countMeasure, parkJob } = vi.hoisted(() => ({ countMeasure: vi.fn(), parkJob: vi.fn(() => true) }));
vi.mock('../../../../../work/measure.js', async (orig) => ({ ...(await orig<typeof import('../../../../../work/measure.js')>()), countMeasure }));
vi.mock('../../../../../work/job-continuation.js', async (orig) => ({ ...(await orig<typeof import('../../../../../work/job-continuation.js')>()), parkJob }));

import { runMigrations } from '../../../../../db/migrations.js';
import { trackerHandlers } from '../../../../tools/cat/tracker.js';
import { recordTouched, recordMeasured } from '../../../../../work/ledger-store.js';
import { recordContinued } from '../../../../../work/job-momentum.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runPostCallClassify, type PostCallClassifyContext } from '../index.js';
import { noteRepeatResult } from '../../../identical-call-brake.js';
import { openTurnContext, turnContext } from '../../../../turn-context.js';
/** The repeat rule counting this turn's calls: a successful result new to the window moves the job. */
function chargeEffortCalls(calls: ToolCall[], turn: { succeeded: () => boolean }): void {
  const bag = turnContext(AGENT) ?? openTurnContext(AGENT);
  for (const c of calls) noteRepeatResult(AGENT, bag, c.name, c.arguments, 'result', turn.succeeded());
}

const AGENT = 'agent-continued-job';
const MEASURE = { tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' };
const db = (): Database.Database => mockDb.current!;
type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });

/** The owner-lane assistant rows that SAY something: a tool pass's own row (its `tool_use` blocks and
 *  no text, the dashboard's tool activity) is not a reply. */
const ownerLaneReplies = (): string[] =>
  (db().prepare(`SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' AND lane = 'owner' ORDER BY seq`).all(AGENT) as Array<{ content: string }>)
    .map((r) => r.content).filter((c) => !c.startsWith('[{"type":"tool_use"'));
const workingNotes = (): number =>
  (db().prepare(`SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND role = 'system' AND content LIKE '[working-note]%'`).get(AGENT) as { n: number }).n;

let turnNumber = 40;
let lastStart = 0;
let msg = 0;

/** A job turn for an owner who asked over iMessage, addressed from his request row (`preflight/turn-trigger.ts`). */
const OVER_IMESSAGE = {
  isHumanContinuation: true, chosenConvKey: 'imessage:owner',
  counterparty: { kind: 'user', relation: 'owner', channel: 'imessage', senderId: 'owner-handle', senderIsAgent: false },
} as const;

type ModelResult = PostCallClassifyContext['result'];

/** One job turn: served from the job's task row, the agent works over one or more passes, then
 *  ends with `text`. The state is shaped EXACTLY as the engine builds it (fix round 4): each pass's model
 *  call REPLACES `toolCalls` with that pass's own calls (`call-llm/index.ts`), and execute APPENDS the
 *  pass's results, each carrying its call's arguments, to `toolResults` (`execute/index.ts`). So the closing pass sees only its own calls in
 *  `toolCalls`, never an earlier pass's. `earlier` = calls an earlier pass made, which succeeded; `earlierFailed`, ones that failed. */
async function continuedTurn(taskId: string, text: string, work: { from: number; n: number } | null,
  over: Partial<Record<string, unknown>> = {},
  more: { earlier?: ToolCall[]; earlierFailed?: ToolCall[]; withThisLine?: ToolCall[] } = {}): Promise<AgentTurnState> {
  turnNumber += 1;
  const bag = openTurnContext(AGENT);
  bag.turnNumber = turnNumber;
  bag.servedJob = taskId;
  lastStart = Math.max(Date.now(), lastStart + 1000);
  let state: AgentTurnState = advance(initState({ agentId: AGENT, turnNumber, lastUserMessageContent: null } as unknown as Parameters<typeof initState>[0]),
    { loopCount: 1, modelId: 'test-model', turnStartMs: lastStart });
  const ctxFor = (result: ModelResult): PostCallClassifyContext => {
    msg += 1;
    return {
      agentId: AGENT, turnCtx: { agentId: AGENT, kind: 'user', convKey: null, conversationId: null, root: undefined, turnNumber, goingIdleDetectorRanThisTurn: false, servedJob: taskId } as never,
      turnNumber, db: db(), agent: { id: AGENT, name: 'Worker' } as never,
      counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false } as never,
      counterpartyIsAgentSender: false, chosenConvKey: null, hasUnansweredUser: false, triggerRow: null,
      isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false, mostRecentIsA2A: false,
      mostRecentInbound: undefined, pendingEngineEvent: null, unrepliedAssign: null, a2aReplyContext: null,
      a2aReplyAssignMessageId: null, settledContextWakeTurn: false, waitingConvs: [], inboundChannel: null,
      latestUserSource: null, lastUserMessageContent: null, configuredModelId: 'test-model',
      turnStartedAt: new Date(lastStart).toISOString(), messageId: `msg-${msg}`, result,
      reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer: vi.fn(),
      deliverEngineUserAck: vi.fn(async () => undefined), persistAndBroadcastSystemRow: vi.fn(), startAckRepliedNow: () => false,
      ...over,
    } as unknown as PostCallClassifyContext;
  };
  /** One tool pass, as the engine runs it: the model call replaces `toolCalls`, the post-call step
   *  persists the pass, execute appends its results and the loop moves to the next pass. */
  const toolPass = async (calls: ToolCall[], isError = false): Promise<void> => {
    state = advance(state, { toolCalls: calls });
    state = (await runPostCallClassify(state, ctxFor({ content: '', toolCalls: calls, inputTokens: 10, outputTokens: 5, stopReason: 'tool_use' } as ModelResult))).state;
    state = advance(state, {
      toolResults: state.toolResults.concat(calls.map((c) => ({ toolCallId: c.id, name: c.name, isError, content: isError ? 'Error: no such task' : '[OK]', arguments: c.arguments }))),
      loopCount: state.loopCount + 1,
    });
  };
  if (work) {
    const label = { id: `tc-${work.from}`, name: 'gmail_label', arguments: { message_ids: Array.from({ length: work.n }, (_, i) => `m${work.from + i}`), add: ['Done'] } } as ToolCall;
    await toolPass([label]);
    chargeEffortCalls([label], { succeeded: () => true });
    recordTouched(taskId, 'gmail_label', Array.from({ length: work.n }, (_, i) => `gmail:msg:m${work.from + i}`), lastStart + 1);
  }
  for (const c of more.earlier ?? []) await toolPass([c]);   // each in a pass of its own
  for (const c of more.earlierFailed ?? []) await toolPass([c], true);
  // The closing pass: its model call carries the text (and any call riding with it), and `toolCalls` is
  // replaced by exactly that.
  const closing = { content: text, toolCalls: more.withThisLine ?? [], inputTokens: 10, outputTokens: 5, stopReason: more.withThisLine ? 'tool_use' : 'end_turn' } as ModelResult;
  state = advance(state, { toolCalls: closing.toolCalls });
  const out = await runPostCallClassify(state, ctxFor(closing));
  return out.state;
}

async function aContinuedMeasuredJob(): Promise<string> {
  countMeasure.mockResolvedValue({ ok: true, count: 10551 });
  const opened = await call('work_open:task', { title: 'Sort the inbox', goal: 'every inbox message labelled', measure: MEASURE });
  const id = /task_id=([0-9a-f-]{36})/.exec(opened.content)![1];
  await call('work_update:status', { task_id: id, status: 'in_progress' });
  recordMeasured(id, { ok: true, count: 10551 }, Date.now());
  recordContinued(id, { remaining: 10551, touchedThisTurn: 1, novelCallsThisTurn: 1, turnNumber: 40 });
  return id;
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
});

describe('a continued job\'s words reach the owner', () => {
  it('a 3-continuation job: each stretch\'s progress reaches him, then the result', async () => {
    const id = await aContinuedMeasuredJob();
    for (const [i, left] of [[0, 10051], [500, 9551], [1000, 9051]] as const) {
      countMeasure.mockResolvedValue({ ok: true, count: left });   // the turn-end re-count reads it
      // eslint-disable-next-line no-await-in-loop
      await continuedTurn(id, `Labelled 500 more; ${left} to go.`, { from: i, n: 500 });
    }
    expect(ownerLaneReplies(), 'progress while the job is still going reaches the owner').toHaveLength(3);
    expect(workingNotes(), 'nothing is demoted to a note').toBe(0);
    expect(parkJob).toHaveBeenCalledTimes(3);

    // The last continuation empties the measure. The STORED reading still says 9,051 (the last turn's);
    // the turn's own re-count, taken once before its text is judged, reads 0: its text is the result.
    expect((db().prepare('SELECT measure_remaining AS r FROM work WHERE id = ?').get(id) as { r: number }).r).toBe(9051);
    countMeasure.mockResolvedValue({ ok: true, count: 0 });
    await continuedTurn(id, 'Done: every inbox message is labelled.', { from: 1500, n: 9051 });
    expect(ownerLaneReplies()).toHaveLength(4);
    expect(ownerLaneReplies()[3]).toContain('every inbox message is labelled');
  });

  it.each([
    ['paused', 'waiting for the owner to say whether newsletters count', 'Should newsletters be labelled Done too, or left alone?'],
    ['blocked', 'the mailbox account needs to be reconnected', 'I cannot reach the mailbox: it needs reconnecting.'],
  ])('a continuation that takes the "%s" door to ask or report reaches him, once', async (status, notes, text) => {
    const id = await aContinuedMeasuredJob();
    countMeasure.mockResolvedValue({ ok: true, count: 10051 });
    recordMeasured(id, { ok: true, count: 10051 }, Date.now());
    await call('work_update:status', { task_id: id, status, notes });
    await continuedTurn(id, text, null);
    expect(ownerLaneReplies()).toEqual([expect.stringContaining(text.slice(0, 20))]);
    expect(workingNotes()).toBe(0);
  });

  it('an owner who asked over iMessage: progress and the result go out on his own channel', async () => {
    const id = await aContinuedMeasuredJob();
    const routed: Array<string | null | undefined> = [];
    for (const [i, left] of [[0, 10051], [500, 9551]] as const) {
      countMeasure.mockResolvedValue({ ok: true, count: left });
      // eslint-disable-next-line no-await-in-loop
      routed.push((await continuedTurn(id, `Labelled 500 more; ${left} to go.`, { from: i, n: 500 }, OVER_IMESSAGE)).lastAssistantTextForIM);
    }
    countMeasure.mockResolvedValue({ ok: true, count: 0 });
    routed.push((await continuedTurn(id, 'Done: every inbox message is labelled.', { from: 1000, n: 9551 }, OVER_IMESSAGE)).lastAssistantTextForIM);
    // `lastAssistantTextForIM` is what the end-of-turn router pushes to the restored counterparty's
    // channel (`finalize/channel-push.ts`), here iMessage: each stretch's line, then the result.
    expect(routed[0]).toContain('Labelled 500 more');
    expect(routed[2]).toContain('every inbox message is labelled');
    expect(ownerLaneReplies()).toHaveLength(3);
    expect(workingNotes()).toBe(0);
  });

  // A question or a blocker reaches the owner once, whatever task it concerns; the door call is made in an
  // EARLIER pass than the line, which is how the engine really runs it.
  it.each([
    ['paused', 'waiting for the owner: which folder?', 'Which folder should the receipts go in?'],
    ['blocked', 'the receipts share is not mounted', 'I cannot reach the receipts share: it is not mounted.'],
  ])('a pass that takes the "%s" door on ANOTHER carried task, then a line in the next pass: it reaches him once, and the job continues', async (status, notes, text) => {
    const id = await aContinuedMeasuredJob();
    const opened = await call('work_open:task', { title: 'File the receipts', goal: 'receipts filed' });
    const other = /task_id=([0-9a-f-]{36})/.exec(opened.content)![1];
    await call('work_update:status', { task_id: other, status: 'in_progress' });
    await call('work_update:status', { task_id: other, status, notes });
    const door = { id: `tc-${status}-b`, name: 'work_update', arguments: { action: 'status', task_id: other, status, notes } } as ToolCall;
    countMeasure.mockResolvedValue({ ok: true, count: 10051 });
    await continuedTurn(id, text, { from: 0, n: 500 }, {}, { earlier: [door] });
    expect(ownerLaneReplies()).toEqual([expect.stringContaining(text)]);
    expect(workingNotes()).toBe(0);
    expect(parkJob).toHaveBeenCalledTimes(1);   // the measured job keeps going
  });

  it('a door call an earlier pass made that FAILED: the line still reaches him', async () => {
    const id = await aContinuedMeasuredJob();
    countMeasure.mockResolvedValue({ ok: true, count: 10051 });
    const failed = { id: 'tc-paused-fail', name: 'work_update', arguments: { action: 'status', task_id: 'no-such-task', status: 'paused' } } as ToolCall;
    await continuedTurn(id, 'Labelled 500 more.', { from: 0, n: 500 }, {}, { earlierFailed: [failed] });
    expect(ownerLaneReplies()).toEqual([expect.stringContaining('Labelled 500 more.')]);
    expect(workingNotes()).toBe(0);
  });

  it('a question that rides WITH the job task\'s own pause call is judged after it, and reaches him (over iMessage)', async () => {
    const id = await aContinuedMeasuredJob();
    countMeasure.mockResolvedValue({ ok: true, count: 10051 });
    recordMeasured(id, { ok: true, count: 10051 }, Date.now());
    const pause = { id: 'tc-pause-a', name: 'work_update', arguments: { action: 'status', task_id: id, status: 'paused', notes: 'waiting for the owner' } } as ToolCall;
    const out = await continuedTurn(id, 'Should newsletters be labelled Done too, or left alone?', null, OVER_IMESSAGE, { withThisLine: [pause] });
    expect(out.lastAssistantTextForIM).toContain('Should newsletters be labelled Done too');
    expect(workingNotes()).toBe(0);
  });

  it('owner-answer: his answer to a question he is waiting on is never a note, even on the job\'s own run', async () => {
    const id = await aContinuedMeasuredJob();
    countMeasure.mockResolvedValue({ ok: true, count: 10051 });
    recordMeasured(id, { ok: true, count: 10051 }, Date.now());
    await continuedTurn(id, 'About 10,051 are left; I am still going.', { from: 0, n: 500 },
      { hasUnansweredUser: true, triggerRow: { rowid: 1, content: 'how many are left?' } });
    expect(ownerLaneReplies()).toEqual([expect.stringContaining('10,051 are left')]);
    expect(workingNotes()).toBe(0);
  });

  it('a plain progress line on the same run reaches him', async () => {
    const id = await aContinuedMeasuredJob();
    countMeasure.mockResolvedValue({ ok: true, count: 10051 });
    await continuedTurn(id, 'Labelled 500 more.', { from: 0, n: 500 });
    expect(ownerLaneReplies()).toEqual([expect.stringContaining('Labelled 500 more.')]);
    expect(workingNotes()).toBe(0);
  });
});

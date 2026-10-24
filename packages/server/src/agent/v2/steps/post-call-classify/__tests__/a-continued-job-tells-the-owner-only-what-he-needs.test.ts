// v3.5 D1, PRE-REVIEW RULING 2 — A CONTINUED JOB TELLS THE OWNER ONLY WHAT HE NEEDS.
//
// While a measured job is still going, the closing text of a turn the engine continued is
// progress, and progress stays on the record: it is kept as a working note (the platform's
// demote-don't-discard row, no ping), never an owner-facing message. The owner hears from a
// continued job when (a) it is finished (the measure reads 0), (b) it stalls (the `stalled` path
// to the PM), or (c) the agent asks him something or reports a blocker through the tracker's own
// doors (status "paused" waiting on him, or "blocked"); those turns speak under the platform's
// existing rules for an engine turn. The owner's own turn's reply is untouched (its run is not the
// park's continuation).
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
import { chargeEffortCalls } from '../../../../../tracker/effort-ledger.js';
import { armTimerWake, beginJobRun, carryJobWork, endJobCarry, endJobRun } from '../../../../../work/task-freshness.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runPostCallClassify, type PostCallClassifyContext } from '../index.js';

const AGENT = 'agent-continued-job';
const MEASURE = { tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' };
const db = (): Database.Database => mockDb.current!;
type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });

const ownerLaneReplies = (): string[] =>
  (db().prepare(`SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' AND lane = 'owner' ORDER BY seq`).all(AGENT) as Array<{ content: string }>)
    .map((r) => r.content);
const workingNotes = (): number =>
  (db().prepare(`SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND role = 'system' AND content LIKE '[working-note]%'`).get(AGENT) as { n: number }).n;

let turnNumber = 40;
let lastStart = 0;
let msg = 0;

/** One continued turn: the park's own wake starts the run, the agent works, then ends with `text`. */
async function continuedTurn(taskId: string, text: string, work: { from: number; n: number } | null): Promise<void> {
  turnNumber += 1;
  lastStart = Math.max(Date.now(), lastStart + 1000);
  armTimerWake(AGENT);
  beginJobRun(AGENT, 'timer');
  let state: AgentTurnState = advance(initState({ agentId: AGENT, maxToolLoops: 75, turnNumber, lastUserMessageContent: null } as unknown as Parameters<typeof initState>[0]),
    { loopCount: 1, modelId: 'test-model', turnStartMs: lastStart });
  if (work) {
    const label = { id: `tc-${work.from}`, name: 'gmail_label', arguments: { message_ids: Array.from({ length: work.n }, (_, i) => `m${work.from + i}`), add: ['Done'] } } as ToolCall;
    chargeEffortCalls(taskId, [label], lastStart);
    recordTouched(taskId, 'gmail_label', Array.from({ length: work.n }, (_, i) => `gmail:msg:m${work.from + i}`), lastStart + 1);
    state = advance(state, { toolCalls: [label], toolResults: [{ toolCallId: label.id, name: 'gmail_label', isError: false, content: '[OK]' } as AgentTurnState['toolResults'][number]] });
  }
  msg += 1;
  const ctx = {
    agentId: AGENT, turnCtx: { agentId: AGENT, kind: 'user', convKey: null, conversationId: null, root: undefined, turnNumber, goingIdleDetectorRanThisTurn: false } as never,
    turnNumber, db: db(), agent: { id: AGENT, name: 'Worker' } as never,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false } as never,
    counterpartyIsAgentSender: false, chosenConvKey: null, hasUnansweredUser: false, triggerRow: null,
    isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false, mostRecentIsA2A: false,
    mostRecentInbound: undefined, pendingEngineEvent: null, unrepliedAssign: null, a2aReplyContext: null,
    a2aReplyAssignMessageId: null, settledContextWakeTurn: false, waitingConvs: [], inboundChannel: null,
    latestUserSource: null, lastUserMessageContent: null, configuredModelId: 'test-model',
    turnStartedAt: new Date(lastStart).toISOString(), messageId: `msg-${msg}`,
    result: { content: text, toolCalls: [], inputTokens: 10, outputTokens: 5, stopReason: 'end_turn' },
    maxToolLoops: 75, reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer: vi.fn(),
    deliverEngineUserAck: vi.fn(async () => undefined), persistAndBroadcastSystemRow: vi.fn(), startAckRepliedNow: () => false,
  } as unknown as PostCallClassifyContext;
  await runPostCallClassify(state, ctx);
  endJobRun(AGENT);
}

async function aContinuedMeasuredJob(): Promise<string> {
  countMeasure.mockResolvedValue({ ok: true, count: 10551 });
  const opened = await call('work_open:task', { title: 'Sort the inbox', goal: 'every inbox message labelled', measure: MEASURE });
  const id = /task_id=([0-9a-f-]{36})/.exec(opened.content)![1];
  await call('work_update:status', { task_id: id, status: 'in_progress' });
  recordMeasured(id, { ok: true, count: 10551 }, Date.now());
  recordContinued(id, { remaining: 10551, touchedThisTurn: 1, novelCallsThisTurn: 1, turnNumber: 40 });
  carryJobWork(AGENT, [id]);
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
  endJobRun(AGENT);
  endJobCarry(AGENT);
});

describe('pre-review ruling 2: a continued job tells the owner only what he needs', () => {
  it('a 3-continuation job sends the owner nothing until it finishes, then one result', async () => {
    const id = await aContinuedMeasuredJob();
    for (const [i, left] of [[0, 10051], [500, 9551], [1000, 9051]] as const) {
      countMeasure.mockResolvedValue({ ok: true, count: left });
      recordMeasured(id, { ok: true, count: left }, Date.now());
      // eslint-disable-next-line no-await-in-loop
      await continuedTurn(id, `Labelled 500 more; ${left} to go.`, { from: i, n: 500 });
    }
    expect(ownerLaneReplies(), 'progress while the job is still going reaches the owner as nothing').toEqual([]);
    expect(workingNotes(), 'and it is kept on the record, not discarded').toBe(3);
    expect(parkJob).toHaveBeenCalledTimes(3);

    // The last continuation empties the measure: that turn's closing text is the result.
    countMeasure.mockResolvedValue({ ok: true, count: 0 });
    recordMeasured(id, { ok: true, count: 0 }, Date.now());
    await continuedTurn(id, 'Done: every inbox message is labelled.', { from: 1500, n: 9051 });
    expect(ownerLaneReplies()).toHaveLength(1);
    expect(ownerLaneReplies()[0]).toContain('every inbox message is labelled');
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
});

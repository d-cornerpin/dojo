// v3.5 D1, FIX ROUND 4 (re-review 2, (c) and (a)) — THE PM'S CHECK-IN AT THE PARK REACHES THE CONTINUED TURN.
//
// A continued measured job that touches no item is checked in on at its park, the boundary between its
// turns (fix round 3). In production the park runs INSIDE the live turn: the runtime holds the agent in
// `activeRuns` until the turn's `finally`, so the check-in, sent as an ordinary re-drive, met the PM's
// busy deferral and was never sent. The check-in to the assignee now travels the way the PM's circling
// verdict already reaches a continuing agent (`work/engine-checkpoint-note.ts`): a PM rider notice, an
// events-lane row that cannot drive a turn of its own and is read at the start of the agent's NEXT turn,
// the continuation the park queued. So the continued turn sees the check-in (continuations since the
// last item, items left) before it acts, and nothing is injected into the running turn.
//
// Driven end to end: the real post-call step parks the job (`runPostCallClassify` → the D1 rule → the
// PM's ladder) with the agent's run registered exactly as the runtime registers it, and "what the next
// turn sees first" is the real assembler's output on the migrated DB.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolCall } from '@dojo/shared';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-d1-park-checkin');
vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-d1-park-checkin');
  return { homeDir: (): string => dir, dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs), isTestRun: (): boolean => true };
});
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-d1-park-checkin', 'dojo.db'),
  };
});
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
// Any wake of the agent's own (a re-drive) would land here; a rider never calls it.
const { wakes } = vi.hoisted(() => ({ wakes: [] as string[] }));
vi.mock('../../runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async (id: string) => { wakes.push(id); }),
    getAgentUptime: () => 0,
  }),
  stopAgent: vi.fn(),
}));
vi.mock('../../a2a-transport.js', () => ({
  deliverA2AMessage: vi.fn(async () => ({ delivered: true, threadId: 't' })),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));
vi.mock('../../model.js', async (orig) => ({ ...(await orig<typeof import('../../model.js')>()), callModel: vi.fn(async () => ({ content: '' })) }));
vi.mock('../../../services/imessage-bridge.js', () => ({ stripSystemTags: (s: string) => s }));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'active' }));
const { countMeasure, parkJob } = vi.hoisted(() => ({ countMeasure: vi.fn(), parkJob: vi.fn(() => true) }));
vi.mock('../../../work/measure.js', async (orig) => ({ ...(await orig<typeof import('../../../work/measure.js')>()), countMeasure }));
vi.mock('../../../work/job-continuation.js', async (orig) => ({ ...(await orig<typeof import('../../../work/job-continuation.js')>()), parkJob }));

import { runMigrations } from '../../../db/migrations.js';

// Each clause boots the real module graph and runs the full migration chain; an import cost, not a
// timing assertion. Nothing here measures time.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { activeRuns } from '../../shared-state.js';
import { assembleContext } from '../../../memory/assembler.js';
import { runPokeCheck } from '../../../tracker/pm-agent.js';
import { recordContinued } from '../../../work/job-momentum.js';
import { chargeEffortCalls } from '../../../tracker/effort-ledger.js';
import { armTimerWake, beginJobRun, carryJobWork, endJobCarry, endJobRun } from '../../../work/task-freshness.js';
import { seedTrackerTask } from '../../../work/__tests__/work-fixture.js';
import { advance, initState, type AgentTurnState } from '../state.js';
import { runPostCallClassify, type PostCallClassifyContext } from '../steps/post-call-classify/index.js';

const AGENT = 'helper';
const MODEL = 'm-a';
let JOB = 'task-sweep';
const MIN = 60_000;
const FACT = /Continued 4 times since it last touched an item; 12 left on its measure\./;
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  endJobCarry(AGENT);
  endJobRun(AGENT);
  activeRuns.delete(AGENT);
  wakes.length = 0;
  parkJob.mockClear();
  countMeasure.mockReset();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  mockDb.current = new Database(':memory:');
  db().pragma('foreign_keys = ON');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, context_window, max_output_tokens, capabilities) VALUES (?, 'prov-a', 'Model A', 'model-a', 200000, 4096, '["tools"]')`).run(MODEL);
  db().prepare(`INSERT INTO agents (id, name, status, model_id, classification, config, session_started_at) VALUES
    ('helper', 'Helper', 'working', 'm-a', 'apprentice', '{}', '1970-01-01'), ('pm', 'PM', 'idle', 'm-a', 'sensei', '{}', '1970-01-01'),
    ('primary', 'Main', 'idle', 'm-a', 'sensei', '{}', '1970-01-01')`).run();
});

afterEach(() => {
  endJobRun(AGENT);
  activeRuns.delete(AGENT);
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

/** A measured job opened 6 minutes ago, continued 3 times without touching an item, with its agent's
 *  continuation running: the park's own wake started the run, and the runtime holds it in `activeRuns`
 *  until the turn's `finally` (`agent/runtime.ts`). */
function aRunningContinuationOfAJobTouchingNothing(now: number, title = 'the mailbox sweep'): void {
  seedTrackerTask(db(), { id: JOB, agentId: AGENT, status: 'in_progress', title,
    opened_at: now - 6 * MIN, updated_at: now - 6 * MIN, origin_conv_key: 'c-1', priority: 'normal' } as never);
  db().prepare(`UPDATE work SET measure_json = ?, measure_initial = 50, measure_remaining = 12, measure_at = ? WHERE id = ?`)
    .run(JSON.stringify({ tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' }), now - 6 * MIN, JOB);
  // The owner's ask that started the job, so the tail is a real conversation.
  db().prepare(`INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier, turn_number, provenance, authorized, created_at)
    VALUES ('ask-1', ?, 'user', 'owner', 'owner', 'please sweep the mailbox', 'user-text', 'user-visible', 1, 'live', 1, ?)`).run(AGENT, now - 6 * MIN);
  for (let i = 0; i < 3; i++) recordContinued(JOB, { remaining: 12, touchedThisTurn: 0, novelCallsThisTurn: 1, turnNumber: 10 + i });
  carryJobWork(AGENT, [JOB]);
  armTimerWake(AGENT);
  beginJobRun(AGENT, 'timer');
  activeRuns.add(AGENT);
}

/** The closing pass of the continued turn: it made one NEW read that succeeded (momentum), touched no
 *  item, and ends with a progress line. The real post-call step decides the park. */
async function theTurnEnds(now: number): Promise<string | undefined> {
  const read = { id: 'tc-read', name: 'gmail_read', arguments: { message_id: `m-${now}` } } as ToolCall;
  chargeEffortCalls(JOB, [read], { startMs: now - 1000, succeeded: () => true });
  countMeasure.mockResolvedValue({ ok: true, count: 12 });
  const state: AgentTurnState = advance(initState({ agentId: AGENT, maxToolLoops: 75, turnNumber: 14, lastUserMessageContent: null } as unknown as Parameters<typeof initState>[0]),
    { loopCount: 2, modelId: MODEL, turnStartMs: now - 1000, toolCalls: [],
      toolResults: [{ toolCallId: read.id, name: read.name, isError: false, content: '[OK]' } as AgentTurnState['toolResults'][number]] });
  const ctx = {
    agentId: AGENT, turnCtx: { agentId: AGENT, kind: 'user', convKey: null, conversationId: null, root: undefined, turnNumber: 14, goingIdleDetectorRanThisTurn: false } as never,
    turnNumber: 14, db: db(), agent: { id: AGENT, name: 'Helper' } as never,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false } as never,
    counterpartyIsAgentSender: false, chosenConvKey: null, hasUnansweredUser: false, triggerRow: null,
    isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false, mostRecentIsA2A: false,
    mostRecentInbound: undefined, pendingEngineEvent: null, unrepliedAssign: null, a2aReplyContext: null,
    a2aReplyAssignMessageId: null, settledContextWakeTurn: false, waitingConvs: [], inboundChannel: null,
    latestUserSource: null, lastUserMessageContent: null, configuredModelId: MODEL,
    turnStartedAt: new Date(now - 1000).toISOString(), messageId: 'msg-close',
    result: { content: 'Read one more message; nothing to label yet.', toolCalls: [], inputTokens: 10, outputTokens: 5, stopReason: 'end_turn' },
    maxToolLoops: 75, reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer: vi.fn(),
    deliverEngineUserAck: vi.fn(async () => undefined), persistAndBroadcastSystemRow: vi.fn(), startAckRepliedNow: () => false,
    stashContinuationIfHuman: vi.fn(),
  } as unknown as PostCallClassifyContext;
  const out = await runPostCallClassify(state, ctx);
  return out.directive;
}

/** Everything the model receives at the start of the agent's next turn (the tail and the events lane). */
async function whatTheNextTurnSeesFirst(): Promise<string> {
  const assembled = await assembleContext(AGENT, MODEL);
  return [
    ...assembled.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
    ...(assembled.eventsLane ? [assembled.eventsLane] : []),
  ].join('\n---\n');
}

const rungs = (): number[] => (db().prepare(
  "SELECT json_extract(payload, '$.rung') AS r FROM work_events WHERE work_id = ? AND kind = 'poke' ORDER BY id",
).all(JOB) as Array<{ r: number }>).map((x) => x.r);
const checkInRows = (): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND lane = 'events' AND content LIKE '%Continued % since it last touched an item%'",
).get(AGENT) as { n: number }).n;

describe('fix round 4: the PM\'s check-in at the park reaches the continued turn before it acts', () => {
  it('park → the next continued turn\'s first assembly carries the check-in (continuations since the last item, items left)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    aRunningContinuationOfAJobTouchingNothing(now);
    expect(await whatTheNextTurnSeesFirst(), 'POSITIVE CONTROL: nothing is there before the park').not.toMatch(FACT);

    const directive = await theTurnEnds(now);
    expect(directive, 'the park is the running turn\'s last act: it exits, no later pass of it reads anything').toBe('exit');
    expect(parkJob).toHaveBeenCalledTimes(1);
    expect(activeRuns.has(AGENT), 'the park ran while the agent\'s run was still active, as in production').toBe(true);
    expect(rungs(), 'the check-in was sent at its normal rung and latched').toEqual([1]);
    expect(wakes, 'it drives no turn of its own: the continuation the park queued reads it').toEqual([]);

    const seen = await whatTheNextTurnSeesFirst();
    // The events lane renders each notice as one bullet, a 400-char gist; the fact must be inside it.
    const line = seen.split('\n').find((l) => l.startsWith('• NEW') && FACT.test(l));
    expect(line, 'the check-in is in what the continued turn receives first, fact and all').toBeTruthy();
    expect(line).toMatch(/\[TO YOU, from [^\]]+: agent_notice\]/);
    expect(line).toContain('the mailbox sweep');
  });

  // Re-review 3, Minor 1: the title is printed twice ahead of the task info, so a long one pushed the
  // fact past the events lane's 400-character gist. The rider at the park leads with the fact.
  it('a 130-character title and a real 36-character id: the fact is still inside the gist the continued turn reads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    JOB = '0f8e6c2a-4b1d-4e7a-9c3f-5a2b8d1e6f40';
    const title = 'Sort every message in the shared inbox into the right project folder and label it Done once it is filed, oldest first, skip drafts';
    expect(title).toHaveLength(130);
    try {
      aRunningContinuationOfAJobTouchingNothing(now, title);
      await theTurnEnds(now);
      expect(rungs()).toEqual([1]);
      const bullet = (await whatTheNextTurnSeesFirst()).split('\n').find((l) => l.startsWith('• NEW') && l.includes('agent_notice'));
      expect(bullet, 'the rider is in what the continued turn receives first').toBeTruthy();
      expect(bullet).toMatch(FACT);
      const row = db().prepare("SELECT content FROM messages WHERE lane = 'events' AND origin_intent = 'agent_notice'").get() as { content: string };
      expect(row.content.match(/Continued \d+ times/g), 'the fact leads, and is said once').toHaveLength(1);
      expect(row.content).toContain(title);
    } finally { JOB = 'task-sweep'; }
  });

  it('with the run active, the sweep injects nothing mid-turn: no check-in row, no wake, no latch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    aRunningContinuationOfAJobTouchingNothing(now);
    await runPokeCheck();
    await new Promise((r) => setTimeout(r, 15));
    expect(rungs()).toEqual([]);
    expect(checkInRows()).toBe(0);
    expect(wakes).toEqual([]);
    expect(await whatTheNextTurnSeesFirst()).not.toMatch(FACT);
  });

  it('delivered once: a second park in the same rung writes no second check-in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    aRunningContinuationOfAJobTouchingNothing(now);
    await theTurnEnds(now);
    await theTurnEnds(now + 1000);
    expect(rungs()).toEqual([1]);
    expect(checkInRows()).toBe(1);
  });
});

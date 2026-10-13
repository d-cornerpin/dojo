// ════════════════════════════════════════════════════════════════════════════════════════
// t137 ROUND 2 (orchestrator ruling R-V333-3) — THE CIRCLING VERDICT REACHES THE AGENT, NOT
// THE OWNER, AT EITHER CHECKPOINT.
//
// The PM's circling verdict ("N+ calls without advancing on <task>: <reason>") used to ride the
// checkpoints' own park rows. Those rows were role='system', which the tail renderer never emits:
// the AGENT never read the verdict, the OWNER read it in the chat, and the checkpoint marked it
// delivered anyway — so the poke sweep's own delivery was cancelled too. Both park rows are gone
// (OR-LONG-JOBS: the checkpoints are invisible housekeeping). The verdict now travels as a
// PM-attributed RIDER notice (`postAgentNotice`, intent `agent_notice`, a declared
// `ENGINE_RIDER_INTENTS` member): an events-lane row, model-visible on the agent's NEXT turn
// (the continuation), broadcast on the inter-agent lane, never on the owner's chat, and unable
// to drive a turn of its own. It is marked delivered only once that row is written.
//
// Driven here through the REAL 15-minute checkpoint (`runTurnTimeBudget`) and the REAL
// assembler on a migrated DB; the 75-call checkpoint lives inside the driver loop and is driven
// through `runV2Turn` in `t137-long-jobs-are-left-alone.test.ts`, which asserts the same row.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { WsEvent } from '@dojo/shared';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));

// Every broadcast the platform makes, wherever it is made from (the checkpoint's own ctx and
// the notice door both go through `gateway/ws.js`'s export or the ctx below).
const broadcastSpy = vi.fn();
vi.mock('../../../gateway/ws.js', () => ({ broadcast: (e: unknown) => broadcastSpy(e) }));

// The checkpoint's compaction ask is not this file's subject (T84's file drives it for real).
vi.mock('../../../memory/compaction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../memory/compaction.js')>()),
  checkAndCompact: vi.fn(async () => ({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 })),
}));

import { runMigrations } from '../../../db/migrations.js';
import { assembleContext } from '../../../memory/assembler.js';
import { writeTaskLog } from '../../../tracker/task-log.js';
import { pendingCirclingVerdict } from '../../../tracker/effort-governor.js';
import { pendingWakeups, turnContinuationCounts, stoppedAgents } from '../../shared-state.js';
import { initState, advance, type AgentTurnState } from '../state.js';
import { PRE_CALL_GATES_PHASE, type PreCallGatesContext } from '../steps/pre-call-gates/index.js';
import { runTurnTimeBudget } from '../steps/pre-call-gates/turn-budget.js';
import type { TurnCounterparty } from '../../turn-context.js';

const AGENT = 'circling-agent';
const MODEL = 'circling-model';
const TASK = 'w-circling-task';
const TITLE = 'summarise the research folder';
const REASON = 'the same three files were re-read with nothing new landing';

function seed(): void {
  const db = mockDb.current!;
  db.prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')").run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'cm', 'CM', 200000, 4096, '["tools"]')`,
  ).run(MODEL);
  db.prepare(
    "INSERT INTO agents (id, name, status, model_id, config, session_started_at) VALUES (?, 'Worker', 'working', ?, '{}', '1970-01-01')",
  ).run(AGENT, MODEL);
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, created_at)
     VALUES ('cv-u1', ?, 'user', 'owner', 'owner', 'please summarise the research folder', 'user-text', 'user-visible', 1, 'live', 1, 1785000000000)`,
  ).run(AGENT);
  const now = Date.now();
  db.prepare(
    `INSERT INTO work (id, agent_id, kind, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, ?, 'task', 'owner', 'tracker', ?, 'claimed', 'action', 1, 0, ?, ?, ?)`,
  ).run(TASK, AGENT, TASK, TITLE, now, now);
  // The PM's circling verdict, written the way `runEffortReview`'s circling branch writes it.
  writeTaskLog({ taskId: TASK, fromEntity: 'pm', entryKind: 'effort_review_intervene', reason: REASON });
}

function stateOverBudget(): AgentTurnState {
  const fresh = initState({
    agentId: AGENT, contextWindow: 200000, isAutoRouted: false, configuredModelId: MODEL,
    turnNumber: 2, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: 'dashboard',
    inboundContext: null, pendingTechniqueAck: null,
  } as Parameters<typeof initState>[0]);
  return advance(fresh, { phase: PRE_CALL_GATES_PHASE, loopCount: 1, turnStartMs: Date.now() - 16 * 60 * 1000 });
}

function ctx(): PreCallGatesContext & { events: WsEvent[] } {
  const events: WsEvent[] = [];
  const c = {
    agentId: AGENT, turnNumber: 2, contextWindow: 200000, contextModelId: MODEL, configuredModelId: MODEL,
    isAutoRouted: false, counterparty: { kind: 'user', displayName: 'Owner', id: 'owner' } as TurnCounterparty,
    assemblerOverheadTokens: 0, engineBlockEscapeHatch: '[escape hatch]',
    broadcast: (e: WsEvent) => { events.push(e); broadcastSpy(e); },
    stashContinuationIfHuman: vi.fn(), detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
  } as unknown as PreCallGatesContext;
  return Object.assign(c, { events });
}

/** Everything the model receives on the agent's next turn (tail + the events lane). */
async function whatTheModelReceives(): Promise<string> {
  const assembled = await assembleContext(AGENT, MODEL);
  return [
    ...assembled.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
    ...(assembled.eventsLane ? [assembled.eventsLane] : []),
  ].join('\n---\n');
}

const chatBroadcasts = (): unknown[] => broadcastSpy.mock.calls
  .map((c) => c[0] as { type?: string }).filter((e) => e.type === 'chat:message');

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  seed();
  broadcastSpy.mockClear();
  pendingWakeups.clear();
  turnContinuationCounts.clear();
  stoppedAgents.clear();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the 15-minute checkpoint hands the circling verdict to the AGENT', () => {
  it('POSITIVE CONTROL: before the checkpoint the verdict is pending and the model has never seen it', async () => {
    expect(pendingCirclingVerdict(TASK)).not.toBeNull();
    expect(await whatTheModelReceives()).not.toContain(REASON.slice(0, 40));
  });

  it('after a park: the verdict is in what the model receives on its next turn, labelled as the PM\'s', async () => {
    const out = await runTurnTimeBudget(stateOverBudget(), ctx());
    expect(out).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(pendingWakeups.has(AGENT)).toBe(true);

    const seen = await whatTheModelReceives();
    // The events lane renders a gist (its leading `[SOURCE: …]` tag stripped), so the PM's
    // attribution the model reads is the verdict's own label, on the same line as the task and
    // the reason — measured (t141's addressee label): `• NEW [<time> <zone>][TO YOU, from the
    // platform: agent_notice] [PM EFFORT REVIEW — 150+ calls without advancing on "<title>" (<id>)] <reason>`.
    const line = seen.split('\n').find((l) => l.includes('[PM EFFORT REVIEW'));
    expect(line, 'the verdict must be in what the model receives').toBeTruthy();
    expect(line).toMatch(/\[TO YOU, from [^\]]+: agent_notice\]/);
    expect(line).toContain(TITLE);
    expect(line).toContain(TASK);
    expect(line).toContain(REASON);
  });

  it('and NOT to the owner: no chat row, no chat broadcast; the row is on the events lane only', async () => {
    await runTurnTimeBudget(stateOverBudget(), ctx());
    expect(chatBroadcasts()).toEqual([]);
    const rows = mockDb.current!.prepare(
      `SELECT role, lane, origin_intent, content FROM messages WHERE agent_id = ? AND content LIKE '%PM EFFORT REVIEW%'`,
    ).all(AGENT) as Array<{ role: string; lane: string; origin_intent: string; content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'user', lane: 'events', origin_intent: 'agent_notice' });
    expect(mockDb.current!.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND lane = 'owner' AND role = 'system'`,
    ).get(AGENT)).toEqual({ n: 0 });
  });

  it('delivered exactly once: the sweep\'s own read sees it delivered, and a second park writes nothing new', async () => {
    await runTurnTimeBudget(stateOverBudget(), ctx());
    expect(pendingCirclingVerdict(TASK)).toBeNull();
    await runTurnTimeBudget(stateOverBudget(), ctx());
    expect((mockDb.current!.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND content LIKE '%PM EFFORT REVIEW%'`,
    ).get(AGENT) as { n: number }).n).toBe(1);
  });

  // ROUND 3 (review M4): `postAgentNotice` inserts the row and THEN broadcasts, inside one try. A
  // broadcast that throws after the insert makes it answer null although the row exists. The
  // delivery is the ROW (that is what the next turn reads), so the door must count it as delivered
  // and latch — otherwise the next checkpoint (or the sweep) hands the same verdict over again.
  it('IDEMPOTENT: a broadcast that fails after the row was written still counts as delivered — one row, latched, never twice', async () => {
    broadcastSpy.mockImplementationOnce((e: unknown) => {
      if ((e as { type?: string }).type === 'interagent:message') throw new Error('socket gone');
    });
    await runTurnTimeBudget(stateOverBudget(), ctx());
    expect(pendingCirclingVerdict(TASK), 'the row exists, so the verdict is delivered').toBeNull();
    await runTurnTimeBudget(stateOverBudget(), ctx());
    expect((mockDb.current!.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND content LIKE '%PM EFFORT REVIEW%'`,
    ).get(AGENT) as { n: number }).n).toBe(1);
  });

  it('a stop during the checkpoint delivers nothing and leaves the verdict pending for the sweep', async () => {
    const { checkAndCompact } = await import('../../../memory/compaction.js');
    vi.mocked(checkAndCompact).mockImplementationOnce(async () => {
      stoppedAgents.add(AGENT);
      return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
    });
    await runTurnTimeBudget(stateOverBudget(), ctx());
    expect(pendingCirclingVerdict(TASK)).not.toBeNull();
    expect(await whatTheModelReceives()).not.toContain(REASON.slice(0, 40));
  });
});

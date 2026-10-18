// ════════════════════════════════════════════════════════════════════════════════════════
// t207 (D8, ctx 12) — A RUNNING TURN SERVES ITS OWN TRIGGER, WHATEVER KIND OF TURN IT IS.
//
// "Served" was built per trigger type: the owner's ask (t145) and a manager's assignment (t159 I). Every
// other trigger relied on staying in view. A terminal-wake A2A turn (a peer's deliverable woke the agent),
// an engine turn and an occurrence turn serve nothing, so once a fold or the trim takes the trigger row out
// of view the tail holds only the turn's own tool rows, the integrity pass strips them, and the last-resort
// guard pulls the raw row out unlabelled.
//
// The rule is now one sentence: the turn's claim records the row that woke it on the turn's root
// (`root.triggerMessageId`), and until the turn ends that row is re-emitted, labelled, whenever it is not
// otherwise in view.
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

const loggerErrorSpy = vi.fn();
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: (...args: unknown[]) => loggerErrorSpy(...args),
  }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { openTurnContext, endTurnContext, type TurnRoot } from '../../agent/turn-context.js';
import { servedRowsOutOfView } from '../served-ask.js';
import { assembleContext } from '../assembler.js';
import { runTurnClassification } from '../../agent/v2/steps/preflight/turn-classification.js';
import type { PreflightContext, PreflightScratch } from '../../agent/v2/steps/preflight/index.js';
import type { TurnContext } from '../../agent/turn-context.js';

const AGENT = 'worker';
const PEER = 'helper';
const THREAD = 'f00dcafe-1111-2222-3333-444455556666';
const DELIVERABLE = 'Here is the audited ledger, line by line, with every wrong line marked.';
const ENGINE_NOTICE = '[Engine event: completion report owed] Send the owner ONE short completion note about the audit.';
const OCCURRENCE = '[Scheduled: nightly ledger check] Run the nightly ledger check now and report only what changed.';
const LABEL = '(the message this work is answering)';

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

beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 40000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Worker', 'm', 'idle', '{}', 'sensei')").run(AGENT);
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Helper', 'm', 'idle', '{}', 'sensei')").run(PEER);
  loggerErrorSpy.mockClear();
});
afterEach(() => { endTurnContext(AGENT); mockDb.current?.close(); mockDb.current = null; });

/** `pairs` rounds of the worker's own tool work after the trigger, padded so a 40K window cannot hold them all. */
function ownWork(pairs: number): void {
  for (let i = 0; i < pairs; i++) {
    insertMessage({
      id: `call-${i}`, agentId: AGENT, role: 'assistant', turnNumber: 2,
      content: JSON.stringify([{ type: 'tool_use', id: `tc-${i}`, name: 'file_read', input: { path: `/ledger/page-${i}.txt` } }]),
    });
    insertMessage({
      id: `res-${i}`, agentId: AGENT, role: 'tool', turnNumber: 2,
      content: JSON.stringify([{ type: 'tool_result', tool_use_id: `tc-${i}`, content: `page ${i} ${'pad '.repeat(400)}` }]),
    });
  }
}

const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;
const wire = async (): Promise<{ text: string; messages: Array<{ role: string; content: unknown }> }> => {
  const ctx = await assembleContext(AGENT, 'm');
  return { text: JSON.stringify(ctx.messages), messages: ctx.messages as Array<{ role: string; content: unknown }> };
};
const withTrigger = (root: Omit<TurnRoot, 'triggerMessageId'>, triggerMessageId: string): TurnRoot =>
  ({ ...root, triggerMessageId } as TurnRoot);

describe('t207 D8 — the trigger of every kind of turn stays in view', () => {
  it('a terminal-wake A2A turn: the peer\'s deliverable, behind the boundary, is re-emitted once and labelled', async () => {
    insertMessage({
      id: 'wake-row', agentId: AGENT, role: 'user', lane: 'a2a', content: `[A2A:DELIVERABLE thread:f00dcafe from:Helper] ${DELIVERABLE}`,
      sourceAgentId: PEER, a2aThreadId: THREAD, a2aIntent: 'DELIVERABLE',
    });
    ownWork(40);
    const bag = openTurnContext(AGENT);
    bag.kind = 'a2a';
    bag.root = withTrigger({ kind: 'a2a', id: THREAD, sourceMessageId: null }, 'wake-row');
    const { text, messages } = await wire();
    expect(occurrences(text, DELIVERABLE), 'the deliverable, once').toBe(1);
    expect(occurrences(text, LABEL), 'labelled').toBe(1);
    expect(JSON.stringify(messages[0])).toContain(DELIVERABLE);
    expect(messages[0].role).toBe('user');
    expect(text).toContain('page 39');
  });

  it('an engine turn: the engine notice, behind the boundary, is re-emitted once and labelled', async () => {
    insertMessage({ id: 'engine-row', agentId: AGENT, role: 'user', lane: 'events', content: ENGINE_NOTICE, originIntent: 'completion_report' });
    ownWork(40);
    const bag = openTurnContext(AGENT);
    bag.root = withTrigger({ kind: 'engine', id: 'engine-row', sourceMessageId: null }, 'engine-row');
    const { text, messages } = await wire();
    expect(occurrences(text, ENGINE_NOTICE), 'the notice, once').toBe(1);
    expect(occurrences(text, LABEL), 'labelled').toBe(1);
    expect(JSON.stringify(messages[0])).toContain(ENGINE_NOTICE);
  });

  it('an occurrence turn: the scheduled directive, behind the boundary, is re-emitted once and labelled', async () => {
    insertMessage({ id: 'occ-row', agentId: AGENT, role: 'user', lane: 'events', content: OCCURRENCE, originIntent: 'scheduled_task' });
    ownWork(40);
    const bag = openTurnContext(AGENT);
    bag.root = withTrigger({ kind: 'occurrence', id: 'run-1', sourceMessageId: null }, 'occ-row');
    const { text } = await wire();
    expect(occurrences(text, OCCURRENCE), 'the directive, once').toBe(1);
    expect(occurrences(text, LABEL), 'labelled').toBe(1);
  });

  it('a trigger that is already in view is not shown twice, and a finished turn re-shows nothing', async () => {
    insertMessage({ id: 'engine-row', agentId: AGENT, role: 'user', lane: 'events', content: ENGINE_NOTICE, originIntent: 'completion_report' });
    const bag = openTurnContext(AGENT);
    bag.root = withTrigger({ kind: 'engine', id: 'engine-row', sourceMessageId: null }, 'engine-row');
    expect(servedRowsOutOfView(AGENT, [{ id: 'engine-row' }]), 'in view: nothing to re-emit').toEqual([]);
    expect(servedRowsOutOfView(AGENT, []).map((m) => m.id)).toEqual(['engine-row']);
    endTurnContext(AGENT);
    expect(servedRowsOutOfView(AGENT, []), 'the turn ended: a finished trigger is never re-shown').toEqual([]);
  });
});

describe('t207 D8 — the claim records the trigger', () => {
  const preflightCtx = (): PreflightContext => ({
    agentId: AGENT,
    startStatusHeartbeat: () => undefined,
    stopStatusHeartbeat: () => undefined,
    detectTaskThrashing: () => ({ thrashing: false }),
    engineBlockEscapeHatch: '',
    engineStartAckAfterMs: 0,
  } as unknown as PreflightContext);
  const classify = async (): Promise<TurnContext> => {
    const turnCtx = {} as unknown as TurnContext;
    const scratch: PreflightScratch = { claimedEngineEvent: null, pendingEngineClaim: null, terminalAnswerRowId: null };
    const out = await runTurnClassification(turnCtx, preflightCtx(), scratch, {
      db: mockDb.current!, waitingConvs: [], openHumanWorkAtTurnStart: false, triggerRow: null,
      chosenConvKey: '', lastUserMessageContent: '', unrepliedAssign: null,
    });
    if (out.directive !== 'proceed') throw new Error(`expected proceed, got ${out.reason}`);
    return turnCtx;
  };

  it('an engine event is the root\'s trigger', async () => {
    insertMessage({ id: 'engine-row', agentId: AGENT, role: 'user', lane: 'events', content: ENGINE_NOTICE, originIntent: 'completion_report' });
    const turnCtx = await classify();
    expect(turnCtx.root?.kind).toBe('engine');
    expect((turnCtx.root as TurnRoot).triggerMessageId).toBe('engine-row');
  });

  it('a peer\'s terminal deliverable is the root\'s trigger', async () => {
    insertMessage({
      id: 'wake-row', agentId: AGENT, role: 'user', lane: 'a2a', content: `[A2A:DELIVERABLE thread:f00dcafe from:Helper] ${DELIVERABLE}`,
      sourceAgentId: PEER, a2aThreadId: THREAD, a2aIntent: 'DELIVERABLE', a2aRequiresResponse: true,
    });
    const turnCtx = await classify();
    expect(turnCtx.root?.kind).toBe('a2a');
    expect((turnCtx.root as TurnRoot).triggerMessageId).toBe('wake-row');
  });
});

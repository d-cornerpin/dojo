// ════════════════════════════════════════════════════════════════════════════════════════
// t232 — AN APPROVAL DECISION BELONGS TO THE WORK THAT ASKED FOR IT.
//
// A sub-agent's destructive call was held, the agent then finished the owner's ask another way
// (the ask closed), and only then did the primary deny the held call. The decision woke the agent
// from `system` with no lineage: the woken turn was rooted in a fresh engine event, saw no open ask
// or task, took "find a non-destructive approach" as its job, ran the report AGAIN and answered the
// owner a second time with a different result.
//
// The approval row already records the held call's lineage (migration 117). These clauses hold the
// three states of that lineage:
//   (a) (b)  the work is CLOSED   -> the decision is recorded, nothing is woken, the text says why;
//   (c)      the work is OPEN     -> the requester is woken and the turn it starts is ROOTED in it;
//   (d)      the row has NO lineage -> woken as before (nothing says the work is finished).
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
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

// THE DELIVERY SEAM: every wake the gate sends goes through `deliverA2AMessage`. It is recorded here and
// then run for real, so the persisted wake row is the production one and the turn classification below
// reads exactly what the transport wrote.
const deliveries: Array<Record<string, unknown>> = [];
const handleMessageSpy = vi.fn(() => Promise.resolve());
vi.mock('../runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: handleMessageSpy }),
}));
vi.mock('../a2a-transport.js', async () => {
  const actual = await vi.importActual<typeof import('../a2a-transport.js')>('../a2a-transport.js');
  return {
    ...actual,
    deliverA2AMessage: (envelope: Parameters<typeof actual.deliverA2AMessage>[0]) => {
      deliveries.push(envelope as unknown as Record<string, unknown>);
      return actual.deliverA2AMessage(envelope);
    },
  };
});

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { transition } from '../../work/store.js';
import { decideApproval } from '../approval-decision.js';
import { runTurnClassification } from '../v2/steps/preflight/turn-classification.js';
import type { PreflightContext, PreflightScratch } from '../v2/steps/preflight/index.js';
import type { TurnContext } from '../turn-context.js';

const WORKER = 'worker';
const PRIMARY = 'primary';

beforeEach(() => {
  deliveries.length = 0;
  handleMessageSpy.mockClear();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 40000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Worker', 'm', 'idle', '{}', 'sensei')").run(WORKER);
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Lead', 'm', 'idle', '{}', 'sensei')").run(PRIMARY);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const db = (): Database.Database => mockDb.current!;

/** The owner's ask: the real writer opens the ticket in the same transaction. */
function openOwnerAsk(): { messageId: string; workId: string } {
  const m = insertMessage({
    agentId: WORKER, role: 'user', lane: 'owner', channel: 'dashboard', senderId: 'owner',
    content: 'run the report and give me the checksum on line 3501',
  });
  return { messageId: m.id, workId: `ask:${m.id}` };
}

/** A tracker task row in the given state (a closed state carries `closed_at`, as the ledger requires). */
function seedTask(id: string, state: 'claimed' | 'abandoned'): void {
  const now = Date.now();
  db().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at, closed_at, provenance, task_kind)
                VALUES (?, 'task', ?, 'agent', 'tracker', ?, ?, 'task', 0, 0, 'a job', ?, ?, ?, 'live', 'task')`)
    .run(id, WORKER, id, state, now, now, state === 'abandoned' ? now : null);
}

function closeAsk(workId: string): void {
  transition(workId, { to: 'abandoned', by: 'agent', actorId: WORKER, reason: 'answered another way' });
}

/** A held call, filed the way `requestApproval` files it (migration 117 lineage columns). */
function fileHeldCall(lineage: { rootKind: string | null; rootId: string | null; taskId?: string | null }): string {
  const token = `tok-${Math.random().toString(36).slice(2, 10)}`;
  db().prepare(`
    INSERT INTO destructive_approvals (token, agent_id, tool_name, signature, request_text, args_json, root_kind, root_id, task_id, turn_number)
    VALUES (?, ?, 'shell', 'shell:{"script":"touch /tmp/x && rm -f /tmp/x"}', 'destructive shell command', '{"script":"touch /tmp/x && rm -f /tmp/x"}', ?, ?, ?, 2)
  `).run(token, WORKER, lineage.rootKind, lineage.rootId, lineage.taskId ?? null);
  return token;
}

const rowOf = (token: string) =>
  db().prepare('SELECT status FROM destructive_approvals WHERE token = ?').get(token) as { status: string };

const wakesTo = (agent: string) => deliveries.filter((d) => d.toAgent === agent && d.requiresResponse === true);

describe('t232 (a) a DENIAL on work that is already finished wakes nobody', () => {
  it('records the denial, delivers no wake to the requester, and says why', async () => {
    const ask = openOwnerAsk();
    const token = fileHeldCall({ rootKind: 'ask', rootId: ask.messageId });
    closeAsk(ask.workId);

    const text = await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'deny' });

    expect(rowOf(token).status).toBe('denied');
    expect(wakesTo(WORKER)).toEqual([]);
    expect(deliveries.filter((d) => d.toAgent === WORKER)).toEqual([]);
    expect(handleMessageSpy).not.toHaveBeenCalled();
    expect(text).toMatch(/no wake was needed/i);
    expect(text).toMatch(/finished/i);
    // The old sentence is only true when a wake went out.
    expect(text).not.toMatch(/has been told not to retry/i);
  });
});

describe('t232 (b) a GRANT on work that is already finished wakes nobody and is not consumed', () => {
  it('records the grant, delivers no wake, leaves the one-shot approval unconsumed', async () => {
    const ask = openOwnerAsk();
    const token = fileHeldCall({ rootKind: 'ask', rootId: ask.messageId });
    closeAsk(ask.workId);

    const text = await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'approve' });

    expect(rowOf(token).status).toBe('approved');   // not 'consumed': nothing retried it
    expect(wakesTo(WORKER)).toEqual([]);
    expect(deliveries.filter((d) => d.toAgent === WORKER)).toEqual([]);
    expect(text).toMatch(/no wake was needed/i);
    expect(text).not.toMatch(/has been woken to retry/i);
  });

  it('a finished TASK (no ask root) is the same: the task id names the work', async () => {
    const taskId = 'task-t232-closed';
    seedTask(taskId, 'abandoned');
    const token = fileHeldCall({ rootKind: 'engine', rootId: 'ev-kickoff', taskId });

    await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'deny' });

    expect(rowOf(token).status).toBe('denied');
    expect(deliveries.filter((d) => d.toAgent === WORKER)).toEqual([]);
  });
});

describe('t232 (c) a decision on work that is STILL OPEN wakes the requester INTO that work', () => {
  it('hands the row\'s own ask to the wake, and the turn it starts is rooted in that ask, not an engine root', async () => {
    const ask = openOwnerAsk();
    const token = fileHeldCall({ rootKind: 'ask', rootId: ask.messageId });

    const text = await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'deny' });

    expect(rowOf(token).status).toBe('denied');
    expect(text).toMatch(/has been told not to retry/i);
    const wakes = wakesTo(WORKER);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].work).toMatchObject({ rootKind: 'ask', rootId: ask.messageId });

    // The woken turn: the persisted wake row is a pending engine event; classify it as the loop does.
    // The owner's own message is already served (the agent picked the ask up and is mid-work), exactly as live.
    db().prepare('UPDATE messages SET served_by_turn = 1 WHERE id = ?').run(ask.messageId);
    const turnCtx = await classify();
    expect(turnCtx.root?.kind).toBe('ask');
    expect(turnCtx.root?.id).toBe(ask.messageId);
    expect(turnCtx.root?.kind).not.toBe('engine');
  });

  it('a GRANT on open work is rooted the same way', async () => {
    const ask = openOwnerAsk();
    const token = fileHeldCall({ rootKind: 'ask', rootId: ask.messageId });

    await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'approve' });

    const wakes = wakesTo(WORKER);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].work).toMatchObject({ rootKind: 'ask', rootId: ask.messageId });
  });

  it('an open task carries its id into the wake and the turn serves it', async () => {
    const taskId = 'task-t232-open';
    seedTask(taskId, 'claimed');
    const token = fileHeldCall({ rootKind: 'engine', rootId: 'ev-kickoff', taskId });

    await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'deny' });

    const wakes = wakesTo(WORKER);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].work).toMatchObject({ taskId });
    const turnCtx = await classify();
    expect(turnCtx.servedWork?.taskId).toBe(taskId);
  });
});

describe('t232 the work is finished only when EVERY referent the ledger can answer for is finished', () => {
  it('an ask that closed while its task is still open is open work: woken, carrying the task and not the dead ask', async () => {
    const ask = openOwnerAsk();
    const taskId = 'task-t232-still-going';
    seedTask(taskId, 'claimed');
    const token = fileHeldCall({ rootKind: 'ask', rootId: ask.messageId, taskId });
    closeAsk(ask.workId);

    await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'deny' });

    const wakes = wakesTo(WORKER);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].work).toEqual({ taskId, runId: null, rootKind: null, rootId: null });
  });
});

describe('t232 (d) a row with NO lineage is woken as before', () => {
  it('delivers the wake with no work, because nothing says the work is finished', async () => {
    const token = fileHeldCall({ rootKind: null, rootId: null, taskId: null });

    const text = await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'deny' });

    expect(rowOf(token).status).toBe('denied');
    expect(wakesTo(WORKER)).toHaveLength(1);
    expect(text).toMatch(/has been told not to retry/i);
  });

  it('a root the ledger cannot answer for (an engine event, no task) is also woken', async () => {
    const token = fileHeldCall({ rootKind: 'engine', rootId: 'ev-unknown', taskId: null });
    await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'approve' });
    expect(wakesTo(WORKER)).toHaveLength(1);
  });
});

// ── the loop's own classification of the pending wake ──
async function classify(): Promise<TurnContext> {
  const turnCtx = {} as unknown as TurnContext;
  const scratch: PreflightScratch = { claimedEngineEvent: null, pendingEngineClaim: null, terminalAnswerRowId: null };
  const ctx = {
    agentId: WORKER,
    startStatusHeartbeat: () => undefined,
    stopStatusHeartbeat: () => undefined,
    detectTaskThrashing: () => ({ thrashing: false }),
    engineBlockEscapeHatch: '',
    engineStartAckAfterMs: 0,
  } as unknown as PreflightContext;
  const out = await runTurnClassification(turnCtx, ctx, scratch, {
    db: db(), waitingConvs: [], openHumanWorkAtTurnStart: false, triggerRow: null,
    chosenConvKey: '', lastUserMessageContent: '', unrepliedAssign: null,
  });
  if (out.directive !== 'proceed') throw new Error(`expected proceed, got ${out.reason}`);
  return turnCtx;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// t232 (race) — A WAKE QUEUED FOR AN OPEN ASK MUST NOT BECOME A TURN ON THAT ASK ONCE IT CLOSES.
//
// The primary decides while the ask is open, so the wake is delivered ask-rooted. The sub-agent then answers
// and the ask closes BEFORE the queued wake becomes a turn. Serving it would run a turn on a closed ask, which
// is the second unasked answer. The serve boundary (`retireSpentEngineEvents`) is the door: it retires the
// queued wake, loudly, with its own reason, using the same verdict the decision used.
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
import { insertMessage, insertEngineEventIfAbsent } from '../../memory/message-store.js';
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


const wakeRow = () => db().prepare(
  "SELECT seq, served_by_turn, swept_at FROM messages WHERE agent_id = ? AND origin_intent = 'a2a_request' ORDER BY seq DESC LIMIT 1",
).get(WORKER) as { seq: number; served_by_turn: number | null; swept_at: unknown } | undefined;

describe('t232 (race) the queued wake meets the serve boundary', () => {
  it('the ask closed after the decision: the wake is retired, nothing is served, no turn is rooted in the closed ask', async () => {
    const ask = openOwnerAsk();
    const token = fileHeldCall({ rootKind: 'ask', rootId: ask.messageId });
    db().prepare('UPDATE messages SET served_by_turn = 1 WHERE id = ?').run(ask.messageId);
    await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'deny' });
    expect(wakesTo(WORKER)).toHaveLength(1);   // delivered while the ask was open
    closeAsk(ask.workId);                       // ...and the ask closes before the wake becomes a turn

    const turnCtx = await classify();

    expect(wakeRow()?.swept_at).toBeTruthy();
    expect(wakeRow()?.served_by_turn).toBeNull();
    expect(turnCtx.root?.kind).not.toBe('ask');
    expect(turnCtx.root?.id).not.toBe(ask.messageId);
  });

  it('an ask closed while its task is still open stays served', async () => {
    const ask = openOwnerAsk();
    seedTask('task-t232-race', 'claimed');
    const token = fileHeldCall({ rootKind: 'ask', rootId: ask.messageId, taskId: 'task-t232-race' });
    db().prepare('UPDATE messages SET served_by_turn = 1 WHERE id = ?').run(ask.messageId);
    await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'deny' });
    closeAsk(ask.workId);

    await classify();

    expect(wakeRow()?.swept_at).toBeFalsy();
  });

  it('the converse: the ask is still open, so the wake is served and the turn is ask-rooted', async () => {
    const ask = openOwnerAsk();
    const token = fileHeldCall({ rootKind: 'ask', rootId: ask.messageId });
    db().prepare('UPDATE messages SET served_by_turn = 1 WHERE id = ?').run(ask.messageId);
    await decideApproval({ deciderAgentId: PRIMARY, token, decision: 'deny' });

    const turnCtx = await classify();

    expect(wakeRow()?.swept_at).toBeFalsy();
    expect(turnCtx.root?.kind).toBe('ask');
    expect(turnCtx.root?.id).toBe(ask.messageId);
  });

  it('NEGATIVE CONTROL: an engine event of another origin whose root columns only label an ask is not retired by this rule', async () => {
    const ask = openOwnerAsk();
    db().prepare('UPDATE messages SET served_by_turn = 1 WHERE id = ?').run(ask.messageId);
    closeAsk(ask.workId);
    insertEngineEventIfAbsent({
      id: 'steer-1', agentId: WORKER, content: '[Engine] a steer', sourceAgentId: null, originIntent: 'fanout_join',
      work: { taskId: null, runId: null, rootKind: 'ask', rootId: ask.messageId },
    });

    await classify();

    const steer = db().prepare("SELECT swept_at FROM messages WHERE id = 'steer-1'").get() as { swept_at: unknown };
    expect(steer.swept_at).toBeFalsy();
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

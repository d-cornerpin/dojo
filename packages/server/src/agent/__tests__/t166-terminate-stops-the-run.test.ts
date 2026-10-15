// ════════════════════════════════════════════════════════════════════════════════════════
// t166 — A TERMINATED AGENT STOPS, AND NOTHING IT STARTED REACHES ANYONE'S OWNER.
//
// THE WITNESS (dev box log, 2026-10-14): a helper agent was terminated mid-turn. Its running turn
// carried on regardless: a history search, a shell call, a task opened, and later an A2A ANSWER the
// engine relayed to the owner inside another conversation's window. `terminateAgent` wrote the
// status and never stopped the run in flight.
//
// THE DOORS DRIVEN: the real `terminateAgent`, the real `stopAgent`, the real runtime
// (`handleMessage`), the real v2 turn (executor, fences, teardown), the real A2A transport door.
// Only the provider (`callModel`, scripted), the tool bodies (`executeTool`, a recording stub) and
// the websocket are replaced. Nothing here reads an agent NAME.
//
// RED-FIRST at e88d1857: clauses (i), (ii-seam) and (iv) fail without the fix; (iii) and the CONTROLs
// are green before and after (the owner's Stop is byte-unchanged: `runtime.ts` is untouched).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };
const callModelSpy = vi.fn();
const executeToolSpy = vi.fn();
const warns: Array<{ msg: string; facts: unknown }> = [];

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../model.js', async () => {
  const actual = await vi.importActual<typeof import('../model.js')>('../model.js');
  return { ...actual, callModel: (...a: unknown[]) => callModelSpy(...a), getContextWindow: () => 200000 };
});
vi.mock('../tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../tools/index.js')>('../tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../tool-outcome.js')>('../tool-outcome.js');
  return {
    ...actual,
    executeTool: async (...a: unknown[]) => classifyToolResult(await executeToolSpy(...a)),
    getFilteredTools: () => [],
  };
});
// The dedup's embedding call is the long await inside the A2A door; a clause holds it open to end the sender there.
const embedding: { calls: number; hold: Promise<void> | null } = { calls: 0, hold: null };
vi.mock('../../memory/embeddings.js', async () => {
  const actual = await vi.importActual<typeof import('../../memory/embeddings.js')>('../../memory/embeddings.js');
  return {
    ...actual,
    generateEmbedding: async () => {   // the new payload and the earlier one embed orthogonally: not a duplicate
      const n = ++embedding.calls; await embedding.hold; return new Float32Array(n === 1 ? [1, 0, 0, 0] : [0, 1, 0, 0]);
    },
    queueEmbedding: () => {},
  };
});
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(),
    warn: (msg: string, facts: unknown) => { warns.push({ msg, facts }); },
    error: vi.fn(),
  }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
// The engine's shared maps, read from the SAME module instance the code under test was loaded in
// (`vi.resetModules()` gives every clause a fresh graph; a static import here would be a stranger's).
const shared = async (): Promise<typeof import('../shared-state.js')> => import('../shared-state.js');
const clearShared = async (): Promise<void> => {
  const s = await shared();
  for (const m of [s.activeRuns, s.stoppedAgents, s.pendingWakeups]) m.clear();
  s.stopFencedRuns.clear(); s.activeAbortControllers.clear();
};

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const WORKER = 'worker-t166';
const PEER = 'peer-t166';
const OWNER_AGENT = 'primary';
const db = (): Database.Database => mockDb.current!;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let migratedImage: Buffer | null = null;
function freshDb(): Database.Database {
  if (migratedImage === null) {
    const seed = new Database(':memory:');
    mockDb.current = seed;
    runMigrations();
    migratedImage = seed.serialize();
    seed.close();
  }
  const d = new Database(migratedImage);
  d.pragma('foreign_keys = ON');
  return d;
}

function seedWorld(): void {
  db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p1', 'Test', 'anthropic', 'api_key')").run();
  db().prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
     VALUES ('m1', 'p1', 'Test Model', 'test-1', '["tools"]', 200000, 1)`,
  ).run();
  const agent = db().prepare(
    "INSERT INTO agents (id, name, model_id, status, config, classification, parent_agent) VALUES (?, ?, 'm1', 'idle', '{}', ?, ?)",
  );
  agent.run(OWNER_AGENT, 'Primary', 'sensei', null);
  agent.run(WORKER, 'Helper', 'apprentice', OWNER_AGENT);
  agent.run(PEER, 'Peer', 'apprentice', OWNER_AGENT);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-w', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(WORKER);
  insertMessage({
    id: 'msg-w-1', agentId: WORKER, role: 'user', content: 'please look into the depot manifests', turnNumber: 1,
    channel: 'dashboard', senderId: 'owner', conversationId: 'conv-w',
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  });
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ id, name, arguments: args });
const reply = (toolCalls: ToolCall[], content = ''): Record<string, unknown> => ({
  content, toolCalls, inputTokens: 10, outputTokens: 5, stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
});

/** A tool body that holds the first call open until the test lets it go. */
let gate: { open: () => void; opened: Promise<void> } = { open: () => {}, opened: Promise.resolve() };
let firstToolRunning: Promise<void> = Promise.resolve();
let signalFirstToolRunning: () => void = () => {};
const executed: string[] = [];

function armGate(): void {
  let open!: () => void;
  gate = { open: () => open(), opened: new Promise<void>((r) => { open = r; }) };
  firstToolRunning = new Promise<void>((r) => { signalFirstToolRunning = r; });
}

beforeEach(async () => {
  vi.resetModules();
  mockDb.current = freshDb();
  seedWorld();
  callModelSpy.mockReset(); executeToolSpy.mockReset();
  executed.length = 0; warns.length = 0;
  armGate();
  // Tool bodies: `shell` is the slow first call (held open); everything else answers at once.
  executeToolSpy.mockImplementation(async (_agentId: string, tc: ToolCall) => {
    executed.push(tc.name);
    if (tc.name === 'shell' && executed.filter((n) => n === 'shell').length === 1) {
      signalFirstToolRunning();
      await gate.opened;
    }
    return { toolCallId: tc.id, name: tc.name, content: `${tc.name} ok`, isError: false };
  });
});

afterEach(async () => {
  gate.open();
  await clearShared();
  mockDb.current?.close();
  mockDb.current = null;
});

const statusOf = (id = WORKER): string => (db().prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;
const rowsFor = (id: string): number => (db().prepare('SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?').get(id) as { n: number }).n;

/** Start the worker's real run and wait until its first tool call is in flight. */
async function startRunMidTool(script: Array<Record<string, unknown>>): Promise<{ run: Promise<void> }> {
  script.forEach((r, i) => callModelSpy.mockImplementationOnce(async () => r));
  callModelSpy.mockImplementation(async () => reply([], 'done'));   // any further call: a plain text end
  const { getAgentRuntime } = await import('../runtime.js');
  const run = getAgentRuntime().handleMessage(WORKER, '');
  await firstToolRunning;
  return { run };   // boxed: returning the bare promise would make this function await the whole run
}

describe('t166 (i) — an agent terminated mid tool loop does nothing further', () => {
  it('no further tool executes, no model call is made, no A2A send leaves, nothing lands on any owner', async () => {
    const { run } = await startRunMidTool([
      reply([call('c1', 'shell', { command: 'ls' }), call('c2', 'work_open', { title: 'x' })]),
      reply([call('c3', 'history_search', { query: 'x' }), call('c4', 'send_to_agent', { agent_id: PEER, intent: 'ANSWER', payload: 'the answer' })]),
    ]);
    const ownerRowsBefore = rowsFor(OWNER_AGENT);
    const peerRowsBefore = rowsFor(PEER);

    const { terminateAgent } = await import('../spawner.js');
    terminateAgent(WORKER, 'Terminated via dashboard');
    gate.open();
    await run;
    await sleep(900);   // past the 500 ms queued-wakeup timer

    expect(executed, 'only the call already in flight ran; the rest of the loop stood down').toEqual(['shell']);
    expect(callModelSpy, 'the loop made no second model call after the termination').toHaveBeenCalledTimes(1);
    expect(rowsFor(PEER), 'nothing was delivered to the peer').toBe(peerRowsBefore);
    expect(rowsFor(OWNER_AGENT), 'nothing reached the owner\'s agent (no relay)').toBe(ownerRowsBefore);
    expect(statusOf(), 'the end stands: the run\'s own teardown does not write idle over it').toBe('terminated');
    const s = await shared();
    expect(s.activeRuns.has(WORKER)).toBe(false);
    expect(s.stopFencedRuns.has(WORKER) || s.stoppedAgents.has(WORKER), 'the run retired its own fence on the way out').toBe(false);
  });
});

describe('t166 (ii) — a terminated agent\'s late send is refused and logged', () => {
  const ASSIGN_OPEN = { intent: 'ANSWER' as const, requiresResponse: false, payload: 'late answer' };

  it('the A2A door refuses a sender ended mid-run: nothing persisted, one warn naming the reason', async () => {
    db().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(WORKER);
    (await shared()).stopFencedRuns.set(WORKER, Date.now());   // the run it was ended in is still unwinding
    const { deliverA2AMessage } = await import('../a2a-transport.js');
    const r = await deliverA2AMessage({ ...ASSIGN_OPEN, threadId: '', toAgent: PEER, fromAgent: WORKER });
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe('SENDER_TERMINATED');
    expect(rowsFor(PEER), 'no row for the peer').toBe(0);
    expect(db().prepare('SELECT COUNT(*) AS n FROM a2a_threads').get()).toEqual({ n: 0 });
    expect(warns.some((w) => w.msg === 'A2A message dropped' && (w.facts as { reason?: string }).reason === 'SENDER_TERMINATED'), 'the refusal is logged').toBe(true);
  });

  it('a sender ended WHILE the door awaits its dedup embedding is refused after the await too', async () => {
    const THREAD = 'thread-t166-race';
    insertMessage({
      agentId: PEER, role: 'user', lane: 'a2a', sourceAgentId: WORKER, a2aThreadId: THREAD,
      content: '[A2A:STATUS thread:thread-t internal from:Helper] the depot count was thirty crates',
    });
    const peerRowsBefore = rowsFor(PEER);
    let release!: () => void;
    embedding.calls = 0; embedding.hold = new Promise<void>((r) => { release = r; });
    const { deliverA2AMessage } = await import('../a2a-transport.js');
    const sending = deliverA2AMessage({ intent: 'STATUS', requiresResponse: false, payload: 'the depot count is now thirty one crates', threadId: THREAD, toAgent: PEER, fromAgent: WORKER });
    for (let i = 0; i < 200 && embedding.calls === 0; i++) await sleep(10);
    expect(embedding.calls, 'precondition: the door is parked on the embedding').toBeGreaterThan(0);

    db().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(WORKER);   // ended while it waited
    (await shared()).stopFencedRuns.set(WORKER, Date.now());
    release();
    const r = await sending;
    embedding.hold = null;
    expect(r.reason).toBe('SENDER_TERMINATED');
    expect(rowsFor(PEER), 'nothing was delivered').toBe(peerRowsBefore);
  });

  it('CONTROL: a sender that FINISHED its own task is terminated but no run is unwinding: the engine hand-back still delivers', async () => {
    db().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(WORKER);
    const { deliverA2AMessage } = await import('../a2a-transport.js');
    const r = await deliverA2AMessage({ ...ASSIGN_OPEN, threadId: '', toAgent: PEER, fromAgent: WORKER });
    expect(r.reason).not.toBe('SENDER_TERMINATED');
    expect(r.delivered).toBe(true);
  });

  it('CONTROL: a live sender delivers as before', async () => {
    const { deliverA2AMessage } = await import('../a2a-transport.js');
    const r = await deliverA2AMessage({ ...ASSIGN_OPEN, threadId: '', toAgent: PEER, fromAgent: WORKER });
    expect(r.delivered).toBe(true);
  });
});

describe('t166 (ii-seam) — a tool call by a terminated agent is refused', () => {
  it('the second call of a response runs nothing once the row reads terminated, even with no stop fence', async () => {
    // The first tool ends the agent by a path that raised no fence (a bare status write).
    executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) => {
      executed.push(tc.name);
      if (tc.name === 'shell') db().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(WORKER);
      return { toolCallId: tc.id, name: tc.name, content: `${tc.name} ok`, isError: false };
    });
    callModelSpy.mockImplementationOnce(async () => reply([call('c1', 'shell', { command: 'ls' }), call('c2', 'work_open', { title: 'x' })]));
    callModelSpy.mockImplementation(async () => reply([], 'done'));
    const { getAgentRuntime } = await import('../runtime.js');
    await getAgentRuntime().handleMessage(WORKER, '');
    expect(executed).toEqual(['shell']);
    expect(warns.some((w) => /tool call refused, this agent has been terminated/.test(w.msg))).toBe(true);
  });

  it('CONTROL: an agent that ends ITSELF with complete_task finishes the batch it called alongside', async () => {
    executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) => {
      executed.push(tc.name);
      if (tc.name === 'complete_task') db().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(WORKER);
      return { toolCallId: tc.id, name: tc.name, content: `${tc.name} ok`, isError: false };
    });
    callModelSpy.mockImplementationOnce(async () => reply([
      call('c1', 'complete_task', { status: 'complete', summary: 'done' }),
      call('c2', 'send_to_agent', { agent_id: PEER, intent: 'ANSWER', payload: 'hand-back' }),
    ]));
    callModelSpy.mockImplementation(async () => reply([], 'done'));
    const { getAgentRuntime } = await import('../runtime.js');
    await getAgentRuntime().handleMessage(WORKER, '');
    expect(executed).toEqual(['complete_task', 'send_to_agent']);
  });
});

describe('t166 (iii) — the owner\'s Stop on a live agent is unchanged', () => {
  it('stops the loop, cancels the rest of the batch, and the agent ends idle (not terminated)', async () => {
    const { run } = await startRunMidTool([
      reply([call('c1', 'shell', { command: 'ls' }), call('c2', 'work_open', { title: 'x' })]),
    ]);
    const { stopAgent } = await import('../runtime.js');
    stopAgent(WORKER);
    expect((await shared()).stopFencedRuns.has(WORKER), 'the run\'s fence is raised').toBe(true);
    gate.open();
    await run;
    expect(executed).toEqual(['shell']);
    expect(callModelSpy).toHaveBeenCalledTimes(1);
    expect(statusOf()).toBe('idle');
    const cfg = JSON.parse((db().prepare('SELECT config FROM agents WHERE id = ?').get(WORKER) as { config: string }).config) as { stopMarkerPending?: boolean };
    expect(cfg.stopMarkerPending, 'the one-shot stop marker is set for the next turn').toBe(true);
  });
});

describe('t166 (iv) — a terminated agent\'s queued wakeup never starts a turn', () => {
  it('a message that arrived mid-run is parked, the agent is terminated, and no turn follows', async () => {
    const { run } = await startRunMidTool([
      reply([call('c1', 'shell', { command: 'ls' }), call('c2', 'work_open', { title: 'x' })]),
    ]);
    const { getAgentRuntime } = await import('../runtime.js');
    await getAgentRuntime().handleMessage(WORKER, '');   // arrives while busy: parked as a wakeup
    expect((await shared()).pendingWakeups.has(WORKER), 'precondition: the wakeup is queued').toBe(true);

    const { terminateAgent } = await import('../spawner.js');
    terminateAgent(WORKER, 'Terminated via dashboard');
    gate.open();
    await run;
    await sleep(900);

    expect((await shared()).pendingWakeups.has(WORKER)).toBe(false);
    expect(callModelSpy, 'no turn ran after the termination').toHaveBeenCalledTimes(1);
    expect(executed).toEqual(['shell']);
    expect(statusOf()).toBe('terminated');
  });
});

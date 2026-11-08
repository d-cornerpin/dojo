// PM-CANNOT-APPROVE C7: THE OVERRIDE DOOR IS NOT A WAY AROUND THE RECORD CHECK.
//
// On a lived-in box, all seven of the primary's refused closes were finally approved through
// work_validate(action="override", approve=true), which never ran the record check that refused the
// uphold. An override that approves a close now meets that same check; a deny never does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-override-record-check-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

// A deny notifies the worker through the transport; here it lands as an inbound row and goes nowhere.
const inbound = vi.hoisted(() => ({ turn: 7, to: 'pm-agent', from: 'worker-agent' }));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: async (e: { threadId: string; payload: string }) => {
    const { getDb } = await import('../../db/connection.js');
    const at = Date.now();
    getDb().prepare(
      `INSERT INTO messages (id, agent_id, lane, role, content, turn_number, source_agent_id, a2a_thread_id, created_at, sent_at) VALUES (?, ?, 'a2a', 'user', ?, ?, ?, ?, ?, ?)`,
    ).run(`in-${e.threadId}`, inbound.to, e.payload, inbound.turn, inbound.from, e.threadId, at, at);
    return { delivered: true, threadId: e.threadId };
  },
}));

import { runMigrations } from '../../db/migrations.js';
import { appendWorkEvent } from '../../work/store.js';
import { openTrackerProject, openTrackerTask } from '../../work/tracker-store.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { fileOverrideRequest, findOverrideRequest } from '../../work/override-requests.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const WORKER = 'worker-agent';
const PM = 'pm-agent';
const TURN = 7;
let projectId = '';
let msgSeq = 0;

function newTask(): string {
  return openTrackerTask({
    projectId, title: 'File the quarterly summary', status: 'in_progress', assignedTo: WORKER, createdBy: WORKER,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
}
beforeEach(() => {
  msgSeq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [WORKER, PM]) mockDb.current.prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')").run(id, id);
  projectId = openTrackerProject({ name: 'p', createdBy: WORKER, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null } } as never) as string;
  openTurnContext(PM).turnNumber = TURN;
});
afterEach(() => { endTurnContext(PM); mockDb.current?.close(); mockDb.current = null; });

function fileClose(t: string, deliveryId: string | null = null): void {
  appendWorkEvent(t, 'validation_requested', WORKER, { requested_state: 'done', reason: 'done', from: 'claimed', result_delivery_id: deliveryId }, Date.now() + (++msgSeq));
}
/** The worker's message to the owner on the dashboard; by default only a status claim, which is never proof. */
function seedDelivery(id: string, text = 'Done, please validate.'): string {
  const at = Date.now() + 1000;
  mockDb.current!.prepare(`INSERT INTO messages (id, agent_id, lane, role, content, created_at, sent_at) VALUES (?, ?, 'owner', 'assistant', ?, ?, ?)`)
    .run(`m-${id}`, WORKER, text, at, at);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, message_id, outcome, created_at) VALUES (?, ?, NULL, 'dashboard', 'dashboard', ?, 'delivered', datetime('now', '+1 second'))`,
  ).run(id, WORKER, `m-${id}`);
  return id;
}
async function door(key: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  const out = await trackerHandlers[key]({
    agentId: PM, name: 'work_validate', callId: `v${++msgSeq}`, args,
    toolCall: { id: `v${msgSeq}`, name: 'work_validate', input: {} },
  } as never);
  return { content: String(out.content), isError: !!out.isError };
}
const override = (id: string, approve: boolean) => door('work_validate:override', {
  action: 'override', override_request_id: id, approve, reason: 'the worker says the engine was wrong about this one',
});
const askOverride = (t: string, requestedStatus = 'complete'): string => fileOverrideRequest(t, {
  requestedBy: WORKER, requestedStatus, justification: 'the work is done and the engine could not see it on the record',
});
const upheld = (t: string): number => (mockDb.current!.prepare(`SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ? AND verdict = 'upheld' AND claim_state = 'done'`).get(t) as { n: number }).n;
const stateOf = (t: string): string => (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(t) as { state: string }).state;

describe('C7: an override that approves a close meets the same record check as validate', () => {
  it('an override approve with nothing on record is refused with the record facts; nothing is upheld and the request stays pending', async () => {
    const t = newTask();
    fileClose(t, seedDelivery('deliv-ov-1'));
    const id = askOverride(t);
    const r = await override(id, true);
    expect(r.isError, r.content).toBe(true);
    expect(r.content).toMatch(/^Refused: nothing on record shows this work/);
    expect(upheld(t)).toBe(0);
    expect(stateOf(t)).not.toBe('done');
    expect(findOverrideRequest(id)!.status).toBe('pending');
  });

  it('an override approve with no close filed and nothing on record is refused too', async () => {
    const t = newTask();
    const id = askOverride(t);
    const r = await override(id, true);
    expect(r.content).toMatch(/^Refused: nothing on record shows this work/);
    expect(stateOf(t)).not.toBe('done');
  });

  it('an override approve the record backs (the worker\'s message to the owner carries the work) goes through', async () => {
    const t = newTask();
    fileClose(t, seedDelivery('deliv-ov-2', 'The quarterly summary: revenue 412, costs 300, filed under Reports.'));
    const r = await override(askOverride(t), true);
    expect(r.content, r.content).toMatch(/^\[OK\] override approved/);
    expect(stateOf(t)).toBe('done');
    expect(upheld(t)).toBe(1);
  });

  it('CONTROL: an override deny is never refused, even with nothing on record', async () => {
    const t = newTask();
    fileClose(t, seedDelivery('deliv-ov-3'));
    const id = askOverride(t);
    const r = await override(id, false);
    expect(r.content, r.content).toMatch(/^\[OK\] override denied/);
    expect(findOverrideRequest(id)!.status).toBe('denied');
  });

  it('CONTROL: an override that does not approve a close (here, to blocked) is not a close uphold and is not checked', async () => {
    const t = newTask();
    const r = await override(askOverride(t, 'blocked'), true);
    expect(r.content, r.content).not.toMatch(/^Refused: nothing on record/);
  });
});

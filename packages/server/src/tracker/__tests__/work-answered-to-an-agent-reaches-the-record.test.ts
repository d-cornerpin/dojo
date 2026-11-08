// C4 (PM-CANNOT-APPROVE.md): REAL WORK DONE AS AN ANSWER TO ANOTHER AGENT REACHES THE RECORD THE PM READS.
//
// Measured on the owner's box: three of the main agent's tasks were real work, answered over agent-to-
// agent mail (`send_to_agent`, the engine's verified receipt on record), then closed from a later turn,
// and the PM's door refused the uphold for "nothing on record". The answer to the agent that asked for
// the task is a delivery to the asker, and the one proof check (`work/done/proof.ts`) finds it whatever
// the close pointed at. What must stay true: nothing the engine did not see is counted. A send that did
// not land, a tool-call chip and the engine's own lines are never proof. Reads are the worker's process,
// not proof; the answer they produced is.

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-c4-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage: async () => ({ delivered: true, threadId: 't' }) }));

import { runMigrations } from '../../db/migrations.js';
import { appendWorkEvent } from '../../work/store.js';
import { recordCallsTouched } from '../../work/ledger-store.js';
import { effectsFor } from '../../agent/tools/registry.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { proofDelivery } from '../../work/done/proof.js';
import { openTrackerProject, openTrackerTask } from '../../work/tracker-store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const WORKER = 'main-agent';
const PM = 'pm-agent';
const REQUESTER = 'helper-agent';
const PM_TURN = 6434;
const WORK_TURN = 1793;
let projectId = '';
let n = 0;

const db = (): Database.Database => mockDb.current!;
function newTask(): string {
  return openTrackerTask({
    projectId, title: 'Establish the real disposal path for the blocked fixture rows', status: 'in_progress',
    assignedTo: WORKER, createdBy: REQUESTER, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
}
/** One of the worker's tool calls in its working turn, and the result the engine stored for it. */
function workerCall(name: string, input: object, ok = true): string {
  const id = `call_${++n}`;
  const at = Date.now() + n;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES (?, ?, 'a2a', 'assistant', ?, ?, ?, ?)`)
    .run(`wa-${n}`, WORKER, JSON.stringify([{ type: 'tool_use', id, name, input }]), WORK_TURN, at, at);
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES (?, ?, 'a2a', 'tool', ?, ?, ?, ?)`)
    .run(`wr-${n}`, WORKER, JSON.stringify([{ type: 'tool_result', tool_use_id: id, content: ok ? 'ok' : 'Error: not found', is_error: !ok }]), WORK_TURN, at, at);
  return id;
}
/** The engine's receipt for a call, exactly as `writeToolReceipt` stores a delivered A2A send. */
function receipt(callId: string, verified: boolean): void {
  db().prepare(
    `INSERT INTO tool_receipts (id, agent_id, tool, tier, verified, basis, provider_id, thread_id, recipient, turn_number, call_id)
     VALUES (?, ?, 'send_to_agent', 1, ?, 'provider-id', 'thread-1a9e', 'thread-1a9e', ?, ?, ?)`,
  ).run(`rcpt-${callId}`, WORKER, verified ? 1 : 0, REQUESTER, WORK_TURN, callId);
}
/** The charge site's ledger write for this round (`tracker-counting.ts` -> `recordCallsTouched`). */
function charge(taskId: string, calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): void {
  recordCallsTouched(taskId, calls, calls.map((c) => ({ toolCallId: c.id, isError: false, content: 'ok' })), effectsFor, WORKER);
}
/** The close (Key 1), filed from a LATER turn, pointing at the delivery G7 resolved for it. */
function fileClose(t: string, deliveryId: string): void {
  appendWorkEvent(t, 'validation_requested', WORKER, { requested_state: 'done', reason: 'complete', from: 'claimed', result_delivery_id: deliveryId }, Date.now() + (++n));
}
/** A delivery row, with the message it carried: on the a2a lane to the requesting agent unless the channel says otherwise. */
function delivery(id: string, message: { id: string; content: string; displayKind?: string } | null,
  o: { channel?: string; outcome?: string; receiptId?: string } = {}): string {
  const channel = o.channel ?? 'a2a';
  if (message) {
    db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, display_kind, turn_number, created_at, sent_at) VALUES (?, ?, ?, 'assistant', ?, ?, 1794, ?, ?)`)
      .run(message.id, WORKER, channel === 'a2a' ? 'a2a' : 'owner', message.content, message.displayKind ?? 'agent-text', Date.now() + (++n), Date.now() + n);
  }
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, recipient_id, message_id, receipt_id, detail, outcome, created_at)
    VALUES (?, ?, 1794, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(id, WORKER, channel === 'a2a' ? 'send_to_agent' : 'dashboard', channel, channel === 'a2a' ? REQUESTER : null, message?.id ?? null,
      o.receiptId ?? null, channel === 'a2a' ? 'A2A ANSWER' : null, o.outcome ?? 'delivered');
  return id;
}
const ANSWER = 'The cancel is refused on blocked work; the decider is the owner.';
function pmRead(name: string, input: object): void {
  const id = `pm_${++n}`;
  const at = Date.now() + n;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES (?, ?, 'a2a', 'assistant', ?, ?, ?, ?)`)
    .run(`pa-${n}`, PM, JSON.stringify([{ type: 'tool_use', id, name, input }]), PM_TURN, at, at);
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES (?, ?, 'owner', 'tool', ?, ?, ?, ?)`)
    .run(`pr-${n}`, PM, JSON.stringify([{ type: 'tool_result', tool_use_id: id, content: 'the file', is_error: false }]), PM_TURN, at, at);
}
async function validate(t: string): Promise<string> {
  const out = await trackerHandlers['work_validate:validate']({
    agentId: PM, name: 'work_validate', callId: `v${++n}`,
    args: { action: 'validate', kind: 'complete', task_id: t, valid: true },
    toolCall: { id: `v${n}`, name: 'work_validate', input: {} },
  } as never);
  return String(out.content);
}
const upheld = (t: string): number => (db().prepare(`SELECT COUNT(*) AS c FROM adjudications WHERE work_id = ? AND verdict = 'upheld'`).get(t) as { c: number }).c;
const REFUSED = /^Refused: nothing on record/;

beforeEach(() => {
  n = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [WORKER, PM, REQUESTER]) db().prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')").run(id, id);
  projectId = openTrackerProject({ name: 'p', createdBy: WORKER, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null } } as never) as string;
  openTurnContext(PM).turnNumber = PM_TURN;
});
afterEach(() => { endTurnContext(PM); mockDb.current?.close(); mockDb.current = null; });

describe('C4: an answer sent to the agent that asked, on the engine\'s verified receipt, is on the record', () => {
  it('the answer to the requesting agent a turn before the close backs the uphold; the receipt is tied to the task', async () => {
    const t = newTask();
    const send = workerCall('send_to_agent', { agent: REQUESTER, intent: 'ANSWER', payload: ANSWER });
    receipt(send, true);
    delivery('d-answer', { id: 'm-answer', content: ANSWER }, { receiptId: `rcpt-${send}` });
    charge(t, [{ id: send, name: 'send_to_agent', arguments: { agent: REQUESTER, intent: 'ANSWER', payload: ANSWER } }]);
    // The close's own delivery on the box was the tool-call row of the close itself (a chip, not an answer).
    fileClose(t, delivery('d-close-chip', { id: 'm-close-chip', content: '[{"type":"tool_use"}]', displayKind: 'tool-turn' }));
    expect(proofDelivery(t)).toBe('d-answer');
    expect(await validate(t)).not.toMatch(REFUSED);
    expect(upheld(t)).toBe(1);
    expect((db().prepare('SELECT task_id FROM tool_receipts WHERE call_id = ?').get(send) as { task_id: string }).task_id).toBe(t);
  });

  it('NEGATIVE CONTROL: a send that did not land is not counted, and the uphold is refused', async () => {
    const t = newTask();
    const send = workerCall('send_to_agent', { agent: REQUESTER, intent: 'ANSWER', payload: ANSWER });
    receipt(send, false);
    delivery('d-failed', { id: 'm-failed', content: ANSWER }, { outcome: 'failed', receiptId: `rcpt-${send}` });
    charge(t, [{ id: send, name: 'send_to_agent', arguments: { agent: REQUESTER, intent: 'ANSWER', payload: ANSWER } }]);
    fileClose(t, delivery('d-close-chip', { id: 'm-close-chip', content: '[{"type":"tool_use"}]', displayKind: 'tool-turn' }));
    expect(await validate(t)).toMatch(REFUSED);
    expect(upheld(t)).toBe(0);
  });

  it('NEGATIVE CONTROL: a tool-call chip, or a line to someone who did not ask, is never the answer', () => {
    const a = newTask();
    fileClose(a, delivery('d-chip', { id: 'm-chip', content: '[{"type":"tool_use"}]', displayKind: 'tool-turn' }));
    expect(proofDelivery(a)).toBeNull();
    const b = newTask();
    fileClose(b, delivery('d-owner', { id: 'm-owner', content: ANSWER }, { channel: 'dashboard' }));
    expect(proofDelivery(b)).toBeNull();
  });
});

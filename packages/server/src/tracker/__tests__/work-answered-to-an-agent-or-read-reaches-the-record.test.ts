// C4 (PM-CANNOT-APPROVE.md, v3.5 field fix 3 evidence round): REAL WORK DONE AS AN ANSWER TO ANOTHER
// AGENT, OR BY READING, REACHES THE RECORD THE PM READS.
//
// Measured on the owner's box: three of the main agent's tasks were real work, answered to the PM
// itself over agent-to-agent mail (`send_to_agent`, the engine's VERIFIED receipt on record, task id
// NULL) plus read-only lookups, then closed from a later turn. The PM's door refused the uphold five
// times ("ledger empty, no delivered answer"), and the rows closed three hours later through the
// override door, which skips the check. Three gaps in the record:
//   * the ledger dropped a send whose recipient is another agent (`tools/item-keys.ts`);
//   * the send's receipt carried no task id (only the close gate, in its own turn, stamped one);
//   * the answer resolver never read the delivery the worker's own close request named;
// and reads were never on the record at all.
//
// What must stay true: nothing the engine did not see is counted. A send with no verified receipt, a
// tool-call row the close happened to point at, and a read the PM has not repeated back nothing.

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
import { keepLedgerShownFor, noteAnswerShown } from '../request-shown.js';
import { appendWorkEvent } from '../../work/store.js';
import { recordCallsTouched } from '../../work/ledger-store.js';
import { effectsFor } from '../../agent/tools/registry.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { resetEmptyUpholdRefusals } from '../empty-uphold.js';
import { resolveTaskAnswerPointer } from '../delivery-evidence.js';
import { workerReadsLines } from '../validation-request.js';
import { openTrackerProject, openTrackerTask } from '../../work/tracker-store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const WORKER = 'main-agent';
const PM = 'pm-agent';
const PM_TURN = 6434;
const WORK_TURN = 1793;
let projectId = '';
let n = 0;

const db = (): Database.Database => mockDb.current!;
function newTask(): string {
  return openTrackerTask({
    projectId, title: 'Establish the real disposal path for the blocked fixture rows', status: 'in_progress',
    assignedTo: WORKER, createdBy: WORKER, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
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
  ).run(`rcpt-${callId}`, WORKER, verified ? 1 : 0, PM, WORK_TURN, callId);
}
/** The charge site's ledger write for this round (`tracker-counting.ts` -> `recordCallsTouched`). */
function charge(taskId: string, calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): void {
  recordCallsTouched(taskId, calls, calls.map((c) => ({ toolCallId: c.id, isError: false, content: 'ok' })), effectsFor, WORKER);
}
/** The close (Key 1), filed from a LATER turn, pointing at the delivery G7 resolved for it. */
function fileClose(t: string, deliveryId: string): void {
  appendWorkEvent(t, 'validation_requested', WORKER, { requested_state: 'done', reason: 'complete', from: 'claimed', result_delivery_id: deliveryId }, Date.now() + (++n));
}
/** A delivery row, with the message it carried. */
function delivery(id: string, message: { id: string; content: string; displayKind?: string } | null, channel = 'dashboard'): string {
  if (message) {
    db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, display_kind, turn_number, created_at, sent_at) VALUES (?, ?, 'owner', 'assistant', ?, ?, 1794, ?, ?)`)
      .run(message.id, WORKER, message.content, message.displayKind ?? 'agent-text', Date.now() + (++n), Date.now() + n);
  }
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, message_id, outcome, created_at) VALUES (?, ?, 1794, ?, ?, ?, 'delivered', datetime('now'))`)
    .run(id, WORKER, channel === 'a2a' ? 'send_to_agent' : 'dashboard', channel, message?.id ?? null);
  return id;
}
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
  keepLedgerShownFor(new Set());
  n = 0;
  resetEmptyUpholdRefusals();
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [WORKER, PM]) db().prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')").run(id, id);
  projectId = openTrackerProject({ name: 'p', createdBy: WORKER, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null } } as never) as string;
  openTurnContext(PM).turnNumber = PM_TURN;
});
afterEach(() => { endTurnContext(PM); mockDb.current?.close(); mockDb.current = null; });

describe('C4: an answer sent to another agent, on the engine\'s verified receipt, is on the record', () => {
  it('THE OWNER\'S BOX: the answer to the PM a turn before the close backs the uphold; the receipt is tied to the task', async () => {
    const t = newTask();
    const send = workerCall('send_to_agent', { agent: PM, intent: 'ANSWER', payload: 'The cancel is refused on blocked work; the decider is the owner.' });
    receipt(send, true);
    charge(t, [{ id: send, name: 'send_to_agent', arguments: { agent: PM, intent: 'ANSWER', payload: '...' } }]);
    // The close's own delivery on the box was the tool-call row of the close itself (a chip, not an answer).
    fileClose(t, delivery('d-close-chip', { id: 'm-close-chip', content: '[{"type":"tool_use"}]', displayKind: 'tool-turn' }));
    expect(await validate(t)).not.toMatch(REFUSED);
    expect(upheld(t)).toBe(1);
    expect((db().prepare('SELECT task_id FROM tool_receipts WHERE call_id = ?').get(send) as { task_id: string }).task_id).toBe(t);
  });

  it('NEGATIVE CONTROL: a send with no verified receipt (it did not land) is not counted, and the uphold is refused', async () => {
    const t = newTask();
    const send = workerCall('send_to_agent', { agent: PM, intent: 'ANSWER', payload: 'done' });
    receipt(send, false);
    charge(t, [{ id: send, name: 'send_to_agent', arguments: { agent: PM, intent: 'ANSWER', payload: 'done' } }]);
    const bare = workerCall('send_to_agent', { agent: PM, intent: 'ANSWER', payload: 'done' });   // no receipt at all
    charge(t, [{ id: bare, name: 'send_to_agent', arguments: { agent: PM, intent: 'ANSWER', payload: 'done' } }]);
    fileClose(t, delivery('d-close-chip', { id: 'm-close-chip', content: '[{"type":"tool_use"}]', displayKind: 'tool-turn' }));
    expect(await validate(t)).toMatch(REFUSED);
    expect(upheld(t)).toBe(0);
  });
});

describe('C4: the delivery the worker\'s own close named is read as its answer', () => {
  it('a real delivered line on the close is the task\'s answer; shown to the PM, it backs the uphold', async () => {
    const t = newTask();
    fileClose(t, delivery('d-answer', { id: 'm-answer', content: 'The disposal path: only the owner can cancel blocked work.' }));
    const p = resolveTaskAnswerPointer(t);
    expect(p?.deliveryId).toBe('d-answer');
    expect(p?.basis).toBe('close-request-delivery');
    noteAnswerShown(t, 'd-answer');   // the review printed it
    expect(await validate(t)).not.toMatch(REFUSED);
  });

  it('NEGATIVE CONTROL: the close pointing at a tool-call row, or at a channel send with no message, names no answer', () => {
    const a = newTask();
    fileClose(a, delivery('d-chip', { id: 'm-chip', content: '[{"type":"tool_use"}]', displayKind: 'tool-turn' }));
    expect(resolveTaskAnswerPointer(a)).toBeNull();
    const b = newTask();
    fileClose(b, delivery('d-bare', null));
    expect(resolveTaskAnswerPointer(b)).toBeNull();
  });
});

describe('C4: a read counts the way the PM can verify it, by reading the same thing', () => {
  function readOnlyJob(): string {
    const t = newTask();
    appendWorkEvent(t, 'claim_turn', 'engine', { turn_number: WORK_TURN });
    workerCall('file_read', { path: '/fixtures/export.csv' });
    workerCall('vault_get', { entry_id: 'vault-entry-0730' }, false);   // a failed read read nothing
    fileClose(t, delivery('d-close-chip', { id: 'm-close-chip', content: '[{"type":"tool_use"}]', displayKind: 'tool-turn' }));
    return t;
  }

  it('the request names what the worker read, and only the reads that succeeded', () => {
    const t = readOnlyJob();
    expect(workerReadsLines(t)).toBe('\n  Read by the worker while working it (open the same to check it): file /fixtures/export.csv');
  });

  it('NEGATIVE CONTROL: the worker\'s read alone backs nothing; the PM\'s own read of the same file does', async () => {
    const t = readOnlyJob();
    expect(await validate(t)).toMatch(REFUSED);
    pmRead('file_read', { path: '/fixtures/export.csv' });
    expect(await validate(t)).not.toMatch(REFUSED);
    expect(upheld(t)).toBe(1);
  });

  it('NEGATIVE CONTROL: a read the worker made that FAILED is not something the PM can bind to', async () => {
    const t = readOnlyJob();
    expect(await validate(t)).toMatch(REFUSED);
    pmRead('vault_get', { entry_id: 'vault-entry-0730' });
    expect(await validate(t)).toMatch(REFUSED);
  });
});

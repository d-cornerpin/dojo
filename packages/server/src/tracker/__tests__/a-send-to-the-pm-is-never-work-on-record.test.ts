// THE C4 LOOPHOLE (v3.5 field fix 3, follow-up): A SEND TO THE PM IS NEVER WORK ON THE RECORD.
//
// The owner's ruling: "The entire point was to have the PM verify so that agents weren't just closing
// jobs on their own to get out of doing the work." C4 made a verified send to another agent count as
// work on the task's record, and so a worker could satisfy the record check by telling the PM it was
// finished. A send counts only when it DELIVERS THE WORK to the party the task serves (its requester,
// or an agent the task names). A send to the PM, to the task's validator or to any service agent never
// counts, and neither does a send whose only content is a status claim about the task.

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-pm-send-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage: async () => ({ delivered: true, threadId: 't' }) }));

import { runMigrations } from '../../db/migrations.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { keepLedgerShownFor, noteAnswerShown } from '../request-shown.js';
import { appendWorkEvent } from '../../work/store.js';
import { recordCallsTouched } from '../../work/ledger-store.js';
import { effectsFor } from '../../agent/tools/registry.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { resetEmptyUpholdRefusals } from '../empty-uphold.js';
import { resolveTaskAnswerPointer } from '../delivery-evidence.js';
import * as pmAgent from '../pm-agent.js';
import { isStatusClaimOnly } from '../../work/send-counts-as-work.js';
import { openTrackerProject, openTrackerTask } from '../../work/tracker-store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const WORKER = 'main-agent';
const PM = 'pm-agent';
const REQUESTER = 'helper-agent';
const BYSTANDER = 'other-helper';
const HEALER = 'healer-agent';
const PM_TURN = 7001;
const WORK_TURN = 1900;
let projectId = '';
let n = 0;

const db = (): Database.Database => mockDb.current!;
function newTask(createdBy = REQUESTER, title = 'Find how many rows the export holds'): string {
  return openTrackerTask({
    projectId, title, status: 'in_progress', assignedTo: WORKER, createdBy,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
}
/** One verified send_to_agent by the worker, as the transport records it: the receipt, the recipient's
 *  inbound copy, and the delivery row (which carries the receipt). Returns the call, delivery and message. */
function send(to: string, intent: string, payload: string): { call: string; delivery: string; message: string } {
  const call = `call_${++n}`;
  const at = Date.now() + n;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES (?, ?, 'a2a', 'assistant', ?, ?, ?, ?)`)
    .run(`wa-${n}`, WORKER, JSON.stringify([{ type: 'tool_use', id: call, name: 'send_to_agent', input: { agent: to, intent, payload } }]), WORK_TURN, at, at);
  const message = `11${String(n).padStart(6, '0')}-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, display_kind, a2a_thread_id, source_agent_id, created_at, sent_at) VALUES (?, ?, 'a2a', 'user', ?, 'a2a', 'thread-1', ?, ?, ?)`)
    .run(message, to, `[A2A:${intent} thread:thread-1 from:main-agent] ${payload}`, WORKER, at, at);
  db().prepare(
    `INSERT INTO tool_receipts (id, agent_id, tool, tier, verified, basis, provider_id, thread_id, recipient, turn_number, call_id)
     VALUES (?, ?, 'send_to_agent', 1, 1, 'provider-id', 'thread-1', 'thread-1', ?, ?, ?)`,
  ).run(`rcpt-${call}`, WORKER, to, WORK_TURN, call);
  const delivery = `dd${String(n).padStart(6, '0')}-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, recipient_id, message_id, receipt_id, detail, outcome, created_at)
     VALUES (?, ?, ?, 'send_to_agent', 'a2a', ?, ?, ?, ?, 'delivered', datetime('now'))`,
  ).run(delivery, WORKER, WORK_TURN, to, message, `rcpt-${call}`, `A2A ${intent}`);
  return { call, delivery, message };
}
/** The charge site's ledger write for this round. */
function charge(taskId: string, s: { call: string }, to: string, intent: string, payload: string): void {
  const calls = [{ id: s.call, name: 'send_to_agent', arguments: { agent: to, intent, payload } }];
  recordCallsTouched(taskId, calls, [{ toolCallId: s.call, isError: false, content: 'ok' }], effectsFor, WORKER);
}
/** Key 1, filed on the send's delivery (what the close floor picks: the worker's newest delivery). */
function fileClose(t: string, deliveryId: string): void {
  appendWorkEvent(t, 'validation_requested', WORKER, { requested_state: 'done', reason: 'complete', from: 'claimed', result_delivery_id: deliveryId }, Date.now() + (++n));
}
function pmRead(name: string, input: object): void {
  const id = `pm_${++n}`;
  const at = Date.now() + 1000 + n;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES (?, ?, 'a2a', 'assistant', ?, ?, ?, ?)`)
    .run(`pa-${n}`, PM, JSON.stringify([{ type: 'tool_use', id, name, input }]), PM_TURN, at, at);
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES (?, ?, 'owner', 'tool', ?, ?, ?, ?)`)
    .run(`pr-${n}`, PM, JSON.stringify([{ type: 'tool_result', tool_use_id: id, content: 'the message', is_error: false }]), PM_TURN, at, at);
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
const ledgerSends = (t: string): number => (db().prepare(`SELECT COUNT(*) AS c FROM work_ledger WHERE work_id = ? AND item_key LIKE 'send:%'`).get(t) as { c: number }).c;
const REFUSED = /^Refused: nothing on record/;

/** The worker's whole job, done the loophole's way: tell the PM it is done, and file the close. */
async function closeBySayingDoneToThePM(payload = 'done'): Promise<string> {
  const t = newTask();
  const s = send(PM, 'COMPLETE', payload);
  charge(t, s, PM, 'COMPLETE', payload);
  fileClose(t, s.delivery);
  return t;
}

beforeEach(() => {
  keepLedgerShownFor(new Set());
  n = 0;
  resetEmptyUpholdRefusals();
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [WORKER, PM, REQUESTER, BYSTANDER, HEALER]) db().prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')").run(id, id);
  // The product's own service-agent list reads these ids.
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('pm_agent_id', ?), ('healer_agent_id', ?)").run(PM, HEALER);
  clearPlatformConfigCache();
  projectId = openTrackerProject({ name: 'p', createdBy: WORKER, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null } } as never) as string;
  openTurnContext(PM).turnNumber = PM_TURN;
});
afterEach(() => { endTurnContext(PM); clearPlatformConfigCache(); mockDb.current?.close(); mockDb.current = null; });

describe('the loophole: a worker that only tells the PM it is done has nothing on record', () => {
  it('NEGATIVE CONTROL: "done" to the PM and nothing else; the close is refused for nothing on record, and stays refused after the PM reads that message', async () => {
    const t = await closeBySayingDoneToThePM();
    expect(ledgerSends(t)).toBe(0);
    expect(resolveTaskAnswerPointer(t)).toBeNull();
    expect(await validate(t)).toMatch(REFUSED);
    const msg = (db().prepare(`SELECT message_id AS m FROM deliveries WHERE agent_id = ? AND recipient_id = ?`).get(WORKER, PM) as { m: string }).m;
    pmRead('history_get', { id: msg });
    expect(await validate(t)).toMatch(REFUSED);
    expect(upheld(t)).toBe(0);
  });

  it('NEGATIVE CONTROL: a send to the PM is never work even when the PM asked for the task', async () => {
    const t = newTask(PM);
    const payload = 'The export holds 412 rows; the two duplicates are removed.';
    const s = send(PM, 'ANSWER', payload);
    charge(t, s, PM, 'ANSWER', payload);
    fileClose(t, s.delivery);
    expect(ledgerSends(t)).toBe(0);
    expect(await validate(t)).toMatch(REFUSED);
  });

  it('NEGATIVE CONTROL: a send to a service agent, or to an agent the task does not serve, is never work', async () => {
    const payload = 'The export holds 412 rows; the two duplicates are removed.';
    for (const to of [HEALER, BYSTANDER]) {
      const t = newTask();
      const s = send(to, 'ANSWER', payload);
      charge(t, s, to, 'ANSWER', payload);
      fileClose(t, s.delivery);
      expect(ledgerSends(t), to).toBe(0);
      expect(await validate(t), to).toMatch(REFUSED);
    }
  });

  it('NEGATIVE CONTROL: to the requester, a bare status claim ("task <id> is done, please validate") or a STATUS line is not the work', async () => {
    const t = newTask();
    const claim = `Task ${t.slice(0, 8)} is complete, please validate.`;
    const s = send(REQUESTER, 'COMPLETE', claim);
    charge(t, s, REQUESTER, 'COMPLETE', claim);
    const s2 = send(REQUESTER, 'STATUS', 'The export holds 412 rows; the two duplicates are removed.');
    charge(t, s2, REQUESTER, 'STATUS', 'The export holds 412 rows; the two duplicates are removed.');
    fileClose(t, s.delivery);
    expect(ledgerSends(t)).toBe(0);
    expect(await validate(t)).toMatch(REFUSED);
  });
});

describe('a real answer to the agent that asked for the task still counts', () => {
  it('the answer to the requesting agent is on the ledger and backs the uphold', async () => {
    const t = newTask();
    const payload = 'The export holds 412 rows; the two duplicates (ids 88 and 91) are removed.';
    const s = send(REQUESTER, 'ANSWER', payload);
    charge(t, s, REQUESTER, 'ANSWER', payload);
    fileClose(t, s.delivery);
    expect(ledgerSends(t)).toBe(1);
    expect(await validate(t)).not.toMatch(REFUSED);
    expect(upheld(t)).toBe(1);
  });

  it('the same answer, named by the close, is the task\'s delivered answer', () => {
    const t = newTask();
    const s = send(REQUESTER, 'ANSWER', 'The export holds 412 rows.');
    fileClose(t, s.delivery);
    expect(resolveTaskAnswerPointer(t)?.deliveryId).toBe(s.delivery);
    noteAnswerShown(t, s.delivery);
  });

  it('an agent the task names (the recipient) is served too: "Send other-helper the row count"', async () => {
    const t = newTask(WORKER, `Send ${BYSTANDER} the row count of the export`);
    const payload = 'The export holds 412 rows.';
    const s = send(BYSTANDER, 'DELIVERABLE', payload);
    charge(t, s, BYSTANDER, 'DELIVERABLE', payload);
    fileClose(t, s.delivery);
    expect(ledgerSends(t)).toBe(1);
    expect(await validate(t)).not.toMatch(REFUSED);
  });
});

describe('a status claim is told from content by the words alone', () => {
  it.each([
    ['done', true], ["I'm done.", true], ['All set, ready for your review', true], ['Task 1a2b3c4d is complete, please validate', true],
    ['Finished: Find how many rows the export holds', true],
    ['The export holds 412 rows', false], ['Done. Found 3 stale rows and removed them.', false], ['No', false],
  ])('%j -> %s', (text, expected) => {
    expect(isStatusClaimOnly(text, { id: '1a2b3c4d-0000', title: 'Find how many rows the export holds' })).toBe(expected);
  });
});

describe('the review names each answer basis truthfully', () => {
  it('a scheduled run\'s delivery and the close\'s own delivery are not called "this task\'s own answered turn"', () => {
    const labels = (pmAgent as unknown as { ANSWER_BASIS_LABEL?: Record<string, string> }).ANSWER_BASIS_LABEL;
    expect(labels?.['run-delivery']).toBe('the delivery this scheduled run settled on');
    expect(labels?.['close-request-delivery']).toBe('the delivery the worker named when it filed this close');
    expect(labels?.['task-turn-answer']).toBe('this task\'s own answered turn');
  });
});

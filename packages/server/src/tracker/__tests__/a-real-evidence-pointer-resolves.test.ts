// C6 (PM-CANNOT-APPROVE.md, v3.5 field fix 3 evidence round): A REAL EVIDENCE POINTER RESOLVES, SO THE
// PM'S READ OF WHAT IT NAMES BINDS TO THE ROW.
//
// Measured on the owner's box: the PM was refused, then read the actual message the work was (its
// verdict record lists the message under `messages`), and was refused AGAIN, four times on one row,
// twice more on another after `history_get` on the message. A read binds only to an exact id or path
// the row's record names, and the worker's pointers were prose around the id ("delivered to the PM on
// thread ffd47263 ...", "delivery 4f82ddbc"), so nothing structured named the message.
//
// What must stay true: a pointer that names nothing the worker holds (another agent's own message, an
// id that does not exist, prose with no id at all) still binds nothing.

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-c6-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage: async () => ({ delivered: true, threadId: 't' }) }));

import { runMigrations } from '../../db/migrations.js';
import { keepLedgerShownFor } from '../request-shown.js';
import { appendWorkEvent } from '../../work/store.js';
import { recordCallsTouched } from '../../work/ledger-store.js';
import { effectsFor } from '../../agent/tools/registry.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { resetEmptyUpholdRefusals } from '../empty-uphold.js';
import { rowReadNames } from '../looked-at.js';
import { resolveEvidencePointer } from '../evidence-pointers.js';
import { openTrackerProject, openTrackerTask } from '../../work/tracker-store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const WORKER = 'main-agent';
const PM = 'pm-agent';
const PM_TURN = 6551;
// The real shape: the A2A delivery row and the message it carried (the PM's own inbound copy).
const DELIVERY = '4f82ddbc-d40d-4ef3-9316-8eb3b2a10fd2';
const MESSAGE = '1bb1e8f7-b0a6-44c8-b363-bd3a23fbe379';
const PM_OWN_NOTE = '9c0ffee1-0000-4000-8000-000000000001';
let projectId = '';
let n = 0;
const db = (): Database.Database => mockDb.current!;

function seedSend(): void {
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, display_kind, a2a_thread_id, source_agent_id, created_at, sent_at) VALUES (?, ?, 'a2a', 'user', ?, 'a2a', 'ffd47263', ?, ?, ?)`)
    .run(MESSAGE, PM, '[A2A:ANSWER thread:ffd47263 from:Main] Verified independently: no export exists.', WORKER, Date.now(), Date.now());
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, message_id, outcome, created_at) VALUES (?, ?, 1804, 'send_to_agent', 'a2a', ?, 'delivered', datetime('now'))`)
    .run(DELIVERY, WORKER, MESSAGE);
  // The PM's own note: a message that exists but is not the worker's work.
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, display_kind, created_at, sent_at) VALUES (?, ?, 'a2a', 'assistant', 'my own note', 'agent-text', ?, ?)`)
    .run(PM_OWN_NOTE, PM, Date.now(), Date.now());
}
function taskWithPointer(pointer: string): string {
  const t = openTrackerTask({
    projectId, title: 'Reply on thread ffd47263', status: 'in_progress', assignedTo: WORKER, createdBy: WORKER,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
  db().prepare('UPDATE work SET evidence_json = ? WHERE id = ?').run(JSON.stringify([{ kind: 'external_action', claim: 'answered the PM, engine-verified outbound', pointer }]), t);
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at) VALUES (?, ?, 1805, 'dashboard', 'dashboard', 'delivered', datetime('now'))`).run(`d-close-${++n}`, WORKER);
  appendWorkEvent(t, 'validation_requested', WORKER, { requested_state: 'done', reason: 'complete', from: 'claimed', result_delivery_id: `d-close-${n}` }, Date.now() + n);
  return t;
}
function pmRead(name: string, input: object): void {
  const id = `pm_${++n}`;
  const at = Date.now() + 1000 + n;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, display_kind, turn_number, created_at, sent_at) VALUES (?, ?, 'a2a', 'assistant', ?, 'tool-turn', ?, ?, ?)`)
    .run(`pa-${n}`, PM, JSON.stringify([{ type: 'tool_use', id, name, input }]), PM_TURN, at, at);
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, display_kind, turn_number, created_at, sent_at) VALUES (?, ?, 'owner', 'tool', ?, 'tool-turn', ?, ?, ?)`)
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
  seedSend();
});
afterEach(() => { endTurnContext(PM); mockDb.current?.close(); mockDb.current = null; });

describe('C6: the PM reads the message a pointer names, and the uphold is no longer refused again', () => {
  it('THE OWNER\'S BOX: a pointer naming the send\'s delivery by its prefix; the PM\'s history_get on the message binds', async () => {
    const t = taskWithPointer('delivery 4f82ddbc on thread ffd47263, 16:05 PST');
    expect(await validate(t)).toMatch(REFUSED);
    pmRead('history_get', { id: MESSAGE });
    expect(await validate(t)).not.toMatch(REFUSED);
  });

  it('a pointer that carries the message id in prose resolves to that message', () => {
    const t = taskWithPointer('message 1bb1e8f7 on thread ffd47263 (agent -> PM)');
    expect(rowReadNames(t).messages).toContain(MESSAGE);
  });

  it('a send on the ledger names the message its receipt proved', () => {
    const t = taskWithPointer('RECENT OUTBOUND agent -> PM');
    db().prepare(`INSERT INTO tool_receipts (id, agent_id, tool, tier, verified, basis, call_id) VALUES ('rcpt-1', ?, 'send_to_agent', 1, 1, 'provider-id', 'call-send')`).run(WORKER);
    db().prepare('UPDATE deliveries SET receipt_id = ? WHERE id = ?').run('rcpt-1', DELIVERY);
    recordCallsTouched(t, [{ id: 'call-send', name: 'send_to_agent', arguments: { agent: PM, intent: 'ANSWER', payload: 'x' } }], [{ toolCallId: 'call-send', isError: false }], effectsFor, WORKER);
    expect(rowReadNames(t).messages).toContain(MESSAGE);
  });

  it('NEGATIVE CONTROL: prose with no id names nothing; reading the message then is still refused', async () => {
    const t = taskWithPointer('RECENT OUTBOUND [Nov 5, 2026, 04:05 PM UTC-08:00] agent -> PM');
    expect(await validate(t)).toMatch(REFUSED);
    pmRead('history_get', { id: MESSAGE });
    expect(await validate(t)).toMatch(REFUSED);
  });

  it('NEGATIVE CONTROL: an id that is not the worker\'s (the PM\'s own note) or does not exist resolves to nothing', async () => {
    expect(resolveEvidencePointer(WORKER, `see ${PM_OWN_NOTE.slice(0, 8)} and deadbeef99`)).toEqual([]);
    const t = taskWithPointer(`see ${PM_OWN_NOTE.slice(0, 8)}`);
    expect(await validate(t)).toMatch(REFUSED);
    pmRead('history_get', { id: PM_OWN_NOTE });
    expect(await validate(t)).toMatch(REFUSED);
  });
});

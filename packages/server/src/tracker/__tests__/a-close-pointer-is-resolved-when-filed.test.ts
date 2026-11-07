// C6, THE FILING HALF (v3.5 field fix 3, follow-up): EVERY EVIDENCE POINTER IS RESOLVED WHEN THE
// WORKER FILES ITS CLOSE.
//
// The worker's close door (`closeEvidenceGate` in `tracker/tools.ts`) resolves each pointer it was given
// by the engine's own rows (`resolveEvidencePointer`) and stores the result beside it as the entry's
// `ref`, so the PM's read of what the pointer names binds to the row. A pointer that names nothing is
// refused at filing, naming that pointer. No tool description changes: the refusal is the guidance.
//
// The C5 re-check after the merge: on the owner's box a sibling "Reply to ..." task was upheld only
// because the turn's shell commands were booked to it. With the booking fixed its ledger is empty, so
// its close stands on its pointer: one that names the reply's delivery is upheld once the PM reads it,
// and the reply to the agent that asked still has to be the work (a "done" to the PM never is).

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-pointer-filing-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage: async () => ({ delivered: true, threadId: 't' }) }));

import { runMigrations } from '../../db/migrations.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { keepLedgerShownFor } from '../request-shown.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { trackerUpdateStatus } from '../tools.js';
import { resetEmptyUpholdRefusals } from '../empty-uphold.js';
import { openTrackerProject, openTrackerTask } from '../../work/tracker-store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const WORKER = 'main-agent';
const PM = 'pm-agent';
const REQUESTER = 'helper-agent';
const PM_TURN = 7101;
const WORK_TURN = 1950;
let projectId = '';
let n = 0;
const db = (): Database.Database => mockDb.current!;

function replyTask(): string {
  return openTrackerTask({
    projectId, title: `Reply to ${REQUESTER} on the export question`, status: 'in_progress', assignedTo: WORKER, createdBy: REQUESTER,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
}
/** A verified send_to_agent the worker made, as the transport stores it. Not charged to any task: on the
 *  owner's box the turn's work was booked elsewhere, so the close stands on its pointer alone. */
function send(to: string, intent: string, payload: string): { delivery: string; message: string } {
  n += 1;
  const at = Date.now() + n;
  const message = `22${String(n).padStart(6, '0')}-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, display_kind, a2a_thread_id, source_agent_id, created_at, sent_at) VALUES (?, ?, 'a2a', 'user', ?, 'a2a', 'thread-9', ?, ?, ?)`)
    .run(message, to, `[A2A:${intent} thread:thread-9 from:main-agent] ${payload}`, WORKER, at, at);
  const delivery = `ee${String(n).padStart(6, '0')}-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, recipient_id, message_id, detail, outcome, created_at)
     VALUES (?, ?, ?, 'send_to_agent', 'a2a', ?, ?, ?, 'delivered', datetime('now', '+2 seconds'))`,
  ).run(delivery, WORKER, WORK_TURN, to, message, `A2A ${intent}`);
  return { delivery, message };
}
function close(t: string, pointer: string): string {
  return trackerUpdateStatus(WORKER, {
    taskId: t, status: 'complete', result: 'answered the export question',
    evidence: [{ kind: 'external_action', claim: 'replied on the thread', pointer }],
  });
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
const evidence = (t: string): Array<{ pointer?: string; ref?: unknown }> =>
  JSON.parse((db().prepare('SELECT evidence_json AS e FROM work WHERE id = ?').get(t) as { e: string | null }).e ?? '[]') as Array<{ pointer?: string; ref?: unknown }>;
const filed = (t: string): number =>
  (db().prepare(`SELECT COUNT(*) AS c FROM work_events WHERE work_id = ? AND kind = 'validation_requested'`).get(t) as { c: number }).c;
const upheld = (t: string): number => (db().prepare(`SELECT COUNT(*) AS c FROM adjudications WHERE work_id = ? AND verdict = 'upheld'`).get(t) as { c: number }).c;
const REFUSED = /^Refused: nothing on record/;

beforeEach(() => {
  keepLedgerShownFor(new Set());
  n = 0;
  resetEmptyUpholdRefusals();
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [WORKER, PM, REQUESTER]) db().prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')").run(id, id);
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('pm_agent_id', ?)").run(PM);
  clearPlatformConfigCache();
  projectId = openTrackerProject({ name: 'p', createdBy: WORKER, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null } } as never) as string;
  openTurnContext(PM).turnNumber = PM_TURN;
});
afterEach(() => { endTurnContext(PM); clearPlatformConfigCache(); mockDb.current?.close(); mockDb.current = null; });

describe('a pointer is resolved when the close is filed', () => {
  it('a pointer naming the reply\'s delivery is stored with its ref (the delivery and the message it carried)', () => {
    const t = replyTask();
    const s = send(REQUESTER, 'ANSWER', 'The export holds 412 rows; the two duplicates are removed.');
    const out = close(t, `delivery ${s.delivery.slice(0, 8)} on thread-9`);
    expect(out, out).toMatch(/\[FILED\]/);
    expect(evidence(t)[0].ref).toEqual({ kind: 'delivery', id: s.delivery, messageId: s.message });
  });

  it('NEGATIVE CONTROL: a pointer that names nothing is refused at filing, naming the pointer; no close is filed', () => {
    const t = replyTask();
    send(REQUESTER, 'ANSWER', 'The export holds 412 rows.');
    const out = close(t, 'RECENT OUTBOUND agent -> helper, 16:05');
    expect(out).toMatch(/^Error: evidence\[0\]\.pointer "RECENT OUTBOUND agent -> helper, 16:05" resolved to nothing\. A pointer must name a real delivery, message, file or receipt id/);
    expect(filed(t)).toBe(0);
    const out2 = close(t, 'deadbeef99');   // id-shaped, but no record the worker holds
    expect(out2).toMatch(/^Error: evidence\[0\]\.pointer "deadbeef99" resolved to nothing/);
    expect(filed(t)).toBe(0);
  });

  it('an absolute path is a path, spaces and all', () => {
    const t = replyTask();
    send(REQUESTER, 'ANSWER', 'The export holds 412 rows.');
    const out = close(t, '~/Documents/Some Project/export.csv');
    expect(out, out).toMatch(/\[FILED\]/);
    expect(evidence(t)[0].ref).toEqual({ kind: 'path', id: '~/Documents/Some Project/export.csv' });
  });
});

describe('C5 re-check: the "Reply to ..." close with nothing booked to it stands on its pointer', () => {
  it('a correctly pointed close is upheld once the PM reads the reply it names', async () => {
    const t = replyTask();
    const s = send(REQUESTER, 'ANSWER', 'The export holds 412 rows; the two duplicates are removed.');
    expect(close(t, `delivery ${s.delivery.slice(0, 8)}`)).toMatch(/\[FILED\]/);
    expect(await validate(t)).toMatch(REFUSED);   // the ledger is empty and nothing has been read yet
    pmRead('history_get', { id: s.message });
    expect(await validate(t)).not.toMatch(REFUSED);
    expect(upheld(t)).toBe(1);
  });

  it('NEGATIVE CONTROL: the same close pointing at a "done" sent to the PM stays refused after the PM reads it', async () => {
    const t = replyTask();
    const s = send(PM, 'COMPLETE', 'done');
    expect(close(t, `delivery ${s.delivery.slice(0, 8)}`)).toMatch(/\[FILED\]/);
    expect(await validate(t)).toMatch(REFUSED);
    pmRead('history_get', { id: s.message });
    expect(await validate(t)).toMatch(REFUSED);
    expect(upheld(t)).toBe(0);
  });
});

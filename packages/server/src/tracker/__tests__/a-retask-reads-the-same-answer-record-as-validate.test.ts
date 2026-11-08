// PM-CANNOT-APPROVE C9: THE RETASK DOOR READS THE SAME PROOF AS THE VALIDATE DOOR.
//
// On a lived-in box the retask door answered "has already had its work delivered to the user ...
// bless the close" because a close was FILED, and two seconds later the validate door refused the
// uphold because nothing was on record. The PM could neither approve nor send the work back.
// "Delivered" is now read from the one proof check both doors use (`work/done/proof.ts:proofFor`).
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-retask-answer-record-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/agent-notice.js')>()),
  redriveWithoutReply: async () => true,
}));

import { runMigrations } from '../../db/migrations.js';
import { appendWorkEvent } from '../../work/store.js';
import { openTrackerProject, openTrackerTask } from '../../work/tracker-store.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const WORKER = 'worker-agent';
const PM = 'pm-agent';
const TURN = 7;
let projectId = '';
let seq = 0;

function newTask(): string {
  return openTrackerTask({
    projectId, title: 'Send the quiet-day line', status: 'in_progress', assignedTo: WORKER, createdBy: WORKER,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
}
function fileClose(t: string): void {
  appendWorkEvent(t, 'validation_requested', WORKER, { requested_state: 'done', reason: 'quiet-day line delivered', from: 'claimed', result_delivery_id: null }, Date.now() + (++seq));
}
async function door(key: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  const out = await trackerHandlers[key]({
    agentId: PM, name: 'work_validate', callId: `v${++seq}`, args,
    toolCall: { id: `v${seq}`, name: 'work_validate', input: {} },
  } as never);
  return { content: String(out.content), isError: !!out.isError };
}
const retask = (t: string, extra: Record<string, unknown> = {}) => door('work_validate:retask', {
  action: 'retask', task_id: t, directive: 'nothing reached the owner; send the quiet-day line to them and file the close again', ...extra,
});
const validate = (t: string) => door('work_validate:validate', { action: 'validate', kind: 'complete', task_id: t, valid: true });
const stateOf = (t: string): string => (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(t) as { state: string }).state;
const pendingClose = (t: string): number => (mockDb.current!.prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'validation_requested'",
).get(t) as { n: number }).n;

beforeEach(() => {
  seq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [WORKER, PM]) mockDb.current.prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')").run(id, id);
  projectId = openTrackerProject({ name: 'p', createdBy: WORKER, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null } } as never) as string;
  openTurnContext(PM).turnNumber = TURN;
});
afterEach(() => { endTurnContext(PM); mockDb.current?.close(); mockDb.current = null; });

describe('C9: the retask door reads the same answer record as the validate door', () => {
  it('a filed close with no delivered answer on record: validate refuses it AND retask sends it back, saying nothing delivered was overwritten', async () => {
    const t = newTask();
    fileClose(t);
    expect(pendingClose(t)).toBe(1);
    const v = await validate(t);
    expect(v.content, 'the validate door: nothing on record').toMatch(/^Refused: nothing on record shows this work/);
    const r = await retask(t);
    expect(r.content, r.content).toMatch(/^\[OK\] Retasked/);
    expect(r.content).toMatch(/no delivered answer was on record, so nothing delivered was overwritten/);
    expect(r.content).not.toMatch(/already had its work delivered/);
    expect(stateOf(t)).toBe('claimed');
  });

  it('CONTROL: a filed close WITH a delivered answer on record is still protected from a silent retask', async () => {
    const t = newTask();
    fileClose(t);
    const at = Date.now();
    mockDb.current!.prepare(`INSERT INTO messages (id, agent_id, lane, role, content, created_at, sent_at) VALUES ('msg-aa11bb22', ?, 'owner', 'assistant', ?, ?, ?)`)
      .run(WORKER, 'The quiet-day line: no reports today, nothing needs you.', at, at);
    mockDb.current!.prepare(`INSERT INTO deliveries (id, agent_id, tool, channel, message_id, outcome, created_at)
      VALUES ('deliv-aa11bb22', ?, 'dashboard', 'dashboard', 'msg-aa11bb22', 'delivered', datetime('now', '+1 second'))`).run(WORKER);
    const r = await retask(t);
    expect(r.content).toMatch(/has already had its work delivered to the user/);
    expect(r.content).toMatch(/allow_regenerate=true/);
    expect(pendingClose(t), 'the close stays filed').toBe(1);
  });

  it('CONTROL: with no close filed at all, the retask message says nothing about a close', async () => {
    const t = newTask();
    const r = await retask(t);
    expect(r.content, r.content).toMatch(/^\[OK\] Retasked/);
    expect(r.content).not.toMatch(/A close was filed/);
  });
});

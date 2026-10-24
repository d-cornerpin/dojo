// ════════════════════════════════════════════════════════════════════════════════════════
// K35 — THE PM'S VERDICT SAYS WHAT IT ACTUALLY LOOKED AT.
//
// An uphold used to read "PM validated the close against the goal" whether the PM had read the
// task and opened the files or had read nothing. The PM's own tool calls this turn (the
// `messages` rows) are the complete record of its reading, so the verdict now carries them:
// `adjudications.evidence_ref` and the claim event hold the record, the uphold note is
// "PM validated: <what it read>", and the card (the audit trail the dashboard renders) shows the
// line under a rejection too. A verdict with nothing looked at still stands, and says so.
// ════════════════════════════════════════════════════════════════════════════════════════

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-k35-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

import { runMigrations } from '../../db/migrations.js';
import { openTrackerProject, openTrackerTask, setTrackerStatus, upholdClaim, throwBackClaim } from '../../work/tracker-store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { listTaskLog } from '../task-log.js';

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
function say(role: 'assistant' | 'user', content: unknown, turn = TURN): void {
  const at = Date.now() + (++msgSeq);
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, lane, role, content, turn_number, source_agent_id, created_at, sent_at) VALUES (?, ?, 'a2a', ?, ?, ?, ?, ?, ?)`,
  ).run(`m-${msgSeq}`, PM, role, typeof content === 'string' ? content : JSON.stringify(content), turn, role === 'user' ? WORKER : null, at, at);
}
const call = (name: string, input: object, turn = TURN): void => say('assistant', [{ type: 'tool_use', id: `c${msgSeq}`, name, input }], turn);
const adj = (t: string, verdict: string): { evidence_ref: string | null; note: string } =>
  mockDb.current!.prepare('SELECT evidence_ref, note FROM adjudications WHERE work_id = ? AND verdict = ? ORDER BY id DESC').get(t, verdict) as { evidence_ref: string | null; note: string };
const eventPayload = (t: string, kind: string): Record<string, unknown> =>
  JSON.parse((mockDb.current!.prepare('SELECT payload FROM work_events WHERE work_id = ? AND kind = ? ORDER BY id DESC').get(t, kind) as { payload: string }).payload);

beforeEach(() => {
  msgSeq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [WORKER, PM]) mockDb.current.prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')").run(id, id);
  projectId = openTrackerProject({ name: 'p', createdBy: WORKER, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null } } as never) as string;
  openTurnContext(PM).turnNumber = TURN;
});
afterEach(() => { endTurnContext(PM); mockDb.current?.close(); mockDb.current = null; });

describe('an uphold records what the PM read this turn', () => {
  it('a PM who read the task and a file: both are in the adjudication and the note says so', () => {
    const t = newTask();
    call('work_update', { action: 'get', task_id: t });
    call('file_read', { path: '/work/summary.md' });
    call('work_update', { action: 'get', task_id: t }, TURN - 1);   // an earlier turn does not count
    call('file_read', { path: '/work/from-last-turn.md' }, TURN - 1);
    upholdClaim(t, 'done', 'pm', PM, 'PM validated the close against the goal');

    const a = adj(t, 'upheld');
    const ref = JSON.parse(a.evidence_ref!);
    expect(ref.tasks).toEqual([t]);
    expect(ref.files).toEqual(['/work/summary.md']);
    expect(a.note).toBe('PM validated: read the task, opened 1 file');
    const ev = eventPayload(t, 'claim_upheld');
    expect((ev.looked_at as { files: string[] }).files).toEqual(['/work/summary.md']);
    expect(ev.note).toBe(a.note);
  });

  it('counts the receipts the request carried', () => {
    const t = newTask();
    say('user', 'Audit log excerpts:\n  abcd1234 engine receipts:\n    [2026-10-23 10:00:00] gmail_label VERIFIED (provider-id), id x1\n    [2026-10-23 10:00:01] gmail_send unverified (none)\n');
    upholdClaim(t, 'done', 'pm', PM, 'PM validated the close against the goal');
    expect(JSON.parse(adj(t, 'upheld').evidence_ref!).receiptsShown).toBe(2);
    expect(adj(t, 'upheld').note).toBe('PM validated: 2 receipts shown');
  });

  it('every kind of read is told apart: activity, vault, history, a tool result', () => {
    const t = newTask();
    call('work_update', { action: 'activity', task_id: t });
    call('vault_search', { query: 'quarterly summary' });
    call('history_get', { id: 'msg-1' });
    call('tool_result_read', { id: 'res-9' });
    upholdClaim(t, 'done', 'pm', PM, 'x');
    const ref = JSON.parse(adj(t, 'upheld').evidence_ref!);
    expect([ref.activity, ref.vault, ref.messages, ref.results]).toEqual([[t], ['quarterly summary'], ['msg-1'], ['res-9']]);
  });

  it('a verdict with nothing looked at still stands, and says so', () => {
    const t = newTask();
    upholdClaim(t, 'done', 'pm', PM, 'PM validated the close against the goal');
    expect(adj(t, 'upheld').note).toBe('PM validated: looked at nothing');
    expect(JSON.parse(adj(t, 'upheld').evidence_ref!).tasks).toEqual([]);
  });

  it('the PM\'s own reason on its validate call is recorded with it', () => {
    const t = newTask();
    call('work_update', { action: 'get', task_id: t });
    call('work_validate', { action: 'validate', kind: 'complete', task_id: t.slice(0, 8), valid: true, reason: 'the receipt matches the goal' });
    upholdClaim(t, 'done', 'pm', PM, 'x');
    expect(JSON.parse(adj(t, 'upheld').evidence_ref!).reason).toBe('the receipt matches the goal');
    expect(adj(t, 'upheld').note).toBe('PM validated: read the task (the receipt matches the goal)');
  });
});

describe('a rejection and a key-two close record it too', () => {
  it('a reject keeps the PM\'s reason as its note and carries the same record; the card shows the line under it', () => {
    const t = newTask();
    call('work_update', { action: 'get', task_id: t });
    call('file_read', { path: '/work/summary.md' });
    throwBackClaim(t, 'done', 'pm', PM, 'the summary file was never written');
    const a = adj(t, 'rejected');
    expect(a.note).toBe('the summary file was never written');
    expect(JSON.parse(a.evidence_ref!).files).toEqual(['/work/summary.md']);
    expect((eventPayload(t, 'claim_rejected').looked_at as { tasks: string[] }).tasks).toEqual([t]);
    const card = listTaskLog(t, { kinds: ['claim_rejected'] })[0];
    expect(card.note).toBe('the summary file was never written\nLooked at: read the task, opened 1 file');
  });

  it('a close the PM moves itself (key two) files the same record on its adjudication', () => {
    const t = newTask();
    call('work_update', { action: 'get', task_id: t });
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at) VALUES ('d-1', ?, NULL, 'dashboard', 'dashboard', 'delivered', datetime('now'))`,
    ).run(WORKER);
    const moved = setTrackerStatus(t, 'complete', { by: 'pm', actorId: PM, claim: 'authoritative', reason: 'PM validated the close against the goal', resultDeliveryId: 'd-1' });
    expect(moved.kind).toBe('applied');
    expect(JSON.parse(adj(t, 'upheld').evidence_ref!).tasks).toEqual([t]);
    const card = listTaskLog(t, { kinds: ['transition'] })[0];
    expect(card.note).toContain('Looked at: read the task');
  });
});

describe('only a live PM turn adds the record', () => {
  it('the owner\'s verdict, and a PM verdict outside any turn, read exactly as they did', () => {
    const t = newTask();
    call('work_update', { action: 'get', task_id: t });
    upholdClaim(t, 'done', 'owner', 'user', 'user marked validated');
    expect(adj(t, 'upheld')).toEqual({ evidence_ref: null, note: 'user marked validated' });
    endTurnContext(PM);
    upholdClaim(t, 'done', 'pm', PM, 'PM validated the close against the goal');
    expect(adj(t, 'upheld')).toEqual({ evidence_ref: null, note: 'PM validated the close against the goal' });
  });
});

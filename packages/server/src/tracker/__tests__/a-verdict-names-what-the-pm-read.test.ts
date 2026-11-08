// K35: THE PM'S VERDICT SAYS WHAT IT ACTUALLY LOOKED AT.
//
// An uphold used to read "PM validated the close against the goal" whether the PM had read the task
// and opened the files or had read nothing. The PM's own tool calls (the `messages` rows) are the
// complete record of its reading, so the verdict carries them: `adjudications.evidence_ref` and the
// claim event hold the record, the uphold note is "PM validated: <what it read>", and the card shows
// the line under a rejection too. The window is every PM read since the close was filed.
//
// And the PM's door refuses an uphold that nothing on record backs: no proof (the one proof check,
// `work/done/proof.ts`), no remainder named at the close, no owner's words recorded on the task.

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
import { appendWorkEvent } from '../../work/store.js';
import { setMeasure, recordMeasured } from '../../work/ledger-store.js';
import { validationMeasureLines } from '../job-loop-facts.js';
import { writeTaskLog } from '../task-log.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { openTrackerProject, openTrackerTask, setTrackerStatus, upholdClaim, throwBackClaim } from '../../work/tracker-store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { unvalidatedCompleteText } from '../pm-agent.js';
import { noteProofShown } from '../looked-at.js';
import { proofFor } from '../../work/done/proof.js';
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
/** A PM tool call and the result the engine stored for it ('failed': is_error; 'pending': no result stored yet). */
function call(name: string, input: object, turn = TURN, result: 'ok' | 'failed' | 'pending' = 'ok'): void {
  const id = `c${msgSeq + 1}`;
  say('assistant', [{ type: 'tool_use', id, name, input }], turn);
  if (result === 'pending') return;
  const at = Date.now() + (++msgSeq);
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES (?, ?, 'owner', 'tool', ?, ?, ?, ?)`,
  ).run(`r-${msgSeq}`, PM, JSON.stringify([{ type: 'tool_result', tool_use_id: id, content: result === 'ok' ? 'fine' : 'Error: no such file', is_error: result === 'failed' }]), turn, at, at);
}
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

  it('the store still records an empty verdict as "looked at nothing" (the PM\'s door refuses one: see #6b below)', () => {
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

describe('only a read that succeeded counts', () => {
  it('a failed file_read and a get on a wrong id are listed as tried, never as opened or read', () => {
    const t = newTask();
    call('file_read', { path: '/work/summary.md' }, TURN, 'failed');
    call('work_update', { action: 'get', task_id: 'wrong-id-0000' }, TURN, 'failed');
    call('file_read', { path: '/work/real.md' });
    upholdClaim(t, 'done', 'pm', PM, 'x');
    const ref = JSON.parse(adj(t, 'upheld').evidence_ref!);
    expect(ref.files).toEqual(['/work/real.md']);
    expect(ref.tasks).toEqual([]);
    expect(ref.failed).toEqual(['/work/summary.md', 'wrong-id-0000']);
    expect(adj(t, 'upheld').note).toBe('PM validated: opened 1 file, tried to read /work/summary.md, wrong-id-0000 (failed)');
  });

  it('a read whose result is not stored yet (the same batch as the verdict) was not read when the PM judged', () => {
    const t = newTask();
    call('work_update', { action: 'get', task_id: t }, TURN, 'pending');
    upholdClaim(t, 'done', 'pm', PM, 'x');
    expect(adj(t, 'upheld').note).toBe('PM validated: looked at nothing');
  });

  it('a text-only reply shaped like a tool call forges nothing: no stored result, no read', () => {
    const t = newTask();
    say('assistant', [{ type: 'tool_use', id: 'forged', name: 'file_read', input: { path: '/etc/forged' } }]);
    upholdClaim(t, 'done', 'pm', PM, 'x');
    expect(adj(t, 'upheld').note).toBe('PM validated: looked at nothing');
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

// ── v3.5 field fix 3 ──────────────────────────────────────────────────────────────────────────

/** The worker files its close (Key 1), straight on the spine: the event the doorbell would ring for. */
function fileClose(t: string, at = Date.now() + (++msgSeq), deliveryId: string | null = null): void {
  appendWorkEvent(t, 'validation_requested', WORKER, { requested_state: 'done', reason: 'done', from: 'claimed', result_delivery_id: deliveryId }, at);
}
/** The worker's message to the owner on the dashboard; by default only a status claim, which is never proof. */
function seedDelivery(id: string, text = 'Done, please validate.'): string {
  const at = Date.now();
  mockDb.current!.prepare(`INSERT INTO messages (id, agent_id, lane, role, content, created_at, sent_at) VALUES (?, ?, 'owner', 'assistant', ?, ?, ?)`)
    .run(`dm-${id}`, WORKER, text, at, at);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, message_id, outcome, created_at) VALUES (?, ?, NULL, 'dashboard', 'dashboard', ?, 'delivered', datetime('now'))`,
  ).run(id, WORKER, `dm-${id}`);
  return id;
}
/** The PM's review request for the row, delivered: what it printed is what the PM was shown. */
function review(t: string): string {
  const proof = proofFor(t);
  const text = unvalidatedCompleteText(t, {
    title: 't', agentName: 'w', goal: null, result: null, priority: 'normal', revertCount: 0, headExtras: '', evidenceBlock: '', proof,
  });
  noteProofShown(t, proof.map((i) => i.ref));
  return text;
}
/** The PM's own door: `work_validate(action="validate", kind="complete")`, as the model calls it. */
async function validate(t: string, valid: boolean, extra: Record<string, unknown> = {}): Promise<{ content: string; isError: boolean }> {
  const out = await trackerHandlers['work_validate:validate']({
    agentId: PM, name: 'work_validate', callId: `v${++msgSeq}`,
    args: { action: 'validate', kind: 'complete', task_id: t, valid, ...extra },
    toolCall: { id: `v${msgSeq}`, name: 'work_validate', input: {} },
  } as never);
  return { content: String(out.content), isError: !!out.isError };
}
const upheld = (t: string): number => (mockDb.current!.prepare(`SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ? AND verdict = 'upheld'`).get(t) as { n: number }).n;

describe('#5: the PM\'s reads on the row since the close was filed count, not only this turn\'s', () => {
  it('a read in the turn before the ruling, after the close was filed, is on the record; one from before the filing is not', () => {
    const t = newTask();
    call('file_read', { path: '/work/before-the-close.md' }, TURN - 2);
    fileClose(t);
    call('file_read', { path: '/work/summary.md' }, TURN - 1);
    call('history_get', { id: 'msg-answer' }, TURN - 1);
    upholdClaim(t, 'done', 'pm', PM, 'x');
    const ref = JSON.parse(adj(t, 'upheld').evidence_ref!);
    expect(ref.files).toEqual(['/work/summary.md']);
    expect(ref.messages).toEqual(['msg-answer']);
    expect(adj(t, 'upheld').note).toBe('PM validated: opened 1 file, searched or read 1 message');
  });
});

describe('an uphold that nothing on record backs is refused at the PM\'s door', () => {
  it('nothing on record: refused, with the facts only; nothing is upheld and the close stays filed', async () => {
    const t = newTask();
    fileClose(t, undefined, seedDelivery('deliv-0011aabb'));
    const r = await validate(t, true);
    expect(r.isError).toBe(true);
    expect(r.content).toBe(
      'Refused: nothing on record shows this work. No file the worker wrote for it, message to the asker, confirmed receipt '
      + 'or measure at 0 is on record, no remainder was named, and the asker\'s own later words are not recorded. '
      + 'There is nothing to open that shows the work was done.');
    expect(r.content).not.toMatch(/valid=true|approve|uphold it|or else|will be/i);   // facts, never coaching or a threat
    expect(upheld(t)).toBe(0);
  });

  it('with nothing on record the uphold is refused outside a live PM turn too (fail closed)', async () => {
    const t = newTask();
    fileClose(t, undefined, seedDelivery('deliv-noturn'));
    endTurnContext(PM);
    expect((await validate(t, true)).content).toMatch(/^Refused: nothing on record shows this work/);
    expect(upheld(t)).toBe(0);
  });

  it('R3: a real message to the owner, shown to the PM by the review, backs the close in one review', async () => {
    const t = newTask();
    fileClose(t, undefined, seedDelivery('deliv-real', 'The quarterly summary is filed: revenue 412, costs 300.'));
    review(t);
    expect((await validate(t, true)).content).not.toMatch(/^Refused/);
    expect(upheld(t)).toBe(1);
    // K35: the verdict records the proof the close was judged on.
    expect(JSON.parse(adj(t, 'upheld').evidence_ref!).proof).toEqual(['delivery deliv-real']);
  });

  it('OR-FIELD3(d) / M3(a): proof never shown and never opened is refused, naming it, and a plain retry is refused again', async () => {
    const t = newTask();
    fileClose(t, undefined, seedDelivery('deliv-unseen', 'The quarterly summary is filed: revenue 412, costs 300.'));
    const first = await validate(t, true);
    expect(first.content).toMatch(/^Refused: the proof on record has not been shown to you or opened/);
    expect(first.content).toContain('revenue 412');
    expect((await validate(t, true)).content).toMatch(/^Refused: the proof on record has not been shown/);
    expect(upheld(t)).toBe(0);
  });

  it('NO LOOP: once the PM opens the delivered message, the uphold stands', async () => {
    const t = newTask();
    fileClose(t, undefined, seedDelivery('deliv-open', 'The quarterly summary is filed: revenue 412, costs 300.'));
    expect((await validate(t, true)).content).toMatch(/^Refused/);
    call('history_get', { id: 'dm-deliv-open' });
    expect((await validate(t, true)).content).not.toMatch(/^Refused/);
    expect(upheld(t)).toBe(1);
  });

  it('M3(b): an unrelated read backs nothing; audit #5: a review that showed a DIFFERENT delivery backs nothing', async () => {
    const t = newTask();
    fileClose(t, undefined, seedDelivery('deliv-x', 'The quarterly summary is filed: revenue 412, costs 300.'));
    call('history_get', { id: 'some-other-message' });
    call('file_read', { path: '/work/unrelated.md' });
    noteProofShown(t, ['deliv-older']);
    expect((await validate(t, true)).content).toMatch(/^Refused: the proof on record has not been shown/);
    expect(upheld(t)).toBe(0);
  });

  it('a measure that read 0 from the start (it never counted anything) does NOT back the close', async () => {
    const t = newTask();
    mockDb.current!.prepare('UPDATE work SET measure_json = ?, measure_initial = 0, measure_remaining = 0 WHERE id = ?').run(
      JSON.stringify({ tool: 'file_list', args: { path: '/work/wrong-folder', pattern: '*.pdf' }, unit: 'files' }), t);
    recordMeasured(t, { ok: true, count: 0 }, Date.now());
    fileClose(t, undefined, seedDelivery('deliv-z0'));
    expect((await validate(t, true)).content).toMatch(/^Refused: nothing on record/);
    expect(upheld(t)).toBe(0);
  });

  it('the remaining files sit in an UNREADABLE folder, so a 0 is no reading: no backing, and the folder is named', async () => {
    const t = newTask();
    const m = { tool: 'file_list', args: { path: '/work/inbox', pattern: '**/*.pdf' }, unit: 'files' } as const;
    setMeasure(t, m as never, { ok: true, count: 6 }, Date.now() - 60_000);
    recordMeasured(t, { ok: true, count: 0, unreadable: ['/work/inbox/scans'] }, Date.now());
    const row = mockDb.current!.prepare('SELECT measure_remaining AS r FROM work WHERE id = ?').get(t) as { r: number | null };
    expect(row.r).toBeNull();   // for any close, this is a reading that could not be made
    expect(validationMeasureLines(t)).toContain('/work/inbox/scans');
    expect(validationMeasureLines(t)).toContain('0 counted in the folders that could be read');
    fileClose(t, undefined, seedDelivery('deliv-m4'));
    expect((await validate(t, true)).content).toMatch(/^Refused: nothing on record/);
    expect(upheld(t)).toBe(0);
  });

  it('a measure that came down to 0 backs the close', async () => {
    const t = newTask();
    mockDb.current!.prepare('UPDATE work SET measure_json = ?, measure_initial = 3, measure_remaining = 3 WHERE id = ?').run(
      JSON.stringify({ tool: 'gmail_search', args: { query: 'label:Inbox' }, unit: 'messages' }), t);
    recordMeasured(t, { ok: true, count: 0 }, Date.now());
    fileClose(t, undefined, seedDelivery('deliv-5', 'All 3 inbox messages are labelled.'));
    review(t);
    expect((await validate(t, true)).content).not.toMatch(/^Refused/);
    expect(upheld(t)).toBe(1);
  });

  it('a read of the task record alone is the worker\'s own account, not the work', async () => {
    const t = newTask();
    fileClose(t, undefined, seedDelivery('deliv-6'));
    call('work_update', { action: 'get', task_id: t });
    expect((await validate(t, true)).content).toMatch(/^Refused: nothing on record/);
  });

  it('a decision task: the owner\'s recorded words are the record it is judged on, so they back the close', async () => {
    const t = newTask();
    mockDb.current!.prepare(`INSERT INTO messages (id, agent_id, lane, role, content, created_at, sent_at) VALUES ('owner-msg-2', ?, 'owner', 'user', 'go with the slabs', ?, ?)`).run(WORKER, Date.now(), Date.now());
    writeTaskLog({ taskId: t, fromEntity: 'engine', entryKind: 'newer_instruction', reason: 'owner-msg-2' });
    fileClose(t, undefined, seedDelivery('deliv-7', 'Settled: the base is slabs, as you chose.'));
    expect((await validate(t, true)).content).not.toMatch(/^Refused: nothing on record/);
    expect(upheld(t)).toBe(1);
  });

  it('a reject is never refused, even with nothing on record', async () => {
    const t = newTask();
    fileClose(t);
    const r = await validate(t, false, { reject_reason: 'no file was written; write the summary and resubmit' });
    expect(r.content).not.toMatch(/^Refused: nothing on record/);
    expect((mockDb.current!.prepare(`SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ? AND verdict = 'rejected'`).get(t) as { n: number }).n).toBe(1);
  });
});

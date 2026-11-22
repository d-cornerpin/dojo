// The one proof check. A hand-in's proof is a list of references the engine resolves against its own
// rows, never prose. Each item must be real (its row exists), made by this worker and made after the
// task was opened. A status claim never resolves, a worker's own message is shown for exactly what it
// is ("the worker's own message to the asker"), and the can't-be-done kinds (failure, remainder)
// never prove a task finished. `proofFor` is the engine's finder, held to the same rule.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { freshDoneDb, doneDb, seedTask } from './helpers/done-db.js';
import { checkProof, proofFor, proofLines, type ProofItemInput } from '../proof.js';
import { EXCERPT_BYTES } from '../file-facts.js';
import { FXID } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';

const WORKER = FXID.n1;
const OTHER = FXID.n2;
const ASKER_AGENT = FXID.n3;
const STRANGER = FXID.n4;
const TASK = 'task-report';
const OTHER_TASK = 'task-other';
const HOUR = 3_600_000;
const OWN_MESSAGE = "the worker's own message to the asker";

let openedAt = 0;

/** audit_log, deliveries and tool_receipts stamp `datetime('now')`: UTC text, second resolution. */
const sqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function agent(id: string): void {
  doneDb().prepare(`INSERT OR IGNORE INTO agents (id, name, permissions) VALUES (?, ?, '{"file_read":"*"}')`).run(id, id);   // a worker that may read its own files
}

function audit(id: string, o: { agent?: string; action?: string; target: string; result?: string; detail?: string; at?: number }): void {
  doneDb().prepare(
    'INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, o.agent ?? WORKER, o.action ?? 'file_write', o.target, o.result ?? 'success', o.detail ?? null,
    sqlTime(o.at ?? Date.now()));
}

function failedReceipt(id: string): void {
  doneDb().prepare(
    `INSERT INTO tool_receipts (id, agent_id, tool, tier, verified, basis, recipient, detail, created_at)
     VALUES (?, ?, 'file_write', 1, 0, 'provider-id', NULL, '{"error":"no such file"}', ?)`,
  ).run(id, WORKER, sqlTime(Date.now()));
}

function message(id: string, o: { agent?: string; role?: string; lane?: string; content: string; from?: string | null; channel?: string | null; sender?: string | null; at?: number }): void {
  const at = Math.floor((o.at ?? Date.now()) / 1000) * 1000;
  doneDb().prepare(
    `INSERT INTO messages (id, agent_id, lane, role, content, channel, sender_id, source_agent_id, inbound_meta, authorized, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, o.agent ?? WORKER, o.lane ?? 'owner', o.role ?? 'assistant', o.content, o.channel ?? null,
    o.sender ?? null, o.from ?? null,
    // A person's inbound row carries its ingest door's stamp, as the bridge writes it (`@dojo/shared` InboundMeta).
    o.sender ? JSON.stringify({ channel: o.channel, sender: o.sender, relation: 'known_contact', authorized: true }) : null,
    at, at);
}

function delivery(id: string, o: { agent?: string; channel?: string; recipient?: string | null; tool?: string; outcome?: string; text?: string; at?: number } = {}): void {
  const msg = `msg-${id}`;
  message(msg, { agent: o.agent ?? WORKER, content: o.text ?? 'The report has 12 sections; the totals are on page 3.', at: o.at,
    lane: o.channel === 'a2a' ? 'a2a' : 'owner' });
  doneDb().prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, recipient_id, message_id, outcome, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, o.agent ?? WORKER, o.tool ?? 'auto-route', o.channel ?? 'dashboard', o.recipient ?? null, msg,
    o.outcome ?? 'delivered', sqlTime(o.at ?? Date.now()), sqlTime(o.at ?? Date.now()));
}

function workEvent(kind: string, actor: string, payload: Record<string, unknown>, workId = TASK): number {
  return Number(doneDb().prepare(
    'INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(workId, kind, JSON.stringify(payload), actor, Date.now()).lastInsertRowid);
}

function writeFile(name: string, body: string): string {
  const dir = path.join(process.env.DOJO_HOME ?? '/tmp', 'proof-files');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

/** The engine's ledger charge of a file write to a task (`work/ledger-store.ts`). */
function charge(workId: string, file: string): void {
  doneDb().prepare(`INSERT INTO work_ledger (work_id, item_key, tool, first_at, last_at) VALUES (?, ?, 'file_write', ?, ?)`)
    .run(workId, `file:${file}`, Date.now(), Date.now());
}

function askedByAgent(): void {
  doneDb().prepare("UPDATE work SET requester = 'agent', requester_id = ? WHERE id = ?").run(ASKER_AGENT, TASK);
}

const PERSON = '+15550001111';
/** The task exists for a person's iMessage (not the owner): that sender is the asker. */
function askedByPerson(): void {
  message('m-ask', { role: 'user', channel: 'imessage', sender: PERSON, content: 'Can you write up the report?', at: openedAt - 1000 });
  doneDb().prepare("UPDATE work SET source_message_id = 'm-ask' WHERE id = ?").run(TASK);
}

const finished = (items: ProofItemInput[]) => checkProof(TASK, WORKER, 'finished', items);
const cantBeDone = (items: ProofItemInput[]) => checkProof(TASK, WORKER, 'cant_be_done', items);

function refusal(r: ReturnType<typeof checkProof>): string {
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.refusals.map((x) => x.why).join('\n');
}

beforeEach(() => {
  freshDoneDb();
  runMigrations();
  for (const a of [WORKER, OTHER, ASKER_AGENT, STRANGER]) agent(a);
  seedTask(TASK, WORKER);
  seedTask(OTHER_TASK, OTHER);
  openedAt = Date.now() - 60_000;
  doneDb().prepare('UPDATE work SET opened_at = ?').run(openedAt);
});

describe('a hand-in proof must be real and this task\'s', () => {
  it('refuses a hand-in with no proof items', () => {
    expect(refusal(finished([]))).toMatch(/no proof items/);
  });

  it('refuses a can\'t be done hand-in whose only item is a delivery (no failure or remainder)', () => {
    delivery('d1');
    expect(refusal(cantBeDone([{ kind: 'delivery', ref: 'd1' }]))).toMatch(/can't be done.*needs/i);
  });

  it('refuses a status claim as an item: { kind: "delivery", ref: "task complete, please validate" }', () => {
    const why = refusal(finished([{ kind: 'delivery', ref: 'task complete, please validate' }]));
    expect(why).toContain('task complete, please validate');
    expect(why).toMatch(/never proof/);
  });

  it('refuses a delivery made by another agent', () => {
    delivery('d-other', { agent: OTHER });
    const why = refusal(finished([{ kind: 'delivery', ref: 'd-other' }]));
    expect(why).toContain('d-other');
    expect(why).toMatch(/not made by the worker/);
  });

  it('refuses a delivery made before the task was opened', () => {
    delivery('d-old', { at: openedAt - HOUR });
    const why = refusal(finished([{ kind: 'delivery', ref: 'd-old' }]));
    expect(why).toContain('d-old');
    expect(why).toMatch(/before the task was opened/);
  });

  it('refuses a delivery whose text is only a status claim to the asker', () => {
    delivery('d-claim', { text: 'Task complete, please validate.' });
    const why = refusal(finished([{ kind: 'delivery', ref: 'd-claim' }]));
    expect(why).toContain('d-claim');
    expect(why).toMatch(/only a status claim/);
  });

  it('refuses a delivery that did not go to the asker', () => {
    askedByAgent();
    delivery('d-elsewhere', { channel: 'a2a', recipient: STRANGER, tool: 'send_to_agent' });
    expect(refusal(finished([{ kind: 'delivery', ref: 'd-elsewhere' }]))).toMatch(/not addressed to the asker/);
  });

  it('refuses a file written before the task started', () => {
    const p = writeFile('old.md', 'an old report');
    audit('a-old', { target: p, at: openedAt - HOUR });
    const why = refusal(finished([{ kind: 'file', ref: p }]));
    expect(why).toContain(p);
    expect(why).toMatch(/before the task was opened/);
  });

  it('refuses a file the worker never wrote', () => {
    const p = writeFile('theirs.md', 'someone else wrote this');
    audit('a-theirs', { agent: OTHER, target: p });
    const why = refusal(finished([{ kind: 'file', ref: p }]));
    expect(why).toContain(p);
    expect(why).toMatch(/the worker never wrote/);
  });

  it('resolves a file the worker wrote after the start, with its sha256', () => {
    const body = 'The report: 12 sections, totals on page 3.';
    const p = writeFile('report.md', body);
    audit('a-mine', { target: p });
    const r = finished([{ kind: 'file', ref: p }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'file', ref: p });
    expect(r.items[0].facts).toMatchObject({
      path: p, size: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex'),
    });
    expect(typeof r.items[0].facts.mtime).toBe('string');
  });

  it('labels every delivery item "the worker\'s own message to the asker"', () => {
    delivery('d1');
    delivery('d2', { channel: 'voice', tool: 'auto-route', text: 'Sent: the 12-section report.' });
    const r = finished([{ kind: 'delivery', ref: 'd1' }, { kind: 'delivery', ref: 'd2' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.map((i) => i.label)).toEqual([OWN_MESSAGE, OWN_MESSAGE]);
    const lines = proofLines(r.items);
    expect(lines.every((l) => l.startsWith(`${OWN_MESSAGE}: `))).toBe(true);
    expect(lines[0]).toContain('12 sections');
    expect(lines.every((l) => !/delivered answer/i.test(l))).toBe(true);
  });

  it('refuses a measure that does not read zero for a finished hand-in', () => {
    doneDb().prepare(
      `UPDATE work SET measure_json = ?, measure_initial = 5, measure_remaining = 2, measure_at = ? WHERE id = ?`,
    ).run(JSON.stringify({ tool: 'file_list', args: { path: '/inbox' }, unit: 'files' }), Date.now(), TASK);
    const ev = workEvent('measured', 'engine', { ok: true, count: 2 });
    const why = refusal(finished([{ kind: 'measure', ref: String(ev) }]));
    expect(why).toContain(String(ev));
    expect(why).toMatch(/does not read 0/);
  });

  it('accepts a named remainder with a reason for cant_be_done', () => {
    const reason = 'they belong to accounts that were closed last year';
    const r = cantBeDone([{ kind: 'remainder', ref: 'the 3 archived mailboxes', facts: { reason } }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items[0]).toMatchObject({ kind: 'remainder', ref: 'the 3 archived mailboxes' });
    expect(r.items[0].facts.reason).toBe(reason);
  });

  it('refuses a failure item on a finished hand-in', () => {
    failedReceipt('r-fail');
    const why = refusal(finished([{ kind: 'failure', ref: 'r-fail' }]));
    expect(why).toContain('r-fail');
    expect(why).toMatch(/only for a can't be done hand-in/);
  });

  it('a failed receipt proves a can\'t be done hand-in; an audit id is not a proof record', () => {
    failedReceipt('r-ok');
    expect(cantBeDone([{ kind: 'failure', ref: 'r-ok' }]).ok).toBe(true);
    audit('a-err', { action: 'exec', target: 'convert report.md', result: 'error', detail: 'exit 2' });
    expect(refusal(cantBeDone([{ kind: 'failure', ref: 'a-err' }]))).toContain('a-err');
  });

  it('refuses an engine acknowledgement as a delivery', () => {
    delivery('d-ack', { tool: 'engine-ack', text: 'On it: the 12-section report.' });
    expect(refusal(finished([{ kind: 'delivery', ref: 'd-ack' }]))).toMatch(/engine's own line or acknowledgement/);
  });

  it('names a command by the text the worker ran, and refuses one that did not exit 0 for a finished hand-in', () => {
    audit('a-exit2', { action: 'exec', target: 'convert report.md', result: 'error', detail: 'exit 2 | stderr: no such file' });
    audit('a-refused', { action: 'exec', target: 'pandoc report.md', result: 'denied', detail: 'not allowed' });
    expect(refusal(finished([{ kind: 'command', ref: 'convert report.md' }]))).toMatch(/did not succeed \(exit 2\)/);
    expect(refusal(finished([{ kind: 'command', ref: 'pandoc report.md' }]))).toMatch(/did not succeed/);
    expect(cantBeDone([{ kind: 'command', ref: 'convert report.md' }]).ok).toBe(true);
    audit('a-ok', { action: 'exec', target: 'wc -l report.md', detail: '12 report.md' });
    expect(finished([{ kind: 'command', ref: 'wc -l report.md' }]).ok).toBe(true);
    audit('a-old', { action: 'exec', target: 'ls reports', at: openedAt - HOUR });
    expect(refusal(finished([{ kind: 'command', ref: 'ls reports' }]))).toMatch(/before the task was opened/);
    audit('a-theirs', { agent: OTHER, action: 'exec', target: 'du -sh reports' });
    expect(refusal(finished([{ kind: 'command', ref: 'du -sh reports' }]))).toMatch(/not a command the worker ran/);
  });

  it('refuses the same record cited twice in one hand-in, whatever the kind', () => {
    failedReceipt('r-exit2');
    expect(refusal(cantBeDone([{ kind: 'failure', ref: 'r-exit2' }, { kind: 'failure', ref: 'r-exit2' }])))
      .toMatch(/already listed in this hand-in/);
  });

  it('for a person asker, refuses a delivery to a third party and accepts one to that person', () => {
    askedByPerson();
    delivery('d-third', { channel: 'imessage', recipient: '+15550002222', tool: 'imessage_send' });
    delivery('d-person', { channel: 'imessage', recipient: PERSON, tool: 'imessage_send' });
    expect(refusal(finished([{ kind: 'delivery', ref: 'd-third' }]))).toMatch(/not addressed to the asker/);
    expect(finished([{ kind: 'delivery', ref: 'd-person' }]).ok).toBe(true);
  });

  it('hashes a large file in chunks, never reading it whole, and keeps an excerpt of at most 8 KB', () => {
    const body = 'row of the report\n'.repeat(200_000);   // about 3.6 MB
    const p = writeFile('large.md', body);
    audit('a-large', { target: p });
    const whole = vi.spyOn(fs, 'readFileSync');
    const r = finished([{ kind: 'file', ref: p }]);
    expect(whole.mock.calls.some((c) => String(c[0]) === p)).toBe(false);
    whole.mockRestore();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items[0].facts.sha256).toBe(crypto.createHash('sha256').update(body).digest('hex'));
    expect(String(r.items[0].facts.excerpt).length).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(String(r.items[0].facts.excerpt).startsWith('row of the report')).toBe(true);
  });

  it('refuses a message to another agent offered as a receipt, and one that only reports a status', () => {
    askedByAgent();
    doneDb().prepare(
      `INSERT INTO tool_receipts (id, agent_id, tool, tier, verified, basis, recipient, created_at)
       VALUES ('r-send', ?, 'send_to_agent', 1, 1, 'provider-id', ?, ?)`,
    ).run(WORKER, STRANGER, sqlTime(Date.now()));
    expect(refusal(finished([{ kind: 'receipt', ref: 'r-send' }]))).toMatch(/only as a delivery to the asker/);
    delivery('d-status', { channel: 'a2a', recipient: ASKER_AGENT, tool: 'send_to_agent', text: '[A2A:STATUS] The report has 12 sections.' });
    doneDb().prepare("UPDATE deliveries SET detail = 'A2A STATUS' WHERE id = 'd-status'").run();
    expect(refusal(finished([{ kind: 'delivery', ref: 'd-status' }]))).toMatch(/does not hand over the work/);
  });

  it('proofFor counts a measure only when the count came down to 0', () => {
    doneDb().prepare(
      `UPDATE work SET measure_json = ?, measure_initial = 5, measure_remaining = 0, measure_at = ? WHERE id = ?`,
    ).run(JSON.stringify({ tool: 'file_list', args: { path: '/inbox' }, unit: 'files' }), Date.now(), TASK);
    const ev = workEvent('measured', 'engine', { ok: true, count: 0 });
    expect(proofFor(TASK).map((i) => ({ kind: i.kind, ref: i.ref }))).toEqual([{ kind: 'measure', ref: String(ev) }]);
    doneDb().prepare('UPDATE work SET measure_initial = 0 WHERE id = ?').run(TASK);
    expect(proofFor(TASK)).toEqual([]);
  });

  it('proofFor finds the worker\'s delivery to the asker and a file write, and nothing from before the run', () => {
    const since = Date.now() - 30_000;
    doneDb().prepare(
      `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, opened_at, updated_at)
       VALUES ('run-1', 'occurrence', ?, ?, 'schedule', 'tracker', ?, 'claimed', 'task', 0, 0, ?, ?)`,
    ).run(TASK, WORKER, TASK, since, since);
    delivery('d-before', { at: since - 20_000 });
    delivery('d-new');
    delivery('d-other-agent', { agent: OTHER });
    delivery('d-ack', { tool: 'engine-ack', text: 'On it: the 12-section report.' });
    delivery('d-a2a', { channel: 'a2a', recipient: STRANGER, tool: 'send_to_agent' });
    const oldFile = writeFile('before.md', 'older work');
    audit('a-before', { target: oldFile, at: since - 20_000 });
    const newFile = writeFile('new.md', 'this task\'s work');
    audit('a-new', { target: newFile });
    const gone = path.join(path.dirname(newFile), 'deleted-since.md');
    audit('a-gone', { target: gone });
    const otherTasks = writeFile('other-task.md', 'another task\'s work');
    audit('a-other', { target: otherTasks });
    for (const [work, file] of [[TASK, newFile], [TASK, gone], [OTHER_TASK, otherTasks]]) charge(work, file);
    expect(proofFor(TASK).map((i) => ({ kind: i.kind, ref: i.ref }))).toEqual([
      { kind: 'delivery', ref: 'd-new' },
      { kind: 'file', ref: newFile },
    ]);
  });

  it('the start line of a turn is never the answer: followed by a later line in that turn, or a lone line the ask settled elsewhere', () => {
    // Each turn took up the task's request, which is what makes its first line a start line.
    const turn = (n: number, ended: boolean): void => {
      doneDb().prepare("INSERT INTO turns (agent_id, turn_number, kind, answered, ended_at, exit_reason, root_kind, root_id) VALUES (?, ?, 'user', 0, ?, ?, 'ask', 'm-src')")
        .run(WORKER, n, ended ? sqlTime(Date.now()) : null, ended ? 'answered' : null);
    };
    message('m-src', { role: 'user', content: 'Write up the report?', at: openedAt - 1000 });
    doneDb().prepare("UPDATE work SET source_message_id = 'm-src' WHERE id = ?").run(TASK);
    const inTurn = (id: string, n: number, text: string, offsetMs: number): void => {
      delivery(id, { text, at: Date.now() + offsetMs });
      doneDb().prepare('UPDATE deliveries SET turn_number = ? WHERE id = ?').run(n, id);
    };
    turn(7, false);
    inTurn('d-ack', 7, "On it, I've handed the report to a helper to write up.", 0);
    inTurn('d-answer', 7, 'The report: 12 sections, totals on page 3.', 1000);
    expect(refusal(finished([{ kind: 'delivery', ref: 'd-ack' }]))).toMatch(/start line of its turn/);
    expect(finished([{ kind: 'delivery', ref: 'd-answer' }]).ok, 'the answer counts in the same turn').toBe(true);
    // A lone line in an ended turn: the ask settled on another line, so it was the start line.
    turn(8, true);
    inTurn('d-lone', 8, "On it, I've handed the report to a helper.", 2000);
    expect(finished([{ kind: 'delivery', ref: 'd-lone' }]).ok, 'the request settled on no line yet: a lone line is just a line').toBe(true);
    doneDb().prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, result_delivery_id, opened_at, closed_at, updated_at)
       VALUES ('ask:m-src', 'ask', ?, 'owner', 'conv', 'm-src', 'done', 'answer', 1, 0, 'd-answer', ?, ?, ?)`,
    ).run(WORKER, openedAt, openedAt, openedAt);
    expect(refusal(finished([{ kind: 'delivery', ref: 'd-lone' }]))).toMatch(/start line of its turn/);
  });

  it('an answer to the asker followed by a hand-off to a helper in the same turn still counts', () => {
    doneDb().prepare("INSERT INTO turns (agent_id, turn_number, kind, answered) VALUES (?, 11, 'user', 0)").run(WORKER);
    delivery('d-ans', { text: 'The report: 12 sections, totals on page 3.' });
    delivery('d-handoff', { channel: 'a2a', recipient: STRANGER, tool: 'send_to_agent', text: '[A2A:ASSIGN] Format the report tables.', at: Date.now() + 1000 });
    doneDb().prepare("UPDATE deliveries SET turn_number = 11 WHERE id IN ('d-ans', 'd-handoff')").run();
    expect(finished([{ kind: 'delivery', ref: 'd-ans' }]).ok).toBe(true);
  });

  it('the line the ask settled on is never a start line, whatever follows it in its turn', () => {
    doneDb().prepare("INSERT INTO turns (agent_id, turn_number, kind, answered) VALUES (?, 12, 'user', 0)").run(WORKER);
    delivery('d-settled', { text: 'The report: 12 sections, totals on page 3.' });
    delivery('d-bubble', { text: 'Anything else on the report?', at: Date.now() + 1000 });
    doneDb().prepare("UPDATE deliveries SET turn_number = 12 WHERE id IN ('d-settled', 'd-bubble')").run();
    message('m-src2', { role: 'user', content: 'Write up the report?', at: openedAt - 1000 });
    doneDb().prepare("UPDATE work SET source_message_id = 'm-src2' WHERE id = ?").run(TASK);
    doneDb().prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, result_delivery_id, opened_at, closed_at, updated_at)
       VALUES ('ask:m-src2', 'ask', ?, 'owner', 'conv', 'm-src2', 'done', 'answer', 1, 0, 'd-settled', ?, ?, ?)`,
    ).run(WORKER, openedAt, openedAt, openedAt);
    expect(finished([{ kind: 'delivery', ref: 'd-settled' }]).ok).toBe(true);
  });

  it('refuses a delivery with no text on record (unknown never counts)', () => {
    doneDb().prepare(
      `INSERT INTO deliveries (id, agent_id, tool, channel, outcome, created_at, updated_at)
       VALUES ('d-bare', ?, 'dashboard', 'dashboard', 'delivered', ?, ?)`,
    ).run(WORKER, sqlTime(Date.now()), sqlTime(Date.now()));
    expect(refusal(finished([{ kind: 'delivery', ref: 'd-bare' }]))).toMatch(/no text on record/);
  });
});

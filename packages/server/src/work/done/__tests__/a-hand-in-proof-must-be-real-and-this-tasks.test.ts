// The one proof check. A hand-in's proof is a list of references the engine resolves against its own
// rows, never prose. Each item must be real (its row exists), made by this worker and made after the
// task was opened. A status claim never resolves, a worker's own message is shown for exactly what it
// is ("the worker's own message to the asker"), and the can't-be-done kinds (failure, remainder,
// withdrawal) never prove a task finished. `proofFor` is the engine's finder, held to the same rule.

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
  doneDb().prepare('INSERT OR IGNORE INTO agents (id, name) VALUES (?, ?)').run(id, id);
}

function audit(id: string, o: { agent?: string; action?: string; target: string; result?: string; detail?: string; at?: number }): void {
  doneDb().prepare(
    'INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, o.agent ?? WORKER, o.action ?? 'file_write', o.target, o.result ?? 'success', o.detail ?? null,
    sqlTime(o.at ?? Date.now()));
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

  it('refuses a can\'t be done hand-in whose only item is a delivery (no failure, remainder or withdrawal)', () => {
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
    audit('a-fail', { action: 'exec', target: 'convert report.md', result: 'error', detail: 'exit 2 | stderr: no such file' });
    const why = refusal(finished([{ kind: 'failure', ref: 'a-fail' }]));
    expect(why).toContain('a-fail');
    expect(why).toMatch(/only for a can't be done hand-in/);
  });

  it('refuses a withdrawal written by someone who is not the asker', () => {
    askedByAgent();
    message('m-stranger', { role: 'user', lane: 'a2a', from: STRANGER, content: 'We no longer need the report, drop it.' });
    const why = refusal(cantBeDone([{ kind: 'withdrawal', ref: 'm-stranger' }]));
    expect(why).toContain('m-stranger');
    expect(why).toMatch(/not from the asker/);
  });

  it('accepts a withdrawal from the agent that asked, written after the start', () => {
    askedByAgent();
    message('m-asker', { role: 'user', lane: 'a2a', from: ASKER_AGENT, content: 'We no longer need the report, drop it.' });
    const r = cantBeDone([{ kind: 'withdrawal', ref: 'm-asker' }]);
    expect(r.ok).toBe(true);
  });

  it('refuses an engine acknowledgement as a delivery', () => {
    delivery('d-ack', { tool: 'engine-ack', text: 'On it: the 12-section report.' });
    expect(refusal(finished([{ kind: 'delivery', ref: 'd-ack' }]))).toMatch(/engine's own line or acknowledgement/);
  });

  it('refuses a command that did not exit 0 for a finished hand-in, and accepts it for cant_be_done', () => {
    audit('a-exit2', { action: 'exec', target: 'convert report.md', result: 'error', detail: 'exit 2 | stderr: no such file' });
    audit('a-refused', { action: 'exec', target: 'convert report.md', result: 'denied', detail: 'not allowed' });
    expect(refusal(finished([{ kind: 'command', ref: 'a-exit2' }]))).toMatch(/did not succeed \(exit 2\)/);
    expect(refusal(finished([{ kind: 'command', ref: 'a-refused' }]))).toMatch(/did not succeed/);
    const r = cantBeDone([{ kind: 'command', ref: 'a-exit2' }]);
    expect(r.ok).toBe(true);
    audit('a-ok', { action: 'exec', target: 'wc -l report.md', detail: '12 report.md' });
    expect(finished([{ kind: 'command', ref: 'a-ok' }]).ok).toBe(true);
  });

  it('refuses the same record cited twice in one hand-in, whatever the kind', () => {
    audit('a-exit2', { action: 'exec', target: 'convert report.md', result: 'error', detail: 'exit 2' });
    expect(refusal(cantBeDone([{ kind: 'command', ref: 'a-exit2' }, { kind: 'failure', ref: 'a-exit2' }])))
      .toMatch(/already listed in this hand-in/);
  });

  it('refuses a withdrawal that is the request the task was opened for', () => {
    askedByAgent();
    message('m-src', { role: 'user', lane: 'a2a', from: ASKER_AGENT, content: 'Please write the report.' });
    doneDb().prepare("UPDATE work SET source_message_id = 'm-src' WHERE id = ?").run(TASK);
    expect(refusal(cantBeDone([{ kind: 'withdrawal', ref: 'm-src' }]))).toMatch(/the request the task was opened for/);
  });

  it('refuses a withdrawal written in the same second the task was opened, before it', () => {
    askedByAgent();
    const exact = Math.floor(Date.now() / 1000) * 1000 + 500;
    doneDb().prepare('UPDATE work SET opened_at = ? WHERE id = ?').run(exact, TASK);
    message('m-same-second', { role: 'user', lane: 'a2a', from: ASKER_AGENT, content: 'Drop it.', at: exact });
    expect(refusal(cantBeDone([{ kind: 'withdrawal', ref: 'm-same-second' }]))).toMatch(/before the task was opened/);
  });

  it('labels a withdrawal "the asker\'s message" and never judges its wording', () => {
    askedByAgent();
    message('m-any', { role: 'user', lane: 'a2a', from: ASKER_AGENT, content: 'any update?' });
    const r = cantBeDone([{ kind: 'withdrawal', ref: 'm-any' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].label).toBe("the asker's message");
  });

  it('for a person asker, refuses a delivery to a third party and accepts one to that person', () => {
    askedByPerson();
    delivery('d-third', { channel: 'imessage', recipient: '+15550002222', tool: 'imessage_send' });
    delivery('d-person', { channel: 'imessage', recipient: PERSON, tool: 'imessage_send' });
    expect(refusal(finished([{ kind: 'delivery', ref: 'd-third' }]))).toMatch(/not addressed to the asker/);
    expect(finished([{ kind: 'delivery', ref: 'd-person' }]).ok).toBe(true);
  });

  it('accepts a withdrawal from a person asker who is not the owner', () => {
    askedByPerson();
    message('m-person', { role: 'user', channel: 'imessage', sender: PERSON, content: 'Never mind the report.' });
    message('m-stranger-person', { role: 'user', channel: 'imessage', sender: '+15550002222', content: 'Never mind the report.' });
    expect(cantBeDone([{ kind: 'withdrawal', ref: 'm-person' }]).ok).toBe(true);
    expect(refusal(cantBeDone([{ kind: 'withdrawal', ref: 'm-stranger-person' }]))).toMatch(/not from the asker/);
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
    audit('a-gone', { target: path.join(path.dirname(newFile), 'deleted-since.md') });
    expect(proofFor(TASK).map((i) => ({ kind: i.kind, ref: i.ref }))).toEqual([
      { kind: 'delivery', ref: 'd-new' },
      { kind: 'file', ref: newFile },
    ]);
  });
});

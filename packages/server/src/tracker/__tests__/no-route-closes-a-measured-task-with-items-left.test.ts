// v3.5 DONE IS MEASURED, fix round 2 — NO ROUTE closes a measured task with items left unless the
// remainder is named: the engine's own closes (the same-turn receipt close, the A2A deliverable
// close request, the PM's receipt close, the join-drive card release, a group deletion's orphans,
// the scheduler's last-run and recovery closes) all cross the tracker's ONE status writer, which
// now holds the rule; the PM's own close and `complete_task` are judged at their doors.
//
// Driven through the work verbs' own door (`agent/tools/cat/tracker.ts`), because that is where
// the measure is read (it is I/O) before the synchronous close door judges it. The schema is the
// real migration chain. Two seams only: the counter (`countMeasure`, so no mailbox is read) and
// the agent's category grant (so the executor's own wall can be shown refusing).
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-measured-close-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const { countMeasure, granted } = vi.hoisted(() => ({ countMeasure: vi.fn(), granted: { value: true } }));
vi.mock('../../work/measure.js', async (orig) => ({ ...(await orig<typeof import('../../work/measure.js')>()), countMeasure }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()),
  isPMAgent: (id: string) => id === 'pm-agent-x',
}));
vi.mock('../../agent/access/read.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/access/read.js')>()),
  toolCategoryGranted: () => granted.value,
}));

import { runMigrations } from '../../db/migrations.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { setTrackerStatus } from '../../work/tracker-store.js';
import { fileAssignDeliverableCloseRequest, trackerApplyUserVerdict } from '../tools.js';
import { requestUserVerdict } from '../../work/tracker-store.js';
import { agentsHandlers } from '../../agent/tools/cat/agents.js';
import { trackerRouter } from '../../gateway/routes/tracker.js';
import { fileOverrideRequest } from '../../work/override-requests.js';

const AGENT = 'agent-measured';
const MEASURE = { tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' };
const CLOSE = { result: 'done', evidence: [{ kind: 'claim', claim: 'labelled the messages the query listed' }] };

type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>, agentId = AGENT): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId, args });

const db = (): Database.Database => mockDb.current!;
const readWork = (id: string) => db().prepare('SELECT state, measure_json, measure_initial, measure_remaining, measure_at, next_run_at FROM work WHERE id = ?').get(id) as {
  state: string; measure_json: string | null; measure_initial: number | null; measure_remaining: number | null; measure_at: number | null; next_run_at: number | null;
};
const lastEvent = (id: string, kind: string) => {
  const r = db().prepare('SELECT payload, actor FROM work_events WHERE work_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(id, kind) as { payload: string; actor: string } | undefined;
  return r ? { actor: r.actor, payload: JSON.parse(r.payload) as Record<string, unknown> } : undefined;
};
const taskIdFrom = (out: Out): string => {
  const m = /task_id=([0-9a-f-]{36})/.exec(out.content);
  if (!m) throw new Error(`no task id in: ${out.content}`);
  return m[1];
};

/** A result that reached the person — what a one-shot close points at (`deliveryForTaskClose`). */
function seedDelivery(): void {
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
    VALUES (?, ?, NULL, 'dashboard', 'dashboard', 'conv-owner', 'delivered', datetime('now', '+1 second'))`).run(`d-${Math.random()}`, AGENT);
}

async function openMeasured(initial: number, extra: Record<string, unknown> = {}): Promise<string> {
  // Re-review 2 (S2): a measure whose first reading is 0 is refused when it is set. A task "at zero" is
  // therefore one that was set with items and whose count came DOWN to 0: set at 5, then read 0.
  countMeasure.mockResolvedValueOnce({ ok: true, count: initial === 0 ? 5 : initial });
  const out = await call('work_open:task', { title: 'Sort the inbox', goal: 'every inbox message labelled', measure: MEASURE, ...extra });
  const id = taskIdFrom(out);
  if (initial === 0) db().prepare('UPDATE work SET measure_remaining = 0 WHERE id = ?').run(id);
  await call('work_update:status', { task_id: id, status: 'in_progress' });
  seedDelivery();
  return id;
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'Worker', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(AGENT);
  countMeasure.mockReset();
  granted.value = true;
});



const PM = 'pm-agent-x';
function seedPM(): void {
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'PM', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(PM);
}

describe('the status writer holds the rule for every engine and scheduler close', () => {
  for (const by of ['engine', 'scheduler', 'pm', 'healer'] as const) {
    it(`a ${by} close of a measured task whose last reading shows items left is refused`, async () => {
      const id = await openMeasured(30);
      const r = setTrackerStatus(id, 'complete', { by, actorId: by, reason: 'engine close on receipts' });
      expect(r).toMatchObject({ kind: 'refused', reason: 'measure-items-left' });
      expect(readWork(id).state).toBe('claimed');
    });
  }

  it('at zero, unmeasured, or with an outage reading, the writer is unchanged', async () => {
    const zero = await openMeasured(0);
    expect(setTrackerStatus(zero, 'complete', { by: 'engine', actorId: 'engine', reason: 'x' })).not.toMatchObject({ reason: 'measure-items-left' });
    countMeasure.mockResolvedValueOnce({ ok: false, error: '503' });
    const outage = taskIdFrom(await call('work_open:task', { title: 'Sort the outage', goal: 'g', measure: MEASURE }));
    await call('work_update:status', { task_id: outage, status: 'in_progress' });
    expect(setTrackerStatus(outage, 'complete', { by: 'engine', actorId: 'engine', reason: 'x' })).not.toMatchObject({ reason: 'measure-items-left' });
    const plain = taskIdFrom(await call('work_open:task', { title: 'Write it up', goal: 'g' }));
    await call('work_update:status', { task_id: plain, status: 'in_progress' });
    expect(setTrackerStatus(plain, 'complete', { by: 'engine', actorId: 'engine', reason: 'x' })).not.toMatchObject({ reason: 'measure-items-left' });
  });

  it('a close request the worker filed WITH a named remainder is not undone at the writer (the PM\'s Key 2 stays the PM\'s)', async () => {
    const id = await openMeasured(100);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 7 });
    expect((await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE, remainder: { disposition: 'skipped', reason: '7 are calendar invites the owner said to leave' } })).content).not.toMatch(/Refused|Error/);
    const keyTwo = setTrackerStatus(id, 'complete', { by: 'pm', actorId: PM, claim: 'authoritative', reason: 'PM validated the close' });
    expect(keyTwo).not.toMatchObject({ reason: 'measure-items-left' });
  });
});

describe('the A2A deliverable close request', () => {
  const assigned = async (count: number): Promise<string> => {
    const id = await openMeasured(count);
    db().prepare("UPDATE work SET a2a_thread_id = 'thread-assign-1' WHERE id = ?").run(id);
    return id;
  };
  it('is not filed for a measured task with items left', async () => {
    const id = await assigned(12);
    expect(await fileAssignDeliverableCloseRequest(AGENT, 'thread-assign-1', 'here is the result')).toBe(false);
    expect(lastEvent(id, 'validation_requested')).toBeUndefined();
  });
  it('is filed as before at zero', async () => {
    const id = await assigned(0);
    expect(await fileAssignDeliverableCloseRequest(AGENT, 'thread-assign-1', 'here is the result')).toBe(true);
    expect(readWork(id).state).toBe('done');   // the engine's close, as before
  });
});

describe('complete_task (a spawned agent ending)', () => {
  const apprentice = async (count: number): Promise<string> => {
    const id = await openMeasured(count);
    db().prepare("UPDATE agents SET classification = 'apprentice', task_id = ? WHERE id = ?").run(id, AGENT);
    return id;
  };
  const completeTask = (args: Record<string, unknown>) =>
    (agentsHandlers['complete_task'] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });

  it('with items left is refused BEFORE the agent is ended, naming the door that takes a remainder', async () => {
    const id = await apprentice(40);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 40 });
    const out = await completeTask({ status: 'complete', summary: 'labelled what I could' });
    expect(out.content).toMatch(/^Refused: complete_task\(status="complete"\) on a measured task\. .*still returns 40 messages/);
    expect(out.content).toContain('work_update(action="status", status="complete", remainder=');
    expect(out.isError).toBe(true);
    expect((db().prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status).not.toBe('terminated');
    expect(readWork(id).state).toBe('claimed');
  });
  it('at zero ends as before; and after a remainder was named at the status door it is not refused again', async () => {
    await apprentice(40);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
    expect((await completeTask({ status: 'complete', summary: 'all labelled' })).content).toMatch(/Task completion reported: complete/);
  });
  it('a task already closed with a named remainder lets complete_task end the agent', async () => {
    const id = await apprentice(40);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 3 });
    expect((await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE, remainder: { disposition: 'blocked', reason: 'three need the owner to log in to the other account' } })).content).not.toMatch(/Refused|Error/);
    expect((await completeTask({ status: 'complete', summary: 'done but three' })).content).toMatch(/Task completion reported: complete/);
  });
});

describe('the PM\'s own close', () => {
  it('a PM status="complete" on a measured task with items left is refused unless the remainder is named', async () => {
    seedPM();
    const id = await openMeasured(100);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 9 });
    const out = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE }, PM);
    expect(out.content).toMatch(/^Refused: status="complete" on a measured task/);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 9 });
    const named = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE, remainder: { disposition: 'skipped', reason: 'the owner said to leave these nine' } }, PM);
    expect(named.content).not.toMatch(/Refused/);
  });
  it('the PM\'s close re-reads the measure as the task\'s own agent, so a PM without the mailbox grant still gets a real count', async () => {
    seedPM();
    const id = await openMeasured(100);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 9 });
    await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE }, PM);
    expect(countMeasure.mock.calls.at(-1)![1]).toBe(AGENT);
    expect(readWork(id).measure_remaining).toBe(9);
  });
});

describe('fix round 3 (NB1): THE OWNER CAN ALWAYS CLOSE HIS OWN TASK', () => {
  const ownerNotes = (id: string): string[] => (db().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'").all(id) as Array<{ payload: string }>)
    .map((r) => r.payload).filter((p) => p.includes('Closed by the owner with'));

  it('the writer never refuses by:"owner", and records what was left', async () => {
    const id = await openMeasured(30);
    const delivery = (db().prepare('SELECT id FROM deliveries ORDER BY rowid DESC LIMIT 1').get() as { id: string }).id;
    const r = setTrackerStatus(id, 'complete', { by: 'owner', actorId: 'user', claim: 'authoritative', reason: 'the owner closed it', resultDeliveryId: delivery });
    expect(r).not.toMatchObject({ reason: 'measure-items-left' });
    expect(r.kind).toBe('applied');
    expect(ownerNotes(id)).toEqual([expect.stringContaining('Closed by the owner with 30 messages left.')]);
  });

  it('the dashboard drag to complete returns 200', async () => {
    const id = await openMeasured(30);
    const res = await trackerRouter.request(`/tasks/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'complete' }) });
    expect(res.status).toBe(200);
    expect(readWork(id).state).toBe('done');
  });

  it('the owner approving a complete override closes the task', async () => {
    const id = await openMeasured(30);
    const reqId = fileOverrideRequest(id, { requestedBy: AGENT, requestedStatus: 'complete', justification: 'the rest are not mine to do' });
    const res = await trackerRouter.request(`/override-requests/${reqId}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: true, reason: 'leave the rest' }) });
    expect(res.status).toBe(200);
    expect(readWork(id).state).toBe('done');
  });

  it('the owner\'s project close closes its measured tasks too', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 42 });
    const out = await call('work_open:project', { title: 'Mailbox clean-up', level: 1, allow_duplicate: true, plan: { approach: 'Label the inbox, then write it up.', steps: [{ title: 'Label the inbox', how: 'gmail_label in batches', done: 'the search returns 0' }] }, tasks: [{ title: 'Label the inbox', measure: MEASURE }] });
    const project = /project_id=([0-9a-f-]{36})/.exec(out.content)![1];
    const res = await trackerRouter.request(`/projects/${project}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'complete', reason: 'good enough for me' }) });
    expect(res.status).toBe(200);
    const open = db().prepare("SELECT COUNT(*) AS n FROM work WHERE parent_id = ? AND state NOT IN ('done', 'failed', 'abandoned')").get(project) as { n: number };
    expect(open.n).toBe(0);
  });
});

describe('fix round 4: a stalemate verdict is the owner\'s only when his own words are on record', () => {
  const awaiting = (id: string): boolean => (db().prepare(
    "SELECT (SELECT MAX(id) FROM work_events WHERE work_id = ? AND kind = 'user_verdict_requested') > COALESCE((SELECT MAX(id) FROM work_events WHERE work_id = ? AND kind = 'user_verdict_cleared'), -1) AS a",
  ).get(id, id) as { a: number }).a === 1;
  const ownerSays = (content: string, over: Record<string, unknown> = {}): void => {
    const row = {
      id: `m-${Math.random()}`, agent_id: AGENT, conversation_id: 'conv-owner', lane: 'owner', role: 'user', content,
      channel: 'dashboard', authorized: 1, provenance: 'live', display_kind: 'unclassified', display_tier: 'user-visible',
      inbound_meta: JSON.stringify({ channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' }),
      ...over,
    };
    const cols = Object.keys(row);
    db().prepare(`INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row);
  };
  async function stalemated(): Promise<string> {
    const id = await openMeasured(30);
    requestUserVerdict(id, PM, { status_requested: 'complete' });
    return id;
  }

  it('a quote found verbatim in the owner\'s own message since the request closes the task, as the owner', async () => {
    const id = await stalemated();
    ownerSays('Yes, close it. The rest can wait until next week.');

    const out = await trackerApplyUserVerdict(PM, { task_id: id, status: 'complete', user_quote: 'The rest can wait until next week.' });
    expect(out).not.toMatch(/^Error|Refused/);
    expect(readWork(id).state).toBe('done');
    const notes = (db().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'").all(id) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload).note as string);
    expect(notes).toContain('Closed by the owner with 30 messages left.');
  });

  for (const [why, setup] of [
    ['no owner message holds the quote', () => ownerSays('Something else entirely.')],
    ['the quote is in an agent\'s own reply, not the owner\'s', () => ownerSays('The rest can wait until next week.', { role: 'assistant', inbound_meta: null })],
    ['the quote is in a row the platform wrote to itself (no channel)', () => ownerSays('The rest can wait until next week.', { channel: null, inbound_meta: null })],
    ['the quote is in a message from a contact, not the owner', () => ownerSays('The rest can wait until next week.', { channel: 'imessage', inbound_meta: JSON.stringify({ channel: 'imessage', sender: '+15550100', authorized: true }) })],
  ] as const) {
    it(`unverified (${why}): the close is the PM's, and the remainder rule refuses it`, async () => {
      const id = await stalemated();
      setup();
      const out = await trackerApplyUserVerdict(PM, { task_id: id, status: 'complete', user_quote: 'The rest can wait until next week.' });
      expect(out).toMatch(/was refused\. Its measure still returned \d+ \w+ when last read, so the task is not done\./);
      expect(readWork(id).state).toBe('claimed');
      expect(awaiting(id)).toBe(true);
    });
  }

  // fix round 5 (re-review 4): a FRAGMENT never verifies; a real reply survives case, curly quotes and newlines.
  const verdictOn = async (owner: string, quote: string, over: Record<string, unknown> = {}): Promise<{ out: string; state: string }> => {
    const id = await stalemated();
    ownerSays(owner, over);
    const out = await trackerApplyUserVerdict(PM, { task_id: id, status: 'complete', user_quote: quote });
    return { out, state: readWork(id).state };
  };
  for (const [owner, quote] of [
    ['Do not close it.', 'close it'],
    ['No.', 'o'],
    ['No, don\'t mark it complete yet, there are 30 left.', 'mark it complete'],
  ] as const) {
    it(`a fragment is refused: owner "${owner}", quoted "${quote}"`, async () => {
      const r = await verdictOn(owner, quote);
      expect(r.out).toMatch(/was refused\. Its measure still returned \d+ \w+ when last read, so the task is not done\./);
      expect(r.state).toBe('claimed');
    });
  }
  for (const [owner, quote] of [
    ['Close it', 'close it'],
    ['It’s fine, close it', "It's fine, close it"],
    ['Close it.\nThe rest can wait', 'Close it. The rest can wait'],
    ['Thanks for asking!\nclose it.', 'Close it'],
  ] as const) {
    it(`a real reply is accepted across case, curly quotes and newlines: ${JSON.stringify(owner)} / ${JSON.stringify(quote)}`, async () => {
      const r = await verdictOn(owner, quote);
      expect(r.out).not.toMatch(/^Error|Refused/);
      expect(r.state).toBe('done');
    });
  }
  it('the owner\'s own iMessage counts (the bridge stamps him as the owner)', async () => {
    const r = await verdictOn('[SOURCE: IMESSAGE FROM Owner] Close it.', 'close it', {
      channel: 'imessage', inbound_meta: JSON.stringify({ channel: 'imessage', sender: '+15550199', authorized: true, relation: 'owner' }),
    });
    expect(r.state).toBe('done');
  });
  const emailRow = (from: string): Record<string, unknown> => ({
    channel: 'email', lane: 'owner',
    inbound_meta: JSON.stringify({ channel: 'email', accountKind: 'agent', authorized: true, sender: from, emailService: 'gmail' }),
  });
  const emailBody = (preview: string): string => `[SOURCE: GMAIL NOTIFICATION — agent@box (agent)]\n\n[DIRECT MESSAGE] x emailed you.\n\nFrom: x\nSubject: Re: verdict\nDate: today\nPreview: ${preview}\nMessage ID: 1\nUse \`gmail_read\` to read the full body.`;
  // fix round 6 (orchestrator ruling): email is never the owner's verified word. A sender is only a
  // From header, and an email carries the agent's own quoted question back at the PM.
  it('an email reply, even from the owner\'s own mailbox, never verifies a quote', async () => {
    db().prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, 'owner@home.example', 1)").run();
    const r = await verdictOn(emailBody('Yes. Close it, I&#39;ll do the rest.'), "close it, I'll do the rest", emailRow('owner@home.example'));
    expect(r.out).toMatch(/was refused\. Its measure still returned \d+ \w+ when last read, so the task is not done\./);
    expect(r.state).toBe('claimed');
  });
  it('an email from anyone else is not the owner', async () => {
    db().prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, 'owner@home.example', 1)").run();
    const r = await verdictOn(emailBody('Close it.'), 'close it', emailRow('someone@else.example'));
    expect(r.out).toMatch(/was refused\. Its measure still returned \d+ \w+ when last read, so the task is not done\./);
  });
  it('the agent\'s own question, quoted back in an owner-mailbox reply, never verifies', async () => {
    db().prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, 'owner@home.example', 1)").run();
    const r = await verdictOn(emailBody('Not yet. On Mon, the agent wrote: > 30 messages are still left. Close it now? Or keep going?'), 'Close it now', emailRow('owner@home.example'));
    expect(r.out).toMatch(/was refused\. Its measure still returned \d+ \w+ when last read, so the task is not done\./);
    expect(r.state).toBe('claimed');
  });
  // P44 (owner ruling 2026-10-27): the owner's email counts as him ONLY when the mail watcher stamped it — after the
  // provider's own check confirmed it — and then ONLY his new words (`ownerWords`, quoted text already cut) count.
  const verifiedEmailRow = (words: string | undefined, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    channel: 'email', lane: 'owner',
    inbound_meta: JSON.stringify({ channel: 'email', accountKind: 'agent', authorized: true, sender: 'owner@home.example', emailService: 'gmail', relation: 'owner', ownerWordsAt: Date.now() + 60_000, ...(words === undefined ? {} : { ownerWords: words }), ...over }),
  });
  it('P44: an email the provider confirmed as the owner\'s verifies his new words, like his text', async () => {
    const r = await verdictOn(emailBody('Yes. Close it. (preview, quoted: Close it now)'), 'close it', verifiedEmailRow('Yes. Close it.'));
    expect(r.out).not.toMatch(/^Error|Refused/);
    expect(r.state).toBe('done');
  });
  for (const [why, owner, quote, row] of [
    ['the notice and preview are never his words, only ownerWords are', emailBody('Close it.'), 'close it', verifiedEmailRow('Something else entirely.')],
    ['a quoted older sentence that is not in his new words', emailBody('Close it.'), 'close it now', verifiedEmailRow('Not yet.')],
    ['a stamped owner with no new words at all', emailBody('Close it.'), 'close it', verifiedEmailRow('')],
    ['a row stamped owner but carrying no ownerWords field', emailBody('Close it.'), 'close it', verifiedEmailRow(undefined)],
    ['an owner email the provider received BEFORE the question was asked (a replay with a fresh Date header)', emailBody('Close it.'), 'close it', verifiedEmailRow('Close it.', { ownerWordsAt: 1_000 })],
    ['an owner email with no provider receive time', emailBody('Close it.'), 'close it', verifiedEmailRow('Close it.', { ownerWordsAt: undefined })],
    ['ownerWords without the watcher\'s owner stamp (unconfirmed email)', emailBody('Close it.'), 'close it', verifiedEmailRow('Close it.', { relation: 'known_contact' })],
    ['ownerWords on the owner\'s own inbox (user slot) row', emailBody('Close it.'), 'close it', verifiedEmailRow('Close it.', { accountKind: 'user' })],
    ['ownerWords on a text-message row (the field means nothing off email)', '[SOURCE: IMESSAGE FROM x] Hello', 'hello', { channel: 'imessage', inbound_meta: JSON.stringify({ channel: 'imessage', sender: '+15550100', authorized: true, relation: 'known_contact', ownerWords: 'Hello' }) }],
  ] as const) {
    it(`P44 unverified (${why}): refused`, async () => {
      const r = await verdictOn(owner, quote, row);
      expect(r.out).toMatch(/was refused\. Its measure still returned \d+ \w+ when last read, so the task is not done\./);
      expect(r.state).toBe('claimed');
    });
  }
  it('the owner\'s dashboard reply still verifies when an email with the same words is also on record', async () => {
    db().prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, 'owner@home.example', 1)").run();
    const id = await stalemated();
    ownerSays(emailBody('Close it.'), emailRow('owner@home.example'));
    ownerSays('Close it.');
    const out = await trackerApplyUserVerdict(PM, { task_id: id, status: 'complete', user_quote: 'close it' });
    expect(out).not.toMatch(/^Error|Refused/);
    expect(readWork(id).state).toBe('done');
  });

  it('the owner\'s words from BEFORE the verdict was asked do not count', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 30 });
    const id = taskIdFrom(await call('work_open:task', { title: 'Sort the inbox', goal: 'g', measure: MEASURE }));
    ownerSays('The rest can wait until next week.', { sent_at: Date.now() - 60_000 });
    await call('work_update:status', { task_id: id, status: 'in_progress' });
    seedDelivery();
    requestUserVerdict(id, PM, { status_requested: 'complete' });
    const out = await trackerApplyUserVerdict(PM, { task_id: id, status: 'complete', user_quote: 'The rest can wait until next week.' });
    expect(out).toMatch(/was refused\. Its measure still returned \d+ \w+ when last read, so the task is not done\./);
    expect(readWork(id).state).toBe('claimed');
  });

  // fix round 7: a QUESTION is never approval. "Close it?" asks; it does not say.
  for (const [owner, quote] of [
    ['Close it? Not yet.', 'Close it'],
    ['Close it?', 'Close it'],
  ] as const) {
    it(`a question is never approval: owner "${owner}", quoted "${quote}"`, async () => {
      const r = await verdictOn(owner, quote);
      expect(r.out).toMatch(/was refused\. Its measure still returned \d+ \w+ when last read, so the task is not done\./);
      expect(r.state).toBe('claimed');
    });
  }
  for (const [owner, quote] of [
    ['Close it.', 'Close it'],
    ['Close it', 'Close it'],
    ['ok. Close it!', 'Close it'],
    ['Close it.\nThe rest can wait', 'Close it'],
  ] as const) {
    it(`a statement still approves: ${JSON.stringify(owner)} / ${JSON.stringify(quote)}`, async () => {
      const r = await verdictOn(owner, quote);
      expect(r.out).not.toMatch(/^Error|Refused/);
      expect(r.state).toBe('done');
    });
  }
});

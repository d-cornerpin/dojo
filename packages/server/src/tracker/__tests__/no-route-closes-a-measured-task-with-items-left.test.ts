// v3.5 DONE IS MEASURED, fix round 2 — NO ROUTE closes a measured task with items left unless the
// remainder is named: every route, the engine's own hand-ins and `complete_task` included, reaches
// the one hand-in door, which holds the rule; only the owner closes directly.
//
// Driven through the work verbs' own door (`agent/tools/cat/tracker.ts`), because that is where
// the measure is read (it is I/O) before the synchronous close door judges it. The schema is the
// real migration chain. Two seams only: the counter (`countMeasure`, so no mailbox is read) and
// the agent's category grant (so the executor's own wall can be shown refusing).
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
import { decide } from '../../work/done/decide.js';
import { appendWorkEvent } from '../../work/store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

/** The owner was asked about this task (the ask his words must come after). */
const requestUserVerdict = (id: string, _by: string, _detail: unknown): void => { appendWorkEvent(id, 'validation_escalated', 'scheduler', { thread_id: null }); };
/** An agent relaying the owner's decision: his own words, checked against his messages (`work/done/decide.ts`). */
const trackerApplyUserVerdict = async (agent: string, a: { task_id: string; status: string; user_quote: string }): Promise<string> =>
  decide({ workId: a.task_id, deciderAgentId: agent, verdict: 'approve', reason: 'the owner decided it', ownerQuote: a.user_quote }).text;
import { agentsHandlers } from '../../agent/tools/cat/agents.js';
import { trackerRouter } from '../../gateway/routes/tracker.js';

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
  const id = `d-${Math.random()}`;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, created_at, sent_at) VALUES (?, ?, 'owner', 'assistant', 'The labelled messages are listed in the summary.', ?, ?)`)
    .run(`m-${id}`, AGENT, Date.now(), Date.now());
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
    VALUES (?, ?, NULL, 'dashboard', 'dashboard', 'conv-owner', ?, 'delivered', datetime('now', '+1 second'))`).run(id, AGENT, `m-${id}`);
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
  db().prepare(`INSERT OR IGNORE INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'PM', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(PM);
}

describe('the status writer holds the rule for every engine and scheduler close', () => {
  for (const by of ['engine', 'scheduler', 'pm', 'healer'] as const) {
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

});

describe('complete_task (a spawned agent ending)', () => {
  const apprentice = async (count: number): Promise<string> => {
    const id = await openMeasured(count);
    db().prepare("UPDATE agents SET classification = 'apprentice', task_id = ? WHERE id = ?").run(id, AGENT);
    return id;
  };
  const completeTask = (args: Record<string, unknown>) =>
    (agentsHandlers['complete_task'] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });

  it('with items left the hand-in is refused BEFORE the agent is ended, naming the remainder it takes', async () => {
    const id = await apprentice(40);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 40 });
    const out = await completeTask({ status: 'complete', summary: 'labelled what I could' });
    expect(out.content).toMatch(/^Refused: the hand-in of "Sort the inbox".*\n- Its measure still lists 40 items/);
    // Names the hand-in that takes a remainder, as a fact, with no "close it with" menu.
    expect(out.content).toContain("can't be done with a remainder item");
    expect(out.content).toContain('work_update(action="hand_in"');
    expect(out.content).not.toMatch(/close it with/);
    expect(out.isError).toBe(true);
    expect((db().prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status).not.toBe('terminated');
    expect(readWork(id).state).toBe('claimed');
  });
  it('at zero it hands the task in on its measure and ends the agent', async () => {
    const id = await apprentice(40);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
    expect((await completeTask({ status: 'complete', summary: 'all labelled' })).content).toMatch(/Task completion reported: complete/);
    expect(readWork(id).state).toBe('handed_in');
  });
  it('a task handed in with a named remainder lets complete_task end the agent', async () => {
    const id = await apprentice(40);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 3 });
    const handIn = await call('work_update:hand_in', { task_id: id, outcome: 'cant_be_done', proof: [{ kind: 'remainder', ref: '3 messages', reason: 'three need the owner to log in to the other account' }], note: 'done but three' });
    expect(handIn.isError, handIn.content).toBe(false);
    expect((await completeTask({ status: 'complete', summary: 'done but three' })).content).toMatch(/Task completion reported: complete/);
  });
});


describe('fix round 3 (NB1): THE OWNER CAN ALWAYS CLOSE HIS OWN TASK', () => {
  const ownerNotes = (id: string): string[] => (db().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'").all(id) as Array<{ payload: string }>)
    .map((r) => r.payload).filter((p) => p.includes('Closed by the owner with'));


  it('the dashboard drag to complete returns 200', async () => {
    const id = await openMeasured(30);
    const res = await trackerRouter.request(`/tasks/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'complete' }) });
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
  // v3.5 field fix 3 (owner ruling b): an unverified quote is no longer judged as the PM's close (which the
  // remainder rule then refused); it is refused at the verdict door itself, for every status.
  const NOT_THE_OWNERS = /^Refused: the owner's words could not be verified: .*Nothing changed\.$/;
  const awaiting = (id: string): boolean => (db().prepare(
    "SELECT (SELECT MAX(id) FROM work_events WHERE work_id = ? AND kind = 'user_verdict_requested') > COALESCE((SELECT MAX(id) FROM work_events WHERE work_id = ? AND kind = 'user_verdict_cleared'), -1) AS a",
  ).get(id, id) as { a: number }).a === 1;
  afterEach(() => endTurnContext(PM));
  /** The owner writes to the PM, the agent that relays his words here, in a turn answering that message. */
  const ownerSays = (content: string, over: Record<string, unknown> = {}): void => {
    seedPM();
    const row = {
      id: `m-${Math.random()}`, agent_id: PM, conversation_id: 'conv-owner', lane: 'owner', role: 'user', content,
      channel: 'dashboard', authorized: 1, provenance: 'live', display_kind: 'unclassified', display_tier: 'user-visible',
      inbound_meta: JSON.stringify({ channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' }),
      ...over,
    };
    const cols = Object.keys(row);
    db().prepare(`INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row);
    openTurnContext(PM).root = { kind: 'ask', id: row.id, sourceMessageId: row.id };
  };
  /** A measured task handed in with its remainder, and the owner asked about it. */
  async function stalemated(): Promise<string> {
    const id = await openMeasured(30);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 30 });
    const handIn = await call('work_update:hand_in', { task_id: id, outcome: 'cant_be_done', proof: [{ kind: 'remainder', ref: '30 messages', reason: 'the owner keeps these until next week' }], note: 'thirty left for the owner' });
    expect(handIn.isError, handIn.content).toBe(false);
    requestUserVerdict(id, PM, { status_requested: 'complete' });
    return id;
  }

  it('the owner\'s whole message since the request, quoted verbatim, closes the task, as the owner', async () => {
    const id = await stalemated();
    ownerSays('Yes, close it. The rest can wait until next week.');

    const out = await trackerApplyUserVerdict(PM, { task_id: id, status: 'complete', user_quote: 'Yes, close it. The rest can wait until next week.' });
    expect(out).not.toMatch(/^Error|Refused/);
    expect(readWork(id).state).toBe('failed');
  });

  for (const [why, setup] of [
    ['no owner message holds the quote', () => ownerSays('Something else entirely.')],
    ['the quote is in an agent\'s own reply, not the owner\'s', () => ownerSays('The rest can wait until next week.', { role: 'assistant', inbound_meta: null })],
    ['the quote is in a row the platform wrote to itself (no channel)', () => ownerSays('The rest can wait until next week.', { channel: null, inbound_meta: null })],
    ['the quote is in a message from a contact, not the owner', () => ownerSays('The rest can wait until next week.', { channel: 'imessage', inbound_meta: JSON.stringify({ channel: 'imessage', sender: '+15550100', authorized: true }) })],
  ] as const) {
    it(`unverified (${why}): the verdict is refused at the door, nothing changes`, async () => {
      const id = await stalemated();
      setup();
      const out = await trackerApplyUserVerdict(PM, { task_id: id, status: 'complete', user_quote: 'The rest can wait until next week.' });
      expect(out).toMatch(NOT_THE_OWNERS);
      expect(readWork(id).state).toBe('handed_in');
    });
  }

  // fix round 5 (re-review 4): a FRAGMENT, or one sentence of a longer message, never approves; a real reply survives case, curly quotes and newlines.
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
    ['Thanks for asking!\nclose it.', 'Close it'],
    ['ok. Close it!', 'Close it'],
    ['Close it.\nThe rest can wait', 'Close it'],
  ] as const) {
    it(`a fragment is refused: owner "${owner}", quoted "${quote}"`, async () => {
      const r = await verdictOn(owner, quote);
      expect(r.out).toMatch(NOT_THE_OWNERS);
      expect(r.state).toBe('handed_in');
    });
  }
  for (const [owner, quote] of [
    ['Close it', 'close it'],
    ['It’s fine, close it', "It's fine, close it"],
    ['Close it.\nThe rest can wait', 'Close it. The rest can wait'],
  ] as const) {
    it(`a real reply is accepted across case, curly quotes and newlines: ${JSON.stringify(owner)} / ${JSON.stringify(quote)}`, async () => {
      const r = await verdictOn(owner, quote);
      expect(r.out).not.toMatch(/^Error|Refused/);
      expect(r.state).toBe('failed');
    });
  }
  it('the owner\'s own iMessage counts (the bridge stamps him as the owner)', async () => {
    const r = await verdictOn('[SOURCE: IMESSAGE FROM Owner] Close it.', 'close it', {
      channel: 'imessage', inbound_meta: JSON.stringify({ channel: 'imessage', sender: '+15550199', authorized: true, relation: 'owner' }),
    });
    expect(r.state).toBe('failed');
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
    expect(r.out).toMatch(NOT_THE_OWNERS);
    expect(r.state).toBe('handed_in');
  });
  it('an email from anyone else is not the owner', async () => {
    db().prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, 'owner@home.example', 1)").run();
    const r = await verdictOn(emailBody('Close it.'), 'close it', emailRow('someone@else.example'));
    expect(r.out).toMatch(NOT_THE_OWNERS);
  });
  it('the agent\'s own question, quoted back in an owner-mailbox reply, never verifies', async () => {
    db().prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, 'owner@home.example', 1)").run();
    const r = await verdictOn(emailBody('Not yet. On Mon, the agent wrote: > 30 messages are still left. Close it now? Or keep going?'), 'Close it now', emailRow('owner@home.example'));
    expect(r.out).toMatch(NOT_THE_OWNERS);
    expect(r.state).toBe('handed_in');
  });
  // P44 (owner ruling 2026-10-27): the owner's email counts as him ONLY when the mail watcher stamped it — after the
  // provider's own check confirmed it — and then ONLY his new words (`ownerWords`, quoted text already cut) count.
  const verifiedEmailRow = (words: string | undefined, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    channel: 'email', lane: 'owner',
    inbound_meta: JSON.stringify({ channel: 'email', accountKind: 'agent', authorized: true, sender: 'owner@home.example', emailService: 'gmail', relation: 'owner', ownerWordsAt: Date.now() + 60_000, ...(words === undefined ? {} : { ownerWords: words }), ...over }),
  });
  it('P44: an email the provider confirmed as the owner\'s verifies his new words, like his text', async () => {
    const r = await verdictOn(emailBody('Yes. Close it. (preview, quoted: Close it now)'), 'yes. close it', verifiedEmailRow('Yes. Close it.'));
    expect(r.out).not.toMatch(/^Error|Refused/);
    expect(r.state).toBe('failed');
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
      expect(r.out).toMatch(NOT_THE_OWNERS);
      expect(r.state).toBe('handed_in');
    });
  }
  it('the owner\'s dashboard reply still verifies when an email with the same words is also on record', async () => {
    db().prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, 'owner@home.example', 1)").run();
    const id = await stalemated();
    ownerSays(emailBody('Close it.'), emailRow('owner@home.example'));
    ownerSays('Close it.');
    const out = await trackerApplyUserVerdict(PM, { task_id: id, status: 'complete', user_quote: 'close it' });
    expect(out).not.toMatch(/^Error|Refused/);
    expect(readWork(id).state).toBe('failed');
  });

  it('the owner\'s words from BEFORE the verdict was asked do not count', async () => {
    ownerSays('The rest can wait until next week.', { sent_at: Date.now() - 60_000 });
    const id = await stalemated();
    const out = await trackerApplyUserVerdict(PM, { task_id: id, status: 'complete', user_quote: 'The rest can wait until next week.' });
    expect(out).toMatch(NOT_THE_OWNERS);
    expect(readWork(id).state).toBe('handed_in');
  });

  // fix round 7: a QUESTION is never approval. "Close it?" asks; it does not say.
  for (const [owner, quote] of [
    ['Close it? Not yet.', 'Close it'],
    ['Close it?', 'Close it'],
  ] as const) {
    it(`a question is never approval: owner "${owner}", quoted "${quote}"`, async () => {
      const r = await verdictOn(owner, quote);
      expect(r.out).toMatch(NOT_THE_OWNERS);
      expect(r.state).toBe('handed_in');
    });
  }
  for (const [owner, quote] of [
    ['Close it.', 'Close it'],
    ['Close it', 'Close it'],
  ] as const) {
    it(`a statement still approves: ${JSON.stringify(owner)} / ${JSON.stringify(quote)}`, async () => {
      const r = await verdictOn(owner, quote);
      expect(r.out).not.toMatch(/^Error|Refused/);
      expect(r.state).toBe('failed');
    });
  }
});

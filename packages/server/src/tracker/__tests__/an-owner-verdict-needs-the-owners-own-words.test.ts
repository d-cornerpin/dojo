// v3.5 field fix 3 (owner ruling b): "THE OWNER APPROVED" IS ACCEPTED ONLY WHEN THE OWNER'S WORDS ARE
// REALLY IN THE CONVERSATION.
//
// `work_validate(action="apply_user_validation")` and `work_validate(action="apply_user_verdict")` record the
// owner's approval or rejection from a `user_quote` the MODEL supplies. The only check was a non-empty string,
// so any agent holding the verb could approve any task, its own included, by inventing the owner's words.
// The owner's point of the PM review: agents must not close jobs on their own to get out of the work.
//
// The rule, at both doors: the quote must be the owner's own words (`tracker/owner-words.ts`, the platform's
// one "the owner wrote this" answer), sent AFTER he was asked about this task. With no ask on record, only
// the owner's message this turn is answering (and later ones in its conversation) count. Anything else is
// refused, nothing changes, and the refusal is written to the task's log. The dashboard's own verdict doors
// carry the owner's authenticated request, not a quote, and are unchanged.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-owner-own-words', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { recordValidationEscalation, requestUserVerdict } from '../../work/tracker-store.js';
import { trackerApplyUserValidation, trackerApplyUserVerdict } from '../tools.js';
import { trackerRouter } from '../../gateway/routes/tracker.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const AGENT = 'own-words-agent';
const PRIMARY = 'own-words-primary';
const TASK = 'task-own-words-0001';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'Worker', 'idle', 'sensei')").run(AGENT);
  db().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'Main', 'idle', 'sensei')").run(PRIMARY);
  seedTrackerTask(db(), { id: TASK, agentId: AGENT, status: 'in_progress', title: 'sort the labels', opened_at: Date.now(), updated_at: Date.now(), priority: 'normal' } as never);
});
afterEach(() => { endTurnContext(PRIMARY); });

const setState = (state: string): void => { db().prepare('UPDATE work SET state = ? WHERE id = ?').run(state, TASK); };
const state = (): string => (db().prepare('SELECT state FROM work WHERE id = ?').get(TASK) as { state: string }).state;
const adjudications = (): number => (db().prepare('SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ?').get(TASK) as { n: number }).n;
const eventKinds = (): string[] => (db().prepare('SELECT kind FROM work_events WHERE work_id = ? ORDER BY id').all(TASK) as { kind: string }[]).map((r) => r.kind);
const taskLog = (): string => (db().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit' ORDER BY id").all(TASK) as { payload: string }[]).map((r) => r.payload).join('\n');

/** A message row. Defaults: the owner typing in the dashboard, one second after now (after any ask). */
function says(content: string, over: Record<string, unknown> = {}): string {
  const row = {
    id: `m-${Math.random()}`, agent_id: PRIMARY, conversation_id: 'conv-owner', lane: 'owner', role: 'user', content,
    channel: 'dashboard', authorized: 1, provenance: 'live', display_kind: 'unclassified', display_tier: 'user-visible',
    inbound_meta: JSON.stringify({ channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' }),
    sent_at: Date.now() + 1000,
    ...over,
  };
  const cols = Object.keys(row);
  db().prepare(`INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row);
  return row.id as string;
}
const before = { sent_at: Date.now() - 120_000 };

/** Snapshot of everything a refused call must leave alone. */
const snapshot = () => ({ state: state(), adjudications: adjudications(), kinds: eventKinds().filter((k) => k !== 'audit') });

describe('apply_user_validation: the owner approved only if the owner really said so', () => {
  beforeEach(() => { setState('blocked'); recordValidationEscalation(TASK, 'scheduler', 'conv-owner'); });

  it('a made-up quote is refused, nothing changes, and the refusal is on the task log', async () => {
    says('Something else entirely.');
    const was = snapshot();
    const out = await trackerApplyUserValidation(PRIMARY, { task_id: TASK, validated: true, user_quote: 'Yes, it is really blocked.' });
    expect(out).toMatch(/^Error: /);
    expect(out).toContain('Nothing was changed');
    expect(out).toMatch(/Ask .* call again with user_quote set to the exact words of the reply/);
    expect(snapshot()).toEqual(was);
    expect(taskLog()).toContain('owner quote not verified');
  });

  it('a made-up rejection is refused too: the task is not thrown back', async () => {
    const was = snapshot();
    const out = await trackerApplyUserValidation(PRIMARY, { task_id: TASK, validated: false, user_quote: 'No, redo it.' });
    expect(out).toMatch(/^Error: /);
    expect(snapshot()).toEqual(was);
  });

  for (const [why, over] of [
    ['an agent\'s own reply', { role: 'assistant', inbound_meta: null }],
    ['a row the engine wrote (no channel)', { channel: null, inbound_meta: null, lane: 'events' }],
    ['an A2A message from another agent', { source_agent_id: AGENT, lane: 'a2a', inbound_meta: null }],
    ['a contact who is not the owner', { channel: 'imessage', inbound_meta: JSON.stringify({ channel: 'imessage', sender: '+15550100', authorized: true }) }],
  ] as const) {
    it(`a quote of ${why} is refused`, async () => {
      says('Yes, it is really blocked.', over as Record<string, unknown>);
      const was = snapshot();
      const out = await trackerApplyUserValidation(PRIMARY, { task_id: TASK, validated: true, user_quote: 'Yes, it is really blocked.' });
      expect(out).toMatch(/^Error: /);
      expect(snapshot()).toEqual(was);
    });
  }

  it('the owner\'s real reply after the ask is accepted, with the same success text', async () => {
    says('“Yes, it is really blocked.” The vendor has not answered.');
    const out = await trackerApplyUserValidation(PRIMARY, { task_id: TASK, validated: true, user_quote: 'yes, it is really blocked' });
    expect(out).toBe('[OK] task "sort the labels" (task-own) marked validated by user (blocked_validated=1). Bug icon cleared.');
  });

  it('the owner\'s real "no" after the ask throws the task back', async () => {
    says('No');
    const out = await trackerApplyUserValidation(PRIMARY, { task_id: TASK, validated: false, user_quote: 'no', feedback: 'clear the label' });
    expect(out).toMatch(/^\[OK\] task "sort the labels" \(task-own\) reverted to in_progress\./);
    expect(state()).toBe('claimed');
  });

  it('the owner\'s real message from BEFORE the ask is refused', async () => {
    says('Yes, it is really blocked.', before);
    const was = snapshot();
    const out = await trackerApplyUserValidation(PRIMARY, { task_id: TASK, validated: true, user_quote: 'Yes, it is really blocked.' });
    expect(out).toMatch(/^Error: /);
    expect(snapshot()).toEqual(was);
  });
});

describe('apply_user_validation with no ask on record: only the owner message this turn is answering counts', () => {
  beforeEach(() => { setState('blocked'); });

  it('the owner\'s message that started this turn verifies', async () => {
    const msg = says('The labels job is blocked, yes.');
    openTurnContext(PRIMARY).root = { kind: 'ask', id: msg, sourceMessageId: msg, conversationId: 'conv-owner' };
    const out = await trackerApplyUserValidation(PRIMARY, { task_id: TASK, validated: true, user_quote: 'the labels job is blocked, yes' });
    expect(out).toMatch(/^\[OK\]/);
  });

  it('an older owner message is refused even inside an owner turn', async () => {
    says('The labels job is blocked, yes.', before);
    const msg = says('How are things going?');
    openTurnContext(PRIMARY).root = { kind: 'ask', id: msg, sourceMessageId: msg, conversationId: 'conv-owner' };
    const was = snapshot();
    const out = await trackerApplyUserValidation(PRIMARY, { task_id: TASK, validated: true, user_quote: 'The labels job is blocked, yes.' });
    expect(out).toMatch(/^Error: /);
    expect(snapshot()).toEqual(was);
  });

  it('outside an owner turn, even a recent owner message is refused', async () => {
    says('The labels job is blocked, yes.');
    const was = snapshot();
    const out = await trackerApplyUserValidation(PRIMARY, { task_id: TASK, validated: true, user_quote: 'The labels job is blocked, yes.' });
    expect(out).toMatch(/^Error: /);
    expect(snapshot()).toEqual(was);
  });

  it('a turn whose root message is not the owner\'s does not verify', async () => {
    const msg = says('The labels job is blocked, yes.', { channel: 'imessage', inbound_meta: JSON.stringify({ channel: 'imessage', sender: '+15550100', authorized: true }) });
    openTurnContext(PRIMARY).root = { kind: 'ask', id: msg, sourceMessageId: msg, conversationId: 'conv-owner' };
    const out = await trackerApplyUserValidation(PRIMARY, { task_id: TASK, validated: true, user_quote: 'The labels job is blocked, yes.' });
    expect(out).toMatch(/^Error: /);
  });
});

describe('apply_user_verdict: the same rule for every status, not only complete', () => {
  beforeEach(() => { requestUserVerdict(TASK, 'pm', { status_requested: 'complete' }); });

  for (const status of ['on_deck', 'cancelled', 'complete']) {
    it(`a made-up quote for status="${status}" is refused and the stalemate stays`, async () => {
      const was = snapshot();
      const out = await trackerApplyUserVerdict('pm', { task_id: TASK, status, user_quote: 'just drop it' });
      expect(out).toMatch(/^Error: /);
      expect(out).toContain('Nothing was changed');
      expect(snapshot()).toEqual(was);
      expect(taskLog()).toContain('owner quote not verified');
    });
  }

  it('an agent\'s row with the words is refused', async () => {
    says('Park it for now.', { role: 'assistant', inbound_meta: null });
    const out = await trackerApplyUserVerdict('pm', { task_id: TASK, status: 'on_deck', user_quote: 'park it for now' });
    expect(out).toMatch(/^Error: /);
  });

  it('the owner\'s message from before the ask is refused', async () => {
    says('Park it for now.', before);
    const out = await trackerApplyUserVerdict('pm', { task_id: TASK, status: 'on_deck', user_quote: 'park it for now' });
    expect(out).toMatch(/^Error: /);
  });

  it('the owner\'s real reply after the ask is applied with the same success text', async () => {
    says('Park it for now.');
    const out = await trackerApplyUserVerdict('pm', { task_id: TASK, status: 'on_deck', user_quote: 'park it for now' });
    expect(out).toBe('[OK] user verdict applied on "sort the labels" (task-own). Status="on_deck". Quote logged. Stalemate cleared.');
  });
});

describe('the dashboard door keeps working by the owner\'s own request, with no quote', () => {
  it('POST /tasks/:id/user-validate still validates', async () => {
    setState('blocked');
    const res = await trackerRouter.request(`/tasks/${TASK}/user-validate`, { method: 'POST' });
    expect(res.status).toBe(200);
    const upheld = (db().prepare("SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ? AND verdict = 'upheld'").get(TASK) as { n: number }).n;
    expect(upheld).toBe(1);
  });
});

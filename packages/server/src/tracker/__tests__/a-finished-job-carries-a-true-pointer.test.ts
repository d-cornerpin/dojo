// UX-REPAIR ROUND 2 / T11 — A FINISHED JOB CARRIES A TRUE POINTER TO ITS ANSWER.
//
// ── THE FOUR BROKEN LINKS (investigation-round2.md §2, measured on the live box) ──
//  1. `deliveryForTaskClose` resolved "the newest delivery by this agent since the task
//     opened". On S4 (2026-08-10) the task opened 06:11:11 and the close was filed 06:15:14,
//     so the newest delivery in that span was the 06:11:16 acknowledgement — *"On it — I've
//     handed Squarespace to one helper and WordPress to another"* — recorded as the task's
//     `result_delivery_id`. `tool <> 'engine-ack'` did not catch it because the ack was
//     MODEL-authored on the dashboard and is indistinguishable at the ledger from an answer.
//  2. The compiled rundown (`8eb0439c`) carried `root_kind=''`/`root_id=''` — turn 4555 was a
//     bare wake with no subject — so no reverse lookup could find it either.
//  3. The Key-2 review payload selects only the `work` row's own prose (`pm-agent.ts:1441`),
//     while the same payload orders the PM to "Read the file/audit log/output referenced in
//     evidence". 7 `validation_review_miss` rows and ~40 `history_search` calls followed.
//  4. `PM-SOUL.md:66` tells the PM to use `vault_get`; the gate never allowed it.
//
// requirement preserved (G7, `work/store.ts:301-317`): a close that really did deliver in its
// own turn still resolves its receipt, so a legitimate close is never turned into a
// `done-requires-delivery` refusal. That control is the second clause below and it is the one
// that bounds this narrowing.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-true-pointer-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { deliveryForTaskClose, openTrackerTask } from '../../work/tracker-store.js';
import { openAsk, claimAsk, stampClaimingTurn, askIdForMessage } from '../../work/store.js';
import { resolveTaskAnswerPointer } from '../delivery-evidence.js';
import { pmMayCall, PM_ALLOWED_TOOLS } from '../pm-agent.js';

const AGENT = 'behaviorbot';
const CONV = 'conv-owner';
const OWNER_MSG = 'msg-owner-1';

function seedTurn(n: number, opts: { answerMessageId?: string | null } = {}): void {
  mockDb.current!.prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, started_at, ended_at, exit_reason, answered, answer_message_id)
     VALUES (?, ?, 'user', 'conv', datetime('now'), datetime('now'), 'answered', 1, ?)`,
  ).run(AGENT, n, opts.answerMessageId ?? null);
}

function seedMessage(id: string, content: string, turn: number | null): void {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number, created_at)
     VALUES (?, ?, 'assistant', ?, 'owner', ?, ?, ?)`,
  ).run(id, AGENT, content, CONV, turn, Date.now());
}

function seedDelivery(
  id: string, o: { turn: number | null; messageId?: string | null; tool?: string; offsetSeconds?: number },
): void {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, ?, ?, 'dashboard', ?, ?, 'delivered', datetime('now', ?))`,
  ).run(id, AGENT, o.turn, o.tool ?? 'dashboard', CONV, o.messageId ?? null, `+${(o.offsetSeconds ?? 0) + 5} seconds`);
}

/** A tracker task exactly as the tool path opens one. */
function seedTask(id: string, over: { sourceMessageId?: string | null } = {}): string {
  return openTrackerTask({
    id, title: 'synthesize the two research pieces', status: 'in_progress',
    assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: over.sourceMessageId ?? null, turn: null, convKey: null },
  });
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'BehaviorBot', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, AGENT);
});

describe('T11 (1): an acknowledgement from an earlier turn can no longer be a close receipt', () => {
  it('THE S4 FIXTURE: the "On it — I\'ve handed…" ack from the delegating turn is NOT picked', () => {
    seedTurn(4552);
    seedMessage('msg-ack', "On it — I've handed Squarespace to one helper and WordPress to another to dig into.", 4552);
    seedDelivery('a133f5e1', { turn: 4552, messageId: 'msg-ack' });
    const taskId = seedTask('task-s4');
    // the close is filed on turn 4553 — the agent is on 4553 now
    seedTurn(4553);
    expect(deliveryForTaskClose(taskId)).toBeNull();
  });

  it('G7 CONTROL: a close that really did deliver in its own turn still resolves its receipt', () => {
    seedTurn(4552);
    const taskId = seedTask('task-same-turn');
    seedMessage('msg-answer', 'Here is the combined rundown: Squarespace $276/yr…', 4552);
    seedDelivery('d-answer', { turn: 4552, messageId: 'msg-answer' });
    expect(deliveryForTaskClose(taskId)).toBe('d-answer');
  });

  it('a delivery from a LATER turn still resolves (the answer arriving after the close request)', () => {
    seedTurn(4552);
    const taskId = seedTask('task-later');
    seedTurn(4555);
    seedMessage('msg-rundown', 'the combined rundown', 4555);
    seedDelivery('8eb0439c', { turn: 4555, messageId: 'msg-rundown' });
    expect(deliveryForTaskClose(taskId)).toBe('8eb0439c');
  });

  it('a delivery with NO turn stamp is still eligible (1,372 of 14,810 rows on the live box)', () => {
    // The narrowing only removes deliveries we can PROVE belong to an earlier turn. An
    // unstamped delivery — the a2a hand-off, an alert, an owner-close — is unchanged.
    seedTurn(4552);
    const taskId = seedTask('task-null-turn');
    seedTurn(4553);
    seedDelivery('d-unstamped', { turn: null, tool: 'send_to_agent' });
    expect(deliveryForTaskClose(taskId)).toBe('d-unstamped');
  });
});

describe('T11 (3): the task→ask edge is stamped at create', () => {
  it('a task opened on a turn holding a claimed ask records that ask\'s source message', () => {
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at)
       VALUES (?, ?, 'user', 'compare squarespace and wordpress', 'owner', ?, ?)`,
    ).run(OWNER_MSG, AGENT, CONV, Date.now());
    openAsk({
      agentId: AGENT, messageId: OWNER_MSG, conversationId: CONV, requesterId: 'owner',
      openedAt: Date.now(), title: 'compare squarespace and wordpress',
    });
    const askId = askIdForMessage(OWNER_MSG);
    claimAsk(askId, AGENT);
    seedTurn(4552);
    stampClaimingTurn(askId, 4552);

    const taskId = seedTask('task-edged');
    const row = mockDb.current!.prepare('SELECT source_message_id FROM work WHERE id = ?')
      .get(taskId) as { source_message_id: string | null };
    expect(row.source_message_id).toBe(OWNER_MSG);
    // …and the edge is resolvable back to the ask with the existing derivation.
    expect(askIdForMessage(row.source_message_id!)).toBe(askId);
  });

  it('CONTROL: an explicit origin is never overwritten', () => {
    const taskId = seedTask('task-explicit', { sourceMessageId: 'msg-explicit' });
    const row = mockDb.current!.prepare('SELECT source_message_id FROM work WHERE id = ?')
      .get(taskId) as { source_message_id: string | null };
    expect(row.source_message_id).toBe('msg-explicit');
  });

  it('CONTROL: a turn holding no claimed ask stamps nothing', () => {
    seedTurn(4552);
    const taskId = seedTask('task-no-ask');
    const row = mockDb.current!.prepare('SELECT source_message_id FROM work WHERE id = ?')
      .get(taskId) as { source_message_id: string | null };
    expect(row.source_message_id).toBeNull();
  });
});

describe('T11 (4): the review payload can resolve a dereferenceable pointer', () => {
  it('the pointer is the ANSWER, not the ack, and it carries an excerpt', () => {
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at)
       VALUES (?, ?, 'user', 'compare squarespace and wordpress', 'owner', ?, ?)`,
    ).run(OWNER_MSG, AGENT, CONV, Date.now());
    openAsk({
      agentId: AGENT, messageId: OWNER_MSG, conversationId: CONV, requesterId: 'owner',
      openedAt: Date.now(), title: 'compare squarespace and wordpress',
    });
    const askId = askIdForMessage(OWNER_MSG);
    claimAsk(askId, AGENT);
    seedTurn(4552);
    stampClaimingTurn(askId, 4552);
    const taskId = seedTask('task-pointed');

    // the ack, and then the real rundown three turns later
    seedMessage('msg-ack', "On it — I've handed Squarespace to one helper…", 4552);
    seedDelivery('a133f5e1', { turn: 4552, messageId: 'msg-ack' });
    seedTurn(4555, { answerMessageId: 'msg-rundown' });
    seedMessage('msg-rundown', 'Squarespace is $276/yr all-in; WordPress needs separate hosting. My pick: Squarespace.', 4555);
    seedDelivery('8eb0439c', { turn: 4555, messageId: 'msg-rundown', offsetSeconds: 10 });
    // the ask settles on the rundown, exactly as `compile_resolved` records it
    mockDb.current!.prepare(`UPDATE work SET result_delivery_id = ? WHERE id = ?`).run('8eb0439c', askId);

    const p = resolveTaskAnswerPointer(taskId);
    expect(p).not.toBeNull();
    expect(p!.deliveryId).toBe('8eb0439c');
    expect(p!.excerpt).toContain('Squarespace is $276/yr');
    expect(p!.excerpt).not.toContain("On it —");
  });

  it('CONTROL: nothing delivered yet resolves to null rather than to something confidently wrong', () => {
    const taskId = seedTask('task-nothing');
    expect(resolveTaskAnswerPointer(taskId)).toBeNull();
  });
});

describe('T11 (5): the PM gate matches the prompt that names the tool', () => {
  it('vault_get is callable by the PM (PM-SOUL.md:66 names it)', () => {
    expect(pmMayCall('vault_get')).toBe(true);
    expect(PM_ALLOWED_TOOLS).toContain('vault_get');
  });

  it('CONTROL: the gate did not widen anywhere else — a write tool is still refused', () => {
    expect(pmMayCall('file_write')).toBe(false);
    expect(pmMayCall('vault_forget')).toBe(false);
    expect(pmMayCall('work_validate', { action: 'apply_user_verdict' })).toBe(true);
  });
});

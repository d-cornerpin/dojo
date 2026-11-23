// A FINISHED JOB CARRIES A TRUE POINTER TO ITS ANSWER.
//
// The close points at the newest message to the asker the one proof check accepts
// (`work/done/proof.ts:proofDelivery`), never one sent before the task was opened, and the review shows
// that message labelled as the worker's own (design 5b). Also pinned here: the task-to-ask edge is
// stamped at create, and the PM's gate allows the `vault_get` its soul names and nothing more.
//
// requirement preserved (G7, `work/store.ts`): a close that really did deliver still resolves its
// receipt, so a legitimate close is never turned into a `done-requires-delivery` refusal.

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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-true-pointer-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { openTrackerTask } from '../../work/tracker-store.js';
import { openAsk, claimAsk, stampClaimingTurn, askIdForMessage } from '../../work/store.js';
import { proofDelivery, proofFor, proofLines } from '../../work/done/proof.js';
import { pmMayCall, PM_ALLOWED_TOOLS } from '../pm-agent.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const AGENT = 'harnessbot';
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
  id: string, o: { turn: number | null; messageId?: string | null; tool?: string; offsetSeconds?: number; serving?: string },
): void {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at, root_kind, root_id)
     VALUES (?, ?, ?, ?, 'dashboard', ?, ?, 'delivered', datetime('now', ?), ?, ?)`,
  ).run(id, AGENT, o.turn, o.tool ?? 'dashboard', CONV, o.messageId ?? null, `+${(o.offsetSeconds ?? 0) + 5} seconds`,
    o.serving ? 'ask' : null, o.serving ?? null);
  // The turn that served the request is rooted on it, as the delivery's own stamp says.
  if (o.serving) mockDb.current!.prepare("UPDATE turns SET root_kind = 'ask', root_id = ? WHERE agent_id = ? AND turn_number = ?").run(o.serving, AGENT, o.turn);
}

/** A tracker task exactly as the tool path opens one, inside the agent's live turn `turn` when given. */
function seedTask(id: string, over: { sourceMessageId?: string | null; turn?: number } = {}): string {
  if (over.turn !== undefined) openTurnContext(AGENT).turnNumber = over.turn;
  try {
    return openTrackerTask({
      id, title: 'synthesize the two research pieces', status: 'in_progress',
      assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'agent', sourceMessageId: over.sourceMessageId ?? null, turn: null, convKey: null },
    });
  } finally { endTurnContext(AGENT); }
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'HarnessBot', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, AGENT);
});

describe('the close receipt is a message to the asker made during the task', () => {
  it('an acknowledgement delivered before the task was opened is NOT picked', () => {
    seedTurn(4552);
    seedMessage('msg-ack', "On it, I've handed Squarespace to one helper and WordPress to another to dig into.", 4552);
    seedDelivery('a133f5e1', { turn: 4552, messageId: 'msg-ack' });
    mockDb.current!.prepare("UPDATE deliveries SET created_at = datetime('now', '-60 seconds') WHERE id = 'a133f5e1'").run();
    const taskId = seedTask('task-s4');
    seedTurn(4553);
    expect(proofDelivery(taskId)).toBeNull();
  });

  it('THE S4 SHAPE: the delegating turn\'s lone "On it, I\'ve handed Squarespace to a helper" is NOT the answer once the ask settles on the rundown', () => {
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at)
       VALUES ('msg-owner-s4', ?, 'user', 'compare squarespace and wordpress', 'owner', ?, ?)`,
    ).run(AGENT, CONV, Date.now());
    openAsk({ agentId: AGENT, messageId: 'msg-owner-s4', conversationId: CONV, requesterId: 'owner', openedAt: Date.now(), title: 'compare' });
    const askId = askIdForMessage('msg-owner-s4');
    claimAsk(askId, AGENT);
    seedTurn(4552);
    const taskId = seedTask('task-s4-open', { sourceMessageId: 'msg-owner-s4' });
    seedMessage('msg-ack-s4', "On it, I've handed Squarespace to one helper and WordPress to another to dig into.", 4552);
    seedDelivery('a133f5e2', { turn: 4552, messageId: 'msg-ack-s4', serving: 'msg-owner-s4' });
    seedTurn(4555);
    seedMessage('msg-rundown-s4', 'Squarespace is $276/yr all-in; WordPress needs separate hosting.', 4555);
    seedDelivery('8eb0439d', { turn: 4555, messageId: 'msg-rundown-s4', offsetSeconds: 10, serving: 'msg-owner-s4' });
    mockDb.current!.prepare(`UPDATE work SET result_delivery_id = '8eb0439d' WHERE id = ?`).run(askId);
    expect(proofFor(taskId).map((i) => i.ref)).toEqual(['8eb0439d']);
    expect(proofDelivery(taskId)).toBe('8eb0439d');
  });

  it('G7 CONTROL: a close that really did deliver resolves its receipt', () => {
    seedTurn(4552);
    const taskId = seedTask('task-same-turn', { sourceMessageId: OWNER_MSG });
    seedMessage('msg-answer', 'Here is the combined rundown: Squarespace $276/yr…', 4552);
    seedDelivery('d-answer', { turn: 4552, messageId: 'msg-answer', serving: OWNER_MSG });
    expect(proofDelivery(taskId)).toBe('d-answer');
  });

  it('a delivery from a LATER turn resolves (the answer arriving after the close request)', () => {
    seedTurn(4552);
    const taskId = seedTask('task-later', { sourceMessageId: OWNER_MSG });
    seedTurn(4555);
    seedMessage('msg-rundown', 'the combined rundown', 4555);
    seedDelivery('8eb0439c', { turn: 4555, messageId: 'msg-rundown', serving: OWNER_MSG });
    expect(proofDelivery(taskId)).toBe('8eb0439c');
  });
});

describe('the task→ask edge is stamped at create', () => {
  it('a task opened in a live turn holding a claimed ask records that ask\'s source message', () => {
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

    const taskId = seedTask('task-edged', { turn: 4552 });
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

  it('a task opened on a turn that took up two requests links to neither: which one it is for is not on record', () => {
    seedTurn(4552);
    for (const [id, text] of [[OWNER_MSG, 'compare squarespace and wordpress'], ['msg-owner-2', 'and find me a domain name']]) {
      mockDb.current!.prepare(`INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at) VALUES (?, ?, 'user', ?, 'owner', ?, ?)`)
        .run(id, AGENT, text, CONV, Date.now());
      openAsk({ agentId: AGENT, messageId: id, conversationId: CONV, requesterId: 'owner', openedAt: Date.now(), title: text });
      claimAsk(askIdForMessage(id), AGENT);
      stampClaimingTurn(askIdForMessage(id), 4552);
    }
    const taskId = seedTask('task-two-asks', { turn: 4552 });
    expect(mockDb.current!.prepare('SELECT source_message_id FROM work WHERE id = ?').get(taskId)).toEqual({ source_message_id: null });
  });

  it('CONTROL: a turn holding no claimed ask stamps nothing', () => {
    seedTurn(4552);
    const taskId = seedTask('task-no-ask', { turn: 4552 });
    const row = mockDb.current!.prepare('SELECT source_message_id FROM work WHERE id = ?')
      .get(taskId) as { source_message_id: string | null };
    expect(row.source_message_id).toBeNull();
  });
});

describe('the review can show the answer it points at', () => {
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
    const taskId = seedTask('task-pointed', { turn: 4552 });

    // the ack, and then the real rundown three turns later
    seedMessage('msg-ack', "On it, I've handed Squarespace to one helper…", 4552);
    seedDelivery('a133f5e1', { turn: 4552, messageId: 'msg-ack' });
    seedTurn(4555, { answerMessageId: 'msg-rundown' });
    seedMessage('msg-rundown', 'Squarespace is $276/yr all-in; WordPress needs separate hosting. My pick: Squarespace.', 4555);
    seedDelivery('8eb0439c', { turn: 4555, messageId: 'msg-rundown', offsetSeconds: 10, serving: OWNER_MSG });
    // the ask settles on the rundown, exactly as `compile_resolved` records it
    mockDb.current!.prepare(`UPDATE work SET result_delivery_id = ? WHERE id = ?`).run('8eb0439c', askId);

    expect(proofDelivery(taskId)).toBe('8eb0439c');
    const lines = proofLines(proofFor(taskId));
    expect(lines[lines.length - 1]).toContain('Squarespace is $276/yr');
    expect(lines.every((l) => l.startsWith("the worker's own message to the asker: "))).toBe(true);
  });

  it('CONTROL: nothing delivered yet resolves to null rather than to something confidently wrong', () => {
    const taskId = seedTask('task-nothing');
    expect(proofDelivery(taskId)).toBeNull();
  });
});

describe('the PM gate matches the prompt that names the tool', () => {
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

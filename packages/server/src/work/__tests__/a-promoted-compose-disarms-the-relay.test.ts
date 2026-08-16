// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 12 T52, THE OTHER HALF — A PROMOTED COMPOSE DISARMS T48's RELAY EXACTLY
// LIKE A DELIVERED ANSWER, AND BY THE SAME READ.
//
// T52 promotes the model's owed compiled answer at
// `agent/v2/steps/post-call-classify/terminal-text.ts` when it rides with a tool call, instead
// of demoting it into a note neither the owner nor the model can see. That file can prove
// the promotion; it cannot prove the CONSEQUENCE, because the consequence is a read of the
// delivery ledger by a different authority one turn-boundary later. This file is that proof.
//
// ── WHY IT HAS TO BE PROVED AND NOT ASSERTED ──
// T48's ladder rung ships the landed pieces to the owner VERBATIM once the redrives are spent
// and every piece is back. On the S5 shape that is exactly the state the row is in at the
// moment T52 fires. If the promoted delivery were not accepted as the compiled answer, the
// row would stay `compile_pending`, the ladder would advance, and the owner would get the same
// content a second time under an engine preface — the double answer, rebuilt out of the fix
// meant to remove it.
//
// ── AND WHY NOTHING IN T52 CLEARS A FLAG ──
// T47's own predicate states the rule this file drives: "THE DISARM IS A READ, NEVER A LATCH
// ... every road out of the duty comes through this one predicate. None of them has to know
// this gate exists." A promoted compose takes the SAME road the model's ordinary tool-less
// answer takes — a delivered, non-chip, non-ack `agent-text` bubble in the ask's own
// conversation, postdating `join_complete`, from a turn later than the delegating one, named
// by that turn's answer key. Four narrowings and the sixth one, all satisfied by construction,
// which is what makes "exactly like a delivered answer" a fact rather than an intention.
//
// The negative control is the S5 shape AS IT WAS: the demoted note is `role='system'` and
// carries no delivery at all, and the only delivery that round produced was the `tool-turn`
// chip (`c83a1e79` on the body) — so at HEAD the row stayed owed and the ladder walked on.
// ════════════════════════════════════════════════════════════════════════════════════════

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-promoted-compose-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  askIdForMessage, claimAsk, stampClaimingTurn, openDelegationJoin, landPiece,
  compilePendingJoins,
} from '../store.js';
import { settleAskOnJoin } from '../ask-settlement.js';
import {
  JOIN_REDRIVE_BOUND, JOIN_DRIVE_ENTRY, recordJoinDrive, nextJoinDriveRung,
} from '../join-drive.js';
import { compileOwedAfterRedrive, stillCompileOwed } from '../../agent/v2/compile-owed-gate.js';
import { insertMessage } from '../../memory/message-store.js';

const AGENT = 'behaviorbot';
const PEER_A = 'ticky';
const PEER_B = 'healer';
const CONV = '616f857b-2026-44f3-b64e-943032f913ec';
/** S5's own turns: 4899 delegated, 4902 is the later turn that composed. */
const DELEGATING_TURN = 4899;
const COMPOSING_TURN = 4902;

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

/** The owner's ask, claimed by the delegating turn — where every join starts. */
function claimedAsk(messageId: string): string {
  insertMessage({
    id: messageId, agentId: AGENT, role: 'user',
    content: 'plan me a Saturday day trip to Leavenworth with the dog',
    lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
    conversationId: CONV,
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never);
  const id = askIdForMessage(messageId);
  claimAsk(id, AGENT);
  stampClaimingTurn(id, DELEGATING_TURN);
  return id;
}

/** S5's join: two helpers, both back with real content, all three redrives spent. */
function theS5Row(): string {
  const askId = claimedAsk('351d9670-4af7-4f22-802d-34f239b24f18');
  const children = openDelegationJoin({
    parentWorkId: askId, agentId: AGENT, replyConversationId: CONV,
    ttlAt: Date.now() + 60 * 60_000,
    threads: [
      { threadId: '48a082a0', assigneeAgent: PEER_A, intent: 'ASSIGN', hopCount: 0 },
      { threadId: '8431a615', assigneeAgent: PEER_B, intent: 'ASSIGN', hopCount: 0 },
    ],
  });
  for (const [i, childId] of children.entries()) {
    const deliveryId = `piece-${i}`;
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
       VALUES (?, ?, NULL, 'send_to_agent', 'a2a', 'delivered', datetime('now'))`,
    ).run(deliveryId, AGENT);
    landPiece(childId, {
      deliveryId, content: `Research complete — piece ${i}`, messageId: null,
      actorId: i === 0 ? PEER_A : PEER_B,
    });
  }
  for (let i = 0; i < JOIN_REDRIVE_BOUND; i++) {
    recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, { attempt: i + 1, bound: JOIN_REDRIVE_BOUND });
  }
  return askId;
}

/**
 * THE PROMOTED ROW, EXACTLY AS T52 WRITES IT: an `agent-text` assistant bubble with NO origin
 * stamp, delivered under the ordinary dashboard door on a LATER turn — and that turn's own
 * answer key naming it, which is `noteTerminalAnswer`'s doing and the sixth narrowing's
 * requirement.
 */
function promotedAnswer(o: { answerKeyNames?: boolean; turnEnded?: boolean } = {}): string {
  const messageId = 'promoted-answer-row';
  insertMessage({
    id: messageId, agentId: AGENT, role: 'assistant',
    content: "Here's the combined day plan — both research pieces merged: …",
    lane: 'owner', conversationId: CONV, turnNumber: COMPOSING_TURN,
  } as never);
  mockDb.current!.prepare("UPDATE messages SET display_kind = 'agent-text' WHERE id = ?").run(messageId);
  mockDb.current!.prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, started_at, ended_at, exit_reason, answered, answer_message_id, conv_key)
     VALUES (?, ?, NULL, 'none', datetime('now'), ?, 'answered', 1, ?, 'owner')`,
  ).run(
    AGENT, COMPOSING_TURN,
    (o.turnEnded ?? true) ? new Date().toISOString() : null,
    (o.answerKeyNames ?? true) ? messageId : null,
  );
  const deliveryId = 'promoted-delivery';
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, ?, 'dashboard', 'dashboard', ?, ?, 'delivered', datetime('now'))`,
  ).run(deliveryId, AGENT, COMPOSING_TURN, CONV, messageId);
  return deliveryId;
}

/** The S5 shape AS IT WAS: a `role='system'` note, and the round's only delivery a chip. */
function demotedNoteAndChip(): void {
  insertMessage({
    id: 'demoted-note-row', agentId: AGENT, role: 'system',
    content: "[working-note] Here's the combined day plan — both research pieces merged: …",
    lane: 'owner', conversationId: CONV, turnNumber: COMPOSING_TURN,
  } as never);
  const chipId = 'tool-turn-row';
  insertMessage({
    id: chipId, agentId: AGENT, role: 'assistant',
    content: '[{"type":"tool_use","id":"call_1","name":"work_update","input":{}}]',
    lane: 'owner', conversationId: CONV, turnNumber: COMPOSING_TURN,
  } as never);
  mockDb.current!.prepare("UPDATE messages SET display_kind = 'tool-turn' WHERE id = ?").run(chipId);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES ('chip-delivery', ?, ?, 'dashboard', 'dashboard', ?, ?, 'delivered', datetime('now'))`,
  ).run(AGENT, COMPOSING_TURN, CONV, chipId);
}

/** Step 1 of the compile drive, verbatim (`a2a-transport.ts`'s `resolveCompilePendingJoins`). */
const driveStepOne = (askId: string): string =>
  settleAskOnJoin(askId, { agentId: AGENT, reason: 'the compiled answer reached the owner' }).verdict;

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'BehaviorBot', 'idle', '1970-01-01'), (?, 'Ticky', 'idle', '1970-01-01'), (?, 'Healer', 'idle', '1970-01-01')`,
  ).run(AGENT, PEER_A, PEER_B);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

describe('the S5 row, at the instant T52 fires', () => {
  it('is genuinely owed — T47 arms on it, and the ladder\'s next rung IS T48\'s relay', () => {
    const askId = theS5Row();
    expect(compileOwedAfterRedrive(AGENT)).toEqual([askId]);
    expect(stillCompileOwed([askId])).toEqual([askId]);
    expect(nextJoinDriveRung(askId, { everyPieceLanded: true }).rung).toBe('engine-relay');
  });
});

describe('the promoted compose closes the ask, so the relay rung is never reached', () => {
  it('RED→GREEN: step 1 of the compile drive settles on the promoted delivery', () => {
    const askId = theS5Row();
    const deliveryId = promotedAnswer();
    expect(driveStepOne(askId)).toBe('closed');

    const row = workRow(askId);
    expect(row.state).toBe('done');
    expect(row.compile_pending).toBe(0);
    expect(row.result_delivery_id).toBe(deliveryId);
  });

  it('and the compile duty is discharged EVERYWHERE, by the one read every road uses', () => {
    const askId = theS5Row();
    promotedAnswer();
    driveStepOne(askId);
    // T48's ladder cannot be reached: the drive never sees the row again.
    expect(compilePendingJoins(AGENT)).toEqual([]);
    // T47's gate re-reads the spine at the moment it would refuse, and finds nothing owed.
    expect(stillCompileOwed([askId])).toEqual([]);
    expect(compileOwedAfterRedrive(AGENT)).toEqual([]);
  });

  it('the resolution is on the record with the basis the authority decided', () => {
    const askId = theS5Row();
    promotedAnswer();
    driveStepOne(askId);
    const resolved = mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'compile_resolved'`,
    ).all(askId) as Array<{ payload: string }>;
    expect(resolved).toHaveLength(1);
    expect((JSON.parse(resolved[0].payload) as { basis: string }).basis).toBe('compiled');
  });

  it('NO SECOND TELLING: the engine has relayed nothing, so nothing can be relayed "again"', () => {
    const askId = theS5Row();
    promotedAnswer();
    driveStepOne(askId);
    const relays = mockDb.current!.prepare(
      `SELECT id FROM work_events WHERE work_id = ? AND kind = 'audit'
        AND json_extract(payload, '$.entry_kind') = ?`,
    ).all(askId, JOIN_DRIVE_ENTRY.engineRelay) as unknown[];
    expect(relays).toEqual([]);
  });
});

describe('the negative controls — each is one detail away from the positive', () => {
  it('THE HEAD SHAPE: a demoted note plus a tool-turn chip settles NOTHING, and the relay is next', () => {
    const askId = theS5Row();
    demotedNoteAndChip();
    expect(driveStepOne(askId)).toBe('unchanged');
    expect(workRow(askId).compile_pending).toBe(1);
    expect(nextJoinDriveRung(askId, { everyPieceLanded: true }).rung).toBe('engine-relay');
  });

  it('WHY `noteTerminalAnswer` IS NOT OPTIONAL: an ended turn whose answer key names something else refuses the bubble', () => {
    const askId = theS5Row();
    promotedAnswer({ answerKeyNames: false });
    expect(driveStepOne(askId)).toBe('unchanged');
    expect(workRow(askId).compile_pending).toBe(1);
  });

  it('the ack lane still cannot close it — which is why T52 delivers an ANSWER, not an ack', () => {
    const askId = theS5Row();
    const messageId = 'ack-row';
    insertMessage({
      id: messageId, agentId: AGENT, role: 'assistant', content: 'On it — stitching them together.',
      lane: 'owner', conversationId: CONV, turnNumber: COMPOSING_TURN, originIntent: 'engine_start_ack',
    } as never);
    mockDb.current!.prepare("UPDATE messages SET display_kind = 'agent-text' WHERE id = ?").run(messageId);
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
       VALUES ('ack-delivery', ?, ?, 'engine-ack', 'dashboard', ?, ?, 'delivered', datetime('now'))`,
    ).run(AGENT, COMPOSING_TURN, CONV, messageId);
    expect(driveStepOne(askId)).toBe('unchanged');
    expect(workRow(askId).compile_pending).toBe(1);
  });

  it('a piece still out is not settled by a promoted compose either — the countdown rule is untouched', () => {
    const askId = claimedAsk('351d9670-4af7-4f22-802d-34f239b24f18');
    openDelegationJoin({
      parentWorkId: askId, agentId: AGENT, replyConversationId: CONV,
      ttlAt: Date.now() + 60 * 60_000,
      threads: [{ threadId: '48a082a0', assigneeAgent: PEER_A, intent: 'ASSIGN', hopCount: 0 }],
    });
    promotedAnswer();
    expect(driveStepOne(askId)).toBe('unchanged');
  });
});

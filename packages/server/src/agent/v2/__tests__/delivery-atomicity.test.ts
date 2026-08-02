// PHASE-4 T2 Step 2 — THE FLAGSHIP CLUSTER: deliver + done is ONE unit.
//
// `recordDelivery` writes the `deliveries` row and then closes the ask that row
// answers (`closeAsksForDelivery` → `transition(to:'done')`). Until this task
// those were TWO transactions, which the plan named as its own headline
// ("deliver+receipt+work.done atomic") — and §T0-PINS B measured it still true
// at the phase HEAD.
//
// Why the gap is not cosmetic. `work.state='done'` REQUIRES `result_delivery_id`
// (migration 135's CHECK, plus `transition`'s G7), so the whole "done means
// delivered" law rests on those two writes agreeing. A failure between them can
// only produce dishonest shapes, and this file drives both directions:
//
//   * the close fails after the INSERT  → a `deliveries` row nobody's work
//     points at, and an ask still `claimed` although the answer went out.
//     T1 gave this a name (`recordDelivery` returned `failed`) but the ROW was
//     still there, so the ledger's own count disagreed with what happened.
//   * the INSERT fails                  → nothing closes, which was already true
//     and stays true. Kept as the negative control, because a unit that rolls
//     back "the good case too" is the classic over-correction.
//
// The failure is DRIVEN, not simulated by mocking the second half out: a
// BEFORE-UPDATE trigger on `work` aborts the transition for one planted row, so
// what fails is the real second write, inside the real call.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t2-atomicity-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { recordDelivery } from '../deliveries.js';
import { currentTurnNumber, currentTurnRoot } from '../../turn-state.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../../work/store.js';
import { insertMessage } from '../../../memory/message-store.js';

const AGENT = 'kevin';
const TURN = 7;

const deliveryCount = (): number =>
  (mockDb.current!.prepare('SELECT count(*) AS n FROM deliveries').get() as { n: number }).n;
const workRow = (id: string): { state: string; result_delivery_id: string | null } =>
  mockDb.current!.prepare('SELECT state, result_delivery_id FROM work WHERE id = ?').get(id) as
    { state: string; result_delivery_id: string | null };

/** An owner message, its ask, claimed by TURN — the shape a real reply answers. */
function seedClaimedAsk(messageId: string): string {
  insertMessage({
    id: messageId, agentId: AGENT, role: 'user', content: 'can you check the roof quote?',
    lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
    conversationId: 'conv-dash',
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as Parameters<typeof insertMessage>[0]);
  const workId = askIdForMessage(messageId);
  claimAsk(workId, AGENT);
  stampClaimingTurn(workId, TURN);
  return workId;
}

/** Abort the `work` UPDATE for one row — a real second-write failure, no mocks. */
function makeTransitionFail(workId: string): void {
  mockDb.current!.exec(`
    CREATE TRIGGER t2_block_transition BEFORE UPDATE ON work
    FOR EACH ROW WHEN OLD.id = '${workId}'
    BEGIN SELECT RAISE(ABORT, 'planted: the close half fails'); END;
  `);
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-dash', ?, 'dashboard', 'owner')`,
  ).run(AGENT);
  currentTurnNumber.set(AGENT, TURN);
});

describe('T2 flagship: recordDelivery is ONE unit — the row and the close, or neither', () => {
  it('POSITIVE: the happy path is unchanged — one delivery row, the ask done and pointing at it', () => {
    const workId = seedClaimedAsk('m-ok');
    currentTurnRoot.set(AGENT, {
      kind: 'ask', id: workId, sourceMessageId: 'm-ok', conversationId: 'conv-dash',
    });

    const out = recordDelivery({
      agentId: AGENT, tool: 'dashboard', channel: 'dashboard',
      outcome: 'delivered', conversationId: 'conv-dash', messageId: 'm-reply',
    });

    expect(out.kind).toBe('applied');
    expect(deliveryCount()).toBe(1);
    const w = workRow(workId);
    expect(w.state).toBe('done');
    // The whole law in one assertion: done, because THAT row was delivered.
    expect(w.result_delivery_id).toBe(
      (mockDb.current!.prepare('SELECT id FROM deliveries').get() as { id: string }).id,
    );
  });

  it('THE DEFECT: when the close half fails, the delivery row is NOT left behind', () => {
    const workId = seedClaimedAsk('m-bad');
    currentTurnRoot.set(AGENT, {
      kind: 'ask', id: workId, sourceMessageId: 'm-bad', conversationId: 'conv-dash',
    });
    makeTransitionFail(workId);

    const out = recordDelivery({
      agentId: AGENT, tool: 'dashboard', channel: 'dashboard',
      outcome: 'delivered', conversationId: 'conv-dash', messageId: 'm-reply',
    });

    // The caller is still told the truth — T1's `failed` arm, unchanged...
    expect(out.kind).toBe('failed');
    // ...and now the LEDGER agrees with it. Before this task the INSERT had already
    // committed on its own, so the count here was 1: a delivery no work row could
    // ever point at, which is exactly the residue this phase found in the dev body.
    expect(deliveryCount()).toBe(0);
    // And the ask is honestly still open work rather than a done row with no evidence.
    expect(workRow(workId).state).toBe('claimed');
  });

  it('NEGATIVE CONTROL: an INSERT that fails closes nothing — the unit does not over-reach', () => {
    const workId = seedClaimedAsk('m-insert-fail');
    currentTurnRoot.set(AGENT, {
      kind: 'ask', id: workId, sourceMessageId: 'm-insert-fail', conversationId: 'conv-dash',
    });
    mockDb.current!.exec(`
      CREATE TRIGGER t2_block_insert BEFORE INSERT ON deliveries
      FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'planted: the ledger write fails'); END;
    `);

    const out = recordDelivery({
      agentId: AGENT, tool: 'dashboard', channel: 'dashboard',
      outcome: 'delivered', conversationId: 'conv-dash', messageId: 'm-reply',
    });

    expect(out.kind).toBe('failed');
    expect(deliveryCount()).toBe(0);
    expect(workRow(workId).state).toBe('claimed');
  });

  it('NEGATIVE CONTROL: a delivery answering NO ask still records — one unit, not one requirement', () => {
    // The unit must not make the close a precondition of the record. A send to a third
    // party during someone else's turn closes nothing and is still a delivery.
    currentTurnRoot.set(AGENT, {
      kind: 'ask', id: 'no-such-work', sourceMessageId: 'm-none', conversationId: 'conv-dash',
    });
    const out = recordDelivery({
      agentId: AGENT, tool: 'imessage_send', channel: 'imessage',
      recipientId: '+15550000', outcome: 'delivered',
    });
    expect(out.kind).toBe('applied');
    expect(deliveryCount()).toBe(1);
  });
});

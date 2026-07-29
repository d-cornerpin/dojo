// PHASE-2 T5 Step 1 — universal deliveries, recorded AT THE TRANSPORT DOORS.
//
// The hole this closes: `deliveries` had ONE caller (`persistRoutingMarker`) and 44 rows of
// one tool. Dashboard bubbles, spoken replies, alerts, relays, engine acks and ten named
// send paths recorded nothing, and because every existing record was gated on `!isError`,
// a THROWN send could never produce `outcome='failed'`. `work.done` requires a delivery, so
// an answered ask rested at `claimed` forever on the most common path in the product.
//
// The structural move (research 03's own note): the record is written by the DOOR the send
// physically passes through, from the result it actually observed — callers stop writing
// evidence. Callers now declare only IDENTITY (who is sending, on whose behalf, over which
// channel) by opening an OUTBOUND SCOPE; the door writes the row and decides the outcome.
//
// Every assertion below has a negative control of the same shape, because a record that
// fires on everything is not a record.
//
// ⚠ THE ENGINE-ACK ROWS ARE OR2-PROVISIONAL. The tests named
// `engine-ack delivery (OR2-PROVISIONAL)` pin the LEDGER ROW, never the engine's right to
// speak as the agent. PHASE-4 T4 converts them (steer + verify + system voice) and they are
// listed by name in PHASE-4 T0's pin list. Keep them findable under that name.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t5-deliveries-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import {
  withOutbound, withOutboundAsync, recordAtDoor, noteReceiptForOutbound,
  recordDashboardDelivery, PLATFORM_SENDER,
} from '../outbound.js';
import { currentTurnNumber, currentTurnRoot } from '../../turn-state.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../../work/store.js';
import { insertMessage } from '../../../memory/message-store.js';
import { writeToolReceipt } from '../../../receipts/store.js';
import { stampPersistedRow } from '../../../gateway/ws.js';

const AGENT = 'kevin';

const deliveries = (): Array<Record<string, unknown>> =>
  mockDb.current!.prepare('SELECT * FROM deliveries ORDER BY rowid').all() as Array<Record<string, unknown>>;
const deliveryCount = (): number =>
  (mockDb.current!.prepare('SELECT count(*) AS n FROM deliveries').get() as { n: number }).n;

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
     VALUES ('conv-dash', ?, 'dashboard', 'owner'), ('conv-im', ?, 'imessage', '+15550000')`,
  ).run(AGENT, AGENT);
  currentTurnNumber.set(AGENT, 7);
  currentTurnRoot.set(AGENT, {
    kind: 'ask', id: 'm-ask', sourceMessageId: 'm-ask', conversationId: 'conv-dash',
  });
});

// ════════════════════════════════════════════════════════════════════════
// 1. EVERY SEND PATH PRODUCES EXACTLY ONE ROW
// ════════════════════════════════════════════════════════════════════════

describe('a door inside an outbound scope writes exactly one row', () => {
  it('POSITIVE: one scope, one row, carrying the caller identity and the door outcome', () => {
    const id = withOutbound(
      { agentId: AGENT, tool: 'imessage_send', channel: 'imessage', recipientId: '+15550000' },
      () => recordAtDoor({ outcome: 'delivered', channel: 'imessage', detail: 'via imsg' }),
    );
    const rows = deliveries();
    expect(rows).toHaveLength(1);
    expect(id).toBe(rows[0].id);
    expect(rows[0].tool).toBe('imessage_send');
    expect(rows[0].channel).toBe('imessage');
    expect(rows[0].outcome).toBe('delivered');
    expect(rows[0].agent_id).toBe(AGENT);
    expect(rows[0].turn_number).toBe(7);
    expect(rows[0].recipient_id).toBe('+15550000');
  });

  it('NEGATIVE CONTROL: a NESTED door call inside the same scope does not add a second row', () => {
    // The real shape: sendIMessageWithAttachment sends the file, then calls sendIMessage for
    // the caption. Two door crossings, ONE thing the user received.
    withOutbound(
      { agentId: AGENT, tool: 'imessage_send', channel: 'imessage', recipientId: '+15550000' },
      () => {
        recordAtDoor({ outcome: 'delivered', channel: 'imessage', detail: 'file' });
        recordAtDoor({ outcome: 'delivered', channel: 'imessage', detail: 'caption' });
      },
    );
    expect(deliveryCount()).toBe(1);
  });

  it('a FAILURE anywhere in the scope wins: partial success is recorded as failed', () => {
    withOutbound(
      { agentId: AGENT, tool: 'imessage_send', channel: 'imessage', recipientId: '+15550000' },
      () => {
        recordAtDoor({ outcome: 'delivered', channel: 'imessage', detail: 'file 1' });
        recordAtDoor({ outcome: 'failed', channel: 'imessage', detail: 'file 2 missing' });
      },
    );
    const rows = deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failed');
    expect(String(rows[0].detail)).toContain('file 2 missing');
  });

  it('two SEPARATE scopes are two separate rows', () => {
    withOutbound({ agentId: AGENT, tool: 'imessage_send', channel: 'imessage' },
      () => recordAtDoor({ outcome: 'delivered', channel: 'imessage' }));
    withOutbound({ agentId: AGENT, tool: 'sms_send', channel: 'sms' },
      () => recordAtDoor({ outcome: 'delivered', channel: 'sms' }));
    expect(deliveryCount()).toBe(2);
  });

  it('an UNSCOPED door crossing is still recorded — an outbound is never silently unrecorded', () => {
    recordAtDoor({ outcome: 'delivered', channel: 'imessage', tool: 'imessage-door', recipientId: '+1555' });
    const rows = deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe(PLATFORM_SENDER);
    expect(rows[0].tool).toBe('imessage-door');
  });

  it('the scope survives an await (async doors keep their identity)', async () => {
    await withOutboundAsync(
      { agentId: AGENT, tool: 'sms_send', channel: 'sms', recipientId: '+15551111' },
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        recordAtDoor({ outcome: 'delivered', channel: 'sms' });
      },
    );
    const rows = deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('sms_send');
    expect(rows[0].recipient_id).toBe('+15551111');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. A THROWN SEND RECORDS `failed`
// ════════════════════════════════════════════════════════════════════════

describe('a THROWN send records failed', () => {
  it('POSITIVE: the scope records failed when the door throws past it', () => {
    expect(() => withOutbound(
      { agentId: AGENT, tool: 'gmail_send', channel: 'email', recipientId: 'a@b.c' },
      () => { throw new Error('provider exploded'); },
    )).toThrow('provider exploded');
    const rows = deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failed');
    expect(String(rows[0].detail)).toContain('provider exploded');
  });

  it('POSITIVE (async): a rejected promise records failed', async () => {
    await expect(withOutboundAsync(
      { agentId: AGENT, tool: 'outlook_send', channel: 'email' },
      async () => { await Promise.resolve(); throw new Error('graph 500'); },
    )).rejects.toThrow('graph 500');
    const rows = deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failed');
  });

  it('NEGATIVE CONTROL: a throw does NOT overwrite a delivery the door already observed as failed-free…', () => {
    // …it downgrades it, and it never invents a SECOND row for the same send.
    expect(() => withOutbound(
      { agentId: AGENT, tool: 'imessage_send', channel: 'imessage' },
      () => {
        recordAtDoor({ outcome: 'delivered', channel: 'imessage' });
        throw new Error('crashed after the send');
      },
    )).toThrow();
    const rows = deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failed');
  });

  it('NEGATIVE CONTROL: a scope that neither sends nor throws writes NOTHING', () => {
    withOutbound({ agentId: AGENT, tool: 'imessage_send', channel: 'imessage' }, () => {
      // the tool refused before reaching any transport
    });
    expect(deliveryCount()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. THE DASHBOARD BUBBLE — the most common delivery in the product
// ════════════════════════════════════════════════════════════════════════

/** Production ordering, verbatim: the PHASE-1 T9 seam stamps the row, THEN the door reads
 *  what it attached. Nothing here re-implements the seam. */
function emit(event: Record<string, unknown>): string | null {
  stampPersistedRow(event as never);
  return recordDashboardDelivery(event as never);
}

function persistAssistant(id: string, over: Record<string, unknown> = {}): void {
  insertMessage({
    id, agentId: AGENT, role: 'assistant', content: 'the roof quote is $4,200',
    lane: 'owner', channel: 'dashboard', conversationId: 'conv-dash', turnNumber: 7,
    ...over,
  } as never);
}

describe('the dashboard bubble is a delivery', () => {
  it('POSITIVE: an assistant chat:message with a persisted owner-lane row records one row', () => {
    persistAssistant('m-reply');
    emit({
      type: 'chat:message', agentId: AGENT,
      message: { id: 'm-reply', agentId: AGENT, role: 'assistant', content: 'x' },
    });
    const rows = deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('dashboard');
    expect(rows[0].outcome).toBe('delivered');
    expect(rows[0].message_id).toBe('m-reply');
    expect(rows[0].conversation_id).toBe('conv-dash');
  });

  it('NEGATIVE CONTROL: a role=system routing marker is NOT a delivery', () => {
    persistAssistant('m-marker', { role: 'system', content: '[Reply routed via iMessage to Dave]' });
    emit({
      type: 'chat:message', agentId: AGENT,
      message: { id: 'm-marker', agentId: AGENT, role: 'system', content: 'x' },
    });
    expect(deliveryCount()).toBe(0);
  });

  it('NEGATIVE CONTROL: a user message echoed back is NOT a delivery', () => {
    persistAssistant('m-user', { role: 'user', content: 'check the roof quote' });
    emit({
      type: 'chat:message', agentId: AGENT,
      message: { id: 'm-user', agentId: AGENT, role: 'user', content: 'x' },
    });
    expect(deliveryCount()).toBe(0);
  });

  it('NEGATIVE CONTROL: an assistant emission with NO persisted row records nothing', () => {
    // BROADCAST_EQUALS_ROW already reports this as an orphan. Claiming a delivery for
    // something that was never stored would be the dishonest half of the same defect.
    emit({
      type: 'chat:message', agentId: AGENT,
      message: { id: 'm-never-stored', agentId: AGENT, role: 'assistant', content: 'x' },
    });
    expect(deliveryCount()).toBe(0);
  });

  it('NEGATIVE CONTROL: an a2a-lane row is not an owner-facing dashboard delivery', () => {
    persistAssistant('m-peer', { lane: 'a2a', channel: null, sourceAgentId: 'peer-1', a2aThreadId: 'th-1' });
    emit({
      type: 'chat:message', agentId: AGENT,
      message: { id: 'm-peer', agentId: AGENT, role: 'assistant', content: 'x' },
    });
    expect(deliveryCount()).toBe(0);
  });

  it('NEGATIVE CONTROL: a non-chat event (status, chunk) is not a delivery', () => {
    emit({ type: 'agent:status', agentId: AGENT, status: 'working' });
    emit({ type: 'chat:chunk', agentId: AGENT, messageId: 'm', delta: 'x' });
    expect(deliveryCount()).toBe(0);
  });

  it('the same bubble broadcast twice records ONE row (a re-emit is not a second delivery)', () => {
    persistAssistant('m-reply');
    const ev = {
      type: 'chat:message', agentId: AGENT,
      message: { id: 'm-reply', agentId: AGENT, role: 'assistant', content: 'x' },
    };
    emit(ev);
    emit(ev);
    expect(deliveryCount()).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. THE CLAIMED PILE CLOSES — work.done wiring (Step 3)
// ════════════════════════════════════════════════════════════════════════

describe('an answered ask reaches done on the dashboard path', () => {
  it('POSITIVE: bubble recorded -> the claiming turn closes its ask with result_delivery_id', () => {
    insertMessage({
      id: 'm-ask', agentId: AGENT, role: 'user', content: 'check the roof quote?',
      lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
      conversationId: 'conv-dash',
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    } as never);
    const askId = askIdForMessage('m-ask');
    expect(claimAsk(askId, AGENT).kind).toBe('applied');
    expect(stampClaimingTurn(askId, 7)).toBe(1);

    persistAssistant('m-reply');
    emit({
      type: 'chat:message', agentId: AGENT,
      message: { id: 'm-reply', agentId: AGENT, role: 'assistant', content: 'x' },
    });

    const w = mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(askId) as Record<string, unknown>;
    expect(w.state).toBe('done');
    expect(w.result_delivery_id).toBe(deliveries()[0].id);
  });

  it('NEGATIVE CONTROL: a bubble in ANOTHER conversation does not close this ask', () => {
    insertMessage({
      id: 'm-ask', agentId: AGENT, role: 'user', content: 'check the roof quote?',
      lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
      conversationId: 'conv-dash',
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    } as never);
    const askId = askIdForMessage('m-ask');
    expect(claimAsk(askId, AGENT).kind).toBe('applied');
    expect(stampClaimingTurn(askId, 7)).toBe(1);

    withOutbound(
      { agentId: AGENT, tool: 'imessage_send', channel: 'imessage', conversationId: 'conv-im' },
      () => recordAtDoor({ outcome: 'delivered', channel: 'imessage' }),
    );
    const w = mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(askId) as { state: string };
    expect(w.state).toBe('claimed');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. `deliveries.receipt_id` — WRITTEN, AND READ (Phase-1 §7 debt)
// ════════════════════════════════════════════════════════════════════════

describe('deliveries.receipt_id is populated when a receipt exists', () => {
  it('POSITIVE: the receipt written inside the scope stamps the scope its row', () => {
    withOutbound({ agentId: AGENT, tool: 'sms_send', channel: 'sms', recipientId: '+1555' }, () => {
      recordAtDoor({ outcome: 'delivered', channel: 'sms' });
      noteReceiptForOutbound('receipt-abc');
    });
    expect(deliveries()[0].receipt_id).toBe('receipt-abc');
  });

  it('the receipt can arrive BEFORE the door crossing and still lands on the row', () => {
    withOutbound({ agentId: AGENT, tool: 'sms_send', channel: 'sms' }, () => {
      noteReceiptForOutbound('receipt-early');
      recordAtDoor({ outcome: 'delivered', channel: 'sms' });
    });
    expect(deliveries()[0].receipt_id).toBe('receipt-early');
  });

  it('END TO END: writeToolReceipt itself links the row — the two sole writers, no helper', () => {
    // The measured defect this pins: the first live run recorded 119 deliveries and linked
    // ZERO of them, because the auto-route wrote its receipt one statement BELOW the scope.
    // Asserting through `writeToolReceipt` is what makes the ordering part of the contract.
    const id = withOutbound({ agentId: AGENT, tool: 'imessage_send', channel: 'imessage', recipientId: '+1555' }, () => {
      const d = recordAtDoor({ outcome: 'delivered', channel: 'imessage' });
      writeToolReceipt({
        agentId: AGENT, tool: 'imessage_send', tier: 3, verified: false,
        basis: 'exit-code', recipient: '+1555', sentText: 'the roof quote is $4,200',
      });
      return d;
    });
    const row = deliveries()[0];
    expect(row.id).toBe(id);
    expect(row.receipt_id).not.toBeNull();
    const receipt = mockDb.current!.prepare('SELECT sent_text FROM tool_receipts WHERE id = ?')
      .get(row.receipt_id) as { sent_text: string } | undefined;
    expect(receipt?.sent_text).toBe('the roof quote is $4,200');
  });

  it('NEGATIVE CONTROL: a receipt written OUTSIDE any scope stamps nothing', () => {
    withOutbound({ agentId: AGENT, tool: 'sms_send', channel: 'sms' },
      () => recordAtDoor({ outcome: 'delivered', channel: 'sms' }));
    noteReceiptForOutbound('receipt-stray');
    expect(deliveries()[0].receipt_id).toBeNull();
  });
});

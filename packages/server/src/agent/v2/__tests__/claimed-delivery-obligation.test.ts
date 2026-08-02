// ════════════════════════════════════════════════════════════════════════════════════════
// THE OWNER'S FIXTURE — PHASE-4 T4. The claimed-delivery floor stops reading prose.
//
// Caught live on his own `.24` server, 2026-08-01, and recorded verbatim in the phase ledger:
// he asked about a WEDDING TRANSCRIPT, the reply quoted it, the transcript contained the words
// "told Michael" (Michael was the groom), and the floor fired — three times, once when he
// pasted the steer's own words back at the agent — each fire ordering "do it NOW", producing
// double answers and a re-done delivery.
//
// The planted-fault PAIR below is his example, and it is the acceptance test for the rekey:
//   (a) a reply quoting "told Michael" with NOTHING owed to Michael  -> must NOT fire
//   (b) a genuine unbacked send-claim with an OPEN OBLIGATION and no receipt -> MUST fire
//
// Both are written against the OLD mechanism first (§ "THE DEFECT"), because a fixture that
// only ever ran against the fix proves nothing about what was wrong. The old predicate is
// kept alive in this file for exactly that purpose — the T4S1 precedent, where the retired
// ack clause was replayed beside the new one on the same row.
// ════════════════════════════════════════════════════════════════════════════════════════

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-claimed-delivery-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { owedSendObligations } from '../../../work/store.js';
import { detectUngroundedDeliveryClaim } from '../classifiers/grounding.js';
import {
  decideClaimedDelivery, claimedDeliverySteer, obligationOwedTo,
} from '../claimed-delivery.js';

const AGENT = 'kevin';
const TURN = 4210;

/** The owner's own text, near enough: a transcript quote naming somebody nobody owes. */
const WEDDING_TRANSCRIPT_REPLY =
  'Here is what that recording covers: the planner confirmed the 4pm slot, and Sarah said she ' +
  'told Michael about the seating change before the rehearsal so he could tell the ushers.';

/** The shape the floor exists for: a completed-delivery claim to a third party. */
const UNBACKED_SEND_CLAIM = 'All set — I texted Sam the address a minute ago, so she has it.';

function conversation(id: string, name: string, counterpartyId: string): void {
  mockDb.current!.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name, thread_root)
     VALUES (?, ?, 'imessage', NULL, ?, ?, NULL)`,
  ).run(id, AGENT, counterpartyId, name);
}

/** An obligation that a delivery would discharge: an unanswered ask from a real person. */
function openAskFrom(workId: string, conversationId: string, title: string): void {
  const at = Date.now();
  mockDb.current!.prepare(`
    INSERT INTO work (id, kind, agent_id, requester, requester_id, conversation_id,
                      root_kind, root_id, state, intent, wakes, closes_thread,
                      title, opened_at, updated_at, provenance)
    VALUES (?, 'ask', ?, 'owner', 'sam', ?, 'ask', ?, 'open', 'ask', 1, 0, ?, ?, ?, 'live')
  `).run(workId, AGENT, conversationId, `msg:${workId}`, title, at, at);
}

function delivery(id: string, opts: {
  turn?: number; outcome: string; recipientId?: string | null; recipientDisplay?: string | null;
}): void {
  mockDb.current!.prepare(`
    INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, recipient_id,
                            recipient_display, outcome)
    VALUES (?, ?, ?, 'imessage_send', 'imessage', ?, ?, ?)
  `).run(id, AGENT, opts.turn ?? TURN, opts.recipientId ?? null, opts.recipientDisplay ?? null, opts.outcome);
}

/** The decision, with the receipt suppressor wired to "nothing on record" unless a test says so. */
function decide(responseText: string, over: Partial<{
  toolCallsThisTurn: ReadonlyArray<{ name: string }>;
  hasDeliveryReceipt: (r: string) => boolean;
  counterpartyName: string | null;
  turnNumber: number | null;
}> = {}) {
  return decideClaimedDelivery({
    agentId: AGENT,
    turnNumber: over.turnNumber === undefined ? TURN : over.turnNumber,
    responseText,
    toolCallsThisTurn: over.toolCallsThisTurn ?? [],
    counterpartyName: over.counterpartyName ?? 'David',
    hasDeliveryReceipt: over.hasDeliveryReceipt ?? (() => false),
  });
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
});

describe('THE DEFECT the owner caught — the old trigger was the model’s prose', () => {
  it('the OLD predicate fires on a transcript quote that owes nobody anything', () => {
    // No obligation, no receipt, no send tool — nothing in the platform says a delivery is
    // owed to Michael. The old trigger fires anyway, because "told Michael" is English.
    const old = detectUngroundedDeliveryClaim({
      responseText: WEDDING_TRANSCRIPT_REPLY,
      toolCallsThisTurn: [],
      counterpartyName: 'David',
    });
    expect(old.ungrounded).toBe(true);
    expect(old.ungrounded && old.recipient).toBe('Michael');
  });

  it('and it cannot tell that case apart from a real one — same verdict, opposite truth', () => {
    const real = detectUngroundedDeliveryClaim({
      responseText: UNBACKED_SEND_CLAIM, toolCallsThisTurn: [], counterpartyName: 'David',
    });
    expect(real.ungrounded).toBe(true);
    // Two replies, one true and one false, and the old trigger returns the identical shape.
    expect(real.ungrounded && real.recipient).toBe('Sam');
  });
});

describe('PROOF (a) — the owner’s reply: quoting "told Michael" does NOT fire', () => {
  it('stands down because nothing is owed to Michael', () => {
    const d = decide(WEDDING_TRANSCRIPT_REPLY);
    expect(d.fires).toBe(false);
    expect(!d.fires && d.reason).toBe('nothing-owed-to-them');
    // The narrowing still names him — the stand-down is a decision, not a miss.
    expect(!d.fires && d.recipient).toBe('Michael');
  });

  it('stays stood down with FIFTY other obligations open — this is not "the box was quiet"', () => {
    for (let i = 0; i < 50; i++) {
      conversation(`conv-other-${i}`, `Person${i}`, `person${i}@example.com`);
      openAskFrom(`ask:other-${i}`, `conv-other-${i}`, `something person ${i} asked`);
    }
    expect(owedSendObligations(AGENT).length).toBe(50);
    const d = decide(WEDDING_TRANSCRIPT_REPLY);
    expect(d.fires).toBe(false);
    expect(!d.fires && d.reason).toBe('nothing-owed-to-them');
  });

  it('and it fires the moment Michael actually IS owed something — the arm is not dead', () => {
    conversation('conv-michael', 'Michael', 'michael@example.com');
    openAskFrom('ask:michael-1', 'conv-michael', 'can you send me the seating chart?');
    const d = decide(WEDDING_TRANSCRIPT_REPLY);
    expect(d.fires).toBe(true);
    expect(d.fires && d.obligation?.id).toBe('ask:michael-1');
  });
});

describe('PROOF (b) — a genuine unbacked send-claim with an open obligation DOES fire', () => {
  beforeEach(() => {
    conversation('conv-sam', 'Sam', 'sam@example.com');
    openAskFrom('ask:sam-1', 'conv-sam', 'what is the address for tomorrow?');
  });

  it('fires, names the row, and latches on the ROW id rather than the phrase', () => {
    const d = decide(UNBACKED_SEND_CLAIM);
    expect(d.fires).toBe(true);
    if (!d.fires) return;
    expect(d.basis).toBe('owed-obligation');
    expect(d.recipient).toBe('Sam');
    expect(d.obligation?.id).toBe('ask:sam-1');
    expect(d.latchKey).toBe('work:ask:sam-1');
    expect(claimedDeliverySteer(d)).toContain('ask:sam-1');
  });

  it('NEGATIVE CONTROL: a real delivery on the ledger grounds the claim and it stands down', () => {
    const d = decide(UNBACKED_SEND_CLAIM, { hasDeliveryReceipt: (r) => r === 'Sam' });
    expect(d.fires).toBe(false);
    expect(!d.fires && d.reason).toBe('receipt-backs-the-claim');
  });

  it('NEGATIVE CONTROL: the obligation resolving (a delivery to point at) silences it', () => {
    delivery('del-real', { outcome: 'delivered', recipientDisplay: 'Sam' });
    mockDb.current!.prepare(
      `UPDATE work SET state='done', result_delivery_id='del-real', closed_at=? WHERE id='ask:sam-1'`,
    ).run(Date.now());
    expect(owedSendObligations(AGENT).length).toBe(0);
    const d = decide(UNBACKED_SEND_CLAIM);
    expect(d.fires).toBe(false);
    expect(!d.fires && d.reason).toBe('nothing-owed-to-them');
  });

  it('NEGATIVE CONTROL: a CLAIMED ask is the one this turn is serving and never accuses it', () => {
    mockDb.current!.prepare(`UPDATE work SET state='claimed' WHERE id='ask:sam-1'`).run();
    const d = decide(UNBACKED_SEND_CLAIM);
    expect(d.fires).toBe(false);
  });

  it('NEGATIVE CONTROL: no claim in the text at all', () => {
    const d = decide('Sure — the kettle boils water and the saucepan does not.');
    expect(d.fires).toBe(false);
    expect(!d.fires && d.reason).toBe('no-claim-in-text');
  });
});

describe('ARM B — the hole the old guard could not see: a send the door recorded as FAILED', () => {
  it('fires when the reply claims a delivery this turn’s ledger says did not land', () => {
    delivery('del-failed', { outcome: 'failed', recipientDisplay: 'Sam' });
    // The send TOOL ran, which is exactly what made the old guard stand down.
    const oldVerdict = detectUngroundedDeliveryClaim({
      responseText: UNBACKED_SEND_CLAIM,
      toolCallsThisTurn: [{ name: 'imessage_send' }],
      counterpartyName: 'David',
    });
    expect(oldVerdict.ungrounded).toBe(false); // ← the hole, measured

    const d = decide(UNBACKED_SEND_CLAIM); // the caller passes SUCCESSFUL calls only (C5)
    expect(d.fires).toBe(true);
    if (!d.fires) return;
    expect(d.basis).toBe('failed-receipt');
    expect(d.failedDeliveryId).toBe('del-failed');
    expect(d.latchKey).toBe('delivery:del-failed');
    expect(claimedDeliverySteer(d)).toContain('did NOT land');
  });

  it('NEGATIVE CONTROL: a failure on an EARLIER turn is history, not this claim', () => {
    delivery('del-old', { turn: TURN - 1, outcome: 'failed', recipientDisplay: 'Sam' });
    const d = decide(UNBACKED_SEND_CLAIM);
    expect(d.fires).toBe(false);
    expect(!d.fires && d.reason).toBe('nothing-owed-to-them');
  });

  it('NEGATIVE CONTROL: a failure to somebody ELSE never answers for this recipient', () => {
    delivery('del-other', { outcome: 'failed', recipientDisplay: 'Jordan' });
    const d = decide(UNBACKED_SEND_CLAIM);
    expect(d.fires).toBe(false);
  });
});

describe('the matcher is canonical identity, never substring', () => {
  it('matches an obligation stored by ADDRESS when the reply used the name, and vice versa', () => {
    conversation('conv-sam2', 'Sam Rivera', 'sam@example.com');
    openAskFrom('ask:sam-2', 'conv-sam2', 'the address please');
    const obligations = owedSendObligations(AGENT);
    expect(obligationOwedTo(obligations, 'sam@example.com')?.id).toBe('ask:sam-2');
    expect(obligationOwedTo(obligations, 'Sam Rivera')?.id).toBe('ask:sam-2');
  });

  it('does NOT match a different person whose name merely contains the claim', () => {
    conversation('conv-sammy', 'Sammy Chen', 'sammy@example.com');
    openAskFrom('ask:sammy', 'conv-sammy', 'unrelated');
    expect(obligationOwedTo(owedSendObligations(AGENT), 'Sam')).toBeNull();
  });
});

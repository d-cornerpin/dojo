// UX-REPAIR ROUND 11 · T46 — A WRONG-FORM A2A CORRECTION MUST NOT DOUBLE-DELIVER
//
// ── THE RECORDED INCIDENT (round-11 catalog §8.2, re-queried by W30 on the dev body) ──
//   seq 65475  kevin  turn 638  01:25:01  tool_use send_to_agent ANSWER -> BehaviorBot
//   seq 65476  BehaviorBot a2a lane      01:25:01  the ANSWER LANDS
//   seq 65478  kevin  turn 638  01:25:01  tool_result "Message delivered to BehaviorBot …"
//   seq 65480  kevin  turn 639  01:25:06  THE NOTE: "…you wrote your reply as text… got nothing."
//   seq 65481  kevin  turn 639  01:25:23  the re-send
//   seq 65482  BehaviorBot a2a lane      01:25:23  THE SAME ANSWER LANDS A SECOND TIME
//
// ── THE CAUSE, NOT THE SYMPTOM ──
// The note is the FRESH-MISS branch of `a2aReplyEnforcer`, which needs
// `priorReplyOnSameThread === false`. That input's evidence is `a2a_replies`, and
// `recordA2AReply` only writes a row when the reply BINDS to an inbound assign message
// (`findInboundAssignByThread`) — a binding that needs a `thread_id` the sender may omit.
// kevin's delivered send omitted it, so no row existed and the branch called a delivered
// reply "nothing".
//
// The platform DID hold the fact, in the ledger it already trusts and already uses on the
// OTHER side of this same exchange (`reply-floors.ts` floor 11, "[Engine receipt: you DID
// send …]"): a VERIFIED engine-written `send_to_agent` receipt on that thread, five seconds
// before the note. So the predicate is unchanged — "has this agent already replied on this
// thread" — and only its EVIDENCE is widened to the receipt ledger.
//
// WHAT THIS FILE PINS, in both directions:
//   * a delivered-but-unbound reply draws the ALREADY-REPLIED note (no re-send instruction);
//   * a genuinely unsent reply still draws the fresh-miss note BYTE-IDENTICAL (held verbatim
//     below, so a future edit to that text has to come through this clause);
//   * the ledger reader is thread-keyed with `hasPriorReplyOnThread`'s own exact/legacy
//     discipline — a receipt on a DIFFERENT thread, an UNVERIFIED receipt, another agent's
//     receipt and a non-send tool all leave the note firing.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

// The reader resolves nothing through contacts (it is thread-keyed, not recipient-keyed);
// the module-level import is stubbed so the fixture needs no contacts table.
vi.mock('../../../contacts/store.js', () => ({ findMatchingContact: () => null }));

import { a2aReplyEnforcer } from '../classifiers/a2a.js';
import { hasVerifiedA2ASendOnThread } from '../outbound-ledger.js';

const AGENT = 'kevin';
const PEER = 'BehaviorBot';
/** The incident's thread, full form — what the receipt carries. */
const THREAD_FULL = 'bc9cf088-4376-4d9a-9a1e-dfe6b7ff5cfa';
const THREAD_SHORT = 'bc9cf088';

function seedReceipt(over: Record<string, unknown> = {}): void {
  const r = {
    id: `r-${Math.random().toString(36).slice(2)}`,
    agent_id: AGENT,
    tool: 'send_to_agent',
    tier: 1,
    verified: 1,
    basis: 'provider-id',
    provider_id: THREAD_FULL,
    thread_id: THREAD_FULL,
    recipient: PEER,
    ...over,
  };
  mockDb.current!.prepare(
    `INSERT INTO tool_receipts (id, agent_id, tool, tier, verified, basis, provider_id,
                                thread_id, recipient, sim, created_at, updated_at)
     VALUES (@id, @agent_id, @tool, @tier, @verified, @basis, @provider_id,
             @thread_id, @recipient, 0, datetime('now'), datetime('now'))`,
  ).run(r);
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tool_receipts (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      tool TEXT,
      tier INTEGER,
      verified INTEGER,
      basis TEXT,
      provider_id TEXT,
      thread_id TEXT,
      recipient TEXT,
      detail TEXT,
      audit_id TEXT,
      task_id TEXT,
      sim INTEGER DEFAULT 0,
      conv_key TEXT,
      turn_number INTEGER,
      sent_text TEXT,
      call_id TEXT,
      root_kind TEXT,
      root_id TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  mockDb.current = db;
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 — THE LEDGER READER: thread-keyed, and it refuses everything that is not the fact
// ════════════════════════════════════════════════════════════════════════════════

describe('hasVerifiedA2ASendOnThread', () => {
  it('finds the incident receipt by its FULL thread id', () => {
    seedReceipt();
    expect(hasVerifiedA2ASendOnThread(AGENT, THREAD_SHORT, THREAD_FULL)).toBe(true);
  });

  it('an UNVERIFIED receipt is not evidence', () => {
    seedReceipt({ verified: 0 });
    expect(hasVerifiedA2ASendOnThread(AGENT, THREAD_SHORT, THREAD_FULL)).toBe(false);
  });

  it('a receipt for a DIFFERENT tool is not evidence', () => {
    seedReceipt({ tool: 'imessage_send' });
    expect(hasVerifiedA2ASendOnThread(AGENT, THREAD_SHORT, THREAD_FULL)).toBe(false);
  });

  it('ANOTHER agent\'s receipt on the same thread is not evidence', () => {
    seedReceipt({ agent_id: 'behaviorbot' });
    expect(hasVerifiedA2ASendOnThread(AGENT, THREAD_SHORT, THREAD_FULL)).toBe(false);
  });

  it('a receipt on a DIFFERENT thread is not evidence when the full id is known', () => {
    seedReceipt({ thread_id: 'thread-zzzzzzzz-9999' });
    expect(hasVerifiedA2ASendOnThread(AGENT, THREAD_SHORT, THREAD_FULL)).toBe(false);
  });

  it('a colliding-PREFIX thread cannot soften this thread\'s note (FA-C2 discipline)', () => {
    // `makeThreadId` ids share a leading 'thread-x' prefix; the exact full-id match is
    // authoritative exactly so a reply on an unrelated colliding thread never counts.
    seedReceipt({ thread_id: 'thread-aaaaaaaa-1111' });
    expect(hasVerifiedA2ASendOnThread(AGENT, 'thread-a', 'thread-aaaaaaaa-2222')).toBe(false);
  });

  it('a genuinely-short LEGACY row matches exactly when no full-id row exists', () => {
    seedReceipt({ thread_id: THREAD_SHORT });
    expect(hasVerifiedA2ASendOnThread(AGENT, THREAD_SHORT, THREAD_FULL)).toBe(true);
  });

  it('with no receipts at all it is false', () => {
    expect(hasVerifiedA2ASendOnThread(AGENT, THREAD_SHORT, THREAD_FULL)).toBe(false);
  });

  it('a too-short thread token is refused rather than prefix-matched', () => {
    seedReceipt();
    expect(hasVerifiedA2ASendOnThread(AGENT, 'bc9c', null)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 — THE NOTE ITSELF
// ════════════════════════════════════════════════════════════════════════════════

const base = {
  triggeredByReplyNeededIntent: true,
  sentToAgentThisTurn: false,
  alreadyNudgedForMissedReply: false,
  agentProducedText: true,
  intent: 'QUESTION',
  threadShort: THREAD_SHORT,
  fromName: PEER,
};

/** The fresh-miss note, VERBATIM. A genuinely unsent reply must still draw exactly this. */
const FRESH_MISS_NOTE =
  `[System: You received an [A2A:QUESTION] message from ${PEER} on thread ${THREAD_SHORT} `
  + `but you wrote your reply as text in your own chat instead of calling send_to_agent. `
  + `Other agents CANNOT see your chat — only the user can. ${PEER} got nothing. `
  + `Retry your reply now using send_to_agent with the same thread_id from the message you received. `
  + `Choose an intent that matches your response (ANSWER if you're answering a QUESTION, `
  + `COMPLETE/STATUS/FAIL if you finished or are still working, ASSIGN if delegating further). `
  + `Then end your turn.]`;

/** The already-replied note, VERBATIM. It never instructs a re-send. */
const ALREADY_REPLIED_NOTE =
  `[System: You already replied to ${PEER}'s [A2A:QUESTION] on thread ${THREAD_SHORT} `
  + `via send_to_agent in an earlier turn — ${PEER} has the message. `
  + `The text you just wrote is going to your own chat (only the user sees it), not to ${PEER}. `
  + `If you're done with this thread, just END YOUR TURN — do nothing further. `
  + `Only call send_to_agent again if you have NEW information for ${PEER} (use the same thread_id, intent STATUS or ANSWER as appropriate).]`;

describe('the wrong-form note consults the receipt ledger', () => {
  it('POSITIVE CONTROL — no receipt, no prior reply: the fresh-miss note fires BYTE-IDENTICAL', () => {
    const r = a2aReplyEnforcer({
      ...base, priorReplyOnSameThread: false, verifiedSendReceiptOnThread: false,
    });
    expect(r.decision).toBe('nudge');
    if (r.decision === 'nudge') expect(r.nudgeText).toBe(FRESH_MISS_NOTE);
  });

  it('THE FIX — a VERIFIED send receipt exists: the note stops claiming the peer got nothing', () => {
    const r = a2aReplyEnforcer({
      ...base, priorReplyOnSameThread: false, verifiedSendReceiptOnThread: true,
    });
    expect(r.decision).toBe('nudge');
    if (r.decision === 'nudge') {
      expect(r.nudgeText).toBe(ALREADY_REPLIED_NOTE);
      // The whole harm was the instruction that produced the duplicate delivery.
      expect(r.nudgeText).not.toContain('got nothing');
      expect(r.nudgeText).not.toContain('Retry your reply now');
    }
  });

  it('the a2a_replies evidence path is untouched — its note is byte-identical', () => {
    const r = a2aReplyEnforcer({
      ...base, priorReplyOnSameThread: true, verifiedSendReceiptOnThread: false,
    });
    expect(r.decision).toBe('nudge');
    if (r.decision === 'nudge') expect(r.nudgeText).toBe(ALREADY_REPLIED_NOTE);
  });

  it('the input is OPTIONAL — every existing caller shape behaves exactly as before', () => {
    const r = a2aReplyEnforcer({ ...base, priorReplyOnSameThread: false });
    expect(r.decision).toBe('nudge');
    if (r.decision === 'nudge') expect(r.nudgeText).toBe(FRESH_MISS_NOTE);
  });

  it('the four no_action arms are untouched by the new evidence', () => {
    const withReceipt = { ...base, verifiedSendReceiptOnThread: true };
    expect(a2aReplyEnforcer({ ...withReceipt, triggeredByReplyNeededIntent: false }).decision).toBe('no_action');
    expect(a2aReplyEnforcer({ ...withReceipt, sentToAgentThisTurn: true }).decision).toBe('no_action');
    expect(a2aReplyEnforcer({ ...withReceipt, alreadyNudgedForMissedReply: true }).decision).toBe('no_action');
    expect(a2aReplyEnforcer({ ...withReceipt, agentProducedText: false }).decision).toBe('no_action');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 — THE INCIDENT, REPLAYED THROUGH BOTH HALVES
// ════════════════════════════════════════════════════════════════════════════════

describe('the round-11 incident replay', () => {
  it('kevin\'s delivered-but-unbound ANSWER no longer draws a re-send instruction', () => {
    // The exact shape of the incident: a VERIFIED send_to_agent receipt on the thread,
    // and NOTHING in a2a_replies (the send omitted thread_id, so it never bound).
    seedReceipt();
    const receipted = hasVerifiedA2ASendOnThread(AGENT, THREAD_SHORT, THREAD_FULL);
    expect(receipted).toBe(true);

    const r = a2aReplyEnforcer({
      ...base,
      priorReplyOnSameThread: false,   // a2a_replies is empty for this thread — the defect
      verifiedSendReceiptOnThread: receipted,
    });
    expect(r.decision).toBe('nudge');
    if (r.decision === 'nudge') expect(r.nudgeText).toBe(ALREADY_REPLIED_NOTE);
  });

  it('and the same shape WITHOUT the receipt still gets told the peer heard nothing', () => {
    const receipted = hasVerifiedA2ASendOnThread(AGENT, THREAD_SHORT, THREAD_FULL);
    expect(receipted).toBe(false);
    const r = a2aReplyEnforcer({
      ...base, priorReplyOnSameThread: false, verifiedSendReceiptOnThread: receipted,
    });
    expect(r.decision).toBe('nudge');
    if (r.decision === 'nudge') expect(r.nudgeText).toBe(FRESH_MISS_NOTE);
  });
});

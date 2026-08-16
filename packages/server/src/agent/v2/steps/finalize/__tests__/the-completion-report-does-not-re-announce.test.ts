// UX-REPAIR ROUND 11 — T42. THE COMPLETION REPORT TELLS THE TRUTH.
//
// ── THE INCIDENT, AS THE LEDGER RECORDED IT (round-11 S5-C) ──────────────────────────────
// BehaviorBot's compile task `34519aca` closed `done` at 01:28:33. Its own receipt —
// `work.result_delivery_id` = `1f03db51`, `channel='dashboard'`, `recipient_id='owner'`,
// `outcome='delivered'` — had reached the owner at 01:25:51, and the compiled answer
// `836ede5c` at 01:26:09. `scheduleCompletionReport` fired anyway, because its selector asks
// only "did a one-shot task close in this turn's window" and NEVER consults deliveries. The
// engine event it wrote asserts, in its own first sentence, that the owner "have not seen the
// result yet" — false at the moment it was written — and the turn it scheduled posted a THIRD
// owner bubble re-announcing a 3.2-minute-old answer.
//
// ── THE GUARD, AND WHY IT IS THE EXISTING MECHANISM ──────────────────────────────────────
// This is the round-2 escalation reality-check pattern (T12): a truth guard on a mechanism
// that stays exactly where it is. The ack-and-ghost fix is UNTOUCHED — a one-shot task that
// closed on an A2A turn with nothing owner-facing behind it still rides the event, with the
// same text, byte for byte. What the guard removes is the case where the sentence is a lie.
//
// The "already owner-evidenced" test is not invented here. It is the narrowing
// `answered-edge.ts:turnDeliveredToPerson` already uses for the same question, imported from
// its declared owner (`work/ask-settlement.ts`) rather than retyped: delivered, off the peer
// lane, not a start-ack, and not one of the chip bubbles the platform has already ruled is
// not an answer. That last clause is load-bearing and measured, not decorative — on the dev
// body, 125 `done` one-shot rows point their `result_delivery_id` at a `tool-turn` chip, and
// counting those as "the owner has seen it" would suppress reports that really are owed.
//
// Nothing else moves: the four guarantees in the block's header, the `[no-reply]` escape and
// the recurring-run silence are all still properties of the same code, and the skip is
// non-burning — no counter is spent, exactly as T12's reality-check skip behaves.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t42-completion-report-test', 'dojo.db'),
  };
});

vi.mock('../../../../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { scheduleCompletionReport } from '../close-the-loop.js';
import type { FinalizeContext } from '../index.js';

const AGENT = 'behaviorbot';
const CONV = 'conv-owner';
const TITLE = 'Synthesize combined buy + plant recommendation once both research streams land';

/** `turnStartedAt` exactly as preflight builds it: SQLite datetime text, seconds-granular. */
const asTurnStartedAt = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

const ctx = (turnStartedAt: string, isA2ATurn = true): FinalizeContext => ({
  agentId: AGENT, turnNumber: 4887, db: mockDb.current!, isA2ATurn, turnStartedAt,
} as unknown as FinalizeContext);

interface DeliveryShape {
  channel: string;
  tool?: string;
  outcome?: string;
  recipientId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
}

/** A delivery row of the caller's shape, plus (optionally) the bubble it points at. */
function delivery(id: string, d: DeliveryShape): string {
  if (d.messageId) {
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, display_kind, display_tier,
                             conversation_id, turn_number, created_at)
       VALUES (?, ?, 'assistant', 'the compiled answer', 'owner', ?, 'user-visible', ?, 4887, ?)`,
    ).run(d.messageId, AGENT, d.messageId.startsWith('chip') ? 'tool-turn' : 'agent-text',
      d.conversationId ?? CONV, Date.now());
  }
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, recipient_id,
                             conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, 4887, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(id, AGENT, d.tool ?? 'dashboard', d.channel, d.recipientId ?? null,
    d.conversationId ?? null, d.messageId ?? null, d.outcome ?? 'delivered');
  return id;
}

/** A one-shot tracker task that closed `done` inside the turn window, on the given receipt. */
function doneTask(id: string, deliveryId: string, closedAtMs: number, openedAtMs: number): void {
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'open', 'tracker', 0, 0, ?, ?, ?)`,
  ).run(id, AGENT, id, TITLE, openedAtMs, openedAtMs);
  // Both schema conditions for a closed row: the upheld adjudication (two-key) and
  // migration 135's `done means DELIVERED` receipt.
  mockDb.current!.prepare(
    `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
     VALUES (?, 'done', 'upheld', 'pm', ?)`,
  ).run(id, Date.now());
  mockDb.current!.prepare(
    `UPDATE work SET state='done', closed_at=?, result_delivery_id=? WHERE id=?`,
  ).run(closedAtMs, deliveryId, id);
}

const reportEvents = (): Array<{ content: string }> =>
  mockDb.current!.prepare(
    `SELECT content FROM messages WHERE origin_intent = 'completion_report' ORDER BY seq ASC`,
  ).all() as Array<{ content: string }>;

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'BehaviorBot', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════
// 1 — THE FALSE FIRE. The incident's own row shape.
// ════════════════════════════════════════════════════════════════════════

describe('a completion the owner already has does not ride the event', () => {
  it('THE INCIDENT: the receipt IS an owner delivery -> no completion report is scheduled', async () => {
    const t = Date.now() - 5 * 60_000;
    delivery('1f03db51', {
      channel: 'dashboard', tool: 'dashboard', recipientId: 'owner',
      conversationId: CONV, messageId: 'bubble-1',
    });
    doneTask('34519aca', '1f03db51', Date.now(), t);

    await scheduleCompletionReport(ctx(asTurnStartedAt(t)));

    expect(reportEvents(), 'the owner has the result; the event asserts he does not').toHaveLength(0);
  });

  it('an iMessage receipt is owner-evidence too — the routed channel, not just the dashboard', async () => {
    const t = Date.now() - 5 * 60_000;
    delivery('d-im', { channel: 'imessage', tool: 'auto-route', recipientId: 'David' });
    doneTask('task-im', 'd-im', Date.now(), t);

    await scheduleCompletionReport(ctx(asTurnStartedAt(t)));
    expect(reportEvents()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2 — THE MECHANISM IS UNTOUCHED. The ack-and-ghost fix still fires, byte for byte.
// ════════════════════════════════════════════════════════════════════════

/** The event text at HEAD for the incident's task, with nothing owner-facing behind it.
 *  Held here verbatim so a guard that quietly reworded the event fails this file. */
const EXPECTED_EVENT = (title: string): string =>
  `[Engine event: completion report owed] You just finished work the owner asked for while you were talking to another agent, so they have not seen the result yet:\n`
  + `  - "${title}"\n\n`
  + `Send the owner ONE short completion note: that the task(s) named ABOVE are done, plus a one-line note of what you did. Hard limits:\n`
  + `- Mention ONLY the task(s) listed above. Do NOT list, summarize, or mention ANY other tasks, blockers, projects, or your overall status, this is a completion note, not a status report or a "what needs you" rundown.\n`
  + `- One or two sentences, on the owner's channel. Do NOT redo the work or re-run tools.\n`
  + `If there is genuinely nothing worth telling them, reply with [no-reply].`;

describe('POSITIVE CONTROL — the ack-and-ghost fix is not narrowed', () => {
  it('a receipt on the PEER lane is not owner evidence: the event still fires, byte-identical', async () => {
    const t = Date.now() - 5 * 60_000;
    delivery('d-a2a', {
      channel: 'a2a', tool: 'send_to_agent', recipientId: 'kelly',
    });
    doneTask('task-a2a', 'd-a2a', Date.now(), t);

    await scheduleCompletionReport(ctx(asTurnStartedAt(t)));

    const events = reportEvents();
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe(EXPECTED_EVENT(TITLE));
  });

  it("a start-ack receipt is not the result: the event still fires", async () => {
    const t = Date.now() - 5 * 60_000;
    delivery('d-ack', {
      channel: 'dashboard', tool: 'engine-ack', recipientId: 'owner',
      conversationId: CONV, messageId: 'bubble-ack',
    });
    doneTask('task-ack', 'd-ack', Date.now(), t);

    await scheduleCompletionReport(ctx(asTurnStartedAt(t)));
    expect(reportEvents()).toHaveLength(1);
  });

  it('a receipt pointing at a TOOL-TURN chip is not an answer: the event still fires (125 live rows)', async () => {
    const t = Date.now() - 5 * 60_000;
    delivery('d-chip', {
      channel: 'dashboard', tool: 'dashboard', recipientId: 'owner',
      conversationId: CONV, messageId: 'chip-1',
    });
    doneTask('task-chip', 'd-chip', Date.now(), t);

    await scheduleCompletionReport(ctx(asTurnStartedAt(t)));
    expect(reportEvents()).toHaveLength(1);
  });

  it('a SUPPRESSED delivery reached nobody: the event still fires', async () => {
    const t = Date.now() - 5 * 60_000;
    delivery('d-sup', {
      channel: 'dashboard', tool: 'dashboard', recipientId: 'owner',
      conversationId: CONV, outcome: 'suppressed',
    });
    doneTask('task-sup', 'd-sup', Date.now(), t);

    await scheduleCompletionReport(ctx(asTurnStartedAt(t)));
    expect(reportEvents()).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3 — THE FOUR GUARANTEES AND THE MIXED CASE.
// ════════════════════════════════════════════════════════════════════════

describe('the guard narrows nothing else', () => {
  it('non-A2A turns never reach the selector at all', async () => {
    const t = Date.now() - 5 * 60_000;
    delivery('d-a2a2', { channel: 'a2a', tool: 'send_to_agent' });
    doneTask('task-user', 'd-a2a2', Date.now(), t);

    await scheduleCompletionReport(ctx(asTurnStartedAt(t), false));
    expect(reportEvents()).toHaveLength(0);
  });

  it('a close BEFORE the turn window is out of scope, evidenced or not', async () => {
    const t = Date.now() - 5 * 60_000;
    delivery('d-old', { channel: 'a2a', tool: 'send_to_agent' });
    doneTask('task-old', 'd-old', t - 60_000, t - 120_000);

    await scheduleCompletionReport(ctx(asTurnStartedAt(t)));
    expect(reportEvents()).toHaveLength(0);
  });

  it('MIXED: two closes, one owner-evidenced -> only the unreported one is named', async () => {
    const t = Date.now() - 5 * 60_000;
    delivery('d-seen', {
      channel: 'dashboard', tool: 'dashboard', recipientId: 'owner',
      conversationId: CONV, messageId: 'bubble-seen',
    });
    delivery('d-unseen', { channel: 'a2a', tool: 'send_to_agent' });
    doneTask('task-seen', 'd-seen', Date.now(), t);
    doneTask('task-unseen', 'd-unseen', Date.now() + 1, t);

    await scheduleCompletionReport(ctx(asTurnStartedAt(t)));

    const events = reportEvents();
    expect(events).toHaveLength(1);
    expect(events[0].content).toContain(TITLE);
    // Both rows carry the same title, so the COUNT of listed lines is the assertion.
    expect(events[0].content.split('\n').filter((l) => l.startsWith('  - "'))).toHaveLength(1);
  });
});

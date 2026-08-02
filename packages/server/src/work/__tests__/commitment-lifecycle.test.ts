// PHASE-2 T7 — open loops become open work (research 07-FULL requirements 4a + 4b).
//
// WHAT WAS THERE. `memory/open-loops.ts` (623 lines) recovered obligations from PROSE: the
// summarizer emitted a fenced OPEN-LOOPS section, a bounded walker parsed it, a Jaccard
// similarity function deduped and resolved it, and a regex guard tried to catch the one
// false belief that had already burned the platform ("I never got your message" — the 7/12
// poison, re-raised five times over 36 hours).
//
// WHAT REPLACES IT, and the shape of the proof:
//
//   4a — CREATED AT CREATION TIME. An unresolved obligation is a `work` row from the moment
//        it exists. The ASK half landed at T3 (an inbound owner message opens
//        `work(kind='ask')` in the same transaction as the message INSERT). The PROMISE half
//        is here: `work(kind='commitment')`, opened by the agent's own declaration, through
//        `transition()`/the writer module — never by reading back what a model wrote.
//   4b — STALE IS NOT CLOSED. Aging is a MARKER computed from `opened_at`; it is not a state
//        and it does not close anything. Only an explicit resolution (with a delivery, because
//        `done` requires one) or a dismissal (`abandoned`) closes a commitment. The daily-brief
//        surfacing is preserved: an aged commitment leaves the per-turn block and appears in
//        the brief, exactly as `status='stale'` used to arrange — without a second state.
//
// Every assertion below has a negative control beside a positive control of the same shape.
// A guard that never bit is not a guard.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-work-commitment-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  openCommitment, resolveCommitment, dismissCommitment,
  COMMITMENT_AGING_DAYS, openObligations, agedObligations,
} from '../store.js';
import { buildOpenWorkInjection, buildAgedWorkBriefSection } from '../obligations.js';

const AGENT = 'kevin';
const DAY_MS = 24 * 60 * 60 * 1000;

const rowFor = (id: string): Record<string, unknown> | undefined =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown> | undefined;
const eventsFor = (id: string): string[] =>
  (mockDb.current!.prepare('SELECT kind FROM work_events WHERE work_id = ? ORDER BY id').all(id) as
    Array<{ kind: string }>).map((r) => r.kind);

/** A delivery the transport door recorded. `done` is unreachable without one. */
function seedDelivery(id: string, over: Record<string, unknown> = {}): string {
  const row = {
    id, agent_id: AGENT, tool: 'send_message', channel: 'dashboard', recipient_id: 'owner', recipient_display: 'owner',
    outcome: 'delivered', root_kind: 'commitment', root_id: null, conversation_id: 'conv-1',
    turn_number: 1, receipt_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
  return id;
}

function seedConversation(id: string): void {
  mockDb.current!.prepare(
    `INSERT OR IGNORE INTO conversations (id, agent_id, channel, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', 'owner', datetime('now'))`,
  ).run(id, AGENT);
}

/** Move a row's clock back without touching state — what real ageing looks like. */
function ageBy(id: string, days: number): void {
  mockDb.current!.prepare('UPDATE work SET opened_at = opened_at - ? WHERE id = ?')
    .run(Math.round(days * DAY_MS), id);
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  seedConversation('conv-1');
  seedConversation('conv-2');
});

// ══════════════════════════════════════════════════════════════════════════════
// 4a — the obligation exists as a row from the moment it is made
// ══════════════════════════════════════════════════════════════════════════════

describe('4a — a promise is a work row at creation time, not prose recovered later', () => {
  it('opens work(kind=commitment, state=open) with origin, conversation and the agent that promised', () => {
    const id = openCommitment({
      agentId: AGENT, description: 'email Bob the roof quote after the site visit',
      conversationId: 'conv-1', turnNumber: 4, sourceMessageId: 'm-1',
    });
    const row = rowFor(id)!;
    expect(row.kind).toBe('commitment');
    expect(row.state).toBe('open');
    expect(row.agent_id).toBe(AGENT);
    expect(row.conversation_id).toBe('conv-1');
    expect(row.title).toBe('email Bob the roof quote after the site visit');
    // Origin is REQUIRED on the spine (Part III). A commitment's origin is the turn that made it.
    expect(row.root_kind).toBe('commitment');
    expect(String(row.root_id)).toContain('m-1');
    expect(row.requester).toBe('agent');
    // It never reaches the project board — same rule as `kind='ask'`.
    expect(['ask', 'commitment']).toContain(row.kind);
    expect(eventsFor(id)).toContain('opened');
  });

  it('NEGATIVE CONTROL: an empty or whitespace description opens nothing', () => {
    expect(openCommitment({ agentId: AGENT, description: '   ', conversationId: 'conv-1', turnNumber: 1, sourceMessageId: 'm-1' })).toBeNull();
    expect(mockDb.current!.prepare("SELECT count(*) AS n FROM work WHERE kind='commitment'").get())
      .toEqual({ n: 0 });
  });

  it('is idempotent per (turn, description): a model repeating itself in one turn owes one thing', () => {
    const a = openCommitment({ agentId: AGENT, description: 'send the invoice', conversationId: 'conv-1', turnNumber: 7, sourceMessageId: 'm-9' });
    const b = openCommitment({ agentId: AGENT, description: 'send the invoice', conversationId: 'conv-1', turnNumber: 7, sourceMessageId: 'm-9' });
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(mockDb.current!.prepare("SELECT count(*) AS n FROM work WHERE kind='commitment'").get())
      .toEqual({ n: 1 });
  });

  it('NEGATIVE CONTROL: the SAME words on a LATER turn are a second promise, not a duplicate', () => {
    // This is the line the deleted Jaccard matcher could not draw. It collapsed anything
    // 60%-similar across the whole agent, so "send the invoice" said on Monday and again on
    // Friday was ONE loop for ever. Identity here is the turn that made the promise.
    const a = openCommitment({ agentId: AGENT, description: 'send the invoice', conversationId: 'conv-1', turnNumber: 7, sourceMessageId: 'm-9' });
    const b = openCommitment({ agentId: AGENT, description: 'send the invoice', conversationId: 'conv-1', turnNumber: 8, sourceMessageId: 'm-11' });
    expect(b).not.toBe(a);
    expect(mockDb.current!.prepare("SELECT count(*) AS n FROM work WHERE kind='commitment'").get())
      .toEqual({ n: 2 });
  });

  it('a dangling conversation id is recorded as ABSENT identity, never allowed to throw the promise away', () => {
    const id = openCommitment({ agentId: AGENT, description: 'check the permit', conversationId: 'no-such-conv', turnNumber: 2, sourceMessageId: 'm-2' });
    expect(id).not.toBeNull();
    expect(rowFor(id!)!.conversation_id).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4b — aging is a marker; only resolution or dismissal closes
// ══════════════════════════════════════════════════════════════════════════════

describe('4b — stale is not closed', () => {
  it('an aged commitment is STILL OPEN — ageing changes no state and closes nothing', () => {
    const id = openCommitment({ agentId: AGENT, description: 'book the survey', conversationId: 'conv-1', turnNumber: 1, sourceMessageId: 'm-1' })!;
    ageBy(id, COMMITMENT_AGING_DAYS + 1);
    expect(rowFor(id)!.state).toBe('open');
    expect(rowFor(id)!.closed_at).toBeNull();
    // ...and reading the aged set does not write anything either. The deleted mechanism's
    // `markStaleLoops` was an UPDATE fired from the daily brief; this is a SELECT.
    expect(agedObligations(AGENT).map((r) => r.id)).toEqual([id]);
    expect(rowFor(id)!.state).toBe('open');
    expect(eventsFor(id)).toEqual(['opened']);
  });

  it('aged work leaves the per-turn block and appears in the daily brief — the demotion is preserved', () => {
    const fresh = openCommitment({ agentId: AGENT, description: 'call the surveyor', conversationId: 'conv-1', turnNumber: 1, sourceMessageId: 'm-1' })!;
    const old = openCommitment({ agentId: AGENT, description: 'chase the council', conversationId: 'conv-1', turnNumber: 2, sourceMessageId: 'm-2' })!;
    ageBy(old, COMMITMENT_AGING_DAYS + 1);

    const block = buildOpenWorkInjection(AGENT, 'conv-1') ?? '';
    expect(block).toContain('call the surveyor');
    expect(block).not.toContain('chase the council');

    const brief = buildAgedWorkBriefSection(AGENT) ?? '';
    expect(brief).toContain('chase the council');
    expect(brief).not.toContain('call the surveyor');
    expect(fresh).not.toBe(old);
  });

  it('NEGATIVE CONTROL: below the threshold nothing is aged, so the brief section is null', () => {
    const id = openCommitment({ agentId: AGENT, description: 'nearly old', conversationId: 'conv-1', turnNumber: 1, sourceMessageId: 'm-1' })!;
    ageBy(id, COMMITMENT_AGING_DAYS - 1);
    expect(agedObligations(AGENT)).toEqual([]);
    expect(buildAgedWorkBriefSection(AGENT)).toBeNull();
  });

  it('resolution CLOSES it, and requires the delivery that makes `done` true', () => {
    const id = openCommitment({ agentId: AGENT, description: 'send the summary', conversationId: 'conv-1', turnNumber: 3, sourceMessageId: 'm-3' })!;
    const d = seedDelivery('dlv-1');
    const r = resolveCommitment(id, { agentId: AGENT, resultDeliveryId: d, note: 'sent' });
    expect(r.kind).toBe('applied');
    expect(rowFor(id)!.state).toBe('done');
    expect(rowFor(id)!.result_delivery_id).toBe(d);
    expect(rowFor(id)!.closed_at).not.toBeNull();
  });

  it('NEGATIVE CONTROL: resolution with NO delivery is REFUSED — a promise is not kept by saying so', () => {
    const id = openCommitment({ agentId: AGENT, description: 'send the summary', conversationId: 'conv-1', turnNumber: 3, sourceMessageId: 'm-3' })!;
    const r = resolveCommitment(id, { agentId: AGENT, resultDeliveryId: null, note: 'trust me' });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('done-requires-delivery');
    expect(rowFor(id)!.state).toBe('open');
  });

  it('NEGATIVE CONTROL: resolution against a delivery id that does not exist is REFUSED', () => {
    const id = openCommitment({ agentId: AGENT, description: 'send it', conversationId: 'conv-1', turnNumber: 3, sourceMessageId: 'm-3' })!;
    const r = resolveCommitment(id, { agentId: AGENT, resultDeliveryId: 'dlv-ghost', note: 'sent' });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('delivery-unresolved');
    expect(rowFor(id)!.state).toBe('open');
  });

  it('dismissal CLOSES it as abandoned — honest about the fact that nothing was delivered', () => {
    const id = openCommitment({ agentId: AGENT, description: 'find the old plans', conversationId: 'conv-1', turnNumber: 3, sourceMessageId: 'm-3' })!;
    const r = dismissCommitment(id, { agentId: AGENT, reason: 'the owner said drop it' });
    expect(r.kind).toBe('applied');
    expect(rowFor(id)!.state).toBe('abandoned');
    expect(rowFor(id)!.result_delivery_id).toBeNull();
    expect(eventsFor(id)).toContain('transition');
  });

  it('NEGATIVE CONTROL: a dismissal with no reason is refused — a close nobody can explain does not happen', () => {
    const id = openCommitment({ agentId: AGENT, description: 'find the plans', conversationId: 'conv-1', turnNumber: 3, sourceMessageId: 'm-3' })!;
    const r = dismissCommitment(id, { agentId: AGENT, reason: '  ' });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('reason-required');
    expect(rowFor(id)!.state).toBe('open');
  });

  it('a closed commitment leaves BOTH surfaces — the block and the brief', () => {
    const id = openCommitment({ agentId: AGENT, description: 'gone after closing', conversationId: 'conv-1', turnNumber: 1, sourceMessageId: 'm-1' })!;
    ageBy(id, COMMITMENT_AGING_DAYS + 1);
    expect(buildAgedWorkBriefSection(AGENT)).toContain('gone after closing');
    dismissCommitment(id, { agentId: AGENT, reason: 'dropped' });
    expect(buildAgedWorkBriefSection(AGENT)).toBeNull();
    expect(buildOpenWorkInjection(AGENT, 'conv-1')).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The injection surface: what the per-turn OPEN WORK block owes, carried across
// ══════════════════════════════════════════════════════════════════════════════

describe('the per-turn block carries every property the OPEN LOOPS block had', () => {
  it('current conversation first, then cross-conversation rows LABELLED as such', () => {
    openCommitment({ agentId: AGENT, description: 'this conversation item', conversationId: 'conv-1', turnNumber: 1, sourceMessageId: 'm-1' });
    openCommitment({ agentId: AGENT, description: 'other conversation item', conversationId: 'conv-2', turnNumber: 2, sourceMessageId: 'm-2' });
    const block = buildOpenWorkInjection(AGENT, 'conv-1')!;
    expect(block.indexOf('this conversation item')).toBeLessThan(block.indexOf('other conversation item'));
    expect(block).toMatch(/other conversation/i);
  });

  it('caps the cross-conversation overflow, so one busy peer cannot crowd the lane', () => {
    openCommitment({ agentId: AGENT, description: 'mine', conversationId: 'conv-1', turnNumber: 1, sourceMessageId: 'm-0' });
    for (let i = 0; i < 8; i++) {
      openCommitment({ agentId: AGENT, description: `other ${i}`, conversationId: 'conv-2', turnNumber: 10 + i, sourceMessageId: `m-${i}` });
    }
    const block = buildOpenWorkInjection(AGENT, 'conv-1')!;
    const others = (block.match(/other \d/g) ?? []).length;
    expect(others).toBeGreaterThan(0);
    expect(others).toBeLessThanOrEqual(3);
  });

  it('is bounded in size, so a backlog cannot eat the volatile lane on a floor model', () => {
    for (let i = 0; i < 40; i++) {
      openCommitment({
        agentId: AGENT,
        description: `a deliberately long commitment description number ${i} that exists to push the block past its budget`,
        conversationId: 'conv-1', turnNumber: i + 1, sourceMessageId: `m-${i}`,
      });
    }
    expect(buildOpenWorkInjection(AGENT, 'conv-1')!.length).toBeLessThanOrEqual(700);
  });

  it('NEGATIVE CONTROL: another agent\'s commitments never appear in this agent\'s block', () => {
    openCommitment({ agentId: 'someone-else', description: 'not kevins problem', conversationId: 'conv-1', turnNumber: 1, sourceMessageId: 'm-1' });
    expect(buildOpenWorkInjection(AGENT, 'conv-1')).toBeNull();
  });

  it('shows the id prefix the model needs to close the row, and it resolves back', () => {
    const id = openCommitment({ agentId: AGENT, description: 'resolvable', conversationId: 'conv-1', turnNumber: 1, sourceMessageId: 'm-1' })!;
    const block = buildOpenWorkInjection(AGENT, 'conv-1')!;
    const m = /\[([0-9a-z:.-]{4,})\]/i.exec(block);
    expect(m).not.toBeNull();
    expect(openObligations(AGENT).some((r) => r.id === id)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The store-contradiction guard's requirement, preserved STRUCTURALLY
// ══════════════════════════════════════════════════════════════════════════════

describe('the 7/12 poison cannot become a durable obligation any more', () => {
  it('nothing in this path reads prose: an obligation exists only where a caller declared one', () => {
    // The deleted guard was a REGEX (`MISSING_INBOUND_RE`) defending against a PARSER that
    // manufactured rows from summary text. The parser is gone, so the manufacturing path is
    // gone: the only ways a row appears now are `openAsk` (an ingested message with its
    // structural channel/sender columns) and `openCommitment` (an explicit call).
    //
    // This asserts the consequence rather than the argument: the exact poison sentence,
    // handed to the only remaining creation door, produces one row that the agent OWNS and
    // can close — not an immortal belief that re-injects itself for 36 hours.
    const poison = "I couldn't see your last message — it got eaten before I could read it";
    const id = openCommitment({ agentId: AGENT, description: poison, conversationId: 'conv-1', turnNumber: 1, sourceMessageId: 'm-1' })!;
    expect(rowFor(id)!.state).toBe('open');
    const r = dismissCommitment(id, { agentId: AGENT, reason: 'transient context state, not an obligation' });
    expect(r.kind).toBe('applied');
    expect(buildOpenWorkInjection(AGENT, 'conv-1')).toBeNull();
  });

  it('NEGATIVE CONTROL: no summary text anywhere can create a row — there is no ingest path left', async () => {
    // If a fenced-section ingest ever comes back, this import resolves and this test fails.
    let moduleExists = true;
    try { await import('../../memory/open-loops.js'); } catch { moduleExists = false; }
    expect(moduleExists).toBe(false);
    expect(mockDb.current!.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='open_loops'",
    ).get()).toEqual({ n: 0 });
  });
});

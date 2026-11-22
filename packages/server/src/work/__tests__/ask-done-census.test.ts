// SWEEP-A TB1 Step 4 — THE TWO CENSUSES THAT KEEP THE AUTHORITY THE ONLY AUTHORITY.
//
// DESIGN-2BUGS §1: "a permanent test enumerates every code site that can write ask state
// `done` and asserts they all resolve to the one authority; a second census asserts the
// structural invariant (no `claimed` ask whose claiming turn has finalized)."
//
// WHAT THEY MEASURED AT THE PRE-CHANGE TREE (`3439240`), so RED is a number:
//   PART A — `work/store.ts` carried FIVE `to: 'done'` sites and `work/ask-settlement.ts`
//            did not exist; the ask-reaching ones were `closeAsksForDelivery`,
//            `reconcileOrphanedClaims`, `settleJoinDelivered` and `resolveCommitment`
//            (the model's own tool) — FOUR owners of one decision (verify report M2).
//   PART B — a turn could finalize leaving its ask `claimed` for ever: the recorded fossil,
//            reproduced 4/4 by the kit scenario `ask-burst-always-settles` at TB0.
//
// Neither census can pass vacuously: PART A asserts the measured map EQUALS the declared
// inventory in BOTH directions (a new `done` writer fails; a stale entry fails too) and
// carries planted-fault self-tests for its scanner; PART B drives real rows.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-ask-done-census', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { askIdForMessage, claimAsk, stampClaimingTurn, openDelegationJoin } from '../store.js';
import { settleAsksAtTurnFinalize } from '../ask-settlement.js';
import { insertMessage } from '../../memory/message-store.js';
import { turnRow } from '../../agent/v2/__tests__/helpers/live-turn.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

export interface DoneSites { done: number; dynamic: number }

/**
 * Two counts per file, and BOTH are load-bearing:
 *   `done`    — a transition input carrying the literal `to: 'done'`;
 *   `dynamic` — a `transition(...)` whose target state is a variable, so the literal count
 *               cannot see it. `setTrackerStatus` is written that way (property shorthand
 *               `to,`), and a census that only counted literals would have a hole exactly
 *               the shape of the next closer somebody adds.
 */
export function measureDoneSites(text: string): DoneSites {
  const t = stripComments(text);
  const done = (t.match(/\bto:\s*'done'/g) ?? []).length;
  let dynamic = 0;
  const call = /\btransition\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(t))) {
    const seg = t.slice(m.index, m.index + 500);
    const target = seg.match(/\bto\s*(?::\s*([^,\n]+)|,)/);
    if (!target) continue;
    const value = (target[1] ?? '').trim();
    if (value === '' || !/^['"]/.test(value)) dynamic++;
  }
  return { done, dynamic };
}

/** The sites that can reach a `kind='ask'` row. This is the number the design exists to
 *  reduce: FOUR at `3439240` (verify report M2), TWO at TB1's close (the authority plus the
 *  join relay, handed forward), and **ONE** since SWEEP-A TB2 folded the join arm in. The
 *  inventory is a TIGHTENING each time it shrinks, and the equality below is what refuses a
 *  new one appearing quietly. */
const ASK_DONE_WRITERS: Array<{ file: string; fn: string; handedTo?: string }> = [
  { file: 'work/ask-settlement.ts', fn: 'settleAsk' },
];

describe('CENSUS A — every writer of ask-`done` resolves to the one authority', () => {

  it('the ask-reaching writers are the authority and the join arm, and nothing else', () => {
    expect(ASK_DONE_WRITERS.map((w) => `${w.file}:${w.fn}`)).toEqual([
      'work/ask-settlement.ts:settleAsk',
    ]);
    // …and every ask-reaching site that is NOT the authority carries the task that folds it in.
    for (const w of ASK_DONE_WRITERS) {
      if (w.file === 'work/ask-settlement.ts') continue;
      expect(w.handedTo, `${w.fn} must name the task that folds it into the authority`).toBeTruthy();
    }
  });

  // ── SWEEP CORE-1 CT2 — THE SCHEDULED-RUN CLOSER'S OWN INVENTORY ──
  //
  // Added in the same commit as the change that made it an authority, on TB2's precedent: an
  // inventory that a task can extend without touching is an inventory that stops describing
  // the product. It is a SEPARATE census from the ask one above because the subject is a
  // different row kind with a different lifecycle — folding a run into `settleAsk` would have
  // meant loosening three of that authority's narrowings (its conversation, its turn, its ask
  // row) to admit a subject that has none of them, which is the "scoped away" move this sweep
  // exists to refuse.
  describe('CENSUS A2 — the scheduled-RUN closer', () => {
    /** Every site that can record a run's own outcome word. `settleOccurrence` is the one
     *  writer; the three below are its scopes and carry no decision of their own. */
    const RUN_SETTLE_SITES: Array<{ file: string; fn: string }> = [
      { file: 'work/occurrences.ts', fn: 'settleOccurrence' },
    ];

    it('exactly one function settles a run, and it is where the census says', () => {
      const declared = RUN_SETTLE_SITES.map((w) => `${w.file}:${w.fn}`);
      expect(declared).toEqual(['work/occurrences.ts:settleOccurrence']);
    });
  });

  it('SELF-TEST: the scanner sees both forms and is not fooled by prose', () => {
    expect(measureDoneSites("transition(id, { to: 'done', by: 'agent' })")).toEqual({ done: 1, dynamic: 0 });
    expect(measureDoneSites('transition(id, {\n  to,\n  by: input.by,\n})')).toEqual({ done: 0, dynamic: 1 });
    expect(measureDoneSites('transition(id, { to: nextState, by: "agent" })')).toEqual({ done: 0, dynamic: 1 });
    expect(measureDoneSites("// transition(id, { to: 'done' })")).toEqual({ done: 0, dynamic: 0 });
    expect(measureDoneSites("transition(id, { to: 'open', by: 'agent' })")).toEqual({ done: 0, dynamic: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PART B — NO ASK SURVIVES ITS TURN'S FINALIZE STILL `claimed`
// ════════════════════════════════════════════════════════════════════════════════

const AGENT = FXID.n4;
const CONV = 'conv-1';

const ownerInbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: AGENT, role: 'user', content: 'can you check the roof quote?',
  lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
  conversationId: CONV,
  inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  ...over,
});

describe('CENSUS B — the structural invariant: no `claimed` ask outlives its turn', () => {
  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    mockDb.current = db;
    runMigrations();
    db.pragma('foreign_keys = ON');
    db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, '${FX.n4}', 'idle', '1970-01-01')`).run(AGENT);
    db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')`).run(AGENT);
  });

  it('three turns, three endings, ZERO claimed survivors', () => {
    const db = mockDb.current!;
    vi.useFakeTimers({ toFake: ['Date'] });   // one turn after another, as an agent's turns run
    const claim = (id: string, turn: number): void => {
      vi.setSystemTime(Date.now() + 5_000);
      turnRow(AGENT, turn, null);
      insertMessage(ownerInbound({ id }) as never);
      claimAsk(askIdForMessage(id), AGENT);
      stampClaimingTurn(askIdForMessage(id), turn);
    };
    // turn 1 — answered
    claim('m-answered', 1);
    db.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
       VALUES ('d-1', ?, 1, 'auto-route', 'dashboard', ?, 'delivered', datetime('now','+5 seconds'))`,
    ).run(AGENT, CONV);
    // turn 2 — said nothing at all
    claim('m-silent', 2);
    // turn 3 — delegated
    claim('m-delegated', 3);
    openDelegationJoin({
      agentId: AGENT, parentWorkId: askIdForMessage('m-delegated'),
      threads: [{ threadId: 'th-1', assigneeAgent: 'peer' }],
      replyConversationId: CONV, ttlAt: Date.now() + 600_000,
    });

    for (const turn of [1, 2, 3]) settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn });

    const survivors = db.prepare(
      `SELECT id, claimed_by_turn FROM work
        WHERE kind = 'ask' AND state = 'claimed' AND claimed_by_turn IN (1,2,3)`,
    ).all() as Array<{ id: string; claimed_by_turn: number }>;
    expect(survivors, 'a claimed ask whose turn has finalized, with no reply on its way, is the fossil').toEqual([]);

    const state = (id: string): string => (db.prepare('SELECT state FROM work WHERE id = ?')
      .get(askIdForMessage(id)) as { state: string }).state;
    expect(state('m-answered')).toBe('done');
    expect(state('m-silent'), 'no evidence means the owner is served again, never parked').toBe('open');
    expect(state('m-delegated'), 'delegated work outstanding means held, and visibly owed').toBe('blocked');
    vi.useRealTimers();
  });

  it('the one exception: an ask whose reply is still on its way stays claimed with its turn', () => {
    const db = mockDb.current!;
    insertMessage(ownerInbound({ id: 'm-in-flight' }) as never);
    claimAsk(askIdForMessage('m-in-flight'), AGENT);
    turnRow(AGENT, 4, null);
    stampClaimingTurn(askIdForMessage('m-in-flight'), 4);
    db.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, payload_json, next_attempt_at)
       VALUES ('d-q', ?, 4, 'auto-route', 'imessage', ?, 'pending', '{"text":"on its way"}', 0)`,
    ).run(AGENT, CONV);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 4 });
    const state = (db.prepare('SELECT state FROM work WHERE id = ?').get(askIdForMessage('m-in-flight')) as { state: string }).state;
    expect(state).toBe('claimed');
  });

  it('every ending is NON-TERMINAL or delivery-backed — nothing is quietly written off', () => {
    const db = mockDb.current!;
    insertMessage(ownerInbound({ id: 'm-silent' }) as never);
    claimAsk(askIdForMessage('m-silent'), AGENT);
    turnRow(AGENT, 9, null);
    stampClaimingTurn(askIdForMessage('m-silent'), 9);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 9 });
    const closedWithout = db.prepare(
      `SELECT count(*) AS c FROM work
        WHERE kind = 'ask' AND state IN ('done','failed','abandoned') AND result_delivery_id IS NULL`,
    ).get() as { c: number };
    expect(closedWithout.c).toBe(0);
  });
});

// UX-REPAIR ROUND 12 / T47 — THE OWED COMPILE IS ENFORCED, NOT REQUESTED.
//
// ── THE DEFECT, MEASURED (round-12 S5, `round12/S5-catalog.md` §8.6) ──
// Three redrive steers each carried the sentence "Do NOT search, open files, run commands, or
// call any tools first — not the tracker, not the vault, not a peer notification; everything
// you need is quoted below." The model answered them with `load_tool_docs`, `history_search`,
// `history_get`, `work_update` (errored ×2) and `history_get`, across 12m26s, and never
// composed the reply. PERSUASION FAILED 3/3. The doctrine the owner set for round 12 is
// STRUCTURE OVER PERSUASION: where the engine currently asks the model to behave, make the
// right outcome mechanical.
//
// ── THE FORCING PATTERN ALREADY EXISTED AND ALREADY WORKED ──
// `agent/v2/steps/preflight/closeout-gate.ts` — "the engine refuses non-tracker tool calls
// until a tracker call lands" — and its LOAD-BEARING CONSTRAINT is inherited here VERBATIM:
// BUG-2, the gate is NEVER armed on a turn a human is waiting on. Armed on a conversation turn
// it deleted the agent's just-streamed reply and refused the tool calls the answer needed. The
// BUG-2 half of this task is driven end to end beside the close-out gate's own clauses in
// `agent/v2/__tests__/integration.test.ts`; this file is the decision and the two spine reads.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-compile-gate-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import {
  openAsk, claimAsk, stampClaimingTurn, openDelegationJoin, landPiece, transition,
} from '../../../work/store.js';
import {
  JOIN_DRIVE_ENTRY, JOIN_REDRIVE_BOUND, recordJoinDrive,
} from '../../../work/join-drive.js';
import { CLOSE_OUT_WORK_OPS, SATISFYING_WORK_OPS, toolOpKey } from '../../../tools/work-verbs.js';
import {
  COMPILE_OWED_ALLOWED_OPS, compileOwedAfterRedrive, stillCompileOwed, compileOwedGateDecision,
} from '../compile-owed-gate.js';

const AGENT = 'primary';
const OTHER = 'kelly';
const PEER = 'kayla';
const CONV = 'conv-1';

/** The S5 shape: an owner ask, two delegated streams, both back, no compiled reply. */
function seedCompileOwedJoin(msgId = 'm-1'): string {
  const db = mockDb.current!;
  const openedAt = Date.now() - 20 * 60_000;
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES (?, ?, 'user', 'plan the trip', 'owner', 'dashboard', ?, ?, NULL)`,
  ).run(msgId, AGENT, CONV, openedAt);
  const askId = openAsk({
    agentId: AGENT, messageId: msgId, conversationId: CONV, requesterId: 'owner',
    openedAt, title: 'plan the trip',
  });
  claimAsk(askId, AGENT);
  stampClaimingTurn(askId, 4900);
  const kids = openDelegationJoin({
    parentWorkId: askId, agentId: AGENT, replyConversationId: CONV,
    ttlAt: Date.now() + 60 * 60_000,
    threads: [
      { threadId: `${msgId}-thread-a`, assigneeAgent: OTHER, intent: 'ASSIGN' as const, hopCount: 0 },
      { threadId: `${msgId}-thread-b`, assigneeAgent: PEER, intent: 'ASSIGN' as const, hopCount: 0 },
    ],
  });
  for (const [i, childId] of kids.entries()) {
    db.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
       VALUES (?, ?, NULL, 'send_to_agent', 'a2a', 'delivered', datetime('now'))`,
    ).run(`piece-d-${msgId}-${i}`, AGENT);
    landPiece(childId, {
      deliveryId: `piece-d-${msgId}-${i}`, content: `stream ${i} result`, messageId: null, actorId: OTHER,
    });
  }
  return askId;
}

const spendARedrive = (askId: string, attempt = 1): void => {
  recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, {
    attempt, bound: JOIN_REDRIVE_BOUND, turnNumber: 4900 + attempt,
  });
};

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES
       (?, 'Primary', 'idle', '1970-01-01'), (?, 'Kelly', 'idle', '1970-01-01'), (?, 'Kayla', 'idle', '1970-01-01')`,
  ).run(AGENT, OTHER, PEER);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════
// WHAT THE GATE ARMS ON.
// ════════════════════════════════════════════════════════════════════════════════

describe('T47: the gate arms on a compile the system has already come back for', () => {
  it('a compile-pending join with a REDRIVE spent is owed; the same join before any rung is NOT', () => {
    const askId = seedCompileOwedJoin();
    // The join completed and the compile order went out — but the system has not yet had to
    // come back for it. Steering is still the whole mechanism at that point.
    expect(compileOwedAfterRedrive(AGENT)).toEqual([]);

    spendARedrive(askId);

    expect(compileOwedAfterRedrive(AGENT)).toEqual([askId]);
  });

  it('the gate is per-agent: another agent\'s owed compile is not this agent\'s duty', () => {
    const askId = seedCompileOwedJoin();
    spendARedrive(askId);
    expect(compileOwedAfterRedrive(PEER)).toEqual([]);
  });

  it('a DEFERRED pass is not a rung spent — it arms nothing', () => {
    const askId = seedCompileOwedJoin();
    recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redriveDeferred, { attempt: 1, bound: JOIN_REDRIVE_BOUND, turnNumber: 4901 });
    expect(compileOwedAfterRedrive(AGENT)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// WHAT DISARMS IT. Both halves of the plan's clause: the answer, and the relay.
// ════════════════════════════════════════════════════════════════════════════════

describe('T47: the gate disarms the moment the join resolves, by any road', () => {
  it('THE ANSWER: the ask closing on its receipt takes the duty off the row', () => {
    const askId = seedCompileOwedJoin();
    spendARedrive(askId);
    expect(stillCompileOwed([askId])).toEqual([askId]);

    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
       VALUES ('d-answer', ?, 4910, 'dashboard', 'dashboard', ?, 'delivered', datetime('now'))`,
    ).run(AGENT, CONV);
    expect(transition(askId, {
      to: 'done', by: 'engine', actorId: 'test', reason: 'the compiled answer reached the owner',
      evidenceRef: 'd-answer', resultDeliveryId: 'd-answer',
    }).kind).toBe('applied');

    expect(stillCompileOwed([askId])).toEqual([]);
    expect(compileOwedAfterRedrive(AGENT)).toEqual([]);
  });

  it('T48\'S RELAY: the flag alone coming off is enough — the gate reads the spine, not a latch', () => {
    const askId = seedCompileOwedJoin();
    spendARedrive(askId);
    // What `clearJoinCompilePending` does when the relay lands but the row cannot move.
    mockDb.current!.prepare('UPDATE work SET compile_pending = 0 WHERE id = ?').run(askId);
    expect(stillCompileOwed([askId])).toEqual([]);
  });

  it('a row that VANISHED underneath the turn is dropped, never refused against', () => {
    // The close-out gate's own PHASE-6 T0D finding: a gate that refuses on the strength of a
    // row that no longer exists traps the turn. Same answer here, from the same shape.
    const askId = seedCompileOwedJoin();
    spendARedrive(askId);
    expect(stillCompileOwed([askId, 'ask:never-existed'])).toEqual([askId]);
    expect(stillCompileOwed(['ask:never-existed'])).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// THE ALLOWED SET, CLOSED AND NAMED — AND THE COLLISION WITH THE CLOSE-OUT GATE.
// ════════════════════════════════════════════════════════════════════════════════

describe('T47: the allowed set is closed, named, and cannot deadlock the close-out gate', () => {
  it('it is exactly `send_to_agent` plus the tracker calls that SATISFY the close-out gate', () => {
    expect([...COMPILE_OWED_ALLOWED_OPS].sort())
      .toEqual([...new Set(['send_to_agent', ...SATISFYING_WORK_OPS])].sort());
  });

  it('THE COLLISION: every call this gate allows is also allowed by the close-out gate, so a '
    + 'turn armed by BOTH can always satisfy both', () => {
    // The close-out gate demands a tracker call FIRST (its own text). If this gate refused
    // those, a turn armed by both would have no legal move at all — the deadlock the plan
    // required argued. The union is what makes it impossible.
    for (const op of COMPILE_OWED_ALLOWED_OPS) {
      if (op === 'send_to_agent') continue;
      expect(CLOSE_OUT_WORK_OPS.has(op), `${op} must pass the close-out gate too`).toBe(true);
      expect(SATISFYING_WORK_OPS.has(op), `${op} must SATISFY the close-out gate`).toBe(true);
    }
  });

  it('S5\'S OWN CALLS ARE REFUSED — including the ones the close-out gate would wave through', () => {
    const askId = seedCompileOwedJoin();
    spendARedrive(askId);
    for (const name of ['load_tool_docs', 'history_search', 'history_get', 'file_read', 'web_search']) {
      expect(compileOwedGateDecision([askId], false, toolOpKey(name)).refuse,
        `${name} is what the model reached for instead of composing`).toBe(true);
    }
    // `load_tool_docs` and the tracker READS are in the close-out gate's allowlist and are NOT
    // in this one: reading a tool's schema is not composing the owner's reply.
    expect(CLOSE_OUT_WORK_OPS.has('load_tool_docs')).toBe(true);
    expect(COMPILE_OWED_ALLOWED_OPS.has('load_tool_docs')).toBe(false);
    expect(compileOwedGateDecision([askId], false, toolOpKey('work_update', { action: 'get', id: 'x' })).refuse).toBe(true);
  });

  it('send_to_agent PASSES — the steer\'s own hand-off-fetch exception, kept open', () => {
    const askId = seedCompileOwedJoin();
    spendARedrive(askId);
    expect(compileOwedGateDecision([askId], false, toolOpKey('send_to_agent', { to_agent: 'kayla' })).refuse).toBe(false);
  });

  it('the tracker close-outs PASS', () => {
    const askId = seedCompileOwedJoin();
    spendARedrive(askId);
    for (const [name, args] of [
      ['work_update', { action: 'status', status: 'complete' }],
      ['work_update', { action: 'complete_step' }],
      ['work_update', { action: 'close_project' }],
      ['work_note', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(compileOwedGateDecision([askId], false, toolOpKey(name, args)).refuse,
        `${name} ${JSON.stringify(args)} must pass`).toBe(false);
    }
  });

  it('nothing owed, or the duty already discharged this turn -> the gate asks the database '
    + 'nothing and refuses nothing', () => {
    const askId = seedCompileOwedJoin();
    spendARedrive(askId);
    expect(compileOwedGateDecision([], false, 'file_read').refuse).toBe(false);
    expect(compileOwedGateDecision([askId], true, 'file_read').refuse).toBe(false);
  });

  it('the decision hands back the LIVE list, so a resolved ask stops being named in a refusal', () => {
    const askId = seedCompileOwedJoin();
    spendARedrive(askId);
    const d = compileOwedGateDecision(['ask:never-existed', askId], false, 'file_read');
    expect(d.live).toEqual([askId]);
    expect(d.refuse).toBe(true);
    const gone = compileOwedGateDecision(['ask:never-existed'], false, 'file_read');
    expect(gone.live).toEqual([]);
    expect(gone.refuse, 'nothing is owed any more, so nothing is refused').toBe(false);
  });
});

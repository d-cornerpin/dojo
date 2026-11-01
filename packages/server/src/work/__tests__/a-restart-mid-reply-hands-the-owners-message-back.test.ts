// ════════════════════════════════════════════════════════════════════════════════════════
// A RESTART MID-REPLY HANDS THE OWNER'S MESSAGE BACK — and never answers it twice.
//
// ── THE DEFECT (3.5 proof run, observation O2) ──────────────────────────────────────────
// The server was restarted while the agent was streaming its reply to the owner. After the
// restart the owner's ask stayed `claimed`, the agent sat idle, and no reply ever came.
//
// Two boot steps read ONE fact, and the first one destroyed it before the second could read
// it. `resetWorkingAgentsToIdleAtBoot` (index.ts step 4b) closes every turn the dead process
// left open as `terminated`; `reconcileOrphanedClaims` (step 4b1) then looked for claims
// whose turn had `ended_at IS NULL` — and found none, because 4b had just ended them. On the
// run's own database both stranded asks point at turns whose exit is `terminated`, and the
// boot reconcile's last recorded action predates the change that made 4b close turns.
//
// The fact both steps mean is the same: the claiming turn died with its process. A turn
// still open at boot says it, and a turn the boot sweep (or the stuck-run reaper) closed as
// `terminated` says it too — that exit is written by no other path. These tests drive the
// boot steps in their real order, so they hold whichever step reads first.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-restart-mid-reply', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../store.js';
import { reconcileOrphanedClaims } from '../ask-settlement.js';
import { sweepBootStaleness } from '../work-reaper.js';
import { resetWorkingAgentsToIdleAtBoot } from '../../agent/agent-status.js';
import { insertMessage } from '../../memory/message-store.js';
import { getWaitingHumanConversations } from '../../agent/v2/counterparty.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const db = (): Database.Database => mockDb.current!;

const askOf = (messageId: string): { state: string; result_delivery_id: string | null } =>
  db().prepare('SELECT state, result_delivery_id FROM work WHERE id = ?')
    .get(askIdForMessage(messageId)) as { state: string; result_delivery_id: string | null };
const turnOf = (n: number): { ended_at: string | null; exit_reason: string | null } =>
  db().prepare('SELECT ended_at, exit_reason FROM turns WHERE agent_id = ? AND turn_number = ?')
    .get(AGENT, n) as { ended_at: string | null; exit_reason: string | null };

/** The owner writes from the dashboard; the turn that picks it up claims the ask. */
function ownerAskClaimedBy(turn: number, effectfulCalls = 0): void {
  insertMessage({
    id: 'm-1', agentId: AGENT, role: 'user', content: 'can you check the roof quote?',
    lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
    conversationId: 'conv-1',
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never);
  claimAsk(askIdForMessage('m-1'), AGENT);
  stampClaimingTurn(askIdForMessage('m-1'), turn);
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, root_kind, root_id, source_message_id, conv_key,
                        started_at, answered, effectful_calls)
     VALUES (?, ?, 'user', 'ask', 'm-1', 'm-1', 'owner', datetime('now'), 0, ?)`,
  ).run(AGENT, turn, effectfulCalls);
  db().prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(AGENT);
}

/** The process is gone; a new one boots and runs its recovery steps in index.ts order. */
function restart(): void {
  resetWorkingAgentsToIdleAtBoot();   // 4b
  sweepBootStaleness();               // 4b1
  reconcileOrphanedClaims();          // 4b1 (D19)
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, '${FX.n4}', 'idle', '1970-01-01')`,
  ).run(AGENT);
  d.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')`,
  ).run(AGENT);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('a restart in the middle of a reply', () => {
  it('hands the unanswered owner message back, so the boot re-drain serves it', () => {
    ownerAskClaimedBy(7);
    restart();
    expect(turnOf(7).exit_reason, 'the dead turn is still closed as terminated').toBe('terminated');
    expect(askOf('m-1').state, 'the owner is still owed an answer').toBe('open');
    expect(getWaitingHumanConversations(AGENT).length, 'the re-drain sees him waiting').toBe(1);
  });

  it('closes, and never re-answers, a message the dead turn had already answered', () => {
    ownerAskClaimedBy(7);
    // The reply reached the owner and its delivery is on the ledger; the process died before
    // the turn's own finalize ran, so the ask still reads `claimed`.
    db().prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome)
       VALUES ('d-answer', ?, 7, 'dashboard', 'dashboard', 'conv-1', 'delivered')`,
    ).run(AGENT);
    restart();
    expect(askOf('m-1')).toEqual({ state: 'done', result_delivery_id: 'd-answer' });
    expect(getWaitingHumanConversations(AGENT).length, 'nothing is re-served').toBe(0);
  });

  it('holds, and does not repeat, a turn that had already acted without answering (P6b)', () => {
    ownerAskClaimedBy(7, 1);
    restart();
    expect(askOf('m-1').state).toBe('claimed');
    expect(getWaitingHumanConversations(AGENT).length).toBe(0);
  });

  it('leaves alone a claim whose turn ended on its own (the turn finalize owns that one)', () => {
    ownerAskClaimedBy(7);
    db().prepare(
      `UPDATE turns SET ended_at = datetime('now'), exit_reason = 'no_reply_intended' WHERE agent_id = ? AND turn_number = 7`,
    ).run(AGENT);
    db().prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(AGENT);
    restart();
    expect(askOf('m-1').state).toBe('claimed');
  });
});

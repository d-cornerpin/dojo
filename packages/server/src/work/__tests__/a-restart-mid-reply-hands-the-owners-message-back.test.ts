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
import { reconcileOrphanedClaims } from '../orphaned-claims.js';
import { sweepBootStaleness } from '../work-reaper.js';
import { resetWorkingAgentsToIdleAtBoot } from '../../agent/agent-status.js';
import { insertMessage, insertMessageIfAbsent } from '../../memory/message-store.js';
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
/** What the Dojo told the agent: the awareness notices on its events lane. */
const noticesToAgent = (): string[] =>
  (db().prepare("SELECT content FROM messages WHERE agent_id = ? AND lane = 'events' ORDER BY seq")
    .all(AGENT) as Array<{ content: string }>).map((r) => r.content);
/** Age the owner's message and its claim, as if the process died that long ago. */
function ageEverything(ms: number): void {
  const at = Date.now() - ms;
  db().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(at, 'm-1');
  db().prepare('UPDATE work SET opened_at = ?, updated_at = ? WHERE id = ?').run(at, at, askIdForMessage('m-1'));
}

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

  it('closes on the dashboard bubble the dead turn stored: a cut-off turn names no answer key, like a live one', () => {
    ownerAskClaimedBy(7);
    // The real dashboard shape: the reply is a stored agent-text row, and its delivery points
    // at it. The turn died before it could record which bubble was its answer.
    insertMessageIfAbsent({ id: 'a-1', agentId: AGENT, role: 'assistant', content: 'The roof quote is fine.', turnNumber: 7 } as never);
    db().prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
       VALUES ('d-bubble', ?, 7, 'dashboard', 'dashboard', 'conv-1', 'a-1', 'delivered', datetime('now', '+1 second'))`,
    ).run(AGENT);
    restart();
    expect(askOf('m-1')).toEqual({ state: 'done', result_delivery_id: 'd-bubble' });
    expect(getWaitingHumanConversations(AGENT).length, 'nothing is re-served').toBe(0);
  });

  it('hands back a turn that had already acted, naming each effect from the ledger so it is not repeated', () => {
    ownerAskClaimedBy(7, 1);
    // The dead turn's own record: one email that went out, one lookup, one send that errored,
    // and one call the process died inside (no result row at all).
    const call = (id: string, name: string, input: Record<string, unknown>): void => {
      insertMessageIfAbsent({ id: `u-${id}`, agentId: AGENT, role: 'assistant', turnNumber: 7,
        content: JSON.stringify([{ type: 'tool_use', id, name, input }]) } as never);
    };
    const result = (id: string, isError: boolean): void => {
      insertMessageIfAbsent({ id: `r-${id}`, agentId: AGENT, role: 'tool', turnNumber: 7,
        content: JSON.stringify([{ type: 'tool_result', tool_use_id: id, content: isError ? 'failed' : 'ok', is_error: isError }]) } as never);
    };
    call('c1', 'gmail_send', { to: 'roofer@example.com', subject: 'Quote question' }); result('c1', false);
    call('c2', 'gmail_search', { query: 'roof' }); result('c2', false);
    call('c3', 'outlook_send', { to: 'other@example.com', subject: 'Second try' }); result('c3', true);
    call('c4', 'calendar_create', { title: 'Roofer visit' });
    restart();
    expect(askOf('m-1').state, 'never claimed for ever: the agent finishes the job').toBe('open');
    expect(getWaitingHumanConversations(AGENT).length).toBe(1);
    const notice = noticesToAgent().find((c) => c.includes('handed back'))!;
    expect(notice).toContain('gmail_send');
    expect(notice).toContain('roofer@example.com');
    expect(notice).toMatch(/calendar_create.*may or may not have/);
    expect(notice, 'a lookup is not an effect').not.toContain('gmail_search');
    expect(notice, 'a send that errored did nothing').not.toContain('outlook_send');
    expect(notice).toMatch(/do not repeat/i);
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

describe('the hand-back carries the message\'s real age — no timer decides its fate', () => {
  it('a message received days before the restart is handed back, never dropped, with when it arrived', () => {
    ownerAskClaimedBy(7);
    ageEverything(3 * 24 * 60 * 60 * 1000);
    restart();
    expect(askOf('m-1').state, 'the owner is still owed an answer, however old').toBe('open');
    const notice = noticesToAgent().find((c) => c.includes('handed back'));
    expect(notice, 'the agent is told why it has this message again').toBeDefined();
    expect(notice!).toContain('can you check the roof quote?');
    expect(notice!).toMatch(/received .*\(\d{4}-\d\d-\d\dT/);
    expect(notice!).toContain('3 days ago');
  });

  it('a fresh hand-back says it too, so the agent knows its last reply never landed', () => {
    ownerAskClaimedBy(7);
    restart();
    const notice = noticesToAgent().find((c) => c.includes('handed back'));
    expect(notice).toMatch(/turn 7 stopped before it answered/);
    expect(notice).toMatch(/minute|second/);
  });

  it('an answered message gets no hand-back notice', () => {
    ownerAskClaimedBy(7);
    db().prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome)
       VALUES ('d-answer', ?, 7, 'dashboard', 'dashboard', 'conv-1', 'delivered')`,
    ).run(AGENT);
    restart();
    expect(noticesToAgent().some((c) => c.includes('handed back'))).toBe(false);
  });
});

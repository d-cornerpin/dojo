// C8 (PM-CANNOT-APPROVE.md, v3.5 field fix 3 evidence round; owner ruling (a)): A LINE A TASK OWES ITS
// OWNER IS NOT UNSOLICITED, AND WHEN THE DOJO HOLDS ONE BACK THE TASK SAYS SO.
//
// The 3.5.0-preflight.4 live check: the main agent opened a catch-up task for a helper whose whole goal
// was one line to the owner ("CATCH-UP: daily report sweep + deliver the owner's line"). The helper did
// the sweep, filed its close, and wrote the line as its final reply. The turn was a wake with no human
// waiting, the helper's proactive-send streak was at the threshold, and RC-5.3 demoted the line to a
// working note, on three turns running. The owner got nothing; the PM's door refused the close
// (correctly: nothing reached him), and nothing on the task said the Dojo was why.
//
// Owner ruling (a): when the Dojo itself holds back a helper's delivery, the job isn't left looking
// undelivered. What must stay true: real unsolicited chatter is still budgeted, and a held line is never
// counted as delivered.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-c8-owed-line', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../../../../agent/a2a-transport.js', () => ({ deliverA2AMessage: async () => ({ delivered: true, threadId: 't' }) }));

import { runMigrations } from '../../../../../db/migrations.js';
import { initState, type AgentTurnState } from '../../../state.js';
import { runCloseoutFloors } from '../closeout-floors.js';
import { bumpProactiveSendStreak, getProactiveSendStreak, PROACTIVE_SEND_DEMOTE_THRESHOLD } from '../../../proactive-budget.js';
import { openTrackerProject, openTrackerTask } from '../../../../../work/tracker-store.js';
import { appendWorkEvent } from '../../../../../work/store.js';
import { heldDeliveryLine } from '../../../../../tracker/owed-delivery.js';
import { trackerHandlers } from '../../../../../agent/tools/cat/tracker.js';
import { openTurnContext, endTurnContext } from '../../../../../agent/turn-context.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const HELPER = 'helper-agent';
const MAIN = 'main-agent';
const PM = 'pm-agent';
const TURN = 61;
const LINE = 'No new Dojo reports today: all 20 open reports were already sent to you.';
const PUSH_HELD = 'the owner has not answered your last messages sent on your own';
const db = (): Database.Database => mockDb.current!;
let turnStartMs = 0;

function catchUpTask(): string {
  const p = openTrackerProject({ name: 'daily report', createdBy: MAIN, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null } } as never) as string;
  return openTrackerTask({
    projectId: p, title: 'CATCH-UP: daily report sweep + deliver the owner\'s line', status: 'in_progress',
    assignedTo: HELPER, createdBy: MAIN, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
}
/** The helper's own close, filed in this turn (Key 1), as the live check had it. G7's delivery for it is the
 *  close call's own tool-call row, pushed to the dashboard: a chip, not a line to the owner. */
function fileCloseThisTurn(t: string): void {
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, display_kind, turn_number, created_at, sent_at) VALUES ('m-close', ?, 'owner', 'assistant', '[{"type":"tool_use"}]', 'tool-turn', ?, ?, ?)`)
    .run(HELPER, TURN, Date.now(), Date.now());
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, message_id, outcome, created_at) VALUES ('d-close', ?, ?, 'dashboard', 'dashboard', 'm-close', 'delivered', datetime('now'))`).run(HELPER, TURN);
  appendWorkEvent(t, 'validation_requested', HELPER, { requested_state: 'done', reason: 'quiet-day line delivered', from: 'claimed', result_delivery_id: 'd-close' }, turnStartMs + 5_000);
}
function state(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const s = initState({ agentId: HELPER, contextWindow: 100_000, isAutoRouted: false, configuredModelId: 'floor', turnNumber: TURN } as never);
  return { ...s, turnStartMs, ...over } as AgentTurnState;
}
function ctx(): PostCallClassifyContext {
  return {
    agentId: HELPER, turnNumber: TURN, db: db(), messageId: 'msg-live',
    turnCtx: { conversationId: null, root: undefined },
    settledContextWakeTurn: true, hasUnansweredUser: false,
    result: { content: LINE, toolCalls: [], inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' },
  } as unknown as PostCallClassifyContext;
}
const scratch = (): PostCallScratch => ({
  persistedContent: LINE, interAgentTurn: false, deliberateSurfaceTurn: false, deliveredAsStartLine: false,
  hasXmlFallbackTools: false, effectiveModelIdForPersist: 'floor',
} as PostCallScratch);
const held = (t: string): Array<{ reason: string }> =>
  db().prepare(`SELECT json_extract(payload, '$.reason') AS reason FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'delivery_held'`).all(t) as Array<{ reason: string }>;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [HELPER, MAIN, PM]) db().prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')").run(id, id);
  turnStartMs = Date.now() - 30_000;
  for (let i = 0; i < PROACTIVE_SEND_DEMOTE_THRESHOLD; i++) bumpProactiveSendStreak(HELPER);   // the streak the live check had
});
afterEach(() => { endTurnContext(PM); mockDb.current?.close(); mockDb.current = null; });

describe('C8: the budget does not demote a line the task owes its owner', () => {
  it('THE LIVE CHECK: the helper\'s owed line, at the streak threshold, goes out and is not counted as a ping', () => {
    const t = catchUpTask();
    fileCloseThisTurn(t);
    const sc = scratch();
    runCloseoutFloors(state(), ctx(), sc);
    expect(sc.persistedContent).toBe(LINE);
    expect(getProactiveSendStreak(HELPER)).toBe(PROACTIVE_SEND_DEMOTE_THRESHOLD);
    expect(held(t)).toEqual([]);
  });

  it('NEGATIVE CONTROL: a wake working no task is still budgeted (real unsolicited chatter stays in chat, its push held)', () => {
    const sc = scratch();
    const c = ctx();
    runCloseoutFloors(state(), c, sc);
    expect(sc.persistedContent).toBe(LINE);
    expect(c.turnCtx.pushHeld).toBe(PUSH_HELD);
  });

  it('NEGATIVE CONTROL: once a line has reached the person, the task owes nothing more and the budget applies again', () => {
    const t = catchUpTask();
    fileCloseThisTurn(t);
    db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at) VALUES ('d-line', ?, 60, 'dashboard', 'dashboard', 'delivered', datetime('now'))`).run(HELPER);
    const sc = scratch();
    const c = ctx();
    runCloseoutFloors(state(), c, sc);
    expect(sc.persistedContent).toBe(LINE);
    expect(c.turnCtx.pushHeld).toBe(PUSH_HELD);
  });
});

describe('C8: a line the Dojo holds back for another reason is recorded on the task, and the PM is told', () => {
  function heldByTheArrivalRule(): string {
    const t = catchUpTask();
    fileCloseThisTurn(t);
    const sc = scratch();
    // A second answer to a message that arrived mid-turn is held as a note (T31), whatever the budget says.
    runCloseoutFloors(state({ loopCount: 2, owedInterruptGrant: { atLoop: 1, afterReply: true, messageIds: ['m-arrival'] } } as never), ctx(), sc);
    expect(sc.persistedContent).toBeNull();
    return t;
  }

  it('the task records that the Dojo held the line and why; the review says so', () => {
    const t = heldByTheArrivalRule();
    expect(held(t).map((h) => h.reason)).toEqual(['a second answer to a message that arrived mid-turn; that message is answered by its own turn']);
    const review = heldDeliveryLine(t);
    expect(review).toContain('Held by the Dojo: the worker\'s line at ');
    expect(review).toContain(`was not sent (a second answer to a message that arrived mid-turn; that message is answered by its own turn): "${LINE}". Nothing from it reached the person`);
  });


  it('a hold that a later delivered line replaced is not reported', () => {
    const t = heldByTheArrivalRule();
    db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at) VALUES ('d-later', ?, 62, 'dashboard', 'dashboard', 'delivered', datetime('now', '+1 minute'))`).run(HELPER);
    const review = heldDeliveryLine(t);
    expect(review).not.toContain('Held by the Dojo');
  });
});

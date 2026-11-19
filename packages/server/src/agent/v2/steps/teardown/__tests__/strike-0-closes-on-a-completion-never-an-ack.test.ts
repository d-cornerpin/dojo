// v3.5 field fix 3, review rounds 3 and 4: THE STRIKE-0 BOUNDARY CLOSE NEVER CLOSES ON A LINE OF TEXT.
//
// Strike-0 (`finalize-record.ts`) is the ENGINE closing, at the turn's end, the tasks that turn
// opened. Base closed them on the turn's delivery summary: any out-of-band line ("via imessage")
// counted, so an iMessage "On it" engine-closed the tasks it had just opened. Round 3 asked each
// task for "its answer", and the re-review measured a start ack followed by a PROGRESS line
// engine-closing every step ("Found three tables; I will book one next").
//
// THE RULING (binding, round 4): done is measured, never declared. The engine hands a same-turn task
// in for its worker only on what the engine can count (`work/done/proof.ts:engineProof`): a file the
// worker wrote for the task, or a measure that came down to 0. A line of text never makes the engine
// hand a task in, on any channel; a text answer is the worker's to hand in. Nothing here sets done.
//
// Driven through the real `finalizeTurnRecord` on a real migrated database: the real settlement
// runs on the turn's answer line, then strike-0 runs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-strike0', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../../../db/migrations.js';
import { finalizeTurnRecord } from '../finalize-record.js';
import { initState, type AgentTurnState } from '../../../state.js';
import type { TeardownContext } from '../index.js';
import { openAsk, claimAsk, stampClaimingTurn, askIdForMessage } from '../../../../../work/store.js';
import { openTrackerTask } from '../../../../../work/tracker-store.js';

const AGENT = 'agent-strike0';
const TURN = 812;
const db = (): Database.Database => mockDb.current!;
let clock = 0;

function ctxFor(conv: string, channel: string, answerRowId: string | null): TeardownContext {
  return {
    agentId: AGENT,
    turnCtx: {
      agentId: AGENT, root: undefined, servedWork: undefined, convKey: `${channel}:owner`,
      startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
      engineStartAckDeliveredThisTurn: false, startAckSteersInjected: 0,
      anyToolStartedThisTurn: true, toolPhaseEndedBySpinBrake: false,
      lastAssembledAtIso: null,
    } as never,
    turnNumber: TURN, db: db(),
    chosenConvKey: `${channel}:owner`, chosenConversationId: conv, lastAssembledAtIso: null,
    terminalAnswerRowId: answerRowId, triggerWorkId: null,
    toolPhaseEndedBySpinBrake: false,
    counterparty: { kind: 'user', name: 'the owner', relation: 'owner', channel, senderId: 'owner', senderIsAgent: false } as never,
    isA2ATurn: false, isEngineTurn: false,
    turnStartedAt: new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' '),
    inboundChannel: channel, inboundContext: null,
    reArmIfStrandedNoAnswer: vi.fn(), stopStatusHeartbeat: vi.fn(),
  } as unknown as TeardownContext;
}

const freshState = (): AgentTurnState => initState({
  agentId: AGENT, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'model-1',
  turnNumber: TURN, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
  lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: 'dashboard',
  inboundContext: null,
});

/** The owner asks on `channel`; the turn claims the ask and opens two tasks for it. */
function askAndTasks(channel: string): { conv: string; tasks: string[] } {
  const conv = `conv-${channel}`;
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id) VALUES (?, ?, ?, ?, 'owner')`)
    .run(conv, AGENT, channel, channel);
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at)
     VALUES ('msg-ask', ?, 'user', 'book the table and send me the confirmation', 'owner', ?, ?)`,
  ).run(AGENT, conv, Date.now() - 50_000);
  openAsk({ agentId: AGENT, messageId: 'msg-ask', conversationId: conv, requesterId: 'owner', openedAt: Date.now() - 50_000, title: 'book the table' });
  claimAsk(askIdForMessage('msg-ask'), AGENT);
  stampClaimingTurn(askIdForMessage('msg-ask'), TURN);
  const tasks = ['find a table', 'book it'].map((title) => openTrackerTask({
    title, status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: 'msg-ask', turn: TURN, convKey: `${channel}:owner` },
  }));
  return { conv, tasks };
}

/** A model line the turn delivered on `channel`, after the tasks opened. */
function line(id: string, channel: string, conv: string, content: string): string {
  clock += 2;
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number, display_kind, created_at)
     VALUES (?, ?, 'assistant', ?, 'owner', ?, ?, 'agent-text', ?)`,
  ).run(`m-${id}`, AGENT, content, conv, TURN, Date.now() + clock * 1000);
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', datetime('now', ?))`,
  ).run(id, AGENT, TURN, channel === 'dashboard' ? 'dashboard' : 'imessage_send', channel, conv, `m-${id}`, `+${clock} seconds`);
  return `m-${id}`;
}

function openTurn(): void {
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, source_message_id, conv_key, answered, effectful_calls, started_at)
     VALUES (?, ?, 'user', 'conv', 'msg-ask', 'owner', 0, 1, datetime('now','-60 seconds'))`,
  ).run(AGENT, TURN);
}

const states = (ids: string[]): string[] =>
  ids.map((id) => (db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state);

beforeEach(() => {
  clock = 0;
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, permissions) VALUES (?, 'A', 'idle', '{"file_read":"*"}')`).run(AGENT);
  openTurn();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const markAck = (lineId: string): void => {
  // The engine's own marking of the start line (`terminal-text.ts`): its message row carries
  // `origin_intent = engine_start_ack`, and its channel push is recorded on the `engine-ack` lane.
  db().prepare("UPDATE messages SET origin_intent = 'engine_start_ack' WHERE id = ?").run(`m-${lineId}`);
  db().prepare("UPDATE deliveries SET tool = 'engine-ack' WHERE id = ?").run(lineId);
};

describe('(a) a turn whose only line is the start ack does NOT engine-close the tasks it opened', () => {
  for (const channel of ['imessage', 'dashboard']) {
    it(`${channel}: the marked "On it" only; both tasks stay open`, async () => {
      const { conv, tasks } = askAndTasks(channel);
      const ack = line('d-onit', channel, conv, "On it, I've opened two tasks and will book the table.");
      markAck('d-onit');
      await finalizeTurnRecord(freshState(), ctxFor(conv, channel, ack));
      expect(states(tasks)).toEqual(['claimed', 'claimed']);
    });
    it(`${channel}: an UNMARKED "On it" final line (the ask settles on it) still closes nothing`, async () => {
      const { conv, tasks } = askAndTasks(channel);
      const ack = line('d-onit-plain', channel, conv, "On it, I've opened two tasks and will book the table.");
      await finalizeTurnRecord(freshState(), ctxFor(conv, channel, ack));
      expect(states(tasks)).toEqual(['claimed', 'claimed']);
    });
  }
});

describe('THE RE-REVIEW PROBE (R1): the start ack, then a PROGRESS line, closes nothing', () => {
  for (const channel of ['dashboard', 'imessage']) {
    it(`${channel}: "On it." then "Found three tables, booking next" leaves both tasks open`, async () => {
      const { conv, tasks } = askAndTasks(channel);
      line('d-ack', channel, conv, 'On it.');
      markAck('d-ack');
      const progress = line('d-progress', channel, conv, 'Found three tables that fit; I will book one next and send you the confirmation.');
      await finalizeTurnRecord(freshState(), ctxFor(conv, channel, progress));
      expect(states(tasks)).toEqual(['claimed', 'claimed']);
    });
  }
});

describe('(b) a real text completion is the WORKER\'s to close on, never the engine\'s', () => {
  for (const channel of ['imessage', 'dashboard']) {
    it(`${channel}: ack, then the booking confirmation; strike-0 leaves both tasks open`, async () => {
      const { conv, tasks } = askAndTasks(channel);
      line('d-ack', channel, conv, 'On it.');
      markAck('d-ack');
      const answer = line('d-booked', channel, conv, 'Booked: a table for four on Friday at 7pm, confirmation 4471.');
      await finalizeTurnRecord(freshState(), ctxFor(conv, channel, answer));
      expect(states(tasks)).toEqual(['claimed', 'claimed']);
    });
  }
});

const engineHandedIn = (id: string): void => {
  const ev = db().prepare("SELECT actor FROM work_events WHERE work_id = ? AND kind = 'handed_in'").all(id) as Array<{ actor: string }>;
  expect(ev.map((e) => e.actor)).toEqual(['engine']);
  expect(db().prepare("SELECT COUNT(*) AS c FROM work_events WHERE work_id = ? AND kind = 'decided'").get(id)).toEqual({ c: 0 });
};

describe('(c) what the engine can count is handed in for its worker, never set done', () => {
  it('a file the worker wrote, charged to one task, hands in that task and only that one', async () => {
    const { conv, tasks } = askAndTasks('dashboard');
    const only = line('d-file-line', 'dashboard', conv, 'Here is the confirmation.');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.join(process.env.DOJO_HOME ?? '/tmp', 'confirmation.txt');
    fs.writeFileSync(file, 'Confirmation 4471: a table for four on Friday at 7pm.');
    db().prepare(
      `INSERT INTO audit_log (id, agent_id, action_type, target, result) VALUES ('a-file', ?, 'file_write', ?, 'success')`,
    ).run(AGENT, file);
    db().prepare(`INSERT INTO work_ledger (work_id, item_key, tool, first_at, last_at) VALUES (?, ?, 'file_write', ?, ?)`)
      .run(tasks[0], `file:${file}`, Date.now(), Date.now());
    await finalizeTurnRecord(freshState(), ctxFor(conv, 'dashboard', only));
    expect(states(tasks)).toEqual(['handed_in', 'claimed']);
    engineHandedIn(tasks[0]);
  });

  it('a measured task whose measure reads 0 is handed in; its unmeasured sibling stays open', async () => {
    const { conv, tasks } = askAndTasks('dashboard');
    db().prepare(`UPDATE work SET measure_json = ?, measure_initial = 12, measure_remaining = 12, measure_at = ? WHERE id = ?`)
      .run(JSON.stringify({ tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' }), Date.now(), tasks[0]);
    const { recordMeasured } = await import('../../../../../work/ledger-store.js');
    recordMeasured(tasks[0], { ok: true, count: 0 }, Date.now());
    const only = line('d-swept', 'dashboard', conv, 'The inbox is clear.');
    await finalizeTurnRecord(freshState(), ctxFor(conv, 'dashboard', only));
    expect(states(tasks)).toEqual(['handed_in', 'claimed']);
    engineHandedIn(tasks[0]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// t158 A — THE BOARD-CHECK STEER MAY NOT ORDER A SECOND COPY OF AN ANSWER THE OWNER HAS.
//
// THE INCIDENT (ritual run 6, scenario S2, a quick arithmetic question mid-conversation):
//   owner    "Quick one while I think of it: what is 17 times 6?"
//   agent    "102. One thing worth flagging: I did open the handover note … I haven't acted on
//             it, and the check task stays parked until you ask."        <- the owner SAW this
//   engine   steer: "… Then say that same answer again with every line corrected against what
//             the board actually holds …"
//   agent    work_update(list)  -> the board matched what the agent had said
//   agent    "102. And the rest of that answer, now checked against the board … Nothing else
//             is owed from my side."                                      <- the owner saw it AGAIN
//
// The standing-state-claim class (T36) is right that a claim about the board must be checked
// against the board. What was wrong is the LAST ORDER of its steer: a full restatement of a
// reply the person already holds, even when every line was right. The steer now says: the
// user already has your reply; if it all matches, end with [no-reply]; if a line is wrong,
// tell the user only the correction.
//
// THESE TESTS DRIVE THE REAL STEPS (`runPostCallClassify`, one model call at a time, in the
// order the loop runs them) on a real in-memory database, the way the ghosted-ask suite does,
// then write the turn record off whatever the truthful-answer key was given and ask the real
// draft re-classifier and the real ask-settlement authority for their verdicts.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t158-test', 'dojo.db'),
  };
});

/** The dashboard door, in the one row it writes: an assistant `chat:message` whose row exists
 *  becomes a delivery (`gateway/ws.ts` → `recordDashboardDelivery`). */
const broadcastSpy = vi.fn((event: { type?: string; message?: { id?: string; role?: string } }) => {
  if (event?.type !== 'chat:message' || event.message?.role !== 'assistant') return;
  const id = event.message.id;
  if (!id || !mockDb.current) return;
  if (!mockDb.current.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)) return;
  mockDb.current.prepare(
    `INSERT OR IGNORE INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                                       message_id, outcome, created_at)
     VALUES (?, ?, ?, 'dashboard', 'dashboard', ?, ?, 'delivered', datetime('now'))`,
  ).run(`d-${id}`, AGENT, TURN, CONV, id);
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [never])) }));
vi.mock('../../../../../services/imessage-bridge.js', () => ({ stripSystemTags: (s: string) => s }));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'active' }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../../../../work/store.js';
import { settleAsksAtTurnFinalize } from '../../../../../work/ask-settlement.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { reclassifyTurnDrafts } from '../../teardown/draft-reclassify.js';
import { runPostCallClassify, type PostCallClassifyContext } from '../index.js';

const AGENT = 'harnessbot';
const CONV = 'conv-1';
const TURN = 71;

const ASK = 'Quick one while I think of it: what is 17 times 6?';
/** Every line of this reply is right about the board; it is the first reply the owner reads. */
const FIRST_REPLY =
  '102. One thing worth flagging: I opened the handover note and did not act on it. '
  + 'The check task stays parked until you ask.';
/** A one-line correction, said only when the board disagreed. */
const THE_CORRECTION = 'One correction: the check task was closed yesterday, so nothing is parked.';

interface Bag { [k: string]: unknown }

const turnCtxFor = (): Bag => ({
  agentId: AGENT, kind: 'user', convKey: 'dashboard:owner', conversationId: CONV,
  root: { kind: 'ask', id: 'm-ask', conversationId: CONV }, servedWork: undefined,
  turnNumber: TURN,
  deferredUserReplyWithTools: null, deferredDeliveredByAck: false,
  engineStartAckDeliveredThisTurn: false, startAckPromotedRowId: null,
  startAckSteerArmedThisTurn: false, startAckSteerRequested: false,
  startAckSteersInjected: 0, startAckSteerInjectedAtLoop: null,
  inboundClassifiedAsWork: true,
});

/** The truthful-answer key, as `turn-closures.ts` keeps it: ONE setter, last write wins. */
let answerKey: string | null;
const noteTerminalAnswer = vi.fn((rowId: string) => { answerKey = rowId; });
const persistAndBroadcastSystemRow = vi.fn();
const deliverEngineUserAck = vi.fn(async () => undefined);

const modelResult = (content: string, toolCalls: ToolCall[] = []): PostCallClassifyContext['result'] => ({
  content, toolCalls, inputTokens: 10, outputTokens: 5, stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
} as unknown as PostCallClassifyContext['result']);

function ctxFor(turnCtx: Bag, messageId: string, content: string): PostCallClassifyContext {
  return {
    agentId: AGENT, turnCtx: turnCtx as never, turnNumber: TURN, db: mockDb.current,
    agent: { id: AGENT, name: 'HarnessBot' } as never,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false } as never,
    counterpartyIsAgentSender: false,
    chosenConvKey: 'dashboard:owner',
    hasUnansweredUser: true,
    triggerRow: { rowid: 1, id: 'm-ask', content: ASK } as never,
    isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false,
    mostRecentIsA2A: false, mostRecentInbound: undefined, pendingEngineEvent: null,
    unrepliedAssign: null, a2aReplyContext: null, a2aReplyAssignMessageId: null,
    settledContextWakeTurn: false, waitingConvs: [], inboundChannel: 'dashboard',
    latestUserSource: 'dashboard', lastUserMessageContent: ASK,
    configuredModelId: 'test-model', turnStartedAt: new Date().toISOString(), messageId,
    result: modelResult(content), maxToolLoops: 75,
    reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer,
    deliverEngineUserAck: deliverEngineUserAck as never,
    persistAndBroadcastSystemRow, startAckRepliedNow: () => false,
  } as unknown as PostCallClassifyContext;
}

let state: AgentTurnState;

/** One model call that ends the iteration with no tool calls. */
async function speak(turnCtx: Bag, messageId: string, content: string) {
  const out = await runPostCallClassify(state, ctxFor(turnCtx, messageId, content));
  state = out.state;
  return out;
}

/** The board read the steer asked for, recorded the way the loop records a tool result. */
function readTheBoard(): void {
  state = advance(state, {
    toolCalls: [{ id: 'tc-list', name: 'work_update', arguments: { action: 'list' } } as ToolCall],
    toolResults: [{ toolCallId: 'tc-list', name: 'work_update', isError: false, content: '[]' } as AgentTurnState['toolResults'][number]],
  });
}

const steersOf = (floor: string): Array<{ content: string }> =>
  (state.steerQueue as unknown as { fired: Array<{ floor: string; content: string }> }).fired
    .filter((e) => e.floor === floor);

/** `teardown/finalize-record.ts`, in the facts the authorities read. */
function finalizeTurnRecord(): void {
  mockDb.current!.prepare(
    `INSERT OR REPLACE INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason,
                                   answered, answer_message_id)
     VALUES (?, ?, datetime('now','-90 seconds'), datetime('now'), ?, ?, ?)`,
  ).run(AGENT, TURN, answerKey ? 'answered' : 'no_reply_intended', answerKey ? 1 : 0, answerKey);
}

const rowKind = (id: string): string | undefined =>
  (mockDb.current!.prepare('SELECT display_kind FROM messages WHERE id = ?').get(id) as { display_kind: string } | undefined)?.display_kind;

/** What the owner sees as an ANSWER this turn: assistant text bubbles not demoted to notes. */
const answerBubbles = (): string[] =>
  (mockDb.current!.prepare(
    `SELECT content FROM messages WHERE agent_id = ? AND turn_number = ? AND role = 'assistant'
        AND lane = 'owner' AND display_kind = 'agent-text' AND content <> '' ORDER BY seq ASC`,
  ).all(AGENT, TURN) as Array<{ content: string }>).map((r) => r.content);

const askRow = (workId: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(workId) as Record<string, unknown>;
const markersFor = (workId: string): string[] =>
  (mockDb.current!.prepare('SELECT payload FROM work_events WHERE work_id = ? ORDER BY id')
    .all(workId) as Array<{ payload: string }>)
    .map((r) => (JSON.parse(r.payload) as { marker?: string }).marker)
    .filter((m): m is string => !!m);

function claimedAsk(): string {
  insertMessage({
    id: 'm-ask', agentId: AGENT, role: 'user', content: ASK,
    lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true, conversationId: CONV,
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never);
  claimAsk(askIdForMessage('m-ask'), AGENT);
  stampClaimingTurn(askIdForMessage('m-ask'), TURN);
  return askIdForMessage('m-ask');
}

beforeEach(() => {
  vi.clearAllMocks();
  answerKey = null;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'HarnessBot', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
  state = initState({
    agentId: AGENT, maxToolLoops: 75, turnNumber: TURN, lastUserMessageContent: ASK,
  } as Parameters<typeof initState>[0]);
  state = advance(state, { loopCount: 1, modelId: 'test-model' });
});

describe('t158 A (i): the board matches, so the model ends with [no-reply] and the owner has ONE answer', () => {
  it('the first reply stays the turn\'s answer; nothing is re-classified, re-steered or re-served', async () => {
    const workId = claimedAsk();
    const turnCtx = turnCtxFor();

    // Call 1: the reply the owner reads. The floor steers (a standing-state claim, no board read).
    const first = await speak(turnCtx, 'msg-first', FIRST_REPLY);
    expect(first.directive).toBe('continue');
    expect(steersOf('promise-floor')).toHaveLength(1);
    expect(answerKey, 'the shown reply is the answer from the moment the steer is filed').toBe('msg-first');

    // Call 2: the board read the steer asked for. Call 3: the board matched, so the model ends.
    readTheBoard();
    state = advance(state, { loopCount: 3 });
    const last = await speak(turnCtx, 'msg-last', '[no-reply]');
    expect(last.directive, 'the turn ends; no further round is granted').toBe('exit');

    // The key still names the FIRST reply, and the ghosted-ask machinery did not wake.
    expect(answerKey).toBe('msg-first');
    expect(steersOf('ghosted-ask')).toHaveLength(0);
    expect(steersOf('ghosted-ask-answer')).toHaveLength(0);

    // The turn record, the draft re-classifier and the ask authority, all real.
    finalizeTurnRecord();
    expect(reclassifyTurnDrafts({ agentId: AGENT, turnNumber: TURN }).reclassified).toEqual([]);
    expect(rowKind('msg-first')).toBe('agent-text');
    expect(answerBubbles()).toEqual([FIRST_REPLY]);
    expect(settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN }))
      .toEqual({ closed: 1, held: 0, reopened: 0 });
    expect(askRow(workId).state).toBe('done');
    expect(askRow(workId).result_delivery_id).toBe('d-msg-first');
    expect(markersFor(workId)).not.toContain('ct0_ask_re_served');
  });

  it('the persist seam is the ONE setter: the floor adds no second write of the key', async () => {
    // Re-derived for t158: `runPersistAssistant` runs before the turn-ending floors and files the
    // shown reply as the truthful answer ('a genuine terminal reply'). The floor and the later
    // [no-reply] round must not file anything further, or the one-setter rule has two writers.
    claimedAsk();
    const turnCtx = turnCtxFor();
    await speak(turnCtx, 'msg-first', FIRST_REPLY);
    readTheBoard();
    state = advance(state, { loopCount: 3 });
    await speak(turnCtx, 'msg-last', '[no-reply]');
    expect(noteTerminalAnswer.mock.calls).toEqual([['msg-first', 'a genuine terminal reply']]);
  });
});

describe('t158 A (ii): the board differs, so ONE correction is the answer and the first reply is demoted', () => {
  it('the correction overwrites the key through the ordinary seam; the ask settles once', async () => {
    const workId = claimedAsk();
    const turnCtx = turnCtxFor();

    await speak(turnCtx, 'msg-first', FIRST_REPLY);
    readTheBoard();
    state = advance(state, { loopCount: 3 });
    const fix = await speak(turnCtx, 'msg-fix', THE_CORRECTION);
    expect(fix.directive).toBe('exit');
    expect(answerKey, 'the ordinary persist seam moved the key to the correction').toBe('msg-fix');

    finalizeTurnRecord();
    const demoted = reclassifyTurnDrafts({ agentId: AGENT, turnNumber: TURN }).reclassified;
    expect(demoted.map((r) => r.id)).toEqual(['msg-first']);
    expect(rowKind('msg-first')).toBe('working-note');
    expect(answerBubbles()).toEqual([THE_CORRECTION]);
    expect(settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN }))
      .toEqual({ closed: 1, held: 0, reopened: 0 });
    expect(askRow(workId).state).toBe('done');
    expect(askRow(workId).result_delivery_id).toBe('d-msg-fix');
    expect(markersFor(workId)).not.toContain('ct0_ask_re_served');
  });
});

describe('t158 A (iii): the steer no longer orders a restatement', () => {
  it('no "say that same answer again"; it says the user has the reply, [no-reply] if it all matches, only the correction otherwise', async () => {
    claimedAsk();
    await speak(turnCtxFor(), 'msg-first', FIRST_REPLY);
    const text = steersOf('promise-floor')[0]!.content;
    expect(text).not.toMatch(/say that same answer again/i);
    expect(text).not.toMatch(/same answer again/i);
    expect(text).toContain('already has your reply');
    expect(text).toContain('[no-reply]');
    expect(text).toMatch(/only that correction/i);
    // The parts the owner's rulings and T36's own suite keep:
    expect(text.startsWith('[System]')).toBe(true);
    expect(text).toContain('work_update(action="list")');
    expect(text).toMatch(/what the board actually holds/i);
    expect(text).toMatch(/abandoned, closed, or was never created/i);
    expect(text).toMatch(/do not pick up new work you were not asked for/i);
    // …and it quotes the claim it is about, as before.
    expect(text).toContain("stays parked until you ask");
  });
});

describe('t158 A (iv): the sibling classes are byte-unchanged, and neither files the answer key itself', () => {
  it('the forward-promise steer is exactly the sentence it has always been', async () => {
    claimedAsk();
    const promise = 'On it. Let me pull up all your calendars.';
    await speak(turnCtxFor(), 'msg-promise', promise);
    expect(steersOf('promise-floor')[0]!.content).toBe(
      `[System] Your reply to the user was a promise to start ('${promise}') but the turn `
      + 'was about to end with no work done. Do the work NOW with tool calls and deliver the '
      + 'result. Do not narrate what you are about to do again.',
    );
  });

  it('the standing-promise steer is exactly the sentence it has always been', async () => {
    claimedAsk();
    const promise = "Yes, I can. From now on, when a reminder fires I'll post it here first — and if you haven't "
      + "replied within a few minutes, I'll text it to your phone as a backup.";
    await speak(turnCtxFor(), 'msg-standing', promise);
    const quoted = promise.replace(/\s+/g, ' ').trim().slice(0, 200);
    expect(steersOf('promise-floor')[0]!.content).toBe(
      `[System] Your reply made a STANDING promise to the user ('${quoted}') — a commitment `
      + 'about every future occasion — but nothing durable was written this turn, so nothing '
      + 'will carry it out. A promise that lives only in this conversation does not survive a '
      + 'session reset. Either record what you can actually deliver where it will be kept '
      + '(vault_remember with verbatim:true and pin:true for a standing instruction; work_open '
      + 'for a tracked task or a scheduled reminder), or tell the user honestly what you can '
      + 'and cannot do. Do not repeat the promise without recording it.',
    );
  });
});

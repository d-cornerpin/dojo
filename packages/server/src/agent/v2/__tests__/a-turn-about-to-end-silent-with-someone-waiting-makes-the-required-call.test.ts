// A turn about to end with nothing said to the person whose request it claimed arms the required reply once, with
// the steer; nobody waiting, "ok thanks", a reply on its way, a live call or a cut turn arm nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
const asksNothing = vi.hoisted(() => ({ on: false }));
vi.mock('../classifiers/inbound-routing.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  inboundAsksNothing: async () => asksNothing.on,
}));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { askIdForMessage, claimAsk, stampClaimingTurn, transition } from '../../../work/store.js';
import { openTrackerTask } from '../../../work/tracker-store.js';
import { openTurnContext, endTurnContext, type TurnContext } from '../../turn-context.js';
import { advance, initState, type AgentTurnState } from '../state.js';
import { forcedReplyDue } from '../forced-reply.js';
import { freshReplyDb, testDb, AGENT } from './helpers/reply-sender.js';

const TURN = 4;
let turnCtx: TurnContext;

function turnState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  return advance(initState({ agentId: AGENT, turnNumber: TURN } as Parameters<typeof initState>[0]), { phase: 'postCallClassify', ...over });
}
const due = (latestUserSource: string | null = null): Promise<boolean> =>
  forcedReplyDue(turnCtx, { agentId: AGENT, turnNumber: TURN, latestUserSource, counterpartyIsAgentSender: false });

beforeEach(() => {
  asksNothing.on = false;
  freshReplyDb(runMigrations);
  testDb().prepare("INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id) VALUES ('conv-owner', ?, 'dashboard', 'dashboard', 'owner')").run(AGENT);
  insertMessage({ id: 'm-1', agentId: AGENT, role: 'user', content: 'Which of the three quotes should I take?',
    conversationId: 'conv-owner', channel: 'dashboard', senderId: 'owner', lane: 'owner' } as never);
  claimAsk(askIdForMessage('m-1'), AGENT);
  stampClaimingTurn(askIdForMessage('m-1'), TURN);
  endTurnContext(AGENT);
  turnCtx = openTurnContext(AGENT);
  turnCtx.address = { kind: 'person', name: 'Sam' } as TurnContext['address'];
  turnCtx.spinBrakeGraceCalls = -1;
  turnCtx.state = turnState();
});

describe('the required reply is armed when the turn would end silent with someone waiting', () => {
  it('arms once: spent, pending, the steer queued in the platform voice, the loop sent back past its gates', async () => {
    expect(await due()).toBe(true);
    expect(turnCtx.forcedReplySpent).toBe(true);
    expect(turnCtx.forceReplyPending).toBe(true);
    expect(turnCtx.spinBrakeGraceCalls).toBe(0);
    expect(turnCtx.state!.phase).toBe('preCallGates');
    expect(turnCtx.state!.steerQueue.pending.map((e) => [e.floor, e.content])).toEqual([
      ['forced-reply', '[Engine: Sam is waiting for your answer to their message. Write it now.]'],
    ]);
    // A pass that leaves before its call never arms a second one.
    turnCtx.forceReplyPending = false;
    expect(await due()).toBe(false);
  });

  it('nobody waiting: no request this turn claimed, nothing armed', async () => {
    testDb().prepare("UPDATE work SET state = 'open', claimed_by_turn = NULL WHERE kind = 'ask'").run();
    expect(await due()).toBe(false);
    expect(turnCtx.forcedReplySpent).toBe(false);
  });

  it('a message that asked for nothing ("ok thanks") is not forced to a reply', async () => {
    asksNothing.on = true;
    expect(await due()).toBe(false);
  });

  it('a reply already on its way arms nothing', async () => {
    testDb().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, payload_json, created_at, updated_at)
      VALUES ('d-1', ?, ?, 'imessage_send', 'dashboard', 'conv-owner', 'pending', '{}', datetime('now'), datetime('now'))`).run(AGENT, TURN);
    expect(await due()).toBe(false);
  });

  it('words already said, a voice or phone turn, or a cut turn arm nothing', async () => {
    turnCtx.state = turnState({ lastAssistantTextForIM: 'The second one.' });
    expect(await due()).toBe(false);
    turnCtx.state = turnState();
    expect(await due('voice')).toBe(false);
    turnCtx.state = turnState({ inboundChannel: 'phone' } as Partial<AgentTurnState>);
    expect(await due()).toBe(false);
    turnCtx.state = turnState({ engineCutExit: 'stop' });
    expect(await due()).toBe(false);
    expect(turnCtx.forcedReplySpent).toBe(false);
  });

  it('a turn that hands in the task behind the request and says nothing is made to answer', async () => {
    const task = openTrackerTask({ title: 'Compare the quotes', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'user', sourceMessageId: 'm-1', turn: TURN, convKey: 'dashboard:owner' } });
    expect(await due()).toBe(false);
    expect(transition(task, { to: 'handed_in', by: 'agent', actorId: AGENT, reason: 'handed in: compared all three' }).kind)
      .toBe('applied');
    expect(await due()).toBe(true);
  });

  it('a turn that only sent to another agent, with no join open, is made to answer', async () => {
    testDb().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at, updated_at)
      VALUES ('d-a2a', ?, ?, 'send_to_agent', 'a2a', 'delivered', datetime('now'), datetime('now'))`).run(AGENT, TURN);
    testDb().prepare("UPDATE work SET remaining_children = 1 WHERE kind = 'ask'").run();
    expect(await due()).toBe(false);
    testDb().prepare("UPDATE work SET remaining_children = 0 WHERE kind = 'ask'").run();
    expect(await due()).toBe(true);
  });

  it('a reminder run that said nothing is made to say it', async () => {
    testDb().prepare("UPDATE work SET state = 'open', claimed_by_turn = NULL WHERE kind = 'ask'").run();
    turnCtx.root = { kind: 'occurrence', id: 'occ-1', sourceMessageId: null };
    turnCtx.servedWork = { taskId: 't-1', runId: 'r-1', taskKind: 'reminder', originConvKey: null };
    expect(await due()).toBe(true);
    expect(turnCtx.state!.steerQueue.pending.map((e) => e.content)).toEqual([
      '[Engine: this run is due to deliver its reminder and has said nothing yet. Write it now.]',
    ]);
  });
});

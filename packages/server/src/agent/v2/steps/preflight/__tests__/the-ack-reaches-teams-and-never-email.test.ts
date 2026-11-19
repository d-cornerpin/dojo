// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 12 T51 — THE ACK FAST DOOR WIDENS TO TEAMS, AND STOPS AT EMAIL.
//
// ── THE RULING (owner, 2026-08-16, ruling 3 of twelve) ──
// **TEAMS YES, EMAIL NO.** W20 built the fast door on a DERIVED set and said so in its own
// report §6.1: the predicate is `isRoutedHumanCounterparty ∩ (the ack's own push arms)`, and
// "widening it to email/Teams is one predicate and one test row." The owner widened it to
// Teams only. Email is not deferred, not pending, not a smaller version of the same job —
// it is REFUSED, and this file is the refusal's durable form.
//
// ── WHY A PREDICATE ALONE WOULD HAVE BEEN A LIE ──
// The derivation is what makes the set honest, and the derivation has two halves. Opening the
// door for Teams while `deliverEngineUserAck` had no Teams arm would arm a steer whose
// delivery persists and broadcasts and REACHES NOBODY — a bubble on the dashboard the channel
// never received, which is the F-22 shape RC-9's internal note exists to prevent, arrived at
// from the other side. So T51 is TWO changes, and this file pins them as one fact:
//   * `preflight/turn-closures.ts`: `deliverEngineUserAck` queues the line for the one reply
//     sender, which posts a Teams reply as `teams_send_message` through `executeTool`, with the
//     routing marker the owner sees;
//   * `v2/counterparty.ts` — `engineAckReachesTheirChannel` gains `teams`, because the
//     intersection moved.
//
// ── WHAT IS PINNED AGAINST EMAIL, IN BOTH DIRECTIONS ──
// The predicate refuses it, AND the delivery site has no arm for it. Either one alone would
// let the ruling drift back in through the other: a push arm added later would silently make
// the derivation argue for email, and a predicate widened later would arm a door with nothing
// behind it. Both clauses are here, in one file, so the ruling is one edit to defeat and the
// edit is loud.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const tool = vi.hoisted(() => ({ calls: [] as Array<{ name: string; arguments: Record<string, unknown> }>, grant: true }));
vi.mock('../../../../../db/connection.js', async () => (await import('../../../__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../../../access/engine-route.js', () => ({ engineMayRouteTo: () => tool.grant, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../../tools/index.js', () => ({
  executeTool: async (_agentId: string, call: { name: string; arguments: Record<string, unknown> }) => {
    tool.calls.push(call);
    return { kind: 'applied', value: { toolCallId: 'x', name: call.name, content: 'sent' } };
  },
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { START_ACK_ORIGIN_INTENT } from '../../../../../memory/message-store.js';
import { runTurnClosures } from '../turn-closures.js';
import { deliverDueReplies } from '../../../channel-sender.js';
import { engineAckReachesTheirChannel, isRoutedHumanCounterparty, type TurnCounterparty } from '../../../counterparty.js';
import { freshReplyDb, replyRows, testDb, AGENT } from '../../../__tests__/helpers/reply-sender.js';
import { FX } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

const CHAT_ID = '19:meeting_abcdef0123456789@thread.v2';

const person = (over: Partial<TurnCounterparty> = {}): TurnCounterparty => ({
  kind: 'user', name: FX.n11, relation: 'owner', channel: 'imessage',
  senderId: '+15550000000', threadId: null, senderIsAgent: false, ...over,
} as TurnCounterparty);

/** The start line as the turn delivers it, then one pass of the reply sender. */
async function startLine(counterparty: TurnCounterparty, inboundContext: Record<string, unknown> | null): Promise<void> {
  const turnCtx = { root: { kind: 'ask', id: 'ask-1', sourceMessageId: 'm-1', conversationId: 'conv-1' }, state: { inboundContext } };
  const { deliverEngineUserAck } = runTurnClosures(turnCtx as never, { agentId: AGENT } as never, { terminalAnswerRowId: null } as never, {
    counterparty, chosenConvKey: 'teams:chat', chosenConversationId: 'conv-1', turnNumber: 9, revertTriggerStampOnAbort: () => {},
  });
  await deliverEngineUserAck('On it.', START_ACK_ORIGIN_INTENT, null, 'agent-text');
  await deliverDueReplies(Date.now());
}

const markers = (): string[] => (testDb().prepare("SELECT content FROM messages WHERE role = 'system' ORDER BY rowid").all() as Array<{ content: string }>).map((r) => r.content);
const ackRow = () => testDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND content = 'On it.'").get();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  testDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('teams_approved_senders', JSON.stringify([{ address: 'colleague@example.com', name: 'a colleague' }]));
  tool.calls = [];
  tool.grant = true;
});

describe('the predicate: the door opens where the ack can now actually be pushed', () => {
  it('RED→GREEN: a Teams-origin ask is inside the fast door (owner ruling 3 — TEAMS YES)', () => {
    expect(engineAckReachesTheirChannel(person({ channel: 'teams' }))).toBe(true);
  });

  it('THE OWNER SAID NO ON EMAIL: an email-origin ask is outside it, and this row is the pin', () => {
    expect(engineAckReachesTheirChannel(person({ channel: 'email' }))).toBe(false);
  });

  it('the two channels W20 shipped are untouched, and the dashboard/voice pair still buys nothing', () => {
    expect(engineAckReachesTheirChannel(person({ channel: 'imessage' }))).toBe(true);
    expect(engineAckReachesTheirChannel(person({ channel: 'sms' }))).toBe(true);
    expect(engineAckReachesTheirChannel(person({ channel: 'dashboard', senderId: null }))).toBe(false);
    expect(engineAckReachesTheirChannel(person({ channel: 'voice', senderId: null }))).toBe(false);
    // `phone` stays out on its own recorded ground: a live voice session with its own
    // delivery lane and its own ambient signal, not a text ask (W20 §6.2).
    expect(engineAckReachesTheirChannel(person({ channel: 'phone' }))).toBe(false);
  });

  it('the set is still a SUBSET of the RC-9 routed-human rule, never a second copy of it', () => {
    for (const channel of ['imessage', 'sms', 'teams', 'email'] as const) {
      const c = person({ channel });
      expect(isRoutedHumanCounterparty(c), channel).toBe(true);
      if (engineAckReachesTheirChannel(c)) expect(isRoutedHumanCounterparty(c), channel).toBe(true);
    }
    // and it still refuses everyone the wider rule refuses
    expect(engineAckReachesTheirChannel(person({ channel: 'teams', relation: 'unknown' }))).toBe(false);
    expect(engineAckReachesTheirChannel({ kind: 'agent', name: FX.n6 } as TurnCounterparty)).toBe(false);
  });
});

describe('the delivery: the ack REACHES a Teams chat, through the one reply sender', () => {
  it('the ack is posted into the originating chat as a `teams_send_message`, once, as a start line', async () => {
    await startLine(person({ channel: 'teams', senderId: 'colleague@example.com' }), { chatId: CHAT_ID, chatType: 'dm' });
    expect(tool.calls).toEqual([{ id: expect.any(String), name: 'teams_send_message', arguments: { chat_id: CHAT_ID, message: 'On it.' } }]);
    expect(replyRows()).toMatchObject([{ outcome: 'delivered', attempts: 1 }]);
    expect(testDb().prepare('SELECT tool, channel FROM deliveries').all()).toEqual([{ tool: 'engine-ack', channel: 'teams' }]);
  });

  it('the owner sees the same badge a routed reply gets — one marker writer, never a second wording', async () => {
    await startLine(person({ channel: 'teams', senderId: 'colleague@example.com' }), { chatId: CHAT_ID, chatType: 'dm' });
    expect(markers().at(-1)).toBe(`[Reply routed via Teams to chat ${CHAT_ID.slice(0, 8)}…]`);
  });

  it('CONTROL: a withheld channel grant queues nothing', async () => {
    tool.grant = false;
    await startLine(person({ channel: 'teams', senderId: 'colleague@example.com' }), { chatId: CHAT_ID, chatType: 'dm' });
    expect(tool.calls).toEqual([]);
    expect(replyRows()).toEqual([]);
  });

  it('CONTROL: no chat id, no push: an ack with nowhere to go is never queued', async () => {
    await startLine(person({ channel: 'teams', senderId: 'colleague@example.com' }), {});
    expect(tool.calls).toEqual([]);
    expect(replyRows()).toEqual([]);
  });

  it('CONTROL: EMAIL IS NOT PUSHED. The ack row is written and that is all', async () => {
    await startLine(person({ channel: 'email', senderId: 'colleague@example.com' }), { emailMessageId: '<abc@mail>' });
    expect(tool.calls).toEqual([]);
    expect(replyRows()).toEqual([]);
    expect(ackRow()).toEqual({ n: 1 });
  });

  it('CONTROL: the dashboard path is untouched: the row, no channel push at all', async () => {
    await startLine(person({ channel: 'dashboard', senderId: null }), null);
    expect(replyRows()).toEqual([]);
    expect(ackRow()).toEqual({ n: 1 });
  });
});

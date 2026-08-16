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
//   * `preflight/turn-closures.ts` — `deliverEngineUserAck` gains a Teams push arm, built out
//     of the SAME send the end-of-turn router already uses for a Teams reply
//     (`finalize/channel-push.ts`: a synthetic `teams_send_message` ToolCall through
//     `executeTool`, inside an outbound scope, with the routing marker the owner sees);
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCall } from '@dojo/shared';

const { broadcastSpy, insertSpy, executeToolSpy, outboundIntents } = vi.hoisted(() => ({
  broadcastSpy: vi.fn(),
  insertSpy: vi.fn(),
  executeToolSpy: vi.fn(async () => ({ kind: 'applied', result: { content: 'sent' } })),
  outboundIntents: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: broadcastSpy }));
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: insertSpy,
}));
vi.mock('../../../../tools/index.js', () => ({
  executeTool: (...a: unknown[]) => executeToolSpy(...(a as [])),
}));
// The outbound scope is the LEDGER's business and has its own suite; here it is a
// pass-through that records the identity each arm declares, which is the half this file
// is about — a Teams ack must cross the door as `engine-ack`/`teams`, to the chat it came
// from, exactly as the iMessage and SMS arms do for theirs.
vi.mock('../../../outbound.js', () => ({
  withOutboundAsync: async (intent: Record<string, unknown>, fn: () => Promise<unknown>) => {
    outboundIntents.push(intent);
    return fn();
  },
}));
vi.mock('../../../../../contacts/resolve-recipient.js', () => ({
  resolveRecipientDisplay: (_c: string, id: string) => id,
}));
vi.mock('../../../../turn-state.js', () => ({ continuationContext: { set: vi.fn() } }));

import { runTurnClosures } from '../turn-closures.js';
import { engineAckReachesTheirChannel, isRoutedHumanCounterparty, type TurnCounterparty } from '../../../counterparty.js';
import type { PreflightContext, PreflightScratch } from '../index.js';
import type { TurnContext } from '../../../../turn-context.js';

const AGENT = 'kevin';
const CHAT_ID = '19:meeting_abcdef0123456789@thread.v2';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (rel: string): string => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

const person = (over: Partial<TurnCounterparty> = {}): TurnCounterparty => ({
  kind: 'user', name: 'David', relation: 'owner', channel: 'imessage',
  senderId: '+15550000000', threadId: null, senderIsAgent: false, ...over,
} as TurnCounterparty);

/** The ack closure as the turn hands it out, with only what its body reads. */
function ackFor(counterparty: TurnCounterparty, inboundContext: Record<string, unknown> | null) {
  const turnCtx = {
    root: { conversationId: 'conv-1' },
    state: { inboundContext },
  } as unknown as TurnContext;
  const sc: PreflightScratch = {
    claimedEngineEvent: null, pendingEngineClaim: null, terminalAnswerRowId: null,
  };
  return runTurnClosures(
    turnCtx,
    { agentId: AGENT } as unknown as PreflightContext,
    sc,
    {
      counterparty, chosenConvKey: 'teams:chat', chosenConversationId: 'conv-1',
      turnNumber: 9, revertTriggerStampOnAbort: vi.fn(),
    },
  ).deliverEngineUserAck;
}

const routingMarkers = (): string[] => insertSpy.mock.calls
  .map((c) => c[0] as { role?: string; content?: string })
  .filter((m) => m.role === 'system')
  .map((m) => m.content ?? '');

beforeEach(() => {
  broadcastSpy.mockClear(); insertSpy.mockClear(); executeToolSpy.mockClear();
  outboundIntents.length = 0;
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
    expect(engineAckReachesTheirChannel({ kind: 'agent', name: 'Ticky' } as TurnCounterparty)).toBe(false);
  });
});

describe('the delivery: the ack REACHES a Teams chat, through the send the router already uses', () => {
  it('RED→GREEN: the ack is pushed to the originating chat as a `teams_send_message`', async () => {
    const deliver = ackFor(person({ channel: 'teams', senderId: 'david@cornerp.in' }), { chatId: CHAT_ID });
    await deliver('On it — pulling the numbers now.', 'start_ack', null, 'agent-text');

    expect(executeToolSpy).toHaveBeenCalledTimes(1);
    const [calledAgent, tc] = executeToolSpy.mock.calls[0] as unknown as [string, ToolCall];
    expect(calledAgent).toBe(AGENT);
    expect(tc.name).toBe('teams_send_message');
    expect(tc.arguments).toEqual({ chat_id: CHAT_ID, message: 'On it — pulling the numbers now.' });
  });

  it('it crosses the door under the ack\'s own identity, to the chat it came from', async () => {
    const deliver = ackFor(person({ channel: 'teams' }), { chatId: CHAT_ID });
    await deliver('On it.', 'start_ack', null, 'agent-text');
    expect(outboundIntents).toHaveLength(1);
    expect(outboundIntents[0]).toMatchObject({
      agentId: AGENT, tool: 'engine-ack', channel: 'teams',
      recipientId: CHAT_ID, conversationId: 'conv-1',
    });
  });

  it('the owner sees the same badge a routed reply gets — one marker writer, never a second wording', async () => {
    const deliver = ackFor(person({ channel: 'teams' }), { chatId: CHAT_ID });
    await deliver('On it.', 'start_ack', null, 'agent-text');
    expect(routingMarkers().some((m) => m.includes('Teams to chat'))).toBe(true);
  });

  it('CONTROL — no chat id, no push: an ack with nowhere to go is never claimed as delivered', async () => {
    const deliver = ackFor(person({ channel: 'teams' }), {});
    await deliver('On it.', 'start_ack', null, 'agent-text');
    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(outboundIntents).toHaveLength(0);
    expect(routingMarkers()).toEqual([]);
  });

  it('CONTROL — EMAIL IS NOT PUSHED. The ack row is written and broadcast and that is all', async () => {
    const deliver = ackFor(person({ channel: 'email', senderId: 'david@cornerp.in' }),
      { emailMessageId: '<abc@mail>' });
    await deliver('On it.', 'start_ack', null, 'agent-text');
    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(outboundIntents).toHaveLength(0);
    expect(routingMarkers()).toEqual([]);
    // the row itself is byte-identical to every other channel's — the ack is not deleted,
    // it simply has no email transport, which is precisely why the door stays shut for it.
    expect(insertSpy.mock.calls.some((c) => (c[0] as { role?: string }).role === 'assistant')).toBe(true);
  });

  it('CONTROL — the dashboard path is untouched: persist + broadcast, no channel push at all', async () => {
    const deliver = ackFor(person({ channel: 'dashboard', senderId: null }), null);
    await deliver('On it.', 'start_ack', null, 'agent-text');
    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(outboundIntents).toHaveLength(0);
    expect(broadcastSpy).toHaveBeenCalled();
  });
});

describe('the derivation stays true, and email cannot drift back in through the delivery site', () => {
  it('the ack has arms for exactly the channels the predicate names — and none for email', () => {
    const closures = SRC('../turn-closures.ts');
    const ackFn = closures.slice(closures.indexOf('const deliverEngineUserAck'));
    for (const has of ["channel === 'imessage'", "channel === 'sms'", "channel === 'teams'"]) {
      expect(ackFn, has).toContain(has);
    }
    // THE RULING, AS A SOURCE FACT. `phone` has an arm and is deliberately outside the
    // predicate (W20 §6.2, its own ground); email has NEITHER, and must keep having neither.
    expect(ackFn).not.toContain("channel === 'email'");
  });

  it('the predicate is still ONE declaration, and the fast door still asks it rather than re-spelling it', () => {
    const cp = SRC('../../../counterparty.ts');
    expect(cp).toContain('export function engineAckReachesTheirChannel');
    const door = SRC('../../assemble/multistep-detection.ts');
    expect(door).toContain('engineAckReachesTheirChannel');
    expect(door).not.toContain("'teams'");
    expect(door).not.toContain("'email'");
  });
});

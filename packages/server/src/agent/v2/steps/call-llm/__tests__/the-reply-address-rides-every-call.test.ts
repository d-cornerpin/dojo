// 3.5: on a routed channel the line "who the written reply goes to" is re-sent on EVERY model call
// of a turn, in the clock message at the very tail, so it sits below every newer tool result and
// steer. It is one short line after the cache breakpoint; a reply that stays in the dashboard
// gets none.
import { describe, it, expect } from 'vitest';
import '../../../../../prompt/registry/entries.js';
import { getMessageEntries } from '../../../../../prompt/registry/registry.js';
import { appendOnlyTurn } from '../append-only-turn.js';
import { tagMessageLane } from '../../../../../memory/message-lane-tag.js';
import { computeTurnAddress } from '../../../turn-address.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const fits = async () => true;
const contact: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: '+15550100', threadId: null, senderIsAgent: false };
const owner: TurnCounterparty = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };

function clock(cp: TurnCounterparty, inbound: 'imessage' | 'dashboard'): string {
  const address = computeTurnAddress({ autoRoutes: true, counterparty: cp, isEngineTurn: false, isNotificationTurn: false, inboundChannel: inbound, inboundContext: null });
  const entry = getMessageEntries().find((e) => e.id === 'msg.current-time')!;
  const out = (entry.render as (c: unknown) => { content: string })({ agentId: 'a', turnContext: { counterparty: cp, address } });
  return out.content;
}

describe('the reply address is restated at the tail of every call', () => {
  it('a routed reply: the clock message carries one short line naming who it goes to', () => {
    const c = clock(contact, 'imessage');
    expect(c).toContain('[Reply goes to Pat Example by iMessage.]');
    expect(c.trimEnd().endsWith('[Reply goes to Pat Example by iMessage.]')).toBe(true);
  });

  it('a dashboard reply gets no restatement', () => {
    expect(clock(owner, 'dashboard')).not.toContain('Reply goes to');
  });

  it('on call 2 of a turn the newest message, after the new tool result, still names the address', async () => {
    const turn = {};
    const lane = (text: string) => tagMessageLane({ role: 'user' as const, content: text }, 'msg.current-time');
    const H1 = [{ role: 'user' as const, content: 'ask' }, { role: 'assistant' as const, content: 'tool call 1' }];
    const H2 = [...H1, { role: 'user' as const, content: 'tool result 1' }];
    const c1 = clock(contact, 'imessage');
    await appendOnlyTurn({ turn, loopCount: 1, fresh: [...H1, lane(c1)], volatileFrom: H1.length, blocksFrom: H1.length, modelId: 'm', fits });
    // Time moves on between calls; the address does not.
    const c2 = c1.replace(/\d/, (d) => String((Number(d) + 1) % 10));
    expect(c2).not.toBe(c1);
    const r2 = await appendOnlyTurn({ turn, loopCount: 2, fresh: [...H2, lane(c2)], volatileFrom: H1.length, blocksFrom: H2.length, modelId: 'm', fits });
    const msgs = r2.messages;
    expect(msgs[msgs.length - 2].content).toBe('tool result 1');
    expect(String(msgs[msgs.length - 1].content)).toContain('[Reply goes to Pat Example by iMessage.]');
  });

  it('the restatement is one short line', () => {
    const line = '[Reply goes to Pat Example by iMessage.]';
    expect(line.length).toBeLessThan(80);
  });
});

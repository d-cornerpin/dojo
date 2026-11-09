// t182 (Run 10/15/16 S2): on "You there?" the agent recapped open work and results already given, and the owner
// heard them again. The turn context now SAYS what the message is: a presence check, nothing else asked.
// Also: the uncommitted-promise floor's open-work match compares by stem ("receipt" names "receipts").
import { describe, it, expect } from 'vitest';
import '../registry/entries.js';
import { getMessageEntries } from '../registry/registry.js';
import { isPresenceCheck, PRESENCE_HINT } from '../presence-check.js';
import { namesOpenWork } from '../../agent/v2/open-work-names.js';

describe('t182: a presence check asks nothing else', () => {
  it('recognises the presence checks people send, and nothing longer', () => {
    for (const t of ['You there?', 'you there', 'Are you there?', 'still there?', 'Hello?', 'hi', 'hey!', 'ping', 'You around?']) expect(isPresenceCheck(t), t).toBe(true);
    for (const t of ['You there? Can you send the report?', 'Hello, what is 3 plus 4?', 'Are you there yet with the draft', '', 'there']) expect(isPresenceCheck(t), t).toBe(false);
  });
  it('the turn context carries the hint on a person\'s presence check, and not on an engine turn or another message', () => {
    const entry = getMessageEntries().find((e) => e.id === 'msg.turn-context')!;
    const base = { agentId: 'a', inboundChannel: null, lastUserContent: '', replyDestination: null } as Record<string, unknown>;
    const cp = { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };
    const text = (ctx: Record<string, unknown>): string => JSON.stringify((entry.render as (c: unknown) => unknown)(ctx) ?? '');
    expect(text({ ...base, lastUserMessageContent: 'You there?', turnContext: { counterparty: cp } })).toContain('only checks that you are here');
    expect(text({ ...base, lastUserMessageContent: 'You there?', turnContext: { counterparty: cp, isEngineTurn: true } })).not.toContain('only checks that you are here');
    expect(text({ ...base, lastUserMessageContent: 'Please file the receipts.', turnContext: { counterparty: cp } })).not.toContain('only checks that you are here');
    expect(PRESENCE_HINT).toMatch(/do not recap/);
  });
  it('the open-work match compares by stem: "receipt" names a title\'s "receipts"', () => {
    expect(namesOpenWork("Receipt job's parked on the board and ready whenever they start coming in.",
      ['Receive and log garage renovation receipts (vendor, date, amount; flag >$500; running total per vendor)'])).toBe(true);
    expect(namesOpenWork('The dentist reminder is on my list.', ['Receive and log garage renovation receipts'])).toBe(false);
  });
});

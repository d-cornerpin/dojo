import { describe, expect, it } from 'vitest';
import { resolveReplyDestination } from '../reply-destination.js';

const dest = (inboundChannel: Parameters<typeof resolveReplyDestination>[0]['state']['inboundChannel'], more: Partial<Parameters<typeof resolveReplyDestination>[0]> = {}) =>
  resolveReplyDestination({ state: { inboundChannel }, imessageBridgeConfigured: true, ...more });

describe('resolveReplyDestination', () => {
  it('a routed inbound is answered on its own channel', () => {
    expect(dest('imessage')).toBe('imessage');
    expect(dest('teams')).toBe('teams');
    expect(dest('email', { imessageBridgeConfigured: false })).toBe('email');
  });

  // OWNER RULING (2026-11-04): "obviously if a user types a message on the dashboard, they get a response on the dashboard."
  it('a person\'s dashboard ask stays on the dashboard, even with affinity', () => {
    expect(dest('dashboard', { personAskedHere: true, counterpartyIsOwner: true, ownerAffinityChannel: 'imessage' })).toBe('dashboard');
  });

  it('a reply no person asked for stays on the dashboard: "away" alone moves nothing', () => {
    expect(dest('dashboard')).toBe('dashboard');
    expect(dest(null)).toBe('dashboard');
  });

  describe('RC-10 owner-channel affinity', () => {
    it('owner dashboard-default turn with iMessage affinity → iMessage', () => {
      expect(dest('dashboard', { counterpartyIsOwner: true, ownerAffinityChannel: 'imessage' })).toBe('imessage');
    });

    it('a non-owner, no affinity, or no bridge stays on the dashboard', () => {
      expect(dest('dashboard', { counterpartyIsOwner: false, ownerAffinityChannel: 'imessage' })).toBe('dashboard');
      expect(dest('dashboard', { counterpartyIsOwner: true, ownerAffinityChannel: null })).toBe('dashboard');
      expect(dest('dashboard', { counterpartyIsOwner: true, ownerAffinityChannel: 'imessage', imessageBridgeConfigured: false })).toBe('dashboard');
    });

    it('a bound routed channel (email) is unaffected by owner affinity', () => {
      expect(dest('email', { counterpartyIsOwner: true, ownerAffinityChannel: 'imessage' })).toBe('email');
    });
  });
});

import { describe, expect, it } from 'vitest';
import { resolveReplyDestination } from '../reply-destination.js';

describe('resolveReplyDestination', () => {
  it('routes iMessage inbound back to iMessage regardless of presence', () => {
    expect(
      resolveReplyDestination({
        state: { inboundChannel: 'imessage' },
        presence: 'in_dojo',
        imessageBridgeConfigured: true,
      }),
    ).toBe('imessage');
    expect(
      resolveReplyDestination({
        state: { inboundChannel: 'imessage' },
        presence: 'away',
        imessageBridgeConfigured: true,
      }),
    ).toBe('imessage');
  });

  it('routes Teams inbound back to Teams (away override does not apply)', () => {
    expect(
      resolveReplyDestination({
        state: { inboundChannel: 'teams' },
        presence: 'away',
        imessageBridgeConfigured: true,
      }),
    ).toBe('teams');
  });

  it('dashboard inbound while in_dojo stays on dashboard', () => {
    expect(
      resolveReplyDestination({
        state: { inboundChannel: 'dashboard' },
        presence: 'in_dojo',
        imessageBridgeConfigured: true,
      }),
    ).toBe('dashboard');
  });

  it('dashboard inbound while away + bridge configured routes to iMessage', () => {
    expect(
      resolveReplyDestination({
        state: { inboundChannel: 'dashboard' },
        presence: 'away',
        imessageBridgeConfigured: true,
      }),
    ).toBe('imessage');
  });

  it('dashboard inbound while away + bridge NOT configured falls back to dashboard', () => {
    expect(
      resolveReplyDestination({
        state: { inboundChannel: 'dashboard' },
        presence: 'away',
        imessageBridgeConfigured: false,
      }),
    ).toBe('dashboard');
  });

  it('proactive turn (no inbound) while in_dojo → dashboard', () => {
    expect(
      resolveReplyDestination({
        state: { inboundChannel: null },
        presence: 'in_dojo',
        imessageBridgeConfigured: true,
      }),
    ).toBe('dashboard');
  });

  it('proactive turn (no inbound) while away → iMessage', () => {
    expect(
      resolveReplyDestination({
        state: { inboundChannel: null },
        presence: 'away',
        imessageBridgeConfigured: true,
      }),
    ).toBe('imessage');
  });
});

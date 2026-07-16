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

  it('routes email inbound back to email regardless of presence', () => {
    expect(
      resolveReplyDestination({
        state: { inboundChannel: 'email' },
        presence: 'in_dojo',
        imessageBridgeConfigured: false,
      }),
    ).toBe('email');
    expect(
      resolveReplyDestination({
        state: { inboundChannel: 'email' },
        presence: 'away',
        imessageBridgeConfigured: true,
      }),
    ).toBe('email');
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

  // ── RC-10: owner-channel affinity ──
  describe('RC-10 owner-channel affinity', () => {
    it('owner dashboard-default turn (in_dojo) with iMessage affinity → iMessage', () => {
      expect(
        resolveReplyDestination({
          state: { inboundChannel: 'dashboard' },
          presence: 'in_dojo',
          imessageBridgeConfigured: true,
          counterpartyIsOwner: true,
          ownerAffinityChannel: 'imessage',
        }),
      ).toBe('imessage');
    });

    it('NON-owner counterparty never gets affinity promotion (stays dashboard)', () => {
      expect(
        resolveReplyDestination({
          state: { inboundChannel: 'dashboard' },
          presence: 'in_dojo',
          imessageBridgeConfigured: true,
          counterpartyIsOwner: false,
          ownerAffinityChannel: 'imessage',
        }),
      ).toBe('dashboard');
    });

    it('owner with NO affinity (rate-limited / no recent iMessage) stays dashboard', () => {
      expect(
        resolveReplyDestination({
          state: { inboundChannel: 'dashboard' },
          presence: 'in_dojo',
          imessageBridgeConfigured: true,
          counterpartyIsOwner: true,
          ownerAffinityChannel: null,
        }),
      ).toBe('dashboard');
    });

    it('affinity requires the bridge configured', () => {
      expect(
        resolveReplyDestination({
          state: { inboundChannel: 'dashboard' },
          presence: 'in_dojo',
          imessageBridgeConfigured: false,
          counterpartyIsOwner: true,
          ownerAffinityChannel: 'imessage',
        }),
      ).toBe('dashboard');
    });

    it('a bound routed channel (email) is unaffected by owner affinity', () => {
      expect(
        resolveReplyDestination({
          state: { inboundChannel: 'email' },
          presence: 'in_dojo',
          imessageBridgeConfigured: true,
          counterpartyIsOwner: true,
          ownerAffinityChannel: 'imessage',
        }),
      ).toBe('email');
    });

    it('away override remains stronger (away + affinity both resolve to iMessage)', () => {
      expect(
        resolveReplyDestination({
          state: { inboundChannel: 'dashboard' },
          presence: 'away',
          imessageBridgeConfigured: true,
          counterpartyIsOwner: true,
          ownerAffinityChannel: null,
        }),
      ).toBe('imessage');
    });
  });
});

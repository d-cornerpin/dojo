// 3.5: the agent reads ONE block that says who sent the message and who the written reply goes
// to. It comes from the turn's address (computed once in preflight), never from the newest row of
// whichever conversation wrote last.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isPrimaryAgent: vi.fn(() => true),
  isPMAgent: vi.fn(() => false),
  getOwnerName: vi.fn(() => 'Owner Example'),
}));
vi.mock('../../../services/capabilities.js', () => ({ getModelCapabilities: vi.fn(() => []) }));
vi.mock('../../../router/router-window.js', () => ({ agentTurnWindow: vi.fn(() => 200000) }));
// The newest user row of ANY conversation is the owner's dashboard line (the A1 trap).
vi.mock('../../assembler.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveInboundContext: vi.fn(() => ({ inboundChannel: 'dashboard', smsFromNumber: null, phoneFromNumber: null, replyDestination: 'dashboard', lastContent: 'newest owner line' })),
  resolveTtsEngine: vi.fn(() => 'local'),
}));

import { buildAssemblyContext } from '../assembler.js';
import { getMessageEntries } from '../registry.js';
import '../entries.js';
import { computeTurnAddress } from '../../../agent/v2/turn-address.js';
import type { TurnCounterparty } from '../../../agent/v2/counterparty.js';

const contact: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: '+15550100', threadId: null, senderIsAgent: false };
const owner: TurnCounterparty = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };
const peer: TurnCounterparty = { kind: 'agent', name: 'peer-agent', relation: 'agent', channel: 'a2a', senderId: null, threadId: 't1', senderIsAgent: false };

function block(counterparty: TurnCounterparty, over: { isEngineTurn?: boolean; inbound?: 'imessage' | 'dashboard' | null; presence?: 'in_dojo' | 'away'; voice?: boolean } = {}): string {
  const address = computeTurnAddress({ autoRoutes: true,
    counterparty, isEngineTurn: over.isEngineTurn ?? false, isNotificationTurn: false,
    inboundChannel: over.inbound === undefined ? 'imessage' : over.inbound, inboundContext: null,
    presence: over.presence ?? 'in_dojo', imessageBridgeConfigured: true, ownerAffinityChannel: null,
  });
  const ctx = buildAssemblyContext('primary', 'm', {
    counterparty, address, isEngineTurn: over.isEngineTurn ?? false, isNotificationTurn: false,
    isA2ATurn: counterparty.kind === 'agent', latestUserSource: over.voice ? 'voice' : null, othersWaiting: 1,
  } as never);
  const entry = getMessageEntries().find((e) => e.id === 'msg.turn-context')!;
  return JSON.stringify((entry.render as (c: unknown) => unknown)(ctx) ?? '');
}

describe('one block: who sent this, and who the written reply goes to', () => {
  it('A1: a contact is the trigger and the owner wrote last: the block names the contact on iMessage, not the dashboard', () => {
    const t = block(contact);
    expect(t).toContain('Who sent this: **Pat Example**');
    expect(t).toContain('Your written reply goes to **Pat Example**');
    expect(t).toContain('by iMessage');
    expect(t).toContain('Reply destination: iMessage to Pat Example');
    expect(t).not.toContain('dashboard chat, normal voice');
  });

  // Owner ruling 2026-11-04 (field fix 3 test-2 round): a person's dashboard ask is answered on the
  // dashboard whatever the presence; away forwards the owner turns no dashboard message started.
  it('A4: an away owner on a turn no dashboard message started is not told iMessage: "away" alone moves nothing', () => {
    const t = block(owner, { inbound: null, presence: 'away' });
    expect(t).not.toContain('by iMessage');
    expect(t).not.toContain('Reply destination: iMessage');
  });

  it('A4b (owner ruling): an away owner who ASKED on the dashboard is told the dashboard', () => {
    const t = block(owner, { inbound: 'dashboard', presence: 'away' });
    expect(t).not.toContain('by iMessage');
    expect(t).not.toContain('Reply destination: iMessage');
  });

  it('A5: an A2A turn names the peer agent and carries no human reply tag', () => {
    const t = block(peer, { inbound: 'dashboard' });
    expect(t).toContain('peer-agent');
    expect(t).not.toContain('Reply destination');
  });

  it('A6: an engine turn carries no human reply tag', () => {
    const t = block(owner, { isEngineTurn: true, inbound: null });
    expect(t).toContain('ENGINE EVENT');
    expect(t).not.toContain('Reply destination');
  });

  it('the block never calls itself the sole routing authority', () => {
    expect(block(contact)).not.toMatch(/sole routing authority|routing authority/i);
  });
});

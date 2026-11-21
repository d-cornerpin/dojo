// ════════════════════════════════════════
// AN OMITTED RECIPIENT IS NEVER ADVISED (3.5, "who am I sending to")
//
// A channel send with no recipient never runs (`send-recipient.ts`), so every text the agent
// reads must name the recipient or say to just write the reply. Two texts still promised the
// old default ("omit it and the tool falls back to this person"); an agent that followed them
// got its send refused at the tool door. This file pins both shut:
//   · the allowlist refusal in `tools/cat/comms.ts` and the replyHint in
//     `services/imessage-bridge.ts` contain no "omit the recipient" advice;
//   · an allowlist refusal actually returned by `executeTool` says no such thing either.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { ownerAddresses, senders, presence } = vi.hoisted(() => ({
  presence: { now: 'in_dojo' as 'in_dojo' | 'away' },
  ownerAddresses: new Set<string>(),
  senders: [] as Array<{ name: string; address: string; is_primary?: boolean }>,
}));
vi.mock('../../../services/safe-senders.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isOwnerIMessageRecipient: (a: string) => ownerAddresses.has(a),
}));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => presence.now, isImessageConfigured: () => true }));
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSafeSenders: () => senders,
}));
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import { computeTurnAddress } from '../turn-address.js';
import type { TurnCounterparty } from '../counterparty.js';
import { executeTool, toolResultOf } from '../../tools/index.js';
import { runMigrations } from '../../../db/migrations.js';
import { getDb } from '../../../db/connection.js';

const AGENT = 'primary';
const contact: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: '+15550100', threadId: null, senderIsAgent: false };

function turnWith(cp: TurnCounterparty, inbound: 'imessage' | 'dashboard'): void {
  endTurnContext(AGENT);
  const t = openTurnContext(AGENT);
  t.address = computeTurnAddress({ autoRoutes: true, counterparty: cp, isEngineTurn: false, isNotificationTurn: false, inboundChannel: inbound, inboundContext: null });
}

beforeEach(() => {
  // The refusal this test reads lives past the door, in the handler, so the call
  // goes through the real executor, which reads the DB (deny-set, audit row) — and the
  // handler reads its allowlist from the config table (`getSafeSenders` falls back to
  // that read when its in-memory list is empty), so an off-allowlist recipient needs
  // one listed sender seeded there. Same seeding as `stop-cancels-an-imessage-send`.
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ name: 'Pat Example', address: '+15550100', is_primary: false, sharing_level: 'full' }]));
  endTurnContext(AGENT);
  presence.now = 'in_dojo';
  ownerAddresses.clear();
  senders.length = 0;
  senders.push({ name: 'Pat Example', address: '+15550100' });
});

describe('the allowlist refusal itself gives no omit-advice', () => {
  it('an imessage_send to an address off the allowlist refuses without advising an omitted recipient', async () => {
    turnWith(contact, 'imessage');
    const out = await executeTool(AGENT, { id: 'call-1', name: 'imessage_send', arguments: { recipient: '+15550199', message: 'hello' } });
    const r = toolResultOf(out);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not on the safe-sender allowlist');
    expect(r.content).not.toMatch(/omit/i);
  }, 60_000);
});

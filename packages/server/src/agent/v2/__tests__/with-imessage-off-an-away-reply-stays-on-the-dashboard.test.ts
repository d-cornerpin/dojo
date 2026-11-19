// While iMessage is switched off in Settings, an away engine turn's reply stays on the dashboard: being reachable
// by iMessage asks the switch, not whether an approved sender is on file.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const runMock = vi.hoisted(() => vi.fn(async (_program: string, _argv: readonly string[]) => ''));
vi.mock('../../../services/imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/imessage-run.js')>()),
  getImsgPath: () => null,
  runMessagesProgram: runMock,
}));

import { runMigrations } from '../../../db/migrations.js';
import { getDb } from '../../../db/connection.js';
import { computeTurnAddressLive } from '../turn-address.js';

const OWNER = '+15550100198';
const setConfig = (key: string, value: string) =>
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);

beforeAll(() => {
  runMigrations();
  setConfig('imessage_approved_senders', JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'open_book' }]));
  setConfig('user_presence', 'away');
  setConfig('imessage_enabled', 'false');
});

describe('with iMessage switched off', () => {
  it("an engine turn's reply on away stays on the dashboard", async () => {
    const addr = await computeTurnAddressLive({
      counterparty: { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false },
      isEngineTurn: true, isNotificationTurn: false, inboundChannel: null, inboundContext: null,
      ownerAffinityChannel: null, autoRoutes: true,
    });
    expect(addr.deliveryChannel).toBe('dashboard');
  });

  it('switched on, the same reply goes to iMessage', async () => {
    setConfig('imessage_enabled', 'true');
    const addr = await computeTurnAddressLive({
      counterparty: { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false },
      isEngineTurn: true, isNotificationTurn: false, inboundChannel: null, inboundContext: null,
      ownerAffinityChannel: null, autoRoutes: true,
    });
    expect(addr.deliveryChannel).toBe('imessage');
    setConfig('imessage_enabled', 'false');
  });
});

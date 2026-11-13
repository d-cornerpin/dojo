// The main agent's held sudo waits on its card: a critical Healer finding and an away owner send no text.
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

const kit = vi.hoisted(() => ({ db: null as Database.Database | null, sends: [] as string[] }));
const PRIMARY = 'primary-agent';

vi.mock('../../../../../db/connection.js', () => ({ getDb: () => kit.db, getDbPath: () => ':memory:' }));
vi.mock('../../../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../../../config/platform.js')>()),
  getSudoPolicyRaw: () => 'gated', isPrimaryAgent: (id: string) => id === PRIMARY, getPrimaryAgentId: () => PRIMARY,
}));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away', isImessageEnabled: () => true }));
vi.mock('../../../../../services/imessage-bridge.js', () => ({
  getDefaultSender: () => 'owner@example.com',
  sendIMessage: async (_to: string, text: string) => { kit.sends.push(text); return true; },
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { recordDispatchAndHold } from '../dispatch-bookkeeping.js';
import { initState } from '../../../state.js';

describe('a held sudo never texts the owner', () => {
  it('a critical Healer diagnostic and an away owner still give no text', async () => {
    kit.db = new Database(':memory:');
    runMigrations(kit.db);
    kit.db.prepare("INSERT INTO healer_diagnostics (id, report, critical_count, warning_count, info_count) VALUES ('d1', 'r', 1, 0, 0)").run();
    const state = initState({
      agentId: PRIMARY, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'test', turnNumber: 1,
      triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null,
    } as Parameters<typeof initState>[0]);
    const out = await recordDispatchAndHold(state, { id: 'tc-1', name: 'shell', arguments: { script: 'sudo whoami' } } as never,
      { agentId: PRIMARY, db: kit.db } as never);
    expect(out.refusal).not.toBeNull();
    expect(kit.db.prepare('SELECT COUNT(*) AS n FROM healer_proposals').get()).toEqual({ n: 1 });
    expect(kit.sends).toEqual([]);
  });
});

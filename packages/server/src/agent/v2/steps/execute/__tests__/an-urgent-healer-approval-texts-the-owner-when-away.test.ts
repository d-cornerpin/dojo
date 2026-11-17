// A held Healer change texts the owner only when the newest diagnostic is critical and he is away.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const kit = vi.hoisted(() => ({ db: null as Database.Database | null, presence: 'away', sends: [] as string[] }));
const HEALER = 'healer-agent';

vi.mock('../../../../../db/connection.js', () => ({ getDb: () => kit.db, getDbPath: () => ':memory:' }));
vi.mock('../../../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../../../config/platform.js')>()),
  isHealerAgent: (id: string) => id === HEALER, isPrimaryAgent: () => false, getPrimaryAgentId: () => null,
}));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => kit.presence, isImessageConfigured: () => true }));
vi.mock('../../../../../services/imessage-bridge.js', () => ({
  getDefaultSender: () => 'owner@example.com',
  sendIMessage: async (_to: string, text: string) => { kit.sends.push(text); return true; },
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { recordDispatchAndHold } from '../dispatch-bookkeeping.js';
import { initState } from '../../../state.js';

beforeEach(() => {
  kit.db = new Database(':memory:');
  runMigrations(kit.db);
  kit.sends.length = 0;
});

async function holdWith(critical: number, presence: string): Promise<number> {
  kit.presence = presence;
  kit.db!.prepare("INSERT INTO healer_diagnostics (id, report, critical_count, warning_count, info_count) VALUES ('d1', 'r', ?, 1, 0)").run(critical);
  const state = initState({
    agentId: HEALER, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'test', turnNumber: 1,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null,
  } as Parameters<typeof initState>[0]);
  const out = await recordDispatchAndHold(state, { id: 'tc-1', name: 'shell', arguments: { script: 'git reset --hard' } } as never,
    { agentId: HEALER, db: kit.db } as never);
  expect(out.refusal).not.toBeNull();
  return kit.sends.length;
}

describe('an urgent Healer approval texts the owner when he is away', () => {
  it('a critical diagnostic and an away owner give one text', async () => {
    expect(await holdWith(1, 'away')).toBe(1);
  });

  it('no critical finding, or the owner present, gives no text', async () => {
    expect(await holdWith(0, 'away')).toBe(0);
    kit.db = new Database(':memory:');
    runMigrations(kit.db);
    expect(await holdWith(1, 'in_dojo')).toBe(0);
  });
});

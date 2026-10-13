// ════════════════════════════════════════════════════════════════════════════════════════
// t146 — the refusal gate's reminder lane asks "is this recipient the owner?" through the ONE
// owner rule (`services/safe-senders.ts:isOwnerIMessageRecipient`). Before t146 it had its own
// reader (`recipientIsChannelOwner`), one of three that answered differently.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t146-reminder', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => { /* not under test */ }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: () => Promise.resolve() }) }));

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

import { runMigrations } from '../../../../../db/migrations.js';
import { runRefusalGates } from '../refusal-gates.js';

/** Fictional throughout (G1). */
const FIRST = '+15550111';
const SECOND = '+15550122';

const db = (): Database.Database => mockDb.current!;
function setConfig(key: string, value: string): void {
  db().prepare(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(key, value);
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
});

// ════════════════════════════════════════════════════════════════════════════════════════
// The refusal gate's reminder lane reads the same owner: a reminder delivered to the owner —
// by address in any spelling, or by his record's name — goes through; to anyone else it is
// refused once. (No behavioural clause covered this gate's owner check before t146.)
// ════════════════════════════════════════════════════════════════════════════════════════

describe('the reminder lane asks the same owner question', () => {
  const reminderSend = async (recipient: string): Promise<string> => {
    const state = {
      sendsPerAgentThisTurn: {}, thrashGatedSignatures: [], thrashGateRefusalCount: 0,
      structuringToolCalledThisTurn: false, steerQueue: [], heavyLoadsThisTurn: 0, lastContextRatio: 0,
      loopCount: 0, closeOutGateSatisfied: true, danglingTaskIds: [], compileGateSatisfied: true, compileOwedAskIds: [],
    };
    const ctx = {
      agentId: 'quillon', turnNumber: 1,
      turnCtx: { servedWork: { taskKind: 'reminder' } },
      counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' },
      reminderLaneRefusedSigs: new Set<string>(), engineBlockEscapeHatch: '',
    };
    const out = runRefusalGates(
      state as never, { id: 'c1', name: 'imessage_send', arguments: { recipient, message: 'water the seedlings' } } as never,
      ctx as never, false,
    );
    return out.refusal?.content ?? '';
  };

  beforeEach(() => {
    setConfig('imessage_approved_senders', JSON.stringify([
      { address: FIRST, name: 'First' }, { address: SECOND, name: 'Keeper', is_primary: true },
    ]));
  });

  it('to the owner, by address, by another spelling of it, or by his record name: not refused', async () => {
    expect(await reminderSend(SECOND)).not.toMatch(/is not the owner/);
    expect(await reminderSend('1 (555) 012-2')).not.toMatch(/is not the owner/);
    expect(await reminderSend('Keeper')).not.toMatch(/is not the owner/);
  });

  it('to someone else: refused once', async () => {
    expect(await reminderSend(FIRST)).toMatch(/is not the owner/);
  });
});

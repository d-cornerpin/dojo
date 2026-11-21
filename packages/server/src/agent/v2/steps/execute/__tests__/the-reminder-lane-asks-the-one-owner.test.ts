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
      structuringToolCalledThisTurn: false, steerQueue: { pending: [], fired: [] }, heavyLoadsThisTurn: 0, lastContextRatio: 0,
      loopCount: 0,
    };
    const ctx = {
      agentId: 'quillon', turnNumber: 1,
      turnCtx: { servedWork: { taskKind: 'reminder' } },
      counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' },
      refusedOnceSigs: new Set<string>(), engineBlockEscapeHatch: '',
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

// 3.5: the refusal says where the reminder will land from the turn's ADDRESS, never "the owner is
// watching the dashboard conversation".
describe('the reminder lane reads the turn address for where the reminder lands', () => {
  const refusalWith = (address: unknown): string => {
    const state = {
      structuringToolCalledThisTurn: false, steerQueue: { pending: [], fired: [] }, heavyLoadsThisTurn: 0, lastContextRatio: 0,
      loopCount: 0,
    };
    const ctx = {
      agentId: 'quillon', turnNumber: 1,
      turnCtx: { servedWork: { taskKind: 'reminder' }, address },
      counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' },
      refusedOnceSigs: new Set<string>(), engineBlockEscapeHatch: '',
    };
    return runRefusalGates(
      state as never, { id: 'c1', name: 'imessage_send', arguments: { recipient: FIRST, message: 'water the seedlings' } } as never,
      ctx as never, false,
    ).refusal?.content ?? '';
  };
  beforeEach(() => {
    setConfig('imessage_approved_senders', JSON.stringify([
      { address: FIRST, name: 'First' }, { address: SECOND, name: 'Keeper', is_primary: true },
    ]));
  });
  it('a reminder he asked for by text: the written reply reaches him by iMessage', () => {
    const t = refusalWith({ kind: 'engine', isOwner: true, boundChannel: 'imessage', autoRoutes: true, ownerAffinity: null, heldWake: false, deliveryChannel: 'imessage' });
    expect(t).toContain('delivers it to the owner by iMessage');
    expect(t).not.toContain('watching the dashboard');
  });
  it('an owner at the dashboard: by the dashboard chat', () => {
    expect(refusalWith({ kind: 'engine', isOwner: true, boundChannel: 'dashboard', autoRoutes: true, ownerAffinity: null, heldWake: false, deliveryChannel: 'dashboard' })).toContain('delivers it to the owner by the dashboard chat');
  });
  it('a reminder a contact asked for goes to that contact; a send to anyone else is refused once, naming them', () => {
    const contact = { kind: 'engine', isOwner: false, name: 'Pat Example', senderId: FIRST, boundChannel: 'imessage', autoRoutes: true, ownerAffinity: null, heldWake: false, deliveryChannel: 'imessage' };
    expect(refusalWith(contact)).toBe('');
    expect(refusalWith({ ...contact, name: 'Lee Example', senderId: '+15550177' })).toContain('"' + FIRST + '" is not Lee Example');
  });
});

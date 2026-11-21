// ════════════════════════════════════════════════════════════════════════════════════════
// A send addressed TO the owner is never refused by the gates, whatever the presence switch
// says and whatever turn this is. The switch is only the manual in/away setting — not proof
// the owner is watching the dashboard — and on a turn rooted in someone else's text the
// "chat reply" would reach that person, not the owner. The channel choice is the agent's.
// The reminder lane (a send to a NON-owner on a reminder turn) still refuses once.
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-never-refuse-owner-text', 'dojo.db'),
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
// Presence 'in_dojo', a send addressed to the owner: no refusal — dashboard-rooted turn,
// SMS, a third party's inbound text, or a repeat over the same ctx. Only the reminder lane
// still refuses, and only a send to a NON-owner.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('a text to the owner is never refused', () => {
  beforeEach(() => {
    setConfig('imessage_approved_senders', JSON.stringify([
      { address: FIRST, name: 'First' }, { address: SECOND, name: 'Keeper', is_primary: true },
    ]));
    setConfig('user_presence', 'in_dojo');
  });

  const freshState = () => ({
    structuringToolCalledThisTurn: false, steerQueue: { pending: [], fired: [] }, heavyLoadsThisTurn: 0, lastContextRatio: 0,
    loopCount: 0,
  });

  const buildCtx = (
    servedWork: Record<string, unknown> | undefined,
    counterparty: Record<string, unknown>,
  ) => ({
    agentId: 'quillon', turnNumber: 1,
    turnCtx: { servedWork },
    counterparty,
    refusedOnceSigs: new Set<string>(), engineBlockEscapeHatch: '',
  });

  const send = (
    name: string, recipient: string,
    servedWork: Record<string, unknown> | undefined,
    counterparty: Record<string, unknown>,
  ): string => {
    const args = name === 'sms_send' ? { to: recipient, message: 'x' } : { recipient, message: 'x' };
    const out = runRefusalGates(
      freshState() as never, { id: 'c1', name, arguments: args } as never,
      buildCtx(servedWork, counterparty) as never, false,
    );
    return out.refusal?.content ?? '';
  };

  const ownerAtDashboard = { kind: 'user', relation: 'owner', channel: 'dashboard' };

  it('a dashboard-rooted iMessage to the owner in the dojo: not refused', () => {
    expect(send('imessage_send', SECOND, {}, ownerAtDashboard)).toBe('');
  });

  it('a dashboard-rooted SMS to the owner in the dojo: not refused', () => {
    expect(send('sms_send', SECOND, {}, ownerAtDashboard)).toBe('');
  });

  it('a third party texted in and the send answers the owner: not refused', () => {
    expect(send('imessage_send', SECOND, { originConvKey: 'owner' },
      { kind: 'user', relation: 'known_contact', channel: 'imessage' })).toBe('');
  });

  it('two sends over the same ctx both go through', () => {
    const ctx = buildCtx({}, ownerAtDashboard);
    const call = (): string => {
      const out = runRefusalGates(
        freshState() as never,
        { id: 'c1', name: 'imessage_send', arguments: { recipient: SECOND, message: 'x' } } as never,
        ctx as never, false,
      );
      return out.refusal?.content ?? '';
    };
    expect(call()).toBe('');
    expect(call()).toBe('');
  });

  it('the reminder lane still refuses a send to a non-owner once', () => {
    expect(send('imessage_send', FIRST, { taskKind: 'reminder' }, ownerAtDashboard)).toMatch(/is not the owner/);
  });
});

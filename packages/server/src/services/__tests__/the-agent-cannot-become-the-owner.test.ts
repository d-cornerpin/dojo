// The agent can never create, change or promote the iMessage owner. The owner comes only from the
// human's own settings: a flagged record in the approved list, or the older single-recipient key.
// An entry the agent writes is never read as the owner, and the owner exemption in sms_send and
// voice_call reaches only the human-set owner.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commsHandlers } from '../../agent/tools/cat/comms.js';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: () => {
        const m = /key = '([a-z_]+)'/.exec(sql);
        return m && store.has(m[1]) ? { value: store.get(m[1]) } : undefined;
      },
      run: (...a: unknown[]) => { if (/INSERT INTO config/.test(sql)) { const k = /VALUES \('([a-z_]+)'/.exec(sql)?.[1]; if (k) store.set(k, String(a[0])); } },
      all: () => [],
    }),
  }),
}));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] };
});
vi.mock('../imessage-bridge.js', async () => {
  const real = await vi.importActual<typeof import('../safe-senders.js')>('../safe-senders.js');
  return { parseSafeSenders: real.parseSafeSenders, reloadApprovedSenders: () => {} };
});
vi.mock('../../work/row-authority.js', () => ({ ownerAskedInThisTurn: () => ({ ok: true }) }));

const { ownerIMessageRecords, isOwnerIMessageRecipient, parseSafeSenders } = await import('../safe-senders.js');
const { iMessageListHasHumanOwner } = await import('../imessage-owner-gate.js');
const { resolveRecipient } = await import('../../twilio/approved-number.js');

const AGENT = '+15550199999';
const OWNER = '+15550100001';
const agentEntry = { address: AGENT, name: 'Stranger', is_primary: false, sharing_level: 'dont_overshare', is_agent: false };
const ownerEntry = { address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'open_book' };

beforeEach(() => store.clear());

describe('nothing is made the owner by position', () => {
  it('an unflagged object list has no owner', () => {
    expect(parseSafeSenders(JSON.stringify([agentEntry])).some((s) => s.is_primary)).toBe(false);
    store.set('imessage_approved_senders', JSON.stringify([agentEntry]));
    expect(ownerIMessageRecords()).toEqual([]);
    expect(isOwnerIMessageRecipient(AGENT)).toBe(false);
    expect(resolveRecipient([], AGENT)).toBeNull();
  });

  it('with only the older single-recipient setting, an entry in the list is not the owner; the setting is', () => {
    store.set('imessage_default_sender', OWNER);
    store.set('imessage_approved_senders', JSON.stringify([agentEntry]));
    expect(ownerIMessageRecords().map((o) => o.address)).toEqual([OWNER]);
    expect(isOwnerIMessageRecipient(AGENT)).toBe(false);
    expect(resolveRecipient([], AGENT)).toBeNull();
    expect(resolveRecipient([], OWNER)?.address).toBe(OWNER);
  });

  it('an existing human owner stays the only owner when another entry is added', () => {
    store.set('imessage_approved_senders', JSON.stringify([ownerEntry, agentEntry]));
    expect(ownerIMessageRecords().map((o) => o.address)).toEqual([OWNER]);
    expect(resolveRecipient([], AGENT)).toBeNull();
    expect(resolveRecipient([], OWNER)?.address).toBe(OWNER);
  });

  it('the older bare-address list and a legacy-key match still name the owner', () => {
    store.set('imessage_approved_senders', JSON.stringify([OWNER, AGENT]));
    expect(ownerIMessageRecords().map((o) => o.address)).toEqual([OWNER]);
    store.set('imessage_default_sender', OWNER);
    store.set('imessage_approved_senders', JSON.stringify([{ ...agentEntry }, { ...agentEntry, address: OWNER }]));
    expect(ownerIMessageRecords().map((o) => o.address)).toEqual([OWNER]);
  });
});

describe('add_safe_sender (iMessage)', () => {
  const call = async (): Promise<{ content: string; isError: boolean }> => {
    return commsHandlers['add_safe_sender']({
      agentId: 'agent-1',
      args: { channel: 'imessage', address: AGENT, name: 'Stranger', user_quote: 'please text my friend at that number' },
    } as never) as never;
  };

  it('refuses on an empty list, writes nothing, and makes nobody the owner', async () => {
    expect(iMessageListHasHumanOwner()).toBe(false);
    const res = await call();
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Settings');
    expect(store.has('imessage_approved_senders')).toBe(false);
    expect(ownerIMessageRecords()).toEqual([]);
    expect(resolveRecipient([], AGENT)).toBeNull();
  });

  it('refuses with only the older single-recipient setting; that owner is unchanged', async () => {
    store.set('imessage_default_sender', OWNER);
    const res = await call();
    expect(res.isError).toBe(true);
    expect(store.has('imessage_approved_senders')).toBe(false);
    expect(ownerIMessageRecords().map((o) => o.address)).toEqual([OWNER]);
    expect(resolveRecipient([], AGENT)).toBeNull();
  });

  it('with a human owner it adds a non-owner entry and the owner does not change', async () => {
    store.set('imessage_approved_senders', JSON.stringify([ownerEntry]));
    const res = await call();
    expect(res.isError).toBe(false);
    const saved = parseSafeSenders(store.get('imessage_approved_senders'));
    expect(saved.find((s) => s.address === AGENT)?.is_primary).toBe(false);
    expect(ownerIMessageRecords().map((o) => o.address)).toEqual([OWNER]);
    expect(resolveRecipient([], AGENT)).toBeNull();
  });
});

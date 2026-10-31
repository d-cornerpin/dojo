// ════════════════════════════════════════
// Safe senders -> contacts mirror
//
// from-safe-senders.ts pushes a channel's allowlist into the contacts store so a
// trusted name later resolves to a record. None of its three functions are
// probed, and the one that is pure (configKeyToChannel) has no store at all.
//
// The store is mocked so no clause touches a database; every assertion reads a
// call the product made — what it looked up, what it wrote, and when it refused.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../store.js', () => ({
  findMatchingContact: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
}));

import {
  configKeyToChannel,
  syncSafeSendersToContacts,
  syncSafeSenderToContacts,
} from '../from-safe-senders.js';
import { findMatchingContact, createContact, updateContact } from '../store.js';

// A safe sender the store can look up or be created from — a plain object cast
// through `never`, the same shape the product receives.
const sender = (address: string, name = 'Ann'): never => ({ address, name } as never);

// A contact the store hands back as "already on file". The field arrays are empty
// by default so a case states which addresses a known contact already carries.
function known(over: Record<string, unknown> = {}): never {
  return {
    id: 'c1',
    displayName: 'Ann',
    preferredName: null,
    emails: [],
    phones: [],
    imessageHandles: [],
    tags: [],
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findMatchingContact).mockReturnValue(null);
});

describe('configKeyToChannel', () => {
  const CHANNEL_KEYS = [
    ['imessage_approved_senders', 'imessage'],
    ['gmail_approved_senders', 'gmail'],
    ['gmail_approved_senders_agent', 'gmail'],
    ['gmail_approved_senders_user', 'gmail'],
    ['outlook_approved_senders_agent', 'outlook'],
    ['outlook_approved_senders_user', 'outlook'],
    ['teams_approved_senders', 'teams'],
    ['twilio_sms_approved_senders', 'sms'],
    ['twilio_voice_approved_callers', 'voice'],
  ] as const;

  const NON_CHANNEL_KEYS = [
    '',
    'unrelated',
    'Gmail_approved_senders',
    'x_gmail_approved_senders',
    'imessage_approved_senders_extra',
    'teams_approved_senders_x',
    'twilio_sms_approved_senders_x',
  ];

  it.each(CHANNEL_KEYS)('maps the safe-sender key %s to the %s channel', (key, channel) => {
    expect(configKeyToChannel(key)).toBe(channel);
  });

  it.each(NON_CHANNEL_KEYS)('returns null for a key that is not a safe-sender list: %s', (key) => {
    expect(configKeyToChannel(key)).toBeNull();
  });
});

describe('syncSafeSendersToContacts — a new contact', () => {
  it('creates it with the trimmed address, the safe-sender tag, and the trimmed name', () => {
    const out = syncSafeSendersToContacts('gmail', [sender(' A@x.com ', ' Ann ')], null);

    expect(vi.mocked(findMatchingContact).mock.calls[0][0]).toEqual({
      emails: ['A@x.com'], phones: ['A@x.com'], imessageHandles: ['A@x.com'],
    });
    expect(vi.mocked(findMatchingContact).mock.calls[0][1]).toEqual({ allowNameMatch: false });
    expect(vi.mocked(createContact).mock.calls[0][0]).toEqual({
      displayName: 'Ann',
      tags: ['safe-sender'],
      emails: ['A@x.com'],
    });
    expect(vi.mocked(createContact).mock.calls[0][1]).toBeNull();
    expect(out).toEqual({ created: 1, updated: 0 });
  });

  const CHANNEL_FIELDS: Array<
    readonly ['sms' | 'voice' | 'imessage' | 'outlook' | 'teams', 'phones' | 'imessageHandles' | 'emails']
  > = [
    ['sms', 'phones'],
    ['voice', 'phones'],
    ['imessage', 'imessageHandles'],
    ['outlook', 'emails'],
    ['teams', 'emails'],
  ];

  it.each(CHANNEL_FIELDS)('routes the %s address into the %s field on a new contact', (channel, field) => {
    syncSafeSendersToContacts(channel, [sender('addr@x.com')], null);
    expect(vi.mocked(createContact).mock.calls[0][0]).toMatchObject({ [field]: ['addr@x.com'] });
  });

  it('falls back to the address as the display name when the sender carried none', () => {
    syncSafeSendersToContacts('gmail', [sender('a@x.com', '')], null);

    expect(vi.mocked(findMatchingContact).mock.calls[0][0]).toEqual({
      emails: ['a@x.com'], phones: ['a@x.com'], imessageHandles: ['a@x.com'],
    });
    expect(vi.mocked(createContact).mock.calls[0][0]).toMatchObject({ displayName: 'a@x.com' });
  });

  it('skips a blank or empty address without touching the store', () => {
    const out = syncSafeSendersToContacts('gmail', [sender('   '), sender('')], null);

    expect(out).toEqual({ created: 0, updated: 0 });
    expect(findMatchingContact).not.toHaveBeenCalled();
    expect(createContact).not.toHaveBeenCalled();
    expect(updateContact).not.toHaveBeenCalled();
  });
});

describe('syncSafeSendersToContacts — an existing contact', () => {
  it('is a no-op when the address and the name are already on file', () => {
    vi.mocked(findMatchingContact).mockReturnValue(known({ emails: ['a@X.com'] }));
    const out = syncSafeSendersToContacts('gmail', [sender('A@x.com', 'ann')], null);

    expect(updateContact).not.toHaveBeenCalled();
    expect(out).toEqual({ created: 0, updated: 0 });
  });

  it('appends a new address to the contact already on file', () => {
    vi.mocked(findMatchingContact).mockReturnValue(known({ emails: ['old@x.com'] }));
    const out = syncSafeSendersToContacts('gmail', [sender('new@x.com', 'Ann')], null);

    expect(updateContact).toHaveBeenCalledWith('c1', { emails: ['new@x.com'] }, null, 'append');
    expect(out).toEqual({ created: 0, updated: 1 });
  });

  it('records a new name as preferredName on a hand-curated contact', () => {
    // No safe-sender tag: the user named this record by hand, so the new label
    // lands in preferredName and displayName is left untouched.
    vi.mocked(findMatchingContact).mockReturnValue(known({ emails: ['a@x.com'] }));
    syncSafeSendersToContacts('gmail', [sender('a@x.com', 'Bea')], null);

    expect(updateContact).toHaveBeenCalledWith('c1', { preferredName: 'Bea' }, null, 'append');
    expect(vi.mocked(updateContact).mock.calls[0][1]).not.toHaveProperty('displayName');
  });

  it('never replaces a preferred name the owner already set', () => {
    vi.mocked(findMatchingContact).mockReturnValue(known({ emails: ['a@x.com'], preferredName: 'Bee' }));
    const out = syncSafeSendersToContacts('gmail', [sender('a@x.com', 'Bea')], null);
    expect(updateContact).not.toHaveBeenCalled();
    expect(out).toEqual({ created: 0, updated: 0 });
  });

  it('records a new name as displayName on a safe-sender-tagged contact', () => {
    // Safe-sender tag: the record tracks the safe-sender label, so the new name
    // updates displayName and preferredName is left untouched.
    vi.mocked(findMatchingContact).mockReturnValue(known({ emails: ['a@x.com'], tags: ['safe-sender'] }));
    syncSafeSendersToContacts('gmail', [sender('a@x.com', 'Bea')], null);

    expect(updateContact).toHaveBeenCalledWith('c1', { displayName: 'Bea' }, null, 'append');
    expect(vi.mocked(updateContact).mock.calls[0][1]).not.toHaveProperty('preferredName');
  });

  it('does not update a contact whose preferred name already matches, case-insensitively', () => {
    vi.mocked(findMatchingContact).mockReturnValue(known({ emails: ['a@x.com'], preferredName: 'BEA' }));
    const out = syncSafeSendersToContacts('gmail', [sender('a@x.com', 'Bea')], null);

    expect(updateContact).not.toHaveBeenCalled();
    expect(out).toEqual({ created: 0, updated: 0 });
  });
});

describe('resilience', () => {
  it('one failed sender does not stop the rest of the list', () => {
    vi.mocked(findMatchingContact).mockImplementationOnce(() => {
      throw new Error('store down');
    });
    const out = syncSafeSendersToContacts(
      'gmail',
      [sender('first@x.com', 'First'), sender('second@x.com', 'Second')],
      null,
    );

    expect(out).toEqual({ created: 1, updated: 0 });
    expect(createContact).toHaveBeenCalledTimes(1);
  });
});

describe('syncSafeSenderToContacts — the single-sender mirror', () => {
  it('does the same work as the list form and returns nothing', () => {
    const ret = syncSafeSenderToContacts('gmail', sender('a@x.com', 'Ann'), null);

    expect(ret).toBeUndefined();
    expect(createContact).toHaveBeenCalledTimes(1);
  });

  it('never throws when the store throws', () => {
    vi.mocked(findMatchingContact).mockImplementationOnce(() => {
      throw new Error('store down');
    });
    expect(() => syncSafeSenderToContacts('gmail', sender('a@x.com', 'Ann'), null)).not.toThrow();
  });
});

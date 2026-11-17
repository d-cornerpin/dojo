// ════════════════════════════════════════
// isSenderAuthorized (v3.0.9): THE ONE seam that decides whether an inbound
// message earns an auto-reply. It gates user-owned accounts out entirely,
// drops empty senders, checks the channel's safe-sender allowlist, and defers
// iMessage to the bridge that already vetted it. No v3.5 test touches it, so
// this pins every branch of the decision.
//
// The two collaborators are mocked: the per-channel safe-sender lists
// (channel-safe-senders.js) and the address matcher (imessage-bridge.js). No
// real config or DB is read.
// ════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The four allowlists, one mutable array each, reseeded by the beforeEach so
// every case starts from the same known lists.
const lists = vi.hoisted(() => ({
  gmail: [] as Array<{ address: string }>,
  outlook: [] as Array<{ address: string }>,
  teams: [] as Array<{ address: string }>,
  sms: [] as Array<{ address: string }>,
}));

vi.mock('../../../services/channel-safe-senders.js', () => ({
  mailboxesSafeSenders: (service: 'gmail' | 'outlook') => lists[service],
  senderWakes: (channel: 'sms' | 'teams', _account: null, address: string) =>
    (channel === 'sms' ? lists.sms : lists.teams).some((x) => x.address.toLowerCase() === address.toLowerCase()),
}));

vi.mock('../../../services/imessage-bridge.js', () => ({
  addressesMatch: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
}));

import { isSenderAuthorized } from '../channel-auth.js';

beforeEach(() => {
  lists.gmail = [{ address: 'g@example.test' }];
  lists.outlook = [{ address: 'o@example.test' }];
  lists.teams = [{ address: 't@example.test' }];
  lists.sms = [{ address: '+15550001111' }];
});

describe('isSenderAuthorized', () => {
  it('never auto-replies on a user-owned account, even for a listed sender', () => {
    expect(isSenderAuthorized('email', 'g@example.test', 'user')).toBe(false);
    expect(isSenderAuthorized('imessage', 'someone@icloud.com', 'user')).toBe(false);
  });

  it('an empty, null or undefined sender earns no reply (email, sms)', () => {
    for (const sender of ['', null, undefined]) {
      expect(isSenderAuthorized('email', sender)).toBe(false);
      expect(isSenderAuthorized('sms', sender)).toBe(false);
    }
  });

  it('email: with no service, both the gmail and outlook lists count', () => {
    expect(isSenderAuthorized('email', 'g@example.test')).toBe(true);
    expect(isSenderAuthorized('email', 'o@example.test')).toBe(true);
  });

  it('email: { emailService: "gmail" } checks only the gmail list', () => {
    expect(isSenderAuthorized('email', 'o@example.test', 'agent', { emailService: 'gmail' })).toBe(false);
  });

  it('email: { emailService: "outlook" } checks only the outlook list', () => {
    expect(isSenderAuthorized('email', 'g@example.test', 'agent', { emailService: 'outlook' })).toBe(false);
    expect(isSenderAuthorized('email', 'o@example.test', 'agent', { emailService: 'outlook' })).toBe(true);
  });

  it('email: matching is case-insensitive', () => {
    expect(isSenderAuthorized('email', 'G@Example.TEST')).toBe(true);
    expect(isSenderAuthorized('email', 'z@example.test')).toBe(false);
  });

  it('teams: only the teams allowlist counts', () => {
    expect(isSenderAuthorized('teams', 't@example.test')).toBe(true);
    expect(isSenderAuthorized('teams', 'g@example.test')).toBe(false);
  });

  it('sms: only the sms allowlist counts', () => {
    expect(isSenderAuthorized('sms', '+15550001111')).toBe(true);
    expect(isSenderAuthorized('sms', 't@example.test')).toBe(false);
  });

  it('imessage: any non-empty sender on an agent account is authorized (the bridge already vetted it)', () => {
    expect(isSenderAuthorized('imessage', 'not-on-any-list@icloud.com')).toBe(true);
    expect(isSenderAuthorized('imessage', 'not-on-any-list@icloud.com', 'agent')).toBe(true);
  });

  it('email: when both lists are emptied, a previously-listed sender is no longer authorized', () => {
    lists.gmail = [];
    lists.outlook = [];
    expect(isSenderAuthorized('email', 'g@example.test')).toBe(false);
  });
});

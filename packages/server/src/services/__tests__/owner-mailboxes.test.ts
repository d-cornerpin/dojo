import { describe, it, expect } from 'vitest';
import { ownerMailboxesFrom } from '../owner-mailboxes.js';

describe('ownerMailboxesFrom', () => {
  it('lists one mailbox per provider with the address cleaned', () => {
    expect(
      ownerMailboxesFrom(
        [{ id: 'g1', email: 'Me@Gmail.com ' }],
        [{ id: 'm1', email: 'me@work.com' }],
      ),
    ).toEqual([
      { address: 'me@gmail.com', provider: 'google', accountId: 'g1' },
      { address: 'me@work.com', provider: 'microsoft', accountId: 'm1' },
    ]);
  });

  it('returns [] when neither provider has an account', () => {
    expect(ownerMailboxesFrom([], [])).toEqual([]);
  });

  it('skips rows with no address, e.g. a disconnected first slot', () => {
    expect(
      ownerMailboxesFrom(
        [
          { id: 'g1', email: null },
          { id: 'g2', email: '' },
        ],
        [],
      ),
    ).toEqual([]);
  });

  it('keeps the first of the same address twice', () => {
    expect(
      ownerMailboxesFrom(
        [{ id: 'g1', email: 'me@x.com' }],
        [{ id: 'm1', email: 'ME@x.com' }],
      ),
    ).toEqual([{ address: 'me@x.com', provider: 'google', accountId: 'g1' }]);
  });

  it('keeps input order within a provider', () => {
    expect(
      ownerMailboxesFrom(
        [
          { id: 'g1', email: 'a@x.com' },
          { id: 'g2', email: 'b@x.com' },
        ],
        [],
      ),
    ).toEqual([
      { address: 'a@x.com', provider: 'google', accountId: 'g1' },
      { address: 'b@x.com', provider: 'google', accountId: 'g2' },
    ]);
  });

  it('skips an email that is not an address', () => {
    expect(ownerMailboxesFrom([{ id: 'g1', email: 'not an address' }], [])).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { ownerEmailAddresses } from '../owner-email-addresses.js';

describe('ownerEmailAddresses', () => {
  it('keeps email-shaped entries lowercased and trimmed, first duplicate wins, drops the rest', () => {
    expect(
      ownerEmailAddresses([
        'Owner@X.com',
        ' owner@x.com ',
        '+15551234567',
        '',
        null,
        undefined,
        'not an email',
        'a@b',
        'x@y.test',
      ]),
    ).toEqual(['owner@x.com', 'x@y.test']);
  });

  it('rejects a display-name form: angle brackets are not a bare address', () => {
    expect(ownerEmailAddresses(['Ann Lee <ann@x.com>'])).toEqual([]);
  });

  it('rejects a comma-joined list as one address', () => {
    expect(ownerEmailAddresses(['a@x.com, b@x.com'])).toEqual([]);
  });

  it('keeps near-miss addresses as distinct (no fuzzy matching)', () => {
    expect(ownerEmailAddresses(['own-er@x.com', 'owner@x.com'])).toEqual([
      'own-er@x.com',
      'owner@x.com',
    ]);
  });

  it('returns [] for an empty list and for blank-only entries', () => {
    expect(ownerEmailAddresses([])).toEqual([]);
    expect(ownerEmailAddresses(['  '])).toEqual([]);
  });

  it('keeps a tagged local part and a multi-label domain', () => {
    expect(ownerEmailAddresses(['first.last+tag@sub.example.co.uk'])).toEqual([
      'first.last+tag@sub.example.co.uk',
    ]);
  });

  it('skips a non-string slipped in by mistake without throwing', () => {
    expect(ownerEmailAddresses([42 as never, 'z@z.test'])).toEqual(['z@z.test']);
  });
});

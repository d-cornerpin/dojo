import { describe, it, expect } from 'vitest';
import { parseAddressList, placeMailbox, type MailAddress } from '../mail-inbound-facts.js';

// Build a MailAddress without the noise; display defaults to null.
const A = (address: string, display: string | null = null): MailAddress => ({ address, display });

describe('parseAddressList', () => {
  it('splits the mixed example into three entries with display names', () => {
    expect(
      parseAddressList('Ann Lee <Ann@X.com>, "Smith, Bob" <bob@y.test>, carol@z.test'),
    ).toEqual([
      { address: 'ann@x.com', display: 'Ann Lee' },
      { address: 'bob@y.test', display: 'Smith, Bob' },
      { address: 'carol@z.test', display: null },
    ]);
  });

  it('dedupes by lower-cased address, keeping the first occurrence', () => {
    expect(parseAddressList('A@x.com, a@X.COM')).toEqual([{ address: 'a@x.com', display: null }]);
  });

  it('gives [] for empty, null, undefined, and undisclosed recipients', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
  });

  it('does not split a comma inside a quoted name that also carries an angle address', () => {
    const out = parseAddressList('"Doe, J <j@x.com>" <real@x.com>');
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe('real@x.com');
  });
});

describe('placeMailbox', () => {
  it('reports "to" when an own address is on To', () => {
    expect(placeMailbox(['me@x.com'], [A('me@x.com')], [])).toBe('to');
  });

  it('reports "cc" when an own address is on Cc only', () => {
    expect(placeMailbox(['me@x.com'], [], [A('ME@X.COM')])).toBe('cc');
  });

  it('reports "neither" when the own address is on neither', () => {
    expect(placeMailbox(['me@x.com'], [A('someone@x.com')], [A('else@x.com')])).toBe('neither');
  });

  it('reports "to" when the own address is on both To and Cc', () => {
    expect(placeMailbox(['me@x.com'], [A('me@x.com')], [A('me@x.com')])).toBe('to');
  });

  it('does not fuzzy-match a look-alike address', () => {
    expect(placeMailbox(['owner@x.com'], [A('own-er@x.com')], [])).toBe('neither');
  });

  it('finds the second of several own addresses on Cc', () => {
    expect(placeMailbox(['first@x.com', 'second@x.com'], [], [A('second@x.com')])).toBe('cc');
  });
});

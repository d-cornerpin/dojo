import { describe, it, expect } from 'vitest';
import { gmailAddressingFacts, outlookAddressingFacts } from '../mail-inbound-facts.js';

// Plain vitest, no mocks. Each case pairs an input with its exact expected facts.

describe('gmailAddressingFacts', () => {
  it('reads To/Cc/Authentication-Results, ignoring the ARC look-alike header', () => {
    const facts = gmailAddressingFacts(
      [
        { name: 'From', value: 'x@y.test' },
        { name: 'To', value: 'Me <me@x.com>, bob@y.test' },
        { name: 'Cc', value: 'carol@z.test' },
        { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass; dmarc=pass (p=NONE) header.from=y.test' },
        { name: 'ARC-Authentication-Results', value: 'i=1; mx.google.com; dmarc=pass' },
      ],
      ['me@x.com'],
    );
    expect(facts.to).toEqual([{ address: 'me@x.com', display: 'Me' }, { address: 'bob@y.test', display: null }]);
    expect(facts.cc).toEqual([{ address: 'carol@z.test', display: null }]);
    expect(facts.placement).toBe('to');
    expect(facts.authenticationResults).toEqual(['mx.google.com; dkim=pass; dmarc=pass (p=NONE) header.from=y.test']);
  });

  it('reads the same header names regardless of their case', () => {
    const facts = gmailAddressingFacts(
      [
        { name: 'TO', value: 'Me <me@x.com>' },
        { name: 'cc', value: 'carol@z.test' },
        { name: 'AUTHENTICATION-RESULTS', value: 'result-x' },
      ],
      ['me@x.com'],
    );
    expect(facts.to).toEqual([{ address: 'me@x.com', display: 'Me' }]);
    expect(facts.cc).toEqual([{ address: 'carol@z.test', display: null }]);
    expect(facts.placement).toBe('to');
    expect(facts.authenticationResults).toEqual(['result-x']);
  });

  it('joins all Authentication-Results in order, trims each, and drops the blank one', () => {
    const facts = gmailAddressingFacts(
      [
        { name: 'Authentication-Results', value: ' first ' },
        { name: 'Authentication-Results', value: '   ' },
        { name: 'Authentication-Results', value: 'second' },
      ],
      [],
    );
    expect(facts.authenticationResults).toEqual(['first', 'second']);
  });

  it('joins every To header in order before parsing', () => {
    const facts = gmailAddressingFacts(
      [
        { name: 'To', value: 'a@x.com' },
        { name: 'To', value: 'b@x.com' },
      ],
      [],
    );
    expect(facts.to.map((a) => a.address)).toEqual(['a@x.com', 'b@x.com']);
  });

  it('gives empty facts and "neither" when no To/Cc/Authentication-Results are present', () => {
    expect(
      gmailAddressingFacts(
        [
          { name: 'From', value: 'x@y.test' },
          { name: 'Subject', value: 'hi' },
        ],
        ['me@x.com'],
      ),
    ).toEqual({ to: [], cc: [], placement: 'neither', authenticationResults: [] });
    expect(gmailAddressingFacts([], ['me@x.com'])).toEqual({ to: [], cc: [], placement: 'neither', authenticationResults: [] });
  });

  it('reports "cc" when the own address is on Cc only', () => {
    expect(gmailAddressingFacts([{ name: 'Cc', value: 'ME@X.COM' }], ['me@x.com']).placement).toBe('cc');
  });

  it('does not fuzzy-match a look-alike address', () => {
    expect(gmailAddressingFacts([{ name: 'To', value: 'own-er@x.com' }], ['owner@x.com']).placement).toBe('neither');
  });
});

describe('outlookAddressingFacts', () => {
  it('normalizes recipient lists, trims the display, and leaves authenticationResults empty', () => {
    const facts = outlookAddressingFacts(
      {
        toRecipients: [
          { emailAddress: { name: 'Me', address: 'Me@X.com' } },
          { emailAddress: { address: 'bob@y.test' } },
        ],
        ccRecipients: [{ emailAddress: { name: '  ', address: 'carol@z.test' } }],
      },
      ['me@x.com'],
    );
    expect(facts.to).toEqual([{ address: 'me@x.com', display: 'Me' }, { address: 'bob@y.test', display: null }]);
    expect(facts.cc).toEqual([{ address: 'carol@z.test', display: null }]);
    expect(facts.placement).toBe('to');
    expect(facts.authenticationResults).toEqual([]);
  });

  it('drops address-less and duplicate recipients, keeping the first', () => {
    const facts = outlookAddressingFacts(
      {
        toRecipients: [
          { emailAddress: { address: 'Undisclosed' } },
          {},
          { emailAddress: { address: 'a@x.com' } },
          { emailAddress: { address: 'A@x.com', name: 'Second' } },
        ],
      },
      [],
    );
    expect(facts.to).toEqual([{ address: 'a@x.com', display: null }]);
  });

  it('gives empty lists and "neither" when both recipient lists are missing', () => {
    const facts = outlookAddressingFacts({}, ['me@x.com']);
    expect(facts.to).toEqual([]);
    expect(facts.cc).toEqual([]);
    expect(facts.placement).toBe('neither');
    expect(facts.authenticationResults).toEqual([]);
  });
});

// The label-only detector has its own boundaries pinned here: what counts as NOTHING BUT a history-row
// label (`[<instant>]`, or `[<instant> · <subject>]`). A drift that lets a real sentence through, or
// throws a real reply away as "just a label", must be seen against these shapes.
import { describe, it, expect } from 'vitest';
import { isRowLabelOnly, stripLeadingTimeStamp } from '../message-stamp.js';

describe('isRowLabelOnly', () => {
  it('reads a bare instant as nothing but a label', () => {
    expect(isRowLabelOnly('[Oct 26, 2026, 3:45 PM]')).toBe(true);
    expect(isRowLabelOnly('[Oct 26, 2026, 3:45 PM]')).toBe(true); // narrow no-break space before PM
    expect(isRowLabelOnly('[Oct 26, 2026, 3:45 AM UTC]')).toBe(true); // a trailing zone word is allowed
    expect(isRowLabelOnly('[Sep 5, 2026, 9:05 PM]')).toBe(true); // one-digit day and hour
  });

  it('reads an instant plus a subject as nothing but a label', () => {
    expect(isRowLabelOnly('[Sep 5, 2026, 11:05 PM · invoice thread]')).toBe(true);
  });

  it('trims before reading', () => {
    expect(isRowLabelOnly('  [Dec 1, 2026, 9:00 AM]  ')).toBe(true);
    expect(isRowLabelOnly('[Dec 1, 2026, 9:00 AM]\n')).toBe(true);
  });

  it('refuses real words around the label', () => {
    expect(isRowLabelOnly('[Oct 26, 2026, 3:45 PM] and then some words')).toBe(false);
    expect(isRowLabelOnly('hello [Oct 26, 2026, 3:45 PM]')).toBe(false);
  });

  it('refuses a bracket inside the subject', () => {
    expect(isRowLabelOnly('[Oct 26, 2026, 3:45 PM · a [b] c]')).toBe(false);
  });

  it('refuses a different shape', () => {
    expect(isRowLabelOnly('[Oct 26, 2026, 15:45]')).toBe(false); // 24-hour clock
    expect(isRowLabelOnly('[October 26, 2026, 3:45 PM]')).toBe(false); // long month
    expect(isRowLabelOnly('[Oct 26, 2026, 3:45 PM ·x]')).toBe(false); // middle dot without its spacing
  });

  it('a reply that opens with a copied row label keeps only its words, mood marker included', () => {
    const label = '[Nov 21, 2026, 06:40 AM UTC-08:00 · dashboard conversation with the owner]';
    expect(stripLeadingTimeStamp(`${label} On it, checking now.`)).toBe('On it, checking now.');
    expect(stripLeadingTimeStamp(`((mood: warm)) ${label} On it.`)).toBe('((mood: warm)) On it.');
    expect(isRowLabelOnly(label)).toBe(true);
  });

  it('refuses empty and non-string input', () => {
    expect(isRowLabelOnly('')).toBe(false);
    expect(isRowLabelOnly('   ')).toBe(false);
    expect(isRowLabelOnly(null)).toBe(false);
    expect(isRowLabelOnly(undefined)).toBe(false);
  });
});

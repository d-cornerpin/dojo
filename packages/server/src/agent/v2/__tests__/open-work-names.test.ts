// t24: the open-work match must be plural-blind — a word and its English plural name the same work.
// "the invoice job is on my list" names "Send the March invoices" and back, because a singular and its
// plural reduce to the same stem; the old `/(?:es|s)$/` did not (invoices→invoic, invoice→invoice).
import { describe, it, expect } from 'vitest';
import { namesOpenWork } from '../open-work-names.js';

describe('t24: singular and plural of a word name the same open work', () =>
  {
    it('"invoice" names "invoices" both ways', () => {
      expect(namesOpenWork('the invoice job is on my list', ['Send the March invoices'])).toBe(true);
      expect(namesOpenWork('Send the March invoices', ['the invoice job is on my list'])).toBe(true);
    });
    it('the irregular plural stems: license/licenses, process/processes, address/addresses', () => {
      expect(namesOpenWork('the license job is on my list', ['Send the March licenses'])).toBe(true);
      expect(namesOpenWork('the process job is on my list', ['Run the March processes'])).toBe(true);
      expect(namesOpenWork('the address job is on my list', ['Mail the March addresses'])).toBe(true);
    });
    it('"receipts" still names "receipt" (t182 shape is kept)', () => {
      expect(namesOpenWork('the receipts are logged', ['a single receipt on file'])).toBe(true);
      expect(namesOpenWork('a single receipt on file', ['the receipts are logged'])).toBe(true);
    });
    it('a shared ORDINARY word is not naming the work', () => {
      expect(namesOpenWork('the reminder is on my list', ['Set a reminder for the dentist'])).toBe(false);
    });
    it('a shared SHORT word is not naming the work', () => {
      expect(namesOpenWork('the note', ['Write note'])).toBe(false);
    });
    it('an empty title list names nothing', () => {
      expect(namesOpenWork('the invoice is on my list', [])).toBe(false);
    });
    it('a claim with no distinctive word names nothing, even with titles', () => {
      expect(namesOpenWork('the is on my list', ['Send the March invoices now'])).toBe(false);
    });
  });

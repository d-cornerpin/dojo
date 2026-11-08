import { describe, it, expect } from 'vitest';
import { cleanEmailAddress } from '../owner-mailboxes.js';

describe('an owner address is cleaned to one bare email, or none', () => {
  it('keeps an email-shaped entry lowercased and trimmed, and drops the rest', () => {
    expect(['Owner@X.com', ' owner@x.com ', '+15551234567', '', null, undefined, 'not an email', 'a@b', 'x@y.test'].map(cleanEmailAddress))
      .toEqual(['owner@x.com', 'owner@x.com', null, null, null, null, null, null, 'x@y.test']);
  });

  it('rejects a display-name form and a comma-joined list', () => {
    expect(cleanEmailAddress('Ann Lee <ann@x.com>')).toBeNull();
    expect(cleanEmailAddress('a@x.com, b@x.com')).toBeNull();
  });

  it('keeps near-miss addresses distinct (no fuzzy matching), a tagged local part and a multi-label domain', () => {
    expect(cleanEmailAddress('own-er@x.com')).toBe('own-er@x.com');
    expect(cleanEmailAddress('first.last+tag@sub.example.co.uk')).toBe('first.last+tag@sub.example.co.uk');
  });

  it('skips a non-string slipped in by mistake without throwing', () => {
    expect(cleanEmailAddress(42)).toBeNull();
    expect(cleanEmailAddress('  ')).toBeNull();
  });
});

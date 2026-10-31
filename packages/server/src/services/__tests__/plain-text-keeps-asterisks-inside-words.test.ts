// The single-asterisk italic pass opened and closed inside words, so math
// (`2*3*4`), glob patterns (`file*.txt`) and star codes (`*67*`) lost their
// asterisks on the way to SMS. The pass must refuse to open after or close
// before a letter, digit or another star, like the underscore passes do.

import { describe, it, expect } from 'vitest';
import { formatForPlainTextChannel as f } from '../plain-text-format.js';

describe('formatForPlainTextChannel — asterisks inside words survive', () => {
  it('math without spaces keeps its operators', () => {
    expect(f('2*3*4=24')).toBe('2*3*4=24');
  });

  it('glob patterns keep their stars', () => {
    expect(f('file*.txt and doc*.pdf')).toBe('file*.txt and doc*.pdf');
  });

  it('star codes keep their stars', () => {
    expect(f('Call *67*5551234#')).toBe('Call *67*5551234#');
  });

  it('bare products without spaces are left alone', () => {
    expect(f('5*6 and 7*8')).toBe('5*6 and 7*8');
  });
});

describe('formatForPlainTextChannel — spaced stars and real emphasis are untouched', () => {
  it('an asterisk used as a spaced operator is left alone', () => {
    expect(f('2 * 3 * 4')).toBe('2 * 3 * 4');
  });

  it('*hi* still collapses', () => {
    expect(f('*hi*')).toBe('hi');
  });

  it('spaced emphasis still collapses', () => {
    expect(f('a *b* c')).toBe('a b c');
  });

  it('emphasis inside punctuation still collapses', () => {
    expect(f('(*note*)')).toBe('(note)');
  });

  it('bold and italic together still collapse', () => {
    expect(f('**bold** and *it*.')).toBe('bold and it.');
  });
});

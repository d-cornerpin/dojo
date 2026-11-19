// t277 — behavioural tests for the speech sanitizer.
//
// `sanitizeForSpeech` is what every spoken reply passes through (markdown / links /
// code fences / file paths stripped so a TTS engine does not read them out) and
// `StreamingSpeechBuffer` holds back half-finished markdown while a reply streams.
// The logic was previously covered only by `scripts/*.ts` (standalone, not run by
// vitest) and one marker line in marker-ownership.test.ts — the behaviour itself was
// untested. These pins are pure: no mocks, `@dojo/shared` resolves normally.
//
// Expected values measured on v35. A value here that disagrees with what the shipped
// code returns is reported, not "fixed" in text-sanitize.ts.

import { describe, it, expect } from 'vitest';
import { sanitizeForSpeech, StreamingSpeechBuffer } from '../text-sanitize.js';

describe('sanitizeForSpeech — emphasis', () => {
  it('strips bold, italic and triple emphasis', () => {
    expect(sanitizeForSpeech('**bold** and *it* and ***both***')).toBe('bold and it and both');
  });

  it('leaves underscores inside a word, strips underscore emphasis', () => {
    expect(sanitizeForSpeech('snake_case_name and _emph_ word')).toBe('snake_case_name and emph word');
  });

  it('strips strikethrough', () => {
    expect(sanitizeForSpeech('~~gone~~ stays')).toBe('gone stays');
  });
});

describe('sanitizeForSpeech — structure', () => {
  it('strips headers, bullets and numbered lists', () => {
    expect(sanitizeForSpeech('## Heading\n- item one\n* item two\n1. first'))
      .toBe('Heading\nitem one\nitem two\nfirst');
  });

  it('strips a blockquote and collapses an hr line', () => {
    expect(sanitizeForSpeech('> quoted\n---\ntext')).toBe('quoted\n\ntext');
  });

  it('drops a fenced code block, keeping its leading space', () => {
    expect(sanitizeForSpeech('```js\nlet x=1\n```\nafter')).toBe(' code block\nafter');
  });

  it('strips inline code backticks', () => {
    expect(sanitizeForSpeech('use `npm test` ok')).toBe('use npm test ok');
  });
});

describe('sanitizeForSpeech — links and URLs', () => {
  it('keeps link text and drops the URL', () => {
    expect(sanitizeForSpeech('See [the docs](https://x.io/a) now')).toBe('See the docs now');
  });

  it('keeps image alt text, or "image" when there is none', () => {
    expect(sanitizeForSpeech('![chart](http://a/b.png) here')).toBe('chart here');
    expect(sanitizeForSpeech('![](http://a/b.png)')).toBe('image');
  });

  it('collapses a bare URL to "link" and keeps a trailing comma outside the word', () => {
    expect(sanitizeForSpeech('Visit https://example.com/path?q=1, ok')).toBe('Visit link, ok');
  });
});

describe('sanitizeForSpeech — file paths', () => {
  it('reduces an absolute path to its basename', () => {
    expect(sanitizeForSpeech('Open /Users/example/notes/todo.md please')).toBe('Open todo.md please');
  });

  it('reduces a home-relative path with no extension to "file"', () => {
    expect(sanitizeForSpeech('Open ~/Documents/report now.')).toBe('Open file now.');
  });

  it('reduces a bare directory path to "file" and leaves surrounding prose', () => {
    expect(sanitizeForSpeech('at /var/log (see) done')).toBe('at file (see) done');
  });
});

describe('sanitizeForSpeech — mood marker, whitespace, units', () => {
  it('drops the orb mood marker', () => {
    expect(sanitizeForSpeech('((mood: happy)) Hello there')).toBe('Hello there');
  });

  it('collapses runs of spaces and tabs', () => {
    expect(sanitizeForSpeech('a  b\t\tc   ')).toBe('a b c');
  });

  it('expands temperature and currency into speakable forms', () => {
    expect(sanitizeForSpeech('Temp is 72°F and $5.99'))
      .toBe('Temp is 72 degrees Fahrenheit and 5 dollars and 99 cents');
  });
});

describe('StreamingSpeechBuffer — holds unbalanced markdown', () => {
  it('holds a partial bold until it balances, then flushes it', () => {
    const buf = new StreamingSpeechBuffer();
    expect(buf.push('Hey **bold')).toBe('');
    expect(buf.push(' text**! Next')).toBe('Hey bold text!');
    expect(buf.flushUnsafe()).toBe('Next');
    expect(buf.flushUnsafe()).toBe('');
  });

  it('flushes a balanced sentence, leaving the remainder for flushUnsafe', () => {
    const buf = new StreamingSpeechBuffer();
    expect(buf.push('snake_case here. Then')).toBe('snake_case here.');
    expect(buf.flushUnsafe()).toBe('Then');
  });

  it('holds an unclosed fence until its closing fence arrives', () => {
    const buf = new StreamingSpeechBuffer();
    expect(buf.push('```code. here')).toBe('');
    expect(buf.push('``` after. ')).toBe(' code block after.');
  });
});

describe('StreamingSpeechBuffer — clause-level flushing', () => {
  it('splits at a conjunction so the next clause begins with it', () => {
    const buf = new StreamingSpeechBuffer();
    expect(
      buf.pushClauses('I went to the store this morning and bought some milk, then I came home. '),
    ).toEqual(['I went to the store this morning', 'and bought some milk, then I came home.']);
  });

  it('merges a clause shorter than the 30-char minimum into the next', () => {
    const buf = new StreamingSpeechBuffer();
    expect(
      buf.pushClauses('Short one. Another thing that is long enough to flush now! tail'),
    ).toEqual(['Short one. Another thing that is long enough to flush now!']);
    expect(buf.flushUnsafe()).toBe('tail');
  });
});

describe('StreamingSpeechBuffer — empty buffer', () => {
  it('flushUnsafe on an empty buffer is "", and pushing "" is ""', () => {
    const buf = new StreamingSpeechBuffer();
    expect(buf.flushUnsafe()).toBe('');
    expect(buf.push('')).toBe('');
  });
});

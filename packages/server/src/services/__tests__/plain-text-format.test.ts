// formatForPlainTextChannel turns outbound markdown into SMS/iMessage text.
// Two bugs mangled ordinary prose: the strikethrough pass used `$2` on a regex
// with one capture group (so the inner text became the literal "$2"), and the
// emphasis passes treated any marker pair on a line as emphasis, so file names
// and arithmetic were eaten. These tests pin the markdown-flanked behavior.

import { describe, it, expect } from 'vitest';
import { formatForPlainTextChannel } from '../plain-text-format.js';

describe('formatForPlainTextChannel — strikethrough keeps its inner text', () => {
  it('~~gone~~ leaves the word, not a literal "$2"', () => {
    expect(formatForPlainTextChannel('this is ~~gone~~ ok')).toBe('this is gone ok');
  });
});

describe('formatForPlainTextChannel — emphasis is markdown-flanked, not greedy', () => {
  it('underscores inside a word (file names) are left alone', () => {
    expect(formatForPlainTextChannel('see my_file_name and other_file_name')).toBe(
      'see my_file_name and other_file_name',
    );
  });

  it('a snake_case word is unchanged', () => {
    expect(formatForPlainTextChannel('snake_case_word')).toBe('snake_case_word');
  });

  it('an asterisk used as an operator is left alone', () => {
    expect(formatForPlainTextChannel('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(formatForPlainTextChannel('a * b')).toBe('a * b');
  });

  it('real emphasis still collapses', () => {
    expect(formatForPlainTextChannel('**bold** and _it_ and *it2*')).toBe('bold and it and it2');
  });
});

describe('formatForPlainTextChannel — the rest of the formatter is untouched', () => {
  it('a markdown link becomes "text (url)"', () => {
    expect(formatForPlainTextChannel('[docs](https://x.test)')).toBe('docs (https://x.test)');
  });

  it('a bullet becomes a real bullet glyph', () => {
    expect(formatForPlainTextChannel('- item')).toBe('• item');
  });

  it('a fenced code block loses its fences but keeps the code', () => {
    expect(formatForPlainTextChannel('```\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('an empty string returns an empty string', () => {
    expect(formatForPlainTextChannel('')).toBe('');
  });

  it('is idempotent on a plain sentence (twice equals once)', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog.';
    expect(formatForPlainTextChannel(sentence)).toBe(sentence);
    expect(formatForPlainTextChannel(formatForPlainTextChannel(sentence))).toBe(sentence);
  });
});

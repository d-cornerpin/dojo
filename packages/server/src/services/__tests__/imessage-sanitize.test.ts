// Pure unit tests for the outbound-iMessage markdown cleaner. Every row is an
// exact input -> output pair; the fenced-block rows pin the fence being stripped
// before the inline-code step eats its backticks, and the asterisk rows pin that
// arithmetic like "5 * 3 * 2" is never read as emphasis.

import { describe, it, expect } from 'vitest';
import { sanitizeForIMessage } from '../imessage-sanitize.js';

describe('sanitizeForIMessage', () => {
  const rows: Array<[string, string, string]> = [
    ['fenced code keeps its code; the fence and language word go', 'Run:\n```js\nconsole.log(1)\n```\nthen done', 'Run:\nconsole.log(1)\nthen done'],
    ['fence without a language word', '```\nplain block\n```', 'plain block'],
    ['multiplication with spaces keeps its asterisks', '5 * 3 * 2 = 30', '5 * 3 * 2 = 30'],
    ['tight multiplication keeps its asterisks', '2*3*4', '2*3*4'],
    ['lone asterisk stays', 'price is $5 * qty', 'price is $5 * qty'],
    ['bold and italic', '**bold** and *it* ok', 'bold and it ok'],
    ['italic mid-sentence', 'a *b* c', 'a b c'],
    ['italic at line start', '*start italic* word', 'start italic word'],
    ['asterisk inside bold stays', '**bold with * inside**', 'bold with * inside'],
    ['inline code', 'use `npm test` now', 'use npm test now'],
    ['header is stripped', '# Title\ntext', 'Title\ntext'],
    ['link keeps its text', '[docs](https://x.test) here', 'docs here'],
    ['literal backslash-n becomes a real newline', 'line1\\nline2', 'line1\nline2'],
    ['three or more newlines collapse to two', 'a\n\n\n\nb', 'a\n\nb'],
    ['outer whitespace trimmed', '  hi  ', 'hi'],
    ['snake_case does not block a real italic', 'snake_case and *star at end*', 'snake_case and star at end'],
  ];

  for (const [what, input, expected] of rows) {
    it(what, () => {
      expect(sanitizeForIMessage(input)).toBe(expected);
    });
  }
});

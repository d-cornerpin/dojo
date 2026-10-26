// ════════════════════════════════════════════════════════════════════════════════════════
// authoredInputLines NEVER CUTS AN EMOJI IN HALF (the summary writer's own input).
//
// When a span does not fit the summariser's budget, `fitInputToBudget` hands every authored text a
// share below 1, and `authoredInputLines` cut each one to that share's raw UTF-16 code-unit count
// (`value.slice(0, kept)`). An emoji is two code units, so a cut between them left a lone high
// surrogate — a malformed string — in the text the summariser was sent, the same defect
// `resultForSummary` / `aroundTheGap` already guard against with `charBoundary`. The cut now snaps
// back to the character boundary before it, the way a tool result already does.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import { authoredInputLines } from '../summary-authored-text.js';

/** A string is malformed when a high surrogate has no following low one, or a low one has no high. */
const hasLoneSurrogate = (s: string) =>
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe('1 — a cut that would land inside an emoji snaps back to the character boundary', () => {
  it('keeps the emoji whole and counts the not-shown text from the boundary', () => {
    const lines = authoredInputLines('note_add', { text: '😀😀😀' }, 0.5);
    expect(lines).toEqual(['  text: 😀 [... 4 more chars of this text are not shown here]']);
    expect(hasLoneSurrogate(lines[0])).toBe(false);
  });
});

describe('2 — a whole text (keep = 1) is returned untouched', () => {
  it('the emoji row passes through intact', () => {
    expect(authoredInputLines('note_add', { text: '😀😀😀' }, 1)).toEqual(['  text: 😀😀😀']);
  });
});

describe('3 — an ASCII text cuts exactly where it did', () => {
  it('a boundary of a plain character is itself', () => {
    expect(authoredInputLines('note_add', { note: 'abcdef' }, 0.5))
      .toEqual(['  note: abc [... 3 more chars of this text are not shown here]']);
  });
});

describe('4 — a cut that would land inside the FIRST emoji keeps nothing and says so', () => {
  it('no leading space, no lone surrogate, the whole text counted as not shown', () => {
    const lines = authoredInputLines('note_add', { text: '😀😀😀' }, 0.17);
    expect(lines).toEqual(['  text: [... 6 more chars of this text are not shown here]']);
    expect(hasLoneSurrogate(lines[0])).toBe(false);
  });
});

describe('5 — the skips are unchanged', () => {
  it('a withheld-prefix tool carries no authored text', () => {
    expect(authoredInputLines('credential_set', { text: 'x' }, 1)).toEqual([]);
  });

  it('a non-authored field carries no text', () => {
    expect(authoredInputLines('note_add', { path: 'x' }, 1)).toEqual([]);
  });

  it('a blank value carries no text', () => {
    expect(authoredInputLines('note_add', { text: '   ' }, 1)).toEqual([]);
  });

  it('a non-object input carries no text', () => {
    expect(authoredInputLines('note_add', null, 1)).toEqual([]);
    expect(authoredInputLines('note_add', 'str', 1)).toEqual([]);
    expect(authoredInputLines('note_add', [], 1)).toEqual([]);
  });
});

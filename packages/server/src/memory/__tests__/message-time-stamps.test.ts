// ════════════════════════════════════════
// Per-message time stamps (time-awareness, owner ruled 2026-07-16)
//
// Pins the two properties the feature depends on:
//   1. DETERMINISM: a given created_at renders byte-identical every time
//      (the append-only cache property; relative forms would churn).
//   2. SCOPE: only plain-text content is stamped; tool/attachment array
//      content and missing timestamps pass through untouched.
// ════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { renderMessageTimeStamp, stampTextContent } from '../assembler.js';

describe('renderMessageTimeStamp', () => {
  it('renders the SQLite shape (UTC, no marker) deterministically', () => {
    const a = renderMessageTimeStamp('2026-07-16 18:41:00');
    const b = renderMessageTimeStamp('2026-07-16 18:41:00');
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(a).toMatch(/^\[[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2} (AM|PM)\]$/);
  });

  it('renders the ISO shape identically to its SQLite equivalent', () => {
    expect(renderMessageTimeStamp('2026-07-16T18:41:00.000Z')).toBe(
      renderMessageTimeStamp('2026-07-16 18:41:00'),
    );
  });

  it('always includes the date and year (no today/yesterday relativity)', () => {
    const s = renderMessageTimeStamp('2025-12-31 08:05:00');
    expect(s).toContain('2025');
    expect(s).toMatch(/Dec 3[01]/); // local date near the UTC date, tz-dependent day
  });

  it('a past instant renders the same regardless of current DST state', () => {
    // A January (standard-time) instant and a July (daylight-time) instant
    // each have ONE fixed local rendering; re-rendering never shifts them.
    const winter = renderMessageTimeStamp('2026-01-10 20:00:00');
    expect(renderMessageTimeStamp('2026-01-10 20:00:00')).toBe(winter);
    const summer = renderMessageTimeStamp('2026-07-10 20:00:00');
    expect(renderMessageTimeStamp('2026-07-10 20:00:00')).toBe(summer);
  });

  it('returns null for missing or garbage timestamps', () => {
    expect(renderMessageTimeStamp(null)).toBeNull();
    expect(renderMessageTimeStamp(undefined)).toBeNull();
    expect(renderMessageTimeStamp('not a date')).toBeNull();
  });
});

describe('stampTextContent', () => {
  it('prefixes plain-text content with the stamp', () => {
    const out = stampTextContent('hey, quick question', '2026-07-16 18:41:00');
    expect(typeof out).toBe('string');
    expect(out as string).toMatch(/^\[.+\] hey, quick question$/);
  });

  it('leaves array content (tool blocks / attachments) untouched', () => {
    const blocks = [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }];
    // Same reference back: structured content is never wrapped or mutated.
    expect(stampTextContent(blocks as never, '2026-07-16 18:41:00')).toBe(blocks);
  });

  it('leaves text untouched when the timestamp is missing or unparseable', () => {
    expect(stampTextContent('hello', null)).toBe('hello');
    expect(stampTextContent('hello', 'garbage')).toBe('hello');
  });

  it('leaves empty text untouched', () => {
    expect(stampTextContent('', '2026-07-16 18:41:00')).toBe('');
  });
});

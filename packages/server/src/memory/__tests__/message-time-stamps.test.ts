// ════════════════════════════════════════
// Per-message time stamps (time-awareness, owner ruled 2026-07-16)
//
// Pins the properties the feature depends on:
//   1. DETERMINISM: a given created_at renders byte-identical every time
//      (the append-only cache property; relative forms would churn).
//   2. SCOPE: only plain-text content is stamped; tool/attachment array
//      content and missing timestamps pass through untouched.
//   3. THE BYTES THEMSELVES (PHASE-1 T6b, 2026-07-27) — see the block below.
// ════════════════════════════════════════

// PHASE-1 T6b — THE STAMP PIN, and why it is bytes and not a shape.
//
// This stamp rides INTO THE MODEL PAYLOAD: `assembler.ts` prefixes it onto every
// plain-text row's content, so its bytes are part of the cached prefix of every
// conversation on every provider. Non-negotiable #10 says a prefix change is a
// reviewed re-blessing, never silent — and the assembled-array golden that would
// catch a drift here is PHASE-3 T1, which does not exist yet. Until it does, THIS
// FILE is the substitute: it pins the exact rendered bytes for fixed inputs, so a
// formatting change has to walk past a failing test that says what it costs.
//
// T6b converts `messages.created_at` from TEXT to epoch-ms INTEGER. The pin is
// what makes that flip provable rather than argued: the cross-format block below
// asserts that the SAME instant renders IDENTICALLY whether it arrives as the
// SQLite TEXT form or as an epoch-ms number. It was RED before the renderer was
// widened (a number has no `.trim()`, and the declared type is `string`, so
// typecheck could not see it — the failure would have been a thrown TypeError
// inside the assembler, i.e. every turn).
//
// Timezone: the renderer formats in the BOX's local zone, so absolute bytes are
// only meaningful against a fixed zone. `TZ` is pinned to UTC for this file
// before the renderer is first called, and the pin asserts that it took effect
// rather than assuming it.

process.env.TZ = 'UTC';

import { describe, it, expect } from 'vitest';
import { renderMessageTimeStamp, stampTextContent } from '../assembler.js';

// The instants the pin is written against, each as the two forms the platform can
// hand the renderer: the SQLite TEXT shape it stored before T6b, and the epoch-ms
// INTEGER it stores after. `epochMs` is second-granular on purpose — migration 131
// converts with `strftime('%s', …) * 1000`, exactly as migration 127 already did
// for `sent_at`, so no row gains sub-second precision it never had.
const PINNED = [
  { text: '2026-07-16 18:41:00', epochMs: 1784227260000, bytes: '[Jul 16, 2026, 06:41 PM]' },
  { text: '2026-01-10 20:00:00', epochMs: 1768075200000, bytes: '[Jan 10, 2026, 08:00 PM]' },
  { text: '2025-12-31 08:05:00', epochMs: 1767168300000, bytes: '[Dec 31, 2025, 08:05 AM]' },
  { text: '2026-07-16 00:00:00', epochMs: 1784160000000, bytes: '[Jul 16, 2026, 12:00 AM]' },
  { text: '2026-07-16 12:00:00', epochMs: 1784203200000, bytes: '[Jul 16, 2026, 12:00 PM]' },
];

describe('the stamp pin (T6b) — exact bytes into the model payload', () => {
  it('the pinned timezone actually took effect (the pin means nothing otherwise)', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
  });

  it('renders the pinned bytes for the SQLite TEXT form', () => {
    for (const p of PINNED) {
      expect(renderMessageTimeStamp(p.text)).toBe(p.bytes);
    }
  });

  // THE FLIP PIN. This is the assertion T6b's storage conversion has to satisfy:
  // the same instant, arriving in the post-conversion form, produces the same
  // prompt bytes as before. RED before the renderer was widened.
  it('renders BYTE-IDENTICAL bytes for the epoch-ms INTEGER form', () => {
    for (const p of PINNED) {
      expect(renderMessageTimeStamp(p.epochMs as unknown as string)).toBe(p.bytes);
      expect(renderMessageTimeStamp(p.epochMs as unknown as string))
        .toBe(renderMessageTimeStamp(p.text));
    }
  });

  it('stamps the payload row with the pinned bytes, both forms', () => {
    const p = PINNED[0]!;
    expect(stampTextContent('hey, quick question', p.text))
      .toBe('[Jul 16, 2026, 06:41 PM] hey, quick question');
    expect(stampTextContent('hey, quick question', p.epochMs as unknown as string))
      .toBe('[Jul 16, 2026, 06:41 PM] hey, quick question');
  });

  // The epoch-ms form must not be confused with the OTHER two numbers a caller could
  // plausibly hold: epoch SECONDS, and a stringified epoch. Both are rejected rather
  // than rendered as some far-off date, so a mistake is visible instead of plausible.
  it('rejects the forms that are NOT epoch-ms rather than rendering a wrong date', () => {
    expect(renderMessageTimeStamp(1784227260 as unknown as string)).toBeNull();
    expect(renderMessageTimeStamp(0 as unknown as string)).toBeNull();
    expect(renderMessageTimeStamp(-1 as unknown as string)).toBeNull();
  });
});

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

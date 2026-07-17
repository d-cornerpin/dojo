// ════════════════════════════════════════
// Leading time-stamp mimicry strip (2026-07-16)
//
// Pins the fix for the observed production line "[Jul 16, 2026, 10:58 PM]
// Saved." emitted the night the per-message stamps shipped: a leading run of
// assembler-format bracket-times is context markup and must be stripped from
// model output at the persist source; genuine bracketed content survives.
// ════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { stripLeadingTimeStamp } from '../classifiers/output.js';

describe('stripLeadingTimeStamp', () => {
  it('strips the observed production shape', () => {
    expect(stripLeadingTimeStamp('[Jul 16, 2026, 10:58 PM] Saved.')).toBe('Saved.');
  });

  it('strips a doubled prefix', () => {
    expect(stripLeadingTimeStamp('[Jul 16, 2026, 10:58 PM] [Jul 16, 2026, 10:59 PM] Done.')).toBe('Done.');
  });

  it('tolerates the narrow no-break space Intl inserts before AM/PM', () => {
    expect(stripLeadingTimeStamp('[Jul 16, 2026, 10:58 PM] Saved.')).toBe('Saved.');
  });

  it('leaves mid-sentence bracket times alone', () => {
    const s = 'Your flight is at [Jul 18, 2026, 9:00 AM] per the confirmation.';
    expect(stripLeadingTimeStamp(s)).toBe(s);
  });

  it('leaves ordinary leading brackets alone', () => {
    expect(stripLeadingTimeStamp('[URGENT] the build is red')).toBe('[URGENT] the build is red');
    expect(stripLeadingTimeStamp('[no-reply]')).toBe('[no-reply]');
  });

  it('handles a stamp-only message (becomes empty for the caller to null out)', () => {
    expect(stripLeadingTimeStamp('[Jul 16, 2026, 10:58 PM] ').trim()).toBe('');
  });
});

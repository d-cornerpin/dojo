import { describe, it, expect } from 'vitest';
import { stripLeadingTimeStamp, renderMessageTimeStamp } from '../../../memory/message-stamp.js';

describe('stripLeadingTimeStamp', () => {
  it('strips the observed production shape', () => {
    expect(stripLeadingTimeStamp('[Jul 16, 2026, 10:58 PM] Saved.')).toBe('Saved.');
  });

  it('strips the stamp the engine writes today, offset included, and keeps clock-like text that is no stamp', () => {
    const stamp = renderMessageTimeStamp(Date.UTC(2026, 10, 14, 15, 5))!;
    expect(stripLeadingTimeStamp(`${stamp} Here you go.`)).toBe('Here you go.');
    expect(stripLeadingTimeStamp('9:30 AM works.')).toBe('9:30 AM works.');
    expect(stripLeadingTimeStamp('[2026-11-15] the plan')).toBe('[2026-11-15] the plan');
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

  it('sees past a leading mood marker and keeps the marker', () => {
    expect(stripLeadingTimeStamp('((mood: warm)) [Jul 16, 2026, 10:58 PM] Done.')).toBe('((mood: warm)) Done.');
  });
});

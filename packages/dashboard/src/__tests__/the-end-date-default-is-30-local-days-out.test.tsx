// The "On" end option defaulted repeatEndValue to `new Date(Date.now() + 30 * 86400000)
// .toISOString().slice(0, 10)`, which slices the UTC day, not the local one: at 11:30pm on
// Jan 31 in Los Angeles the owner saw "2026-03-03" in the date field instead of "2026-03-02",
// and east of UTC after local midnight it lands a day early. `localDateDaysFromNow` builds
// the YYYY-MM-DD from this computer's local calendar fields instead.
import { describe, it, expect } from 'vitest';
import { localDateDaysFromNow } from '../components/TaskScheduleForm';

/** A local wall-clock moment from numeric parts, set field by field. */
const local = (y: number, mo: number, d: number, h: number, mi: number): Date => {
  const x = new Date(0);
  x.setFullYear(y, mo, d);
  x.setHours(h, mi, 0, 0);
  return x;
};

describe('the end-date default is 30 local days out', () => {
  it('30 days from 11:30pm on Jan 31 2026 is Mar 2, not the next UTC day', () => {
    expect(localDateDaysFromNow(30, local(2026, 0, 31, 23, 30))).toBe('2026-03-02');
  });

  it('30 days from 12:05am on Dec 15 2026 is Jan 14 2027', () => {
    expect(localDateDaysFromNow(30, local(2026, 11, 15, 0, 5))).toBe('2027-01-14');
  });

  it('0 days is the same local date on this computer', () => {
    expect(localDateDaysFromNow(0, local(2026, 4, 9, 23, 59))).toBe('2026-05-09');
  });
});

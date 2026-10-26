// Leftover scratch: used to eyeball-confirm the thousands-comma bug before
// text-normalize-currency.test.ts was written. The task's permitted command set
// (vitest / tsc / git diff|status|log) can't delete a file, and an empty .test.ts
// makes vitest fail with "No test suite found", so it's reduced to a single
// no-op test to keep the suite green. The real coverage lives in
// text-normalize-currency.test.ts.
import { describe, it, expect } from 'vitest';

describe('scratch confirm (leftover, inert)', () => {
  it('is a no-op', () => {
    expect(true).toBe(true);
  });
});

// The owner flag is never handed to another entry because the list lost its owner: a list with no starred
// entry has no owner. (A legacy bare-address list keeps its documented first-entry meaning.)
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('no db'); }, getDbPath: () => ':memory:' }));

import { parseSafeSenders } from '../safe-senders.js';

const entry = (address: string, is_primary: boolean) => ({ address, name: address, is_primary, sharing_level: 'dont_overshare' });

describe('parseSafeSenders', () => {
  it('leaves a list with no starred entry without an owner', () => {
    const out = parseSafeSenders(JSON.stringify([entry('a@x.test', false), entry('b@x.test', false)]));
    expect(out.map((s) => s.is_primary)).toEqual([false, false]);
  });
  it('keeps the entry that is starred', () => {
    const out = parseSafeSenders(JSON.stringify([entry('a@x.test', false), entry('b@x.test', true)]));
    expect(out.map((s) => s.is_primary)).toEqual([false, true]);
  });
  it('still reads a legacy bare-address list as first-entry owner', () => {
    expect(parseSafeSenders(JSON.stringify(['a@x.test', 'b@x.test'])).map((s) => s.is_primary)).toEqual([true, false]);
  });
});

// Two named threads are two threads: the short thread key takes its eight characters from the id with the
// shared `thread-` prefix removed, so ids `makeThreadId` mints never share a key, and a marker written with
// the older front slice still resolves to its own thread through `a2aThreadTokenMatches`.
import { describe, it, expect } from 'vitest';
import {
  a2aThreadShort, a2aThreadShortLegacy, a2aThreadTokenMatches, parseA2AThreadShort,
  A2A_THREAD_SHORT_LENGTH,
} from '@dojo/shared';

/** Two ids of the shape `makeThreadId` produces: `thread-<base36 hash>-<seed>`, whose hashes begin with the
 *  same character, so their front slices are equal. */
const THREAD_A = 'thread-1kq3za-review-01';
const THREAD_B = 'thread-1wtp4m-review-02';

describe('the thread key', () => {
  it('two distinct named threads do not share a key', () => {
    expect(a2aThreadShortLegacy(THREAD_A), 'the front slices are equal').toBe(a2aThreadShortLegacy(THREAD_B));
    expect(a2aThreadShortLegacy(THREAD_A)).toBe('thread-1');
    expect(a2aThreadShort(THREAD_A)).not.toBe(a2aThreadShort(THREAD_B));
    expect(a2aThreadShort(THREAD_A)).toBe('1kq3za-r');
    expect(a2aThreadShort(THREAD_B)).toBe('1wtp4m-r');
  });

  it('the key is exactly A2A_THREAD_SHORT_LENGTH characters', () => {
    for (const t of [THREAD_A, THREAD_B]) expect(a2aThreadShort(t).length).toBe(A2A_THREAD_SHORT_LENGTH);
  });

  it('a UUID-shaped thread id keeps its front eight characters', () => {
    const uuid = '9f2c1a04-7b3e-4f21-a8d5-6c0e1b2d3f44';
    expect(a2aThreadShort(uuid)).toBe(a2aThreadShortLegacy(uuid));
    expect(a2aThreadShort(uuid)).toBe('9f2c1a04');
  });

  it('a legacy marker still resolves; a current key never matches another thread', () => {
    const legacyToken = a2aThreadShortLegacy(THREAD_A);
    expect(a2aThreadTokenMatches(legacyToken, THREAD_A)).toBe(true);
    expect(a2aThreadTokenMatches(legacyToken, THREAD_B), 'a legacy token carries no more than it ever did').toBe(true);
    expect(a2aThreadTokenMatches(a2aThreadShort(THREAD_A), THREAD_B)).toBe(false);
    expect(a2aThreadTokenMatches(a2aThreadShort(THREAD_A), THREAD_A)).toBe(true);
  });

  it('an empty or absent token matches nothing', () => {
    expect(a2aThreadTokenMatches('', THREAD_A)).toBe(false);
    expect(a2aThreadTokenMatches(a2aThreadShort(THREAD_A), '')).toBe(false);
  });

  it('`parseA2AThreadShort` reads whatever the marker carries', () => {
    expect(parseA2AThreadShort(`[A2A:QUESTION thread:${a2aThreadShort(THREAD_A)} from:Peer] hi`)).toBe('1kq3za-r');
    expect(parseA2AThreadShort(`[A2A:QUESTION thread:${a2aThreadShortLegacy(THREAD_A)} from:Peer] hi`)).toBe('thread-1');
    expect(parseA2AThreadShort('no marker here')).toBeNull();
  });
});

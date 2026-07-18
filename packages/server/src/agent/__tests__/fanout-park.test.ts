// Fan-out (multi-thread) park encoding (2026-07-17).
//
// Pure-function tests for the owner-question park key that lets ONE owner ask join
// across N>1 delegated A2A threads. The full close-the-loop + join lifecycle needs
// DB + agent fixtures; those run in integration. Here we lock the encode/decode round
// trip so the writer (loop.ts, via buildOwnerParkKey) and the reader (a2a-transport
// close-the-loop, via parseMultiPark) can never drift out of sync, and so the single-
// vs-multi boundary (which decides whether the deterministic engine relay still fires)
// stays exactly where it is.

import { describe, it, expect } from 'vitest';
import { buildOwnerParkKey, parseMultiPark, isThreadSafeForMultiPark } from '../a2a-transport.js';

const T1 = '7c4fea82-1111-4aaa-8bbb-000000000001';
const T2 = '85242783-2222-4aaa-8bbb-000000000002';
const T3 = 'thread-abc123-deadbeef'; // makeThreadId shape (also separator-free)

describe('buildOwnerParkKey', () => {
  it('returns null for no threads (caller falls back to the prose regex)', () => {
    expect(buildOwnerParkKey([])).toBeNull();
  });

  it('one thread stays today\'s single park:<full-thread> (deterministic relay preserved)', () => {
    expect(buildOwnerParkKey([T1])).toBe(`park:${T1}`);
    // NOT a multi key: parseMultiPark must reject it so the single-park path runs.
    expect(parseMultiPark(`park:${T1}`)).toBeNull();
  });

  it('two+ threads encode a multi park:~<full>#<remaining> with remaining == full initially', () => {
    const key = buildOwnerParkKey([T1, T2, T3]);
    expect(key).toBe(`park:~${T1}|${T2}|${T3}#${T1}|${T2}|${T3}`);
    const parsed = parseMultiPark(key!);
    expect(parsed).not.toBeNull();
    expect(parsed!.full).toEqual([T1, T2, T3]);
    expect(parsed!.remaining).toEqual([T1, T2, T3]);
  });

  it('dedups repeated threads and preserves hand-off order', () => {
    expect(buildOwnerParkKey([T1, T1])).toBe(`park:${T1}`); // collapses to single
    const key = buildOwnerParkKey([T1, T2, T1]);
    expect(parseMultiPark(key!)!.full).toEqual([T1, T2]);
  });

  it('drops threads carrying an encoding separator; single-parks when <2 survive', () => {
    // A pathological thread id containing a separator cannot be multi-encoded safely.
    const bad = 'thread|with#sep~s';
    expect(isThreadSafeForMultiPark(bad)).toBe(false);
    expect(isThreadSafeForMultiPark(T1)).toBe(true);
    // one safe + one unsafe -> single park on the safe survivor (never a corrupt key)
    expect(buildOwnerParkKey([bad, T1])).toBe(`park:${T1}`);
    // two safe + one unsafe -> multi on the two safe only
    const key = buildOwnerParkKey([T1, bad, T2]);
    expect(parseMultiPark(key!)!.full).toEqual([T1, T2]);
  });
});

describe('parseMultiPark round-trip', () => {
  it('parses a shrunk remaining set (mid-join)', () => {
    const key = `park:~${T1}|${T2}|${T3}#${T2}`; // T1 and T3 already landed, T2 outstanding
    const parsed = parseMultiPark(key);
    expect(parsed!.full).toEqual([T1, T2, T3]);
    expect(parsed!.remaining).toEqual([T2]);
  });

  it('parses an empty remaining set (all landed) as remaining: []', () => {
    const key = `park:~${T1}|${T2}#`;
    const parsed = parseMultiPark(key);
    expect(parsed!.full).toEqual([T1, T2]);
    expect(parsed!.remaining).toEqual([]);
  });

  it('rejects non-multi keys (single park, relayed, engine sentinels)', () => {
    expect(parseMultiPark(`park:${T1}`)).toBeNull();
    expect(parseMultiPark(`relayed:${T1}`)).toBeNull();
    expect(parseMultiPark('engine')).toBeNull();
    expect(parseMultiPark('relayed:~a|b')).toBeNull(); // consumed multi is not an OPEN park
  });
});

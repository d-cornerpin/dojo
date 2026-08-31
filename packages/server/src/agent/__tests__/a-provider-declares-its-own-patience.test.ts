// ════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T64b — A PROVIDER DECLARES ITS OWN PATIENCE.
//
// ── THE OWNER'S INCIDENT (2026-08-31) ──
// His local DeepSeek V4 box times out during PROMPT PROCESSING. A hosted API starts
// emitting tokens within a second or two of accepting the request; a local server on
// consumer hardware reads a 35k-character prompt first, and on a long one that read alone
// legitimately runs past 90 seconds before token 1 exists. The stream never stalled — it had
// not started, and the first-chunk bound cannot tell those apart because it is a constant.
//
// ── WHAT HEAD DID, PINNED BELOW BEFORE ANYTHING MOVED ──
// `STREAM_FIRST_CHUNK_TIMEOUT_MS` / `STREAM_IDLE_TIMEOUT_MS` are module constants, and
// `makeStreamWatchdog` has taken both as parameters since it was written — the seam existed
// and nothing on any call path ever passed anything but the defaults. `t64b-red-1` is that
// state: the numbers, and the fact that a provider row had nowhere to say otherwise.
//
// ── THE RULE THIS FILE IS ──
//  1. A provider may DECLARE its own patience, and a declaration is HONOURED verbatim.
//  2. NULL means "exactly today's constants" — not a re-derivation, the same two numbers.
//     Every provider that exists declares nothing, so every provider that exists is
//     byte-identical. That is the control, and it is asserted object-for-object.
//  3. A stored value the reader cannot trust (zero, negative, fractional, out of bounds,
//     not a number at all) is NOT a declaration: it falls back to the default and never
//     throws. Same conservatism `contractForModel` promises for an unrecognised dialect.
//  4. The bounds the reader trusts and the bounds the write door enforces are ONE pair of
//     constants, so a storable declaration and an honoured one cannot drift apart. (The
//     T63 `BEHAVES_LIKE_PROFILES` precedent, applied to numbers.)
//  5. The two bounds are INDEPENDENT: declaring patience for the first token says nothing
//     about how long a mid-stream silence may run, and vice versa.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  makeStreamWatchdog,
  STREAM_FIRST_CHUNK_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
} from '../model.js';
import {
  resolveStreamPatience,
  STREAM_PATIENCE_MIN_MS,
  STREAM_PATIENCE_MAX_MS,
} from '../stream-patience.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('T64b — what HEAD bounded a stream by, pinned', () => {
  it('t64b-red-1: the two constants are the numbers the owner ran into', () => {
    expect(STREAM_FIRST_CHUNK_TIMEOUT_MS).toBe(90_000);
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(60_000);
  });

  it('t64b-red-2: a provider that declares nothing gets exactly those two numbers', () => {
    expect(resolveStreamPatience({ firstChunkTimeoutMs: null, streamIdleTimeoutMs: null }))
      .toEqual({ firstChunkMs: STREAM_FIRST_CHUNK_TIMEOUT_MS, idleMs: STREAM_IDLE_TIMEOUT_MS });
  });
});

describe('T64b — the declaration is the knob', () => {
  it('a declared first-chunk bound is honoured verbatim', () => {
    expect(resolveStreamPatience({ firstChunkTimeoutMs: 600_000, streamIdleTimeoutMs: null }))
      .toEqual({ firstChunkMs: 600_000, idleMs: STREAM_IDLE_TIMEOUT_MS });
  });

  it('a declared idle bound is honoured verbatim, and says nothing about the first', () => {
    expect(resolveStreamPatience({ firstChunkTimeoutMs: null, streamIdleTimeoutMs: 300_000 }))
      .toEqual({ firstChunkMs: STREAM_FIRST_CHUNK_TIMEOUT_MS, idleMs: 300_000 });
  });

  it('both declared are both honoured', () => {
    expect(resolveStreamPatience({ firstChunkTimeoutMs: 420_000, streamIdleTimeoutMs: 120_000 }))
      .toEqual({ firstChunkMs: 420_000, idleMs: 120_000 });
  });

  it('the exact bounds are legal on both ends', () => {
    expect(resolveStreamPatience({
      firstChunkTimeoutMs: STREAM_PATIENCE_MIN_MS,
      streamIdleTimeoutMs: STREAM_PATIENCE_MAX_MS,
    })).toEqual({ firstChunkMs: STREAM_PATIENCE_MIN_MS, idleMs: STREAM_PATIENCE_MAX_MS });
  });

  it('the bounds are the pair the plan named: ten seconds to thirty minutes', () => {
    expect(STREAM_PATIENCE_MIN_MS).toBe(10_000);
    expect(STREAM_PATIENCE_MAX_MS).toBe(30 * 60_000);
  });
});

describe('T64b — a stored value that is not a coherent bound is not a declaration', () => {
  // The reader's rule is NOT the write door's rule, and the difference is the point. The door
  // refuses anything under ten seconds because that floor is a kindness to the person typing
  // (`60` meant as seconds must not become sixty milliseconds). The reader refuses only
  // INCOHERENCE — a "bound" that cannot bound anything — because a row can arrive from a
  // hand-edited DB, a restored backup or a future writer, and quietly substituting 90 s for a
  // number somebody deliberately put there would be the reader overruling the database with
  // no signal that it had. Everything the door can store is inside what the reader honours,
  // so storable still implies honourable.
  const junk: Array<[string, unknown]> = [
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1_500.5],
    ['above the ceiling', STREAM_PATIENCE_MAX_MS + 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '600000'],
    ['undefined', undefined],
  ];

  for (const [label, value] of junk) {
    it(`${label} falls back to the default and never throws`, () => {
      expect(resolveStreamPatience({
        firstChunkTimeoutMs: value as number | null,
        streamIdleTimeoutMs: value as number | null,
      })).toEqual({ firstChunkMs: STREAM_FIRST_CHUNK_TIMEOUT_MS, idleMs: STREAM_IDLE_TIMEOUT_MS });
    });
  }

  it('a whole missing row resolves to the defaults', () => {
    expect(resolveStreamPatience(undefined))
      .toEqual({ firstChunkMs: STREAM_FIRST_CHUNK_TIMEOUT_MS, idleMs: STREAM_IDLE_TIMEOUT_MS });
  });

  it('one junk field does not poison the other', () => {
    expect(resolveStreamPatience({ firstChunkTimeoutMs: -5, streamIdleTimeoutMs: 200_000 }))
      .toEqual({ firstChunkMs: STREAM_FIRST_CHUNK_TIMEOUT_MS, idleMs: 200_000 });
  });

  it('a sub-floor bound IS honoured by the reader — the floor is the door\'s rule, not this one', () => {
    // Impatient and almost certainly a mistake, but coherent, loud when it fires, and
    // reversible. `the-response-patience-door.test.ts` is where this value is refused; by the
    // time a row holds it, somebody put it there on purpose or by hand.
    expect(resolveStreamPatience({
      firstChunkTimeoutMs: STREAM_PATIENCE_MIN_MS - 1,
      streamIdleTimeoutMs: 300,
    })).toEqual({ firstChunkMs: STREAM_PATIENCE_MIN_MS - 1, idleMs: 300 });
  });
});

describe('T64b — the resolved numbers are what the watchdog is armed with', () => {
  // Millisecond-scaled exactly as `stream-watchdog.test.ts` does: the bounds are injectable
  // parameters, so the production logic runs unchanged at a size a suite can wait for. The
  // shape is the owner's: NOTHING arrives for longer than the standing bound, and the
  // declaration is the difference between dying and living.
  const STANDING = 200;
  const DECLARED = 1_400;

  it('the standing bound fires when the first token is late', async () => {
    const w = makeStreamWatchdog(undefined, STANDING, STANDING);
    await sleep(700);
    expect(w.timedOut()).toBe(true);
    w.finish();
  });

  it('a longer declared bound carries the same wait through', async () => {
    const w = makeStreamWatchdog(undefined, DECLARED, STANDING);
    await sleep(700);
    expect(w.timedOut()).toBe(false);
    expect(w.signal.aborted).toBe(false);
    w.finish();
  });

  it('a declared first-chunk bound does not extend the idle bound', async () => {
    // Patience for prompt processing is not patience for a stalled stream: once the first
    // token has arrived the machine has proven it can emit, and the idle bound is the one
    // that governs from there.
    const w = makeStreamWatchdog(undefined, DECLARED, STANDING);
    w.bump();
    await sleep(700);
    expect(w.timedOut()).toBe(true);
    w.finish();
  });
});

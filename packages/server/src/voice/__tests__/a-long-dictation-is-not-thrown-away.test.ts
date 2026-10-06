// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS U5) — A LONG DICTATION IS NOT THROWN AWAY.
//
// `handleUtteranceEnd` bounded the final transcription at a FLAT 30 seconds, on a job whose cost
// is proportional to the length of the recording. `session.pcmChunks` is cleared before the
// transcribe begins — the local `chunks` binding is the only remaining reference — so when that
// bound fired the user's real, fully-captured speech was GONE: no retry, no re-queue, just
// `voice:state error`. A two-minute dictation, or a first utterance landing while whisper-server
// is still warming a large model off a slow disk, exceeded it as a matter of course.
//
// The measured fact was in hand and already in use: `pcm.length` gates the tiny-utterance drop a
// few lines above the clock. The clock did not consult it. The census called this out as the
// shape of the whole U-list — "the size fact is sixteen lines above the clock and is not
// consulted" — and named `log-rotation.ts` as the tree's one correct example, where a size fact
// triggers the act and the clock only refuses.
//
// The budget is a PURE FUNCTION of the recording, so it is driven as arithmetic: that is the
// whole fact, and a resolver clause cannot be satisfied by a mocked socket. The clauses count in
// both directions — a long recording must earn more time, and the bound must still be a bound.
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function stripped(rel: string): string {
  const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

// THE SHIPPED FUNCTION, not a copy of its arithmetic. An earlier cut of this file re-derived the
// formula as a local oracle, and the mutation run exposed that for what it was: planting a flat
// bound in the product left every arithmetic clause GREEN, because they were testing the copy.
// A clause that can pass while the shipped code says something else is the mechanism by which
// the flat bound survived a release ritual in the first place.
import { transcribeBudgetMsFor } from '../voice-ws.js';

const BOOT = 30_000;
const PER_SEC = 2_000;
const MAX = 10 * 60_000;
const RATE = 16_000;   // a fixture sample rate; the function takes it as an argument

/** Audio seconds -> the budget the PRODUCT computes for a recording that long. */
const budgetFor = (audioSeconds: number): number =>
  transcribeBudgetMsFor(Math.round(audioSeconds * RATE), RATE);

describe('§1 the bound is sized from the recording', () => {
  it('THE RED: a two-minute dictation gets far more than the old flat 30s', () => {
    // The exact hurt scenario the census names. Under the flat bound this recording had 30
    // seconds to transcribe 120 seconds of speech, and lost the speech when it did not.
    const twoMinutes = budgetFor(120);

    expect(twoMinutes, 'a long recording earns real time').toBeGreaterThan(BOOT);
    expect(twoMinutes).toBe(30_000 + 120 * 2_000);
  });

  it('a short utterance keeps the boot allowance it has always had', () => {
    // The old number was sized for a cold engine boot — its own comment said so — and that job
    // is still real, so a brief utterance is no less patient than before this change.
    expect(budgetFor(1), 'one second of audio still gets the boot allowance plus its grant')
      .toBe(BOOT + PER_SEC);
    expect(budgetFor(1), 'which is strictly more patient than the old flat bound')
      .toBeGreaterThan(BOOT);
  });

  it('the grant is monotonic in the audio length — more speech is never less time', () => {
    let previous = 0;
    for (const seconds of [0.5, 1, 5, 20, 60, 120, 240]) {
      const budget = budgetFor(seconds);
      expect(budget, `${seconds}s of audio must not get less than a shorter recording`)
        .toBeGreaterThanOrEqual(previous);
      previous = budget;
    }
  });
});

describe('§2 the bound is still a bound', () => {
  it('CONTROL: the ceiling caps the grant, so a wedged engine cannot hold the session for ever', () => {
    expect(budgetFor(10_000), 'an absurd recording stops at the ceiling').toBe(MAX);
    expect(MAX, 'and the ceiling is finite').toBeLessThan(Number.POSITIVE_INFINITY);
  });

  it('CONTROL: a bound still exists at all — this is not "delete the timer"', () => {
    const src = stripped('voice/voice-ws.ts');

    expect(/transcribe_timeout/.test(src), 'the timeout still exists and still rejects').toBe(true);
    expect(/Math\.min\(\s*TRANSCRIBE_BOOT_ALLOWANCE_MS/.test(src), 'and is still capped').toBe(true);
  });
});

describe('§3 the wiring — the clock reads the size fact', () => {
  it('THE RED: the flat 30_000 literal is gone from the transcribe bound', () => {
    const src = stripped('voice/voice-ws.ts');

    expect(
      /setTimeout\([^)]*30_000\s*\)/.test(src),
      'a bare flat 30s bound on the transcribe is the defect',
    ).toBe(false);
    expect(
      /transcribeBudgetMs/.test(src),
      'the bound is a computed budget',
    ).toBe(true);
  });

  it('the budget is derived from pcm.length and the sample rate, not from a constant', () => {
    const src = stripped('voice/voice-ws.ts');

    expect(
      /const audioSeconds = pcm\.length \/ session\.pcmSampleRate/.test(src),
      'the size fact the tiny-utterance check already uses is what sizes the clock',
    ).toBe(true);
    expect(
      /setTimeout\(\s*[\s\S]{0,400}?transcribeBudgetMs,/.test(src),
      'and the computed budget is what the timer is armed with',
    ).toBe(true);
  });

  it('the failure names BOTH numbers, so the bound is legible to whoever hits it', () => {
    const raw = fs.readFileSync(path.join(SRC, 'voice/voice-ws.ts'), 'utf8');

    expect(raw, 'the reason quotes the budget that was actually applied')
      .toContain('Math.round(transcribeBudgetMs / 1000)');
    expect(raw, 'and the length of audio it was sized for')
      .toContain('Math.round(audioSeconds)');
    expect(raw, 'in words a person can read').toContain('s of audio)');
  });
});
